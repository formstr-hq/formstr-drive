import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "nostr-tools/utils";
import { BlossomClient } from "../blossom";
import { resolveChunks, isLegacyBlobFormat, type FileMetadata } from "../types/metadata";
import { aesGcmDecryptBytes, decryptSegment, deriveConversationKeyFromHex, segmentCount } from "../crypto";
import { downloadViaServiceWorker, hasServiceWorkerSupport } from "./swStreamDownload";

/** Verifies NIP-FS's optional unencryptedFileHash, if the metadata carries one. */
function verifyUnencryptedFileHash(file: FileMetadata, plaintext: Uint8Array): void {
  if (!file.unencryptedFileHash) return;
  const actualHash = bytesToHex(sha256(plaintext));
  if (actualHash !== file.unencryptedFileHash) {
    throw new Error(
      `File integrity check failed: expected hash ${file.unencryptedFileHash}, got ${actualHash}`,
    );
  }
}

/** One BlossomClient per distinct server URL a file's chunks actually use —
 *  most files only ever touch one server, but a chunk that fell back to a
 *  different server during upload must be fetched from that server, not
 *  file.server (see types/metadata.ts's resolveChunks). */
function clientCache(): (server: string) => BlossomClient {
  const cache = new Map<string, BlossomClient>();
  return (server: string) => {
    let client = cache.get(server);
    if (!client) {
      client = new BlossomClient(server);
      cache.set(server, client);
    }
    return client;
  };
}

/**
 * Wraps a raw ReadableStream reader with an exact-byte-count `readExactly`,
 * buffering across whatever arbitrary-sized chunks the network actually
 * delivers so callers can pull NIP-FS segment frames (`chunkSize + 16` bytes,
 * except the last) regardless of how the underlying TCP/HTTP chunking landed.
 */
function createFrameReader(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let buffered = new Uint8Array(0);
  let streamDone = false;

  async function fill(n: number): Promise<void> {
    while (buffered.length < n && !streamDone) {
      const { value, done } = await reader.read();
      if (done) {
        streamDone = true;
        break;
      }
      if (value.length === 0) continue;
      const next = new Uint8Array(buffered.length + value.length);
      next.set(buffered, 0);
      next.set(value, buffered.length);
      buffered = next;
    }
  }

  return {
    /** Reads exactly `n` bytes, or throws if the stream ends before `n`
     *  bytes are available — a short read here means a truncated or
     *  corrupted blob, which must never be handed to a caller as if it were
     *  the whole thing. */
    async readExactly(n: number): Promise<Uint8Array> {
      await fill(n);
      if (buffered.length < n) {
        throw new Error(
          `Downloaded blob ended early: expected ${n} more byte(s), got ${buffered.length}. ` +
            `The file may be corrupted, or the download was interrupted.`,
        );
      }
      const out = buffered.subarray(0, n);
      buffered = buffered.subarray(n);
      return out;
    },
  };
}

/**
 * NIP-FS single-blob download: streams `chunkSize + 16`-byte frames off the
 * raw blob response and decrypts each with {@link decryptSegment}
 * (crypto.ts), yielding plaintext segments in order. Peak memory stays
 * around one segment — the frame reader only ever buffers what's needed to
 * complete the CURRENT frame, never the whole blob. Shared by every download
 * path (this file and swStreamDownload.ts) so the framing logic exists in
 * exactly one place.
 */
export async function* streamDecryptedSegments(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  file: FileMetadata & { blobHash: string; chunkSize: number },
  blobKey: Uint8Array,
): AsyncGenerator<Uint8Array> {
  const { chunkSize } = file;
  const total = segmentCount(file.size, chunkSize);
  const frameReader = createFrameReader(reader);

  for (let i = 0; i < total; i++) {
    const isLast = i === total - 1;
    const plainLen = isLast ? file.size - chunkSize * (total - 1) : chunkSize;
    const frame = await frameReader.readExactly(plainLen + 16);
    yield await decryptSegment(frame, blobKey, i, isLast);
  }
}

// Browsers without the File System Access API (Firefox, Safari) have no way to
// stream bytes to disk, so large files would have to be buffered fully in memory.
// Above this guard we refuse rather than risk an OOM/freeze.
const UNSAFE_INMEMORY_SIZE = 500 * 1024 * 1024;

// Bounded prefetch: at most this many chunks are downloaded/decrypted ahead of
// the writer, so peak memory stays at a small multiple of one chunk (~50MB),
// never the full file size.
const PREFETCH_CONCURRENCY = 2;

