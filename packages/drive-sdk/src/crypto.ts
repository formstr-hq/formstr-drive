import { generateSecretKey, getPublicKey, nip44 } from "nostr-tools";
import { bytesToHex, hexToBytes } from "nostr-tools/utils";

/** Convert bytes to a Base64 string without overflowing the call stack. */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

/** Convert a Base64 string to bytes. */
export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** Existing large-payload AES-GCM envelope used by Formstr Drive. */
export async function aesGcmEncrypt(
  plaintext: string,
  conversationKey: Uint8Array,
  nonceOverride?: Uint8Array,
): Promise<string> {
  const encoder = new TextEncoder();
  const plaintextBytes = encoder.encode(plaintext);
  const nonce = nonceOverride ?? crypto.getRandomValues(new Uint8Array(32));
  if (nonce.length !== 32) throw new Error("NIP-FS nonce must contain 32 bytes");
  const info = encoder.encode("nip44-v2");

  const baseKey = await crypto.subtle.importKey(
    "raw",
    conversationKey as BufferSource,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const derivedBits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: nonce as BufferSource, info },
    baseKey,
    44 * 8,
  );
  const derived = new Uint8Array(derivedBits);
  const aesKey = await crypto.subtle.importKey(
    "raw",
    derived.slice(0, 32) as BufferSource,
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: derived.slice(32, 44) as BufferSource },
    aesKey,
    plaintextBytes,
  );

  const ciphertextBytes = new Uint8Array(ciphertext);
  const payload = new Uint8Array(1 + 32 + ciphertextBytes.length);
  payload[0] = 2;
  payload.set(nonce, 1);
  payload.set(ciphertextBytes, 33);
  return uint8ArrayToBase64(payload);
}

/** Decrypt the existing large-payload AES-GCM envelope. */
export async function aesGcmDecrypt(
  ciphertext: string,
  conversationKey: Uint8Array,
): Promise<string> {
  const encoder = new TextEncoder();
  const payload = base64ToUint8Array(ciphertext);
  if (payload[0] !== 2) {
    throw new Error(`Unsupported NIP-44 version: ${payload[0]}`);
  }

  const nonce = payload.slice(1, 33);
  const ciphertextBytes = payload.slice(33);
  const baseKey = await crypto.subtle.importKey(
    "raw",
    conversationKey as BufferSource,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: nonce,
      info: encoder.encode("nip44-v2"),
    },
    baseKey,
    44 * 8,
  );
  const derived = new Uint8Array(derivedBits);
  const aesKey = await crypto.subtle.importKey(
    "raw",
    derived.slice(0, 32) as BufferSource,
    "AES-GCM",
    false,
    ["decrypt"],
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: derived.slice(32, 44) as BufferSource },
    aesKey,
    ciphertextBytes,
  );
  return new TextDecoder().decode(plaintext);
}

// These existing chunk formats are preserved byte-for-byte for backward
// compatibility.
const CHUNK_FORMAT_V2 = 2;
const CHUNK_FORMAT_V3 = 3;

function chunkIndexBytes(chunkIndex: number): Uint8Array {
  const indexBytes = new Uint8Array(4);
  new DataView(indexBytes.buffer).setUint32(0, chunkIndex, false);
  return indexBytes;
}

async function deriveChunkSalt(
  conversationKey: Uint8Array,
  indexBytes: Uint8Array,
): Promise<Uint8Array> {
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    conversationKey as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const salt = await crypto.subtle.sign(
    "HMAC",
    hmacKey,
    indexBytes as BufferSource,
  );
  return new Uint8Array(salt);
}

/** Encrypt a binary chunk with the current deterministic v3 format. */
export async function aesGcmEncryptBytes(
  plaintext: Uint8Array,
  conversationKey: Uint8Array,
  chunkIndex: number,
): Promise<Uint8Array> {
  const indexBytes = chunkIndexBytes(chunkIndex);
  const salt = await deriveChunkSalt(conversationKey, indexBytes);
  const baseKey = await crypto.subtle.importKey(
    "raw",
    conversationKey as BufferSource,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: salt as BufferSource,
      info: new TextEncoder().encode("nip44-v2"),
    },
    baseKey,
    44 * 8,
  );
  const derived = new Uint8Array(derivedBits);
  const aesKey = await crypto.subtle.importKey(
    "raw",
    derived.slice(0, 32) as BufferSource,
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: derived.slice(32, 44) as BufferSource,
      additionalData: indexBytes as BufferSource,
    },
    aesKey,
    plaintext as BufferSource,
  );

  const ciphertextBytes = new Uint8Array(ciphertext);
  const payload = new Uint8Array(1 + ciphertextBytes.length);
  payload[0] = CHUNK_FORMAT_V3;
  payload.set(ciphertextBytes, 1);
  return payload;
}

