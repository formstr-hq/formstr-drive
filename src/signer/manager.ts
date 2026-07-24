import { nip19, SimplePool } from "nostr-tools";
import {
  createSigner,
  encryptSecretKey,
  generateAccount,
  type AndroidSignerAppInfo,
  type Signer as PackageSigner,
  type StoredAccount,
} from "@formstr/signer";
import { NostrSignerPlugin } from "nostr-signer-capacitor-plugin";
import { hydrateSignerStorage } from "./storageAdapter";
import { clearLegacyNsec, readLegacyNsec } from "./migration";
import type { NativeSignerApp, NostrSigner } from "./types";
import { isNativePlatform } from "../utils/platform";

type ChangeListener = (pubkey?: string) => void;

// Without explicit perms, several bunker UIs (Amber included) show no
// approve/deny prompt because the connect request has nothing concrete to
// authorize — see @formstr/signer's README "NIP-46 app identity" section.
const NIP46_PERMS = ["get_public_key", "sign_event", "nip44_encrypt", "nip44_decrypt"];

function decodeNsecBytes(nsec: string): Uint8Array {
  try {
    const decoded = nip19.decode(nsec.trim());
    if (decoded.type !== "nsec" || !(decoded.data instanceof Uint8Array)) {
      throw new Error("Invalid nsec");
    }

    return decoded.data;
  } catch {
    throw new Error("Invalid nsec");
  }
}

class SignerManager {
  private signer: PackageSigner | null = null;
  private pool = new SimplePool();
  private listeners = new Set<ChangeListener>();
  private initPromise: Promise<string | undefined> | null = null;
  private pendingMigrationNsec: string | null = null;

  private requireSigner(): PackageSigner {
    if (!this.signer) {
      throw new Error("Signer not initialized");
    }

    return this.signer;
  }

  private notify() {
    const pubkey = this.getPubkey();
    for (const listener of this.listeners) {
      listener(pubkey);
    }
  }