export interface DownloadProgressInfo {
  stage: string;
  progress?: number;
  currentChunk?: number;
  totalChunks?: number;
}

interface FileSystemWritableFileStream {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

interface FileSystemFileHandleLike {
  createWritable(): Promise<FileSystemWritableFileStream>;
  remove?(): Promise<void>;
}

function hasFileSystemAccess(): boolean {
  return typeof (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker === "function";
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Download aborted", "AbortError");
  }
}

export async function downloadAndDecryptFile(file: FileMetadata, signal?: AbortSignal): Promise<Uint8Array> {
  const getClient = clientCache();

  if (!isLegacyBlobFormat(file)) {
    const { blobHash, chunkSize } = file;
    if (!blobHash || !chunkSize) {
      throw new Error("File is missing blobHash/chunkSize — cannot download");
    }
    const blobKey = deriveConversationKeyFromHex(file.encryptionKey);
    const total = segmentCount(file.size, chunkSize);
    // Already fully buffering below, so no need for the streaming frame
    // reader here — the whole blob is fetched in one shot, then sliced into
    // segment frames from the in-memory buffer.
    const encBlob = await getClient(file.server).download(blobHash, undefined, undefined, signal);

    const result = new Uint8Array(file.size);
    let readOffset = 0;
    let writeOffset = 0;
    for (let i = 0; i < total; i++) {
      throwIfAborted(signal);
      const isLast = i === total - 1;
      const plainLen = isLast ? file.size - chunkSize * (total - 1) : chunkSize;
      const frame = encBlob.subarray(readOffset, readOffset + plainLen + 16);
      readOffset += plainLen + 16;
      const decSegment = await decryptSegment(frame, blobKey, i, isLast);
      result.set(decSegment, writeOffset);
      writeOffset += decSegment.length;
    }

    verifyUnencryptedFileHash(file, result);
    return result;
  }

  const chunks = resolveChunks(file.chunks, file.server);
  if (chunks.length > 0) {
    const convKey = deriveConversationKeyFromHex(file.encryptionKey);
    const result = new Uint8Array(file.size);
    let offset = 0;

    for (let i = 0; i < chunks.length; i++) {
      throwIfAborted(signal);
      const { hash, server } = chunks[i];
      const encBytes = await getClient(server).download(hash, undefined, undefined, signal);
      const decBytes = await aesGcmDecryptBytes(encBytes, convKey);

      result.set(decBytes, offset);
      offset += decBytes.length;
    }

    // Trim trailing padding if last chunk wasn't full
    const trimmed = result.subarray(0, offset);
    verifyUnencryptedFileHash(file, trimmed);
    return trimmed;
  }

  throw new Error("File has no chunks — cannot download");
}

/**
 * Streams the file to disk chunk-by-chunk so peak memory stays around one
 * chunk, never the full file size. Prefers the File System Access API
 * (Chromium); falls back to the self-hosted service worker streaming path
 * (src/services/swStreamDownload.ts) for Firefox/Safari/other browsers, and
 * only falls back further to an in-memory Blob download — under a safe size
 * guard — if the service worker itself is unavailable (e.g. insecure context).
 */
export async function downloadFileStreaming(
  file: FileMetadata,
  onProgress?: (info: DownloadProgressInfo) => void,
  signal?: AbortSignal,
): Promise<{ uri: string | null }> {
  // Primary Strategy: Service Worker (All browsers, background queue compatible)
  if (hasServiceWorkerSupport()) {
    try {
      return await downloadViaServiceWorker(file, onProgress, signal);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        throw e;
      }
      console.warn("Service worker download failed, falling back to File System Access if available:", e);
    }
  }

  // Fallback 1: File System Access API (Chromium only)
  if (hasFileSystemAccess()) {
    return downloadViaFileSystemAccess(file, onProgress, signal);
  }

  // Fallback 2: In-memory blob (Fails on large files)
  if (file.size > UNSAFE_INMEMORY_SIZE) {
    throw new Error(
      "This file is too large to download in this browser. Please enable Service Workers or use a Chromium-based browser.",
    );
  }

  onProgress?.({ stage: "Downloading...", progress: 0 });
  const decrypted = await downloadAndDecryptFile(file, signal);
  throwIfAborted(signal);
  onProgress?.({ stage: "Saving file...", progress: 100 });

