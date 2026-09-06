import { nip44, generateSecretKey, getPublicKey } from "nostr-tools";
import { bytesToHex, hexToBytes } from "nostr-tools/utils";
import { signerManager } from "./signer/manager";

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_ENCODE_TABLE = new Uint8Array(64);
for (let i = 0; i < 64; i++) BASE64_ENCODE_TABLE[i] = BASE64_ALPHABET.charCodeAt(i);
const BASE64_DECODE_TABLE = new Uint8Array(256).fill(255);
for (let i = 0; i < 64; i++) BASE64_DECODE_TABLE[BASE64_ENCODE_TABLE[i]] = i;
const BASE64_PAD = 61; // '='

/**
 * Base64-encodes bytes directly into base64's ASCII alphabet as bytes — never
 * materializes a JS string. Single linear pass over a pre-sized output buffer
 * (standard 3-bytes-in/4-chars-out lookup-table algorithm), which is both
 * faster and lower-memory than `btoa(String.fromCharCode(...))`: that approach
 * builds an intermediate string the same size as the output (~33% bigger than
 * the input) via repeated concatenation, which is the dominant cost on large
 * chunks.
 */
export function base64EncodeToBytes(input: Uint8Array): Uint8Array {
  const fullGroups = Math.floor(input.length / 3);
  const remainder = input.length - fullGroups * 3;
  const out = new Uint8Array((fullGroups + (remainder > 0 ? 1 : 0)) * 4);

  let o = 0;
  let i = 0;
  for (; i < fullGroups * 3; i += 3) {
    const n = (input[i] << 16) | (input[i + 1] << 8) | input[i + 2];
    out[o++] = BASE64_ENCODE_TABLE[(n >> 18) & 63];
    out[o++] = BASE64_ENCODE_TABLE[(n >> 12) & 63];
    out[o++] = BASE64_ENCODE_TABLE[(n >> 6) & 63];
    out[o++] = BASE64_ENCODE_TABLE[n & 63];
  }

  if (remainder === 1) {
    const n = input[i] << 16;
    out[o++] = BASE64_ENCODE_TABLE[(n >> 18) & 63];
    out[o++] = BASE64_ENCODE_TABLE[(n >> 12) & 63];
    out[o++] = BASE64_PAD;
    out[o++] = BASE64_PAD;
  } else if (remainder === 2) {
    const n = (input[i] << 16) | (input[i + 1] << 8);
    out[o++] = BASE64_ENCODE_TABLE[(n >> 18) & 63];
    out[o++] = BASE64_ENCODE_TABLE[(n >> 12) & 63];
    out[o++] = BASE64_ENCODE_TABLE[(n >> 6) & 63];
    out[o++] = BASE64_PAD;
  }

  return out;
}

/** Inverse of {@link base64EncodeToBytes}: reads base64 ASCII bytes and decodes
 *  straight to raw bytes, no intermediate string. */
export function base64DecodeFromBytes(input: Uint8Array): Uint8Array {
  let len = input.length;
  while (len > 0 && input[len - 1] === BASE64_PAD) len--;

  const outLen = Math.floor((len * 3) / 4);
  const out = new Uint8Array(outLen);

  let o = 0;
  let bits = 0;
  let value = 0;
  for (let i = 0; i < len; i++) {
    value = (value << 6) | BASE64_DECODE_TABLE[input[i]];
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (value >> bits) & 0xff;
    }
  }

  return out;
}

/** Convert Uint8Array to Base64 string. */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  // base64EncodeToBytes already outputs base64's own ASCII alphabet — this is
  // just turning those bytes into a JS string, NOT a second base64 pass (no
  // btoa here: that would re-encode already-base64 text into nonsense).
  // Spread is chunked to avoid "Maximum call stack size exceeded" on inputs
  // larger than the engine's argument-count limit.
  const encoded = base64EncodeToBytes(bytes);
  let out = "";
  const chunkSize = 0x8000; // 32KB
  for (let i = 0; i < encoded.length; i += chunkSize) {
    out += String.fromCharCode(...encoded.subarray(i, i + chunkSize));
  }
  return out;
}

/** Convert Base64 string to Uint8Array. */
export function base64ToUint8Array(b64: string): Uint8Array {
  return base64DecodeFromBytes(new TextEncoder().encode(b64));
}

const NIP44_INFO = new TextEncoder().encode("nip44-v2");

