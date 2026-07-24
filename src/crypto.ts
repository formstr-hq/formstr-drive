import {
  base64ToUint8Array,
  uint8ArrayToBase64,
} from "@formstr/drive-sdk";
import { signerManager } from "./signer/manager";

/**
 * Reusable file crypto lives in @formstr/drive-sdk. These exports preserve the
 * application's existing import paths without changing runtime behavior.
 */
export {
  aesGcmDecrypt,
  aesGcmDecryptBytes,
  aesGcmEncrypt,
  aesGcmEncryptBytes,
  base64ToUint8Array,
  decryptFileWithKey,
  decryptNipFsChunk,
  deriveConversationKeyFromHex,
  encryptFileWithExistingKey,
  encryptFileWithKey,
  uint8ArrayToBase64,
} from "@formstr/drive-sdk";

/**
 * Encrypt bytes through the active identity signer.
 * @deprecated Use per-file SDK encryption instead.
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
 * Decrypt bytes through the active identity signer.
 * @deprecated Use per-file SDK decryption instead.
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
