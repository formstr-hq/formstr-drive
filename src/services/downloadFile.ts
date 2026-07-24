import { BlossomClient } from "../blossom";
import type { FileMetadata } from "../types/metadata";
import { decryptFileWithKey } from "../crypto";
import { decryptFileChunk, fileChunkRefs } from "./fileCrypto";
import { downloadViaServiceWorker, hasServiceWorkerSupport } from "./swStreamDownload";

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
  const clients = new Map<string, BlossomClient>();
  const clientFor = (server: string) => {
    let client = clients.get(server);
    if (!client) {
      client = new BlossomClient(server);
      clients.set(server, client);
    }
    return client;
  };

  const chunks = fileChunkRefs(file);
  if (chunks.length > 0) {
    const result = new Uint8Array(file.size);
    let offset = 0;

    for (let i = 0; i < chunks.length; i++) {
      throwIfAborted(signal);
      const chunk = chunks[i];
      const encBytes = await clientFor(chunk.server ?? file.server).download(
        chunk.hash,
        undefined,
        undefined,
        signal,
      );
      const decBytes = await decryptFileChunk(file, encBytes, i);

      result.set(decBytes, offset);
      offset += decBytes.length;
    }

    // Trim trailing padding if last chunk wasn't full
    return result.subarray(0, offset);
  }

  // Legacy single-blob fallback
  const blob = await clientFor(file.server).download(file.hash, undefined, undefined, signal);
  const ciphertext = new TextDecoder().decode(blob);
  return decryptFileWithKey(ciphertext, file.encryptionKey);
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
  const clients = new Map<string, BlossomClient>();
  const clientFor = (server: string) => {
    let client = clients.get(server);
    if (!client) {
      client = new BlossomClient(server);
      clients.set(server, client);
    }
    return client;
  };
  let completed = false;
  let bytesWritten = 0;

  try {
    const chunks = fileChunkRefs(file);
    if (chunks.length > 0) {
      const totalChunks = chunks.length;

      const fetchDecrypt = async (index: number): Promise<Uint8Array> => {
        const chunk = chunks[index];
        const encBytes = await clientFor(chunk.server ?? file.server).download(
          chunk.hash,
          undefined,
          undefined,
          signal,
        );
        return decryptFileChunk(file, encBytes, index);
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
      onProgress?.({ stage: "Downloading...", progress: 0 });
      const encBytes = await clientFor(file.server).download(file.hash, undefined, (loaded, total) => {
        if (total > 0) {
          onProgress?.({ stage: "Downloading...", progress: Math.round((loaded / total) * 100) });
        }
      }, signal);
      throwIfAborted(signal);
      const ciphertext = new TextDecoder().decode(encBytes);
      const decrypted = await decryptFileWithKey(ciphertext, file.encryptionKey);

      let buffer = decrypted;
      if (bytesWritten + buffer.byteLength > file.size) {
        buffer = new Uint8Array(buffer.buffer, buffer.byteOffset, file.size - bytesWritten);
      }

      onProgress?.({ stage: "Saving file...", progress: 100 });
      await writer.write(buffer);
      bytesWritten += buffer.byteLength;
    }

    if (bytesWritten !== file.size) {
      throw new Error(`size-mismatch: expected ${file.size} bytes, got ${bytesWritten} bytes`);
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