  onChange(listener: ChangeListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getPubkey(): string | undefined {
    return this.signer?.getActiveAccount()?.pubkey ?? undefined;
  }

  getActiveAccount(): StoredAccount | null {
    return this.signer?.getActiveAccount() ?? null;
  }

  listAccounts(): StoredAccount[] {
    return this.signer?.listAccounts() ?? [];
  }

  /**
   * Switches which persisted account is active. Per the package contract
   * this always leaves the new account LOCKED, even if it was unlocked
   * earlier this session — callers should expect `isLocked()` to flip true
   * right after this resolves and drive the existing unlock UI from there.
   */
  async switchAccount(pubkey: string): Promise<void> {
    const signer = this.requireSigner();
    await signer.switchAccount(pubkey);
  }

  /**
   * Removes one persisted account. Unlike `logout()` (which always targets
   * the active account), this can remove any account by pubkey — used for
   * pruning a stale entry from the account list without switching to it.
   */
  async removeAccount(pubkey: string): Promise<void> {
    const signer = this.requireSigner();
    await signer.logout(pubkey);
  }

  isLocked(): boolean {
    return !!this.signer?.getActiveAccount() && !this.signer.getActiveSigner();
  }

  hasPendingNsecMigration(): boolean {
    return this.pendingMigrationNsec !== null;
  }

  /**
   * Idempotent — safe to call multiple times (e.g. React StrictMode double
   * effects); every caller after the first awaits the same in-flight promise.
   *
   * Only a successful init is kept memoized. If it rejects (e.g. a slow or
   * failed secure-storage read on cold start), the memo is cleared so the
   * next call retries instead of replaying the same cached rejection forever.
   */
  async init(): Promise<string | undefined> {
    if (!this.initPromise) {
      const attempt = this.doInit();
      attempt.catch(() => {
        if (this.initPromise === attempt) {
          this.initPromise = null;
        }
      });
      this.initPromise = attempt;
    }

    return this.initPromise;
  }

  private async doInit(): Promise<string | undefined> {
    const storage = await hydrateSignerStorage();

    this.signer = createSigner({
      appName: "Formstr Drive",
      appUrl: typeof window !== "undefined" ? window.location.origin : undefined,
      androidSignerPlugin: isNativePlatform ? NostrSignerPlugin : undefined,
      storage,
    });

    this.signer.onChange(() => this.notify());

    if (this.signer.listAccounts().length === 0) {
      const legacyNsec = await readLegacyNsec();
      if (legacyNsec) {
        this.pendingMigrationNsec = legacyNsec;
        return undefined;
      }
    }

    await this.signer.unlock({ pool: this.pool });
    return this.getPubkey();
  }

  async completeNsecMigration(passphrase: string): Promise<string> {
    if (!this.pendingMigrationNsec) {
      throw new Error("No pending nsec migration");
    }

    const pubkey = await this.importNsec(this.pendingMigrationNsec, passphrase);
    await clearLegacyNsec();
    this.pendingMigrationNsec = null;
    return pubkey;
  }

  async requestPubkey(packageName?: string): Promise<string> {
    const signer = this.requireSigner();

    if (isNativePlatform) {
      if (!packageName) {
        throw new Error("Please select an Android signer app");
      }

      const account = await signer.loginWithAndroidSigner({ packageName });
      return account.pubkey;
    }

    const account = await signer.loginWithExtension();
    return account.pubkey;
  }

  async loginWithBunkerUri(uri: string): Promise<string> {
    const signer = this.requireSigner();
    const account = await signer.loginWithBunkerUri(uri, {
      pool: this.pool,
      perms: NIP46_PERMS,
    });
    return account.pubkey;
  }

  async loginWithNostrConnect(options: {
    relays: string[];
    onUri: (uri: string) => void;
    signal?: AbortSignal;
  }): Promise<string> {
    const signer = this.requireSigner();
    const account = await signer.loginWithNostrConnect({
      relays: options.relays,
      onUri: options.onUri,
      signal: options.signal,
      pool: this.pool,
      perms: NIP46_PERMS,
    });
    return account.pubkey;
  }

  /**
   * Pure helper — generates a brand-new nsec and its ncryptsec backup
   * without touching storage or activating anything. The caller shows the
   * ncryptsec to the user for backup and only calls
   * `confirmPendingAccount` once they've confirmed they saved it.
   */
  generatePendingAccount(passphrase: string): { npub: string; ncryptsec: string } {
    const { npub, ncryptsec } = generateAccount(passphrase);
    return { npub, ncryptsec };
  }

  async confirmPendingAccount(ncryptsec: string, passphrase: string): Promise<string> {
    const signer = this.requireSigner();
    const account = await signer.loginWithNcryptsec(ncryptsec, passphrase);
    return account.pubkey;
  }

  async unlockWithPassphrase(passphrase: string): Promise<string> {
    const signer = this.requireSigner();
    const account = signer.getActiveAccount();

    if (!account?.ncryptsec) {
      throw new Error("No locked account to unlock");
    }

    const unlocked = await signer.loginWithNcryptsec(account.ncryptsec, passphrase);
    return unlocked.pubkey;
  }

  async importNsec(nsec: string, passphrase: string): Promise<string> {
    const signer = this.requireSigner();
    const secretKey = decodeNsecBytes(nsec);
    const ncryptsec = encryptSecretKey(secretKey, passphrase);
    const account = await signer.loginWithNcryptsec(ncryptsec, passphrase);
    return account.pubkey;
  }

  async listAndroidSignerApps(): Promise<NativeSignerApp[]> {
    const signer = this.requireSigner();
    const apps: AndroidSignerAppInfo[] = await signer.listAndroidSignerApps();
    return apps;
  }

  async logout(): Promise<void> {
    if (!this.signer) {
      return;
    }

    await this.signer.logout();
  }

  async getSigner(): Promise<NostrSigner> {
    const active = this.signer?.getActiveSigner();

    if (!active) {
      throw new Error("No signer available");
    }

    return active;
  }
}

export const signerManager = new SignerManager();
