// The ONLY place a sharing event's content cipher is chosen. Every sharing
// event (`shared-file`, `container`, `shared-container`) MUST encrypt and
// decrypt through this module — nowhere else in `services/sharing` may call
// `nip44` or the legacy `aesGcmEncrypt`/`aesGcmDecrypt` directly. That
// discipline is what keeps the `["encrypted","nip44"]` tag `event.ts` writes
// honest: previously that tag was hand-written in 7 places while the actual
// cipher (`aesGcmEncrypt`, a NIP-44-*shaped* but incompatible AES-GCM
// construction) lived somewhere else entirely, and the two silently drifted
// apart. Centralizing the choice here means changing it later is a one-file
// change, and the tag can never again claim a scheme the code isn't using.
//
// This is deliberately real NIP-44 v2 (`nostr-tools`' `nip44.v2`, already
// used for the file index in `../fileIndex.ts`) — not `../../crypto.ts`'s
// `aesGcmEncrypt`. That function stays for its one remaining non-sharing
// caller and for the NIP-FS blob *segment* cipher, which the spec mandates
// as AES-GCM. This module is only about small JSON event content, where the
// spec expects interoperable NIP-44.
import { nip44 } from "nostr-tools";

/** Encrypts a sharing event's JSON content under a NIP-44 v2 conversation
 *  key. Synchronous — `nip44.v2.encrypt` does no async work. */
export function encryptSharePayload(plaintext: string, conversationKey: Uint8Array): string {
  return nip44.v2.encrypt(plaintext, conversationKey);
}

/** Inverse of {@link encryptSharePayload}. Throws on a bad key or corrupt
 *  payload — callers decide how to handle that (e.g. trying the next key in
 *  a keyring, or surfacing "this link is invalid"). */
export function decryptSharePayload(ciphertext: string, conversationKey: Uint8Array): string {
  return nip44.v2.decrypt(ciphertext, conversationKey);
}
