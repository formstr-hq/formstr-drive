import { BlossomClient } from "../blossom";
import type { FileMetadata } from "../types/metadata";
import { aesGcmDecryptBytes, decryptFileWithKey, deriveConversationKeyFromHex } from "../crypto";

export async function downloadAndDecryptFile(file: FileMetadata): Promise<Uint8Array> {
  const client = new BlossomClient(file.server);

  if (file.chunks && file.chunks.length > 0) {
    const convKey = deriveConversationKeyFromHex(file.encryptionKey);
    const result = new Uint8Array(file.size);
    let offset = 0;

    for (let i = 0; i < file.chunks.length; i++) {
      const hash = file.chunks[i];
      const encBytes = await client.download(hash);
      const decBytes = await aesGcmDecryptBytes(encBytes, convKey, i);
      
      result.set(decBytes, offset);
      offset += decBytes.length;
    }
    
    // Trim trailing padding if last chunk wasn't full
    return result.subarray(0, offset);
  }

  // Legacy single-blob fallback
  const blob = await client.download(file.hash);
  const ciphertext = new TextDecoder().decode(blob);
  return decryptFileWithKey(ciphertext, file.encryptionKey);
}