/** HKDF-SHA256(conversationKey, salt=nonce, info="nip44-v2") -> 44 bytes,
 *  split into the 32-byte AES-GCM key and 12-byte IV. Shared by every
 *  encrypt/decrypt path below — there is exactly one derivation to get right. */
async function deriveGcmKeyAndIv(
  conversationKey: Uint8Array,
  nonce: Uint8Array,
): Promise<{ aesKey: CryptoKey; iv: Uint8Array }> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    conversationKey as BufferSource,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const derivedBits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: nonce as BufferSource, info: NIP44_INFO },
    baseKey,
    44 * 8,
  );
  const derived = new Uint8Array(derivedBits);
  const aesKey = await crypto.subtle.importKey(
    "raw",
    derived.slice(0, 32) as BufferSource,
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
  return { aesKey, iv: derived.slice(32, 44) };
}

/**
 * Bytes-in/bytes-out NIP-44 v2 blob: `0x02 || nonce(32) || ciphertext`. This is
 * the one place the format is actually produced — {@link aesGcmEncrypt} (string
 * API, for Nostr event content) and {@link aesGcmEncryptBytes} (for Blossom
 * chunk blobs) both call straight through to this, so there's no duplicated
 * crypto and no accidental extra encoding layer on either side.
 */
async function aesGcmEncryptRaw(
  plaintextBytes: Uint8Array,
  conversationKey: Uint8Array,
  nonce?: Uint8Array,
): Promise<Uint8Array> {
  // Random 32-byte nonce, unless the caller supplied one. Callers only supply
  // their own when they need to reproduce an EARLIER encryption of the exact
  // same plaintext under the exact same key (see uploadFile.ts's no-OPFS
  // fallback) — never to encrypt two different plaintexts under one nonce.
  nonce ??= crypto.getRandomValues(new Uint8Array(32));
  const { aesKey, iv } = await deriveGcmKeyAndIv(conversationKey, nonce);

  // Use AES-GCM as a substitute for ChaCha20 (WebCrypto doesn't support ChaCha20)
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, aesKey, plaintextBytes as BufferSource),
  );

  const payload = new Uint8Array(1 + 32 + ciphertext.length);
  payload[0] = 2; // v2
  payload.set(nonce, 1);
  payload.set(ciphertext, 33);
  return payload;
}

/** Inverse of {@link aesGcmEncryptRaw}. */
async function aesGcmDecryptRaw(payload: Uint8Array, conversationKey: Uint8Array): Promise<Uint8Array> {
  const version = payload[0];
  if (version !== 2) {
    // Most likely an old file encrypted under a blob format this client no
    // longer reads (e.g. the pre-NIP-FS v3 chunk format) — this message
    // reaches the user as-is via transferQueue's failed-transfer error, so it
    // needs to be actionable, not a raw version number.
    throw new Error(
      `This file uses an unsupported encryption format (version ${version}) and can no longer be downloaded. It likely predates an app update — please re-upload it.`,
    );
  }
  const nonce = payload.slice(1, 33);
  const ciphertextBytes = payload.slice(33);
  const { aesKey, iv } = await deriveGcmKeyAndIv(conversationKey, nonce);

  return new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, aesKey, ciphertextBytes as BufferSource),
  );
}

/**
 * NIP-44 v2 encryption for large payloads
 * Based on NIP-44 spec, but without the nostr-tools size limitation
 */
export async function aesGcmEncrypt(
  plaintext: string,
  conversationKey: Uint8Array,
  nonce?: Uint8Array,
): Promise<string> {
  const payload = await aesGcmEncryptRaw(new TextEncoder().encode(plaintext), conversationKey, nonce);
  return uint8ArrayToBase64(payload);
}

/**
 * NIP-44 v2 decryption for large payloads
 */
export async function aesGcmDecrypt(
  ciphertext: string,
  conversationKey: Uint8Array,
): Promise<string> {
  try {
    const plaintext = await aesGcmDecryptRaw(base64ToUint8Array(ciphertext), conversationKey);
    return new TextDecoder().decode(plaintext);
  } catch (error) {
    console.error("aesGcmDecrypt error:", error);
    throw error;
  }
}

/**
 * NIP-FS chunk encryption. Each chunk is encrypted independently with the
 * file's per-file conversation key using the NIP-44 v2 scheme: a random 32-byte
 * nonce is used as the HKDF-SHA256 salt (info = "nip44-v2"), and AES-GCM
 * encrypts the chunk bytes. Note: The spec calls for base64(fileBytes), but we 
 * omit it for performance and network efficiency when uploading binary blobs.
 */
