import { nip44, generateSecretKey, getPublicKey } from "nostr-tools";
import { bytesToHex, hexToBytes } from "nostr-tools/utils";
import { signerManager } from "./signer/manager";
import { chacha20 } from "@noble/ciphers/chacha.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { expand as hkdfExpand } from "@noble/hashes/hkdf.js";

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000; // 32KB chunks
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function getMessageKeys(conversationKey: Uint8Array, nonce: Uint8Array) {
  // NIP-44 getMessageKeys: hkdf_expand(prk=conversationKey, info=nonce, length=76)
  const keys = hkdfExpand(sha256, conversationKey, nonce, 76);
  return {
    encKey: keys.slice(0, 32),
    encNonce: keys.slice(32, 44),
    authKey: keys.slice(44, 76),
  };
}

/**
 * NIP-44 v2 encryption for large payloads (ChaCha20 + HMAC-SHA256, no size limit)
 */
export function nip44Encrypt(plaintext: string, conversationKey: Uint8Array): string {
  const plaintextBytes = new TextEncoder().encode(plaintext);
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const { encKey, encNonce, authKey } = getMessageKeys(conversationKey, nonce);

  const ciphertext = chacha20(encKey, encNonce, plaintextBytes);

  // MAC = HMAC-SHA256(key=authKey, data=concat(nonce, ciphertext))
  const macInput = new Uint8Array(32 + ciphertext.length);
  macInput.set(nonce);
  macInput.set(ciphertext, 32);
  const mac = hmac(sha256, authKey, macInput);

  // Format: version(1) + nonce(32) + ciphertext + mac(32)
  const payload = new Uint8Array(1 + 32 + ciphertext.length + 32);
  payload[0] = 2;
  payload.set(nonce, 1);
  payload.set(ciphertext, 33);
  payload.set(mac, 33 + ciphertext.length);

  return uint8ArrayToBase64(payload);
}

/**
 * NIP-44 v2 decryption for large payloads
 */
export function nip44Decrypt(ciphertextB64: string, conversationKey: Uint8Array): string {
  const payload = base64ToUint8Array(ciphertextB64);

  if (payload[0] !== 2) {
    throw new Error(`Unsupported NIP-44 version: ${payload[0]}`);
  }
  if (payload.length < 1 + 32 + 32) {
    throw new Error("Payload too short");
  }

  const nonce = payload.slice(1, 33);
  const ciphertext = payload.slice(33, payload.length - 32);
  const mac = payload.slice(payload.length - 32);

  const { encKey, encNonce, authKey } = getMessageKeys(conversationKey, nonce);

  // Verify MAC
  const macInput = new Uint8Array(32 + ciphertext.length);
  macInput.set(nonce);
  macInput.set(ciphertext, 32);
  const expectedMac = hmac(sha256, authKey, macInput);

  let diff = 0;
  for (let i = 0; i < 32; i++) diff |= mac[i] ^ expectedMac[i];
  if (diff !== 0) throw new Error("Invalid MAC");

  const plaintext = chacha20(encKey, encNonce, ciphertext);
  return new TextDecoder().decode(plaintext);
}

/**
 * Encrypt a file with a newly generated key (self-encryption)
 * Returns both the ciphertext and the private key (hex) needed for decryption
 */
export async function encryptFileWithKey(fileBytes: Uint8Array): Promise<{ ciphertext: string; privateKeyHex: string }> {
  const secretKey = generateSecretKey();
  const pubkey = getPublicKey(secretKey);
  const conversationKey = nip44.v2.utils.getConversationKey(secretKey, pubkey);
  const plaintextBase64 = uint8ArrayToBase64(fileBytes);
  const ciphertext = nip44Encrypt(plaintextBase64, conversationKey);
  return {
    ciphertext,
    privateKeyHex: bytesToHex(secretKey),
  };
}

/**
 * Decrypt a file using the stored private key
 */
export async function decryptFileWithKey(ciphertext: string, privateKeyHex: string): Promise<Uint8Array> {
  const secretKey = hexToBytes(privateKeyHex);
  const pubkey = getPublicKey(secretKey);
  const conversationKey = nip44.v2.utils.getConversationKey(secretKey, pubkey);
  const plaintextBase64 = nip44Decrypt(ciphertext, conversationKey);
  if (!plaintextBase64) {
    throw new Error("Decryption failed");
  }
  return base64ToUint8Array(plaintextBase64);
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
    throw new Error("Decryption returned empty result - did you cancel the prompt?");
  }

  return base64ToUint8Array(plaintextBase64);
}
