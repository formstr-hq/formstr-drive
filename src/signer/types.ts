import type { Event, EventTemplate } from "nostr-tools";

export interface NostrSigner {
  getPublicKey: () => Promise<string>;
  signEvent: (event: EventTemplate) => Promise<Event>;
  nip44Encrypt?: (pubkey: string, plaintext: string) => Promise<string>;
  nip44Decrypt?: (pubkey: string, ciphertext: string) => Promise<string>;
}

export interface NativeSignerApp {
  packageName: string;
  name: string;
  iconUrl?: string;
}

/** Why an account can't sign yet. */
export type LockReason =
  | "passphrase"
  | "extension-missing"
  | "extension-other-account"
  | "signer-unreachable";

export interface LockInfo {
  reason: LockReason;
  /** For "extension-other-account": the key the extension is currently on. */
  extensionPubkey?: string;
}

export type SwitchResult = { ok: true } | ({ ok: false; need: LockReason } & Partial<LockInfo>);