export async function aesGcmEncryptBytes(
  plaintext: Uint8Array,
  conversationKey: Uint8Array,
  nonce?: Uint8Array,
): Promise<Uint8Array> {
  return aesGcmEncryptRaw(plaintext, conversationKey, nonce);
}

/**
 * Inverse of {@link aesGcmEncryptBytes}: parses the `0x02 || nonce(32) || ct`
 * blob directly, decrypting the raw bytes.
 */
export async function aesGcmDecryptBytes(
  payload: Uint8Array,
  conversationKey: Uint8Array,
): Promise<Uint8Array> {
  return aesGcmDecryptRaw(payload, conversationKey);
}

/**
 * Number of segments a file of `size` bytes splits into under `chunkSize`.
 * Always at least 1 — an empty file (size 0) still has exactly one, empty,
 * last segment (NIP-FS: "the last may be shorter, including empty"). A file
 * whose size is an exact multiple of `chunkSize` (including exactly one
 * `chunkSize`) is NOT followed by a trailing empty segment: ceil() already
 * lands on the right count, so e.g. size === chunkSize gives exactly 1.
 */
export function segmentCount(size: number, chunkSize: number): number {
  return Math.max(1, Math.ceil(size / chunkSize));
}

/**
 * Builds the NIP-FS per-segment nonce (12 bytes): an 11-byte big-endian
 * segment counter, followed by a 1-byte last-segment flag (0x01 on the final
 * segment, 0x00 otherwise). Unlike {@link aesGcmEncryptRaw}'s nonce, this is
 * never random and never stored — the decryptor rebuilds the identical nonce
 * from the segment's index and position (both derivable from the file's
 * `size`/`chunkSize` in metadata), which is what makes a reordered segment's
 * auth tag fail (wrong nonce recomputed for that ciphertext) and a truncated
 * stream detectable (the decryptor, told the true segment count up front,
 * never reaches a segment it can decrypt with the last-flag set).
 *
 * Avoids bitwise ops throughout: index can in principle exceed 2^31, where
 * JS's `<<`/`&` silently truncate to 32 bits, so the byte-at-a-time write
 * below uses only `%`/`Math.floor` division.
 */
function buildSegmentNonce(index: number, isLast: boolean): Uint8Array {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`Segment index must be a non-negative integer, got ${index}`);
  }
  const nonce = new Uint8Array(12);
  let remaining = index;
  for (let i = 10; i >= 0; i--) {
    nonce[i] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
  if (remaining > 0) {
    // Would need more than 11 bytes (2^88 segments) — unreachable for any
    // real file, but fail loudly rather than silently wrap the counter.
    throw new Error(`Segment index too large to encode in 11 bytes: ${index}`);
  }
  nonce[11] = isLast ? 1 : 0;
  return nonce;
}

/**
 * Imports `blobKey` directly as an AES-256-GCM key — no HKDF derivation.
 * Distinct from {@link deriveGcmKeyAndIv} (the NIP-44 chunk/content format
 * above), which derives a fresh key+IV per random nonce via HKDF; the NIP-FS
 * segment format uses the key as-is and gets its per-segment uniqueness
 * entirely from the counter nonce (see {@link buildSegmentNonce}).
 */
async function importSegmentKey(blobKey: Uint8Array): Promise<CryptoKey> {
  if (blobKey.length !== 32) {
    throw new Error(`blobKey must be 32 bytes, got ${blobKey.length}`);
  }
  return crypto.subtle.importKey("raw", blobKey as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/**
 * NIP-FS segment encryption ("File Encryption" in the spec): AES-256-GCM
 * directly under the file's 32-byte blobKey, with a nonce built from the
 * segment's position rather than drawn at random — see
 * {@link buildSegmentNonce} for why. Output is `ciphertext || tag(16)`, with
 * no version byte and no stored nonce (both are implicit — recomputed from
 * `index`/`isLast` on decrypt). Every segment's output is concatenated, in
 * order, into the single blob that gets uploaded; that blob's sha256 is the
 * file's `blobHash`.
 *
 * `index`/`isLast` come from the caller's own loop position, not from
 * anything stored in this payload — see {@link segmentCount} for computing
 * the total up front from `size`/`chunkSize`.
 */
export async function encryptSegment(
  plaintext: Uint8Array,
  blobKey: Uint8Array,
  index: number,
  isLast: boolean,
): Promise<Uint8Array> {
  const aesKey = await importSegmentKey(blobKey);
  const nonce = buildSegmentNonce(index, isLast);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce as BufferSource },
    aesKey,
    plaintext as BufferSource,
  );
  return new Uint8Array(ciphertext);
}

