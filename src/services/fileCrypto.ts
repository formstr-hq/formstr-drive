import type { ChunkRef, FileMetadata } from "../types/metadata";
import {
  aesGcmDecryptBytes,
  decryptNipFsChunk,
  deriveConversationKeyFromHex,
} from "../crypto";

export function fileChunkRefs(file: FileMetadata): ChunkRef[] {
  const chunks = file.chunks as ReadonlyArray<ChunkRef | string> | undefined;
  if (!chunks) return [];
  return chunks.map((chunk) => (typeof chunk === "string" ? { hash: chunk } : chunk));
}

export async function decryptFileChunk(
  file: FileMetadata,
  encrypted: Uint8Array,
  index: number,
): Promise<Uint8Array> {
  if (file.protocol === "nip-fs") {
    return decryptNipFsChunk(encrypted, file.encryptionKey);
  }
  return aesGcmDecryptBytes(
    encrypted,
    deriveConversationKeyFromHex(file.encryptionKey),
    index,
  );
}
