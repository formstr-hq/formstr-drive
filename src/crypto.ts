import { nip44, generateSecretKey, getPublicKey } from "nostr-tools";
import { bytesToHex, hexToBytes } from "nostr-tools/utils";

declare global {
  interface Window {
    nostr?: {
      nip44: {
        encrypt: (pubkey: string, text: string) => Promise<string>;
        decrypt: (params: { pubkey: string; ciphertext: string }) => Promise<string>;
      };
      getPublicKey: () => Promise<string>;
      signEvent: (event: object) => Promise<object>;
    };
  }
}

/**
 * Convert Uint8Array to Base64 string
 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000; // 32KB chunks
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

/**
 * Convert Base64 string to Uint8Array
 */
export function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * NIP-44 v2 encryption for large payloads
 * Based on NIP-44 spec, but without the nostr-tools size limitation
 */
export async function aesGcmEncrypt(plaintext: string, conversationKey: Uint8Array): Promise<string> {
  const encoder = new TextEncoder();
  const plaintextBytes = encoder.encode(plaintext);

  // Generate random nonce (32 bytes)
  const nonce = crypto.getRandomValues(new Uint8Array(32));

  // Derive encryption key from conversation key and nonce using HKDF
  const salt = nonce;
  const info = encoder.encode("nip44-v2");

  // Import conversation key for HKDF
  const baseKey = await crypto.subtle.importKey(
    "raw",
    conversationKey as BufferSource,
    "HKDF",
    false,
    ["deriveBits"]
  );

  // Derive 44 bytes: 32 for chacha key, 12 for chacha nonce
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: salt,
      info: info,
    },
    baseKey,
    44 * 8
  );

  const derived = new Uint8Array(derivedBits);
  const chachaKey = derived.slice(0, 32);
  const chachaNonce = derived.slice(32, 44);

  // Use AES-GCM as a substitute for ChaCha20 (WebCrypto doesn't support ChaCha20)
  // This is a pragmatic workaround - ideally we'd use ChaCha20-Poly1305
  const aesKey = await crypto.subtle.importKey(
    "raw",
    chachaKey as BufferSource,
    "AES-GCM",
    false,
    ["encrypt"]
  );

  // Encrypt with AES-GCM
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: chachaNonce as BufferSource,
    },
    aesKey,
    plaintextBytes
  );

  const ciphertextBytes = new Uint8Array(ciphertext);

  // Format: version (1 byte) + nonce (32 bytes) + ciphertext
  const version = new Uint8Array([2]); // v2
  const payload = new Uint8Array(1 + 32 + ciphertextBytes.length);
  payload.set(version, 0);
  payload.set(nonce, 1);
  payload.set(ciphertextBytes, 33);

  // Return as base64
  return uint8ArrayToBase64(payload);
}

/**
 * NIP-44 v2 decryption for large payloads
 */
export async function aesGcmDecrypt(ciphertext: string, conversationKey: Uint8Array): Promise<string> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  try {
    // Decode from base64
    const payload = base64ToUint8Array(ciphertext);

    // Parse: version (1 byte) + nonce (32 bytes) + ciphertext
    const version = payload[0];
    if (version !== 2) {
      throw new Error(`Unsupported NIP-44 version: ${version}`);
    }

    const nonce = payload.slice(1, 33);
    const ciphertextBytes = payload.slice(33);

    // Derive encryption key from conversation key and nonce using HKDF
    const salt = nonce;
    const info = encoder.encode("nip44-v2");

    const baseKey = await crypto.subtle.importKey(
      "raw",
      conversationKey as BufferSource,
      "HKDF",
      false,
      ["deriveBits"]
    );

    const derivedBits = await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: salt,
        info: info,
      },
      baseKey,
      44 * 8
    );

    const derived = new Uint8Array(derivedBits);
    const chachaKey = derived.slice(0, 32);
    const chachaNonce = derived.slice(32, 44);

    // Decrypt with AES-GCM
    const aesKey = await crypto.subtle.importKey(
      "raw",
      chachaKey as BufferSource,
      "AES-GCM",
      false,
      ["decrypt"]
    );

    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: chachaNonce as BufferSource,
      },
      aesKey,
      ciphertextBytes
    );

    return decoder.decode(plaintext);
  } catch (error) {
    console.error("aesGcmDecrypt error:", error);
    throw error;
  }
}

/**
 * Encrypt a file with a newly generated key (self-encryption)
 * Returns both the ciphertext and the private key (hex) needed for decryption
 */
export async function encryptFileWithKey(fileBytes: Uint8Array): Promise<{ ciphertext: string; privateKeyHex: string }> {
  // Generate a new random keypair for this file
  const secretKey = generateSecretKey();
  const pubkey = getPublicKey(secretKey);

  // Create conversation key (encrypt to self)
  const conversationKey = nip44.v2.utils.getConversationKey(secretKey, pubkey);

  // Convert file bytes to base64
  const plaintextBase64 = uint8ArrayToBase64(fileBytes);

  // Encrypt using our large payload implementation
  const ciphertext = await aesGcmEncrypt(plaintextBase64, conversationKey);

  // Return ciphertext and the private key (needed for decryption)
  return {
    ciphertext,
    privateKeyHex: bytesToHex(secretKey)
  };
}

/**
 * Decrypt a file using the stored private key
 */
export async function decryptFileWithKey(ciphertext: string, privateKeyHex: string): Promise<Uint8Array> {
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
 * Encrypt a file (Uint8Array) using NIP-44 with window.nostr
 * DEPRECATED: Use encryptFileWithKey instead
 */
export async function encryptFile(fileBytes: Uint8Array): Promise<string> {
  if (!window.nostr) throw new Error("Nostr signer not found");
  const pubkey = await window.nostr.getPublicKey();
  const plaintextBase64 = uint8ArrayToBase64(fileBytes);
  return window.nostr.nip44.encrypt(pubkey, plaintextBase64);
}

/**
 * Decrypt NIP-44 ciphertext using window.nostr
 * DEPRECATED: Use decryptFileWithKey instead
 */
export async function decryptFile(ciphertext: string): Promise<Uint8Array> {
  if (!window.nostr) throw new Error("Nostr signer not found");
  const pubkey = await window.nostr.getPublicKey();

  // Alby uses positional args: decrypt(peer, ciphertext)
  const plaintextBase64 = await (window.nostr.nip44.decrypt as any)(pubkey, ciphertext);

  if (!plaintextBase64) {
    throw new Error("Decryption returned empty result - did you cancel the prompt?");
  }

  return base64ToUint8Array(plaintextBase64);
}
