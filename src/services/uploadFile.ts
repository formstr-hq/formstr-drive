import { BlossomClient } from "../blossom";
import { aesGcmEncryptBytes, deriveConversationKeyFromHex } from "../crypto";
import { createAuthEvent } from "../auth";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export const CHUNK_SIZE = 50 * 1024 * 1024; // 50MB chunks

export interface UploadResult {
  hashes: string[];
  size: number;
}

export interface UploadProgressInfo {
  stage: string;
  progress?: number;
  currentChunk?: number;
  totalChunks?: number;
}

export async function uploadFile(
  file: File,
  serverUrl: string,
  encryptionKeyHex: string,
  onProgress?: (info: UploadProgressInfo) => void
): Promise<UploadResult> {
  const client = new BlossomClient(serverUrl);
  const convKey = deriveConversationKeyFromHex(encryptionKeyHex);
  const totalSize = file.size;

  if (totalSize <= CHUNK_SIZE) {
    // Single chunk — no chunking needed
    onProgress?.({ stage: "Encrypting file...", progress: 0, currentChunk: 1, totalChunks: 1 });
    const bytes = new Uint8Array(await file.arrayBuffer());
    const encBytes = await aesGcmEncryptBytes(bytes, convKey, 0);
    onProgress?.({ stage: "Waiting for signature approval...", progress: 50, currentChunk: 1, totalChunks: 1 });
    const auth = await createAuthEvent("upload", `Upload ${file.name}`, encBytes);
    const hash = await client.upload(encBytes, auth);
    onProgress?.({ stage: "Upload complete", progress: 100, currentChunk: 1, totalChunks: 1 });
    return { hashes: [hash], size: totalSize };
  }

  const numChunks = Math.ceil(totalSize / CHUNK_SIZE);
  const hashes: string[] = [];

  // Pass 1: Encrypt each chunk, compute hash, discard ciphertext (~100MB peak RAM)
  for (let i = 0; i < numChunks; i++) {
    onProgress?.({
      stage: `Computing hash for chunk ${i + 1} of ${numChunks}...`,
      progress: Math.round((i / numChunks) * 45), // first pass is 45%
      currentChunk: i + 1,
      totalChunks: numChunks
    });
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, totalSize);
    const chunkBlob = file.slice(start, end);
    const bytes = new Uint8Array(await chunkBlob.arrayBuffer());
    const encBytes = await aesGcmEncryptBytes(bytes, convKey, i);

    const hashBuffer = await crypto.subtle.digest("SHA-256", encBytes as unknown as BufferSource);
    const hexHash = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    hashes.push(hexHash);
    // encBytes is discarded here — GC reclaims memory
  }

  // Sign once with all chunk hashes (BUD-11 multi-x-tag)
  // 30 min expiration — covers slow connections and large files
  onProgress?.({
    stage: "Waiting for signature approval...",
    progress: 45,
    currentChunk: numChunks,
    totalChunks: numChunks
  });
  const authHeader = await createAuthEvent("upload", `Upload ${file.name}`, hashes, 1800);

  // Pass 2: Re-encrypt (deterministic = identical ciphertext) and upload
  for (let i = 0; i < numChunks; i++) {
    const startProgress = 50 + (i / numChunks) * 50;
    const chunkWeight = 50 / numChunks;

    onProgress?.({
      stage: `Uploading chunk ${i + 1} of ${numChunks}...`,
      progress: Math.round(startProgress),
      currentChunk: i + 1,
      totalChunks: numChunks
    });
    
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, totalSize);
    const chunkBlob = file.slice(start, end);
    const bytes = new Uint8Array(await chunkBlob.arrayBuffer());
    const encBytes = await aesGcmEncryptBytes(bytes, convKey, i);

    let retries = 3;
    let success = false;
    let lastErr;
    
    while (!success && retries > 0) {
      try {
        await client.upload(encBytes, authHeader, (percent) => {
          onProgress?.({
            stage: `Uploading chunk ${i + 1} of ${numChunks}... (${percent}%)`,
            progress: Math.round(startProgress + (percent / 100) * chunkWeight),
            currentChunk: i + 1,
            totalChunks: numChunks
          });
        });
        success = true;
      } catch (err) {
        lastErr = err;
        retries--;
        if (retries > 0) {
          onProgress?.({
            stage: `Chunk ${i + 1} failed. Retrying...`,
            progress: Math.round(startProgress),
            currentChunk: i + 1,
            totalChunks: numChunks
          });
          await sleep(3000); // Wait 3 seconds before retry
        }
      }
    }
    
    if (!success) {
      throw lastErr;
    }
    
    // Add small delay between successful chunks to avoid rapid-fire rate limiting
    if (i < numChunks - 1) {
      await sleep(1000);
    }
  }

  return { hashes, size: totalSize };
}