/**
 * Inverse of {@link encryptSegment}. The caller must supply the SAME
 * `index`/`isLast` the segment was encrypted with — get either wrong (a
 * reordered segment, or a stream that ended before the true last-flagged
 * segment) and the recomputed nonce won't match, so the AES-GCM tag check
 * fails and this throws rather than returning wrong or truncated plaintext.
 */
export async function decryptSegment(
  payload: Uint8Array,
  blobKey: Uint8Array,
  index: number,
  isLast: boolean,
): Promise<Uint8Array> {
  const aesKey = await importSegmentKey(blobKey);
  const nonce = buildSegmentNonce(index, isLast);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce as BufferSource },
    aesKey,
    payload as BufferSource,
  );
  return new Uint8Array(plaintext);
}

export function deriveConversationKeyFromHex(privateKeyHex: string): Uint8Array {
  const secretKey = hexToBytes(privateKeyHex);
  const pubkey = getPublicKey(secretKey);
  return nip44.v2.utils.getConversationKey(secretKey, pubkey);
}

/**
 * Encrypt a file with a newly generated key (self-encryption)
 * Returns both the ciphertext and the private key (hex) needed for decryption
 */
export async function encryptFileWithKey(
  fileBytes: Uint8Array,
): Promise<{ ciphertext: string; privateKeyHex: string }> {
  const privateKeyHex = bytesToHex(generateSecretKey());
  const ciphertext = await encryptFileWithExistingKey(fileBytes, privateKeyHex);
  return { ciphertext, privateKeyHex };
}

/**
 * Decrypt a file using the stored private key
 */
export async function decryptFileWithKey(
  ciphertext: string,
  privateKeyHex: string,
): Promise<Uint8Array> {
  // Convert hex private key back to bytes
  const secretKey = hexToBytes(privateKeyHex);
  const pubkey = getPublicKey(secretKey);

  // Recreate conversation key (decrypt from self)
  const conversationKey = nip44.v2.utils.getConversationKey(secretKey, pubkey);

  // Decrypt using our large payload implementation
  const plaintextBase64 = await aesGcmDecrypt(ciphertext, conversationKey);

  if (!plaintextBase64) {
    throw new Error("Decryption failed");
  }

  // Convert base64 back to bytes
  return base64ToUint8Array(plaintextBase64);
}

/**
 * Encrypt a file using an existing private key
 */
export async function encryptFileWithExistingKey(
  fileBytes: Uint8Array,
  privateKeyHex: string,
): Promise<string> {
  const secretKey = hexToBytes(privateKeyHex);
  const pubkey = getPublicKey(secretKey);
  const conversationKey = nip44.v2.utils.getConversationKey(secretKey, pubkey);
  const plaintextBase64 = uint8ArrayToBase64(fileBytes);
  return aesGcmEncrypt(plaintextBase64, conversationKey);
}

/**
 * Encrypt a file (Uint8Array) using NIP-44 with window.nostr
 * DEPRECATED: Use encryptFileWithKey instead
 */
export async function encryptFile(fileBytes: Uint8Array): Promise<string> {
  const signer = await signerManager.getSigner();
  if (!signer.nip44Encrypt) {
    throw new Error("Signer does not support NIP-44 encryption");
  }

  const pubkey = await signer.getPublicKey();
  const plaintextBase64 = uint8ArrayToBase64(fileBytes);
  return signer.nip44Encrypt(pubkey, plaintextBase64);
}

/**
 * Decrypt NIP-44 ciphertext using window.nostr
 * DEPRECATED: Use decryptFileWithKey instead
 */
export async function decryptFile(ciphertext: string): Promise<Uint8Array> {
  const signer = await signerManager.getSigner();
  if (!signer.nip44Decrypt) {
    throw new Error("Signer does not support NIP-44 decryption");
  }

  const pubkey = await signer.getPublicKey();
  const plaintextBase64 = await signer.nip44Decrypt(pubkey, ciphertext);

  if (!plaintextBase64) {
    throw new Error(
      "Decryption returned empty result - did you cancel the prompt?",
    );
  }

  return base64ToUint8Array(plaintextBase64);
}
