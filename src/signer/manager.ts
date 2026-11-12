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
import type { LockInfo, NativeSignerApp, NostrSigner, SwitchResult } from "./types";
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
  /** Passphrase accounts unlocked this session. The package forgets a signer on
   *  every switch; keeping it here is what lets you switch back without being
   *  asked again. In memory only, gone with the tab. */
  private sessionSigners = new Map<string, NostrSigner>();
  /** Set while the active account is selected but can't sign (and why). */
  private lockInfo: LockInfo | null = null;
  /** True while an account is being opened and its signer verified (cold start,
   *  switch, retry). Nothing can sign meanwhile and the package's intermediate
   *  events aren't forwarded, so neither the UI nor a caller of getSigner() sees
   *  an account whose extension/bunker hasn't been checked yet. */
  private opening = false;
  private opQueue: Promise<unknown> = Promise.resolve();

  /** One account-changing operation at a time, so two never interleave (a retry
   *  finishing mid-switch would otherwise end the other's "opening" window). */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.opQueue.then(fn);
    this.opQueue = run.catch(() => undefined);
    return run;
  }

  /** Runs `fn` with the active account unusable, then tells the UI once. */
  private async whileOpening<T>(fn: () => Promise<T>): Promise<T> {
    this.opening = true;
    try {
      return await fn();
    } finally {
      this.opening = false;
      this.notify();
    }
  }

  private requireSigner(): PackageSigner {
    if (!this.signer) {
      throw new Error("Signer not initialized");
    }

    return this.signer;
  }

  private removedListeners = new Set<(pubkey: string) => void>();

  /** Fires when an account is removed from this device (logout or removal),
   *  with its pubkey — not on a switch or a lock, where the account stays. */
  onAccountRemoved(listener: (pubkey: string) => void) {
    this.removedListeners.add(listener);
    return () => this.removedListeners.delete(listener);
  }

  private notifyRemoved(pubkey: string) {
    for (const listener of this.removedListeners) listener(pubkey);
  }

  private notify() {
    if (this.opening) return;
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

  /** The signer that can sign for the active account right now, if any. */
  private activeSigner(): NostrSigner | null {
    if (this.opening || this.lockInfo) return null;
    const active = this.signer?.getActiveAccount();
    if (!active) return null;
    return (this.signer?.getActiveSigner() as NostrSigner | null) ?? this.sessionSigners.get(active.pubkey) ?? null;
  }

  /** Why the active account can't sign, or null if it can (or there is none). */
  getLockInfo(): LockInfo | null {
    if (this.opening) return null;
    const active = this.signer?.getActiveAccount();
    if (!active || this.activeSigner()) return null;
    if (this.lockInfo) return this.lockInfo;
    return { reason: active.method === "ncryptsec" ? "passphrase" : "signer-unreachable" };
  }

  /** An extension is only usable if it is on the key this account was added with. */
  private async checkExtension(pubkey: string): Promise<LockInfo | null> {
    const nostr = (globalThis as { nostr?: { getPublicKey(): Promise<string> } }).nostr;
    if (!nostr) return { reason: "extension-missing" };
    try {
      const current = await Promise.race([
        nostr.getPublicKey(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 15_000)),
      ]);
      if (current === pubkey) return null;
      // The extension is untrusted input: only a real key may reach the UI, which
      // encodes it as an npub while rendering.
      const valid = typeof current === "string" && /^[0-9a-f]{64}$/i.test(current);
      return valid
        ? { reason: "extension-other-account", extensionPubkey: current }
        : { reason: "extension-other-account" };
    } catch {
      return { reason: "extension-missing" };
    }
  }

  /** Silently re-creates the active account's signer from what the package stores. */
  private async unlockActive(): Promise<LockInfo | null> {
    const signer = this.requireSigner();
    const account = signer.getActiveAccount();
    if (!account || account.method === "ncryptsec") return null;
    await signer.unlock({ pool: this.pool });
    if (!signer.getActiveSigner()) return { reason: "signer-unreachable" };
    return account.method === "extension" ? this.checkExtension(account.pubkey) : null;
  }

  /**
   * Switches to another persisted account, all or nothing. The package leaves a
   * switched-to account locked, so this re-opens it the way a cold start does
   * (extension / bunker / Android silently, a passphrase account from this
   * session's cache). When the account needs something first — a passphrase, the
   * extension on the right key, a reachable signer — nothing changes: the
   * current account stays active and the reason comes back for the UI to ask.
   */
  async switchAccount(pubkey: string): Promise<SwitchResult> {
    // One switch at a time: a second pick made while the first is still checking
    // the extension waits its turn instead of interleaving with it.
    return this.serial(() => this.doSwitchAccount(pubkey));
  }

  private async doSwitchAccount(pubkey: string): Promise<SwitchResult> {
    const signer = this.requireSigner();
    const target = signer.listAccounts().find((account) => account.pubkey === pubkey);
    if (!target) throw new Error("That account is no longer on this device");

    const previous = signer.getActiveAccount();
    if (previous?.pubkey === pubkey) return { ok: true };

    if (target.method === "ncryptsec" && !this.sessionSigners.has(pubkey)) {
      return { ok: false, need: "passphrase" };
    }

    const previousLock = this.lockInfo;
    return this.whileOpening<SwitchResult>(async () => {
      try {
        await signer.switchAccount(pubkey);
        this.lockInfo = null;
        const problem = await this.unlockActive();
        if (problem) {
          await this.restore(previous, previousLock, problem);
          return { ok: false, need: problem.reason, ...problem };
        }
        return { ok: true };
      } catch (error) {
        await this.restore(previous, previousLock, { reason: "signer-unreachable" });
        throw error;
      }
    });
  }

  /**
   * Puts the account you were on back after a failed switch, re-checking it: an
   * extension may have moved to a third key meanwhile, so the old "usable" verdict
   * can't be trusted. With no previous account the target stays selected, locked.
   */
  private async restore(previous: StoredAccount | null, lock: LockInfo | null, fallback: LockInfo) {
    const signer = this.requireSigner();
    if (!previous) {
      this.lockInfo = fallback;
      return;
    }
    await signer.switchAccount(previous.pubkey);
    this.lockInfo = null;
    const restored = await this.unlockActive().catch((): LockInfo => ({ reason: "signer-unreachable" }));
    // A passphrase account can't be silently reopened; keep the lock it had.
    this.lockInfo = previous.method === "ncryptsec" ? lock : restored;
  }

  /** Re-tries opening the active account (the extension was fixed, the signer is back). */
  async retryUnlock(): Promise<LockInfo | null> {
    // unlock() emits a switch event synchronously, before the extension has been
    // checked; whileOpening keeps that unverified state away from the UI and from
    // getSigner() until lockInfo is set.
    return this.serial(() =>
      this.whileOpening(async () => {
        this.lockInfo = null;
        const problem = await this.unlockActive();
        this.lockInfo = problem;
        return problem;
      }),
    );
  }

  /** Unlocks and switches to a passphrase account in one step, so it is never seen locked. */
  async unlockAndSwitch(pubkey: string, passphrase: string): Promise<string> {
    return this.serial(async () => {
      const signer = this.requireSigner();
      const account = signer.listAccounts().find((a) => a.pubkey === pubkey);
      if (!account?.ncryptsec) throw new Error("No locked account to unlock");
      // A wrong passphrase throws before anything changes: keep the lock we had.
      const previousLock = this.lockInfo;
      this.lockInfo = null;
      try {
        const unlocked = await signer.loginWithNcryptsec(account.ncryptsec, passphrase);
        return unlocked.pubkey;
      } catch (error) {
        this.lockInfo = previousLock;
        throw error;
      }
    });
  }

  /**
   * Removes one persisted account. Unlike `logout()` (which always targets
   * the active account), this can remove any account by pubkey — used for
   * pruning a stale entry from the account list without switching to it.
   */
  async removeAccount(pubkey: string): Promise<void> {
    return this.serial(async () => {
      const signer = this.requireSigner();
      await signer.logout(pubkey);
      this.notifyRemoved(pubkey);
    });
  }

  /** True while an account is still being opened and verified. */
  isOpening(): boolean {
    return this.opening;
  }

  isLocked(): boolean {
    return !!this.signer?.getActiveAccount() && !this.activeSigner();
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

    this.signer.onChange((event) => {
      if (event.type === "logout") {
        this.sessionSigners.delete(event.pubkey);
      } else {
        const account = this.signer?.getActiveAccount();
        const active = this.signer?.getActiveSigner();
        if (account?.method === "ncryptsec" && active) {
          this.sessionSigners.set(account.pubkey, active as NostrSigner);
        }
        // a fresh login is always usable; the next unlock check sets this again if not
        if (event.type === "login") this.lockInfo = null;
      }
      this.notify();
    });

    if (this.signer.listAccounts().length === 0) {
      const legacyNsec = await readLegacyNsec();
      if (legacyNsec) {
        this.pendingMigrationNsec = legacyNsec;
        return undefined;
      }
    }

    const signer = this.signer;
    // unlock() emits login before the extension has been checked. Hold the account
    // as unusable until it has, then tell the UI once - including a UI that gave
    // up waiting (see ProfileProvider) and would otherwise never hear the verdict.
    await this.whileOpening(async () => {
      await signer.unlock({ pool: this.pool });
      const active = signer.getActiveAccount();
      if (active?.method === "extension") {
        this.lockInfo = await this.checkExtension(active.pubkey);
      }
    });
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
    return this.serial(async () => {
      const signer = this.requireSigner();
      const account = signer.getActiveAccount();

      if (!account?.ncryptsec) {
        throw new Error("No locked account to unlock");
      }

      const unlocked = await signer.loginWithNcryptsec(account.ncryptsec, passphrase);
      return unlocked.pubkey;
    });
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

    await this.serial(async () => {
      const removed = this.getPubkey();
      await this.signer?.logout();
      if (removed) this.notifyRemoved(removed);
    });
  }

  async getSigner(): Promise<NostrSigner> {
    const active = this.activeSigner();

    if (!active) {
      throw new Error("No signer available");
    }

    return active;
  }
}

export const signerManager = new SignerManager();