/** Decrypt current v3 and legacy v2 binary chunk envelopes. */
export async function aesGcmDecryptBytes(
  payload: Uint8Array,
  conversationKey: Uint8Array,
  chunkIndex: number,
): Promise<Uint8Array> {
  const version = payload[0];
  const indexBytes = chunkIndexBytes(chunkIndex);

  let salt: Uint8Array;
  let ciphertextBytes: Uint8Array;
  if (version === CHUNK_FORMAT_V3) {
    salt = await deriveChunkSalt(conversationKey, indexBytes);
    ciphertextBytes = payload.slice(1);
  } else if (version === CHUNK_FORMAT_V2) {
    salt = payload.slice(1, 33);
    ciphertextBytes = payload.slice(33);
  } else {
    throw new Error(`Unsupported NIP-44 chunk version: ${version}`);
  }

  const baseKey = await crypto.subtle.importKey(
    "raw",
    conversationKey as BufferSource,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: salt as BufferSource,
      info: new TextEncoder().encode("nip44-v2"),
    },
    baseKey,
    44 * 8,
  );
  const derived = new Uint8Array(derivedBits);
  const aesKey = await crypto.subtle.importKey(
    "raw",
    derived.slice(0, 32) as BufferSource,
    "AES-GCM",
    false,
    ["decrypt"],
  );
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: derived.slice(32, 44) as BufferSource,
      additionalData: indexBytes as BufferSource,
    },
    aesKey,
    ciphertextBytes as BufferSource,
  );
  return new Uint8Array(plaintext);
}

export function deriveConversationKeyFromHex(privateKeyHex: string): Uint8Array {
  const secretKey = hexToBytes(privateKeyHex);
  const publicKey = getPublicKey(secretKey);
  return nip44.v2.utils.getConversationKey(secretKey, publicKey);
}

export async function encryptFileWithKey(
  fileBytes: Uint8Array,
): Promise<{ ciphertext: string; privateKeyHex: string }> {
  const privateKeyHex = bytesToHex(generateSecretKey());
  const ciphertext = await encryptFileWithExistingKey(fileBytes, privateKeyHex);
  return { ciphertext, privateKeyHex };
}

export async function decryptFileWithKey(
  ciphertext: string,
  privateKeyHex: string,
): Promise<Uint8Array> {
  const conversationKey = deriveConversationKeyFromHex(privateKeyHex);
  const plaintextBase64 = await aesGcmDecrypt(ciphertext, conversationKey);
  if (!plaintextBase64) throw new Error("Decryption failed");
  return base64ToUint8Array(plaintextBase64);
}

export async function encryptFileWithExistingKey(
  fileBytes: Uint8Array,
  privateKeyHex: string,
): Promise<string> {
  const conversationKey = deriveConversationKeyFromHex(privateKeyHex);
  return aesGcmEncrypt(uint8ArrayToBase64(fileBytes), conversationKey);
}

/**
 * Encrypt one NIP-FS chunk. Blossom stores the UTF-8 bytes of the Base64
 * `version || nonce || ciphertext` envelope defined by the proposal.
 */
export async function encryptNipFsChunk(
  plaintext: Uint8Array,
  privateKeyHex: string,
  nonceOverride?: Uint8Array,
): Promise<Uint8Array> {
  const conversationKey = deriveConversationKeyFromHex(privateKeyHex);
  const envelope = await aesGcmEncrypt(
    uint8ArrayToBase64(plaintext),
    conversationKey,
    nonceOverride,
  );
  return new TextEncoder().encode(envelope);
}

/** Decrypt Base64-formatted NIP-FS chunks and raw-envelope early drafts. */
export async function decryptNipFsChunk(
  blob: Uint8Array,
  privateKeyHex: string,
): Promise<Uint8Array> {
  const conversationKey = deriveConversationKeyFromHex(privateKeyHex);
  const encoded = new TextDecoder().decode(blob).trim();

  let envelope = encoded;
  try {
    const decoded = base64ToUint8Array(encoded);
    if (decoded[0] !== 2) throw new Error("Not a Base64 NIP-FS envelope");
  } catch {
    // Some early implementations uploaded the decoded envelope bytes.
    envelope = uint8ArrayToBase64(blob);
  }

  const plaintextBase64 = await aesGcmDecrypt(envelope, conversationKey);
  return base64ToUint8Array(plaintextBase64);
}
