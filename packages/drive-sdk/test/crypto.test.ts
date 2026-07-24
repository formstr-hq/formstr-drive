import { describe, expect, it } from "vitest";
import {
  aesGcmDecrypt,
  aesGcmDecryptBytes,
  aesGcmEncrypt,
  aesGcmEncryptBytes,
  base64ToUint8Array,
  decryptFileWithKey,
  deriveConversationKeyFromHex,
  encryptFileWithKey,
  uint8ArrayToBase64,
} from "../src";

const PRIVATE_KEY = "01".padStart(64, "0");

function chunkIndexBytes(chunkIndex: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, chunkIndex, false);
  return bytes;
}

async function makeLegacyV2Chunk(
  plaintext: Uint8Array,
  conversationKey: Uint8Array,
  chunkIndex: number,
): Promise<Uint8Array> {
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const baseKey = await crypto.subtle.importKey(
    "raw",
    conversationKey as BufferSource,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info: new TextEncoder().encode("nip44-v2"),
    },
    baseKey,
    44 * 8,
  );
  const derived = new Uint8Array(bits);
  const key = await crypto.subtle.importKey(
    "raw",
    derived.slice(0, 32),
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: derived.slice(32, 44),
        additionalData: chunkIndexBytes(chunkIndex) as BufferSource,
      },
      key,
      plaintext as BufferSource,
    ),
  );
  const payload = new Uint8Array(1 + salt.length + ciphertext.length);
  payload[0] = 2;
  payload.set(salt, 1);
  payload.set(ciphertext, 33);
  return payload;
}

describe("existing Formstr Drive crypto", () => {
  it("round-trips byte arrays through Base64", () => {
    const bytes = Uint8Array.from([0, 1, 2, 127, 128, 254, 255]);
    expect(base64ToUint8Array(uint8ArrayToBase64(bytes))).toEqual(bytes);
  });

  it("preserves the existing v2 string envelope", async () => {
    const key = deriveConversationKeyFromHex(PRIVATE_KEY);
    const encrypted = await aesGcmEncrypt("formstr-drive", key);
    expect(base64ToUint8Array(encrypted)[0]).toBe(2);
    await expect(aesGcmDecrypt(encrypted, key)).resolves.toBe("formstr-drive");
  });

  it("preserves deterministic v3 chunk encryption", async () => {
    const key = deriveConversationKeyFromHex(PRIVATE_KEY);
    const plaintext = new TextEncoder().encode("existing chunk payload");
    const first = await aesGcmEncryptBytes(plaintext, key, 4);
    const second = await aesGcmEncryptBytes(plaintext, key, 4);

    expect(first[0]).toBe(3);
    expect(second).toEqual(first);
    await expect(aesGcmDecryptBytes(first, key, 4)).resolves.toEqual(plaintext);
    await expect(aesGcmDecryptBytes(first, key, 5)).rejects.toBeDefined();
  });

  it("continues to decrypt legacy v2 binary chunks", async () => {
    const key = deriveConversationKeyFromHex(PRIVATE_KEY);
    const plaintext = new TextEncoder().encode("legacy v2 chunk");
    const payload = await makeLegacyV2Chunk(plaintext, key, 2);
    await expect(aesGcmDecryptBytes(payload, key, 2)).resolves.toEqual(plaintext);
  });

  it("round-trips the existing per-file encryption API", async () => {
    const bytes = crypto.getRandomValues(new Uint8Array(4096));
    const encrypted = await encryptFileWithKey(bytes);
    await expect(
      decryptFileWithKey(encrypted.ciphertext, encrypted.privateKeyHex),
    ).resolves.toEqual(bytes);
  });
});