  const url = URL.createObjectURL(
    new Blob([decrypted as BlobPart], { type: file.type || "application/octet-stream" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  a.click();
  URL.revokeObjectURL(url);

  return { uri: null };
}

async function downloadViaFileSystemAccess(
  file: FileMetadata,
  onProgress?: (info: DownloadProgressInfo) => void,
  signal?: AbortSignal,
): Promise<{ uri: null }> {
  const showSaveFilePicker = (
    window as unknown as {
      showSaveFilePicker: (options: { suggestedName: string }) => Promise<FileSystemFileHandleLike>;
    }
  ).showSaveFilePicker;

  const handle = await showSaveFilePicker({ suggestedName: file.name });
  const writer = await handle.createWritable();
  const getClient = clientCache();
  let completed = false;
  let bytesWritten = 0;

  const plaintextHasher = file.unencryptedFileHash ? sha256.create() : null;

  try {
    if (!isLegacyBlobFormat(file)) {
      const { blobHash, chunkSize } = file;
      if (!blobHash || !chunkSize) {
        throw new Error("File is missing blobHash/chunkSize — cannot download");
      }
      const blobKey = deriveConversationKeyFromHex(file.encryptionKey);
      const total = segmentCount(file.size, chunkSize);
      const { reader } = await getClient(file.server).downloadStream(blobHash, undefined, signal);

      let i = 0;
      // One HTTP request, read sequentially — unlike the legacy per-chunk
      // path below, there's nothing to prefetch in parallel: the segments
      // arrive in order off a single stream.
      for await (const decBytes of streamDecryptedSegments(reader, { ...file, blobHash, chunkSize }, blobKey)) {
        throwIfAborted(signal);
        plaintextHasher?.update(decBytes);
        await writer.write(decBytes);
        bytesWritten += decBytes.byteLength;
        i++;

        onProgress?.({
          stage: "Downloading...",
          progress: Math.round((i / total) * 100),
          currentChunk: i,
          totalChunks: total,
        });
      }
    } else {
      const chunks = resolveChunks(file.chunks, file.server);
      if (chunks.length > 0) {
        const convKey = deriveConversationKeyFromHex(file.encryptionKey);
        const totalChunks = chunks.length;

        const fetchDecrypt = async (index: number): Promise<Uint8Array> => {
          const { hash, server } = chunks[index];
          const encBytes = await getClient(server).download(hash, undefined, undefined, signal);
          return aesGcmDecryptBytes(encBytes, convKey);
        };

        let nextToFetch = 0;
        const pending = new Map<number, Promise<Uint8Array>>();
        const fillPending = () => {
          while (pending.size < PREFETCH_CONCURRENCY && nextToFetch < totalChunks) {
            pending.set(nextToFetch, fetchDecrypt(nextToFetch));
            nextToFetch += 1;
          }
        };
        fillPending();

        for (let i = 0; i < totalChunks; i++) {
          throwIfAborted(signal);
          const decBytes = await pending.get(i)!;
          pending.delete(i);

          let buffer = decBytes;
          if (bytesWritten + buffer.byteLength > file.size) {
            buffer = new Uint8Array(buffer.buffer, buffer.byteOffset, file.size - bytesWritten);
          }
          plaintextHasher?.update(buffer);
          await writer.write(buffer);
          bytesWritten += buffer.byteLength;
          fillPending();

          onProgress?.({
            stage: "Downloading...",
            progress: Math.round(((i + 1) / totalChunks) * 100),
            currentChunk: i + 1,
            totalChunks,
          });
        }
      } else {
        throw new Error("File has no chunks — cannot download");
      }
    }

    if (bytesWritten !== file.size) {
      throw new Error(`size-mismatch: expected ${file.size} bytes, got ${bytesWritten} bytes`);
    }

    if (plaintextHasher && file.unencryptedFileHash) {
      const actualHash = bytesToHex(plaintextHasher.digest());
      if (actualHash !== file.unencryptedFileHash) {
        throw new Error(
          `File integrity check failed: expected hash ${file.unencryptedFileHash}, got ${actualHash}`,
        );
      }
    }

    completed = true;
  } finally {
    if (completed) {
      await writer.close();
    } else {
      try {
        await writer.abort();
      } catch (e) {
        console.warn("Failed to abort writer:", e);
      }
      try {
        await handle.remove?.();
      } catch (e) {
        console.warn("Failed to remove file:", e);
      }
    }
  }

  return { uri: null };
}
