import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "nostr-tools/utils";
import { BlossomClient } from "../blossom";
import { aesGcmEncryptBytes, deriveConversationKeyFromHex, encryptFileWithExistingKey } from "../crypto";
import { createAuthEvent } from "../auth";
import { describeAllServersFailed, isPermanentFailure } from "./uploadErrors";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export const CHUNK_SIZE = 50 * 1024 * 1024; // 50MB chunks

export interface UploadResult {
  hashes: string[];
  size: number;
  /** SHA-256 hex of the original (plaintext) file bytes, computed incrementally
   *  during upload for NIP-FS `unencryptedFileHash`. */
  unencryptedFileHash: string;
  previewHash?: string;
  /** Parallel to `hashes`. `undefined` at an index means that chunk landed on
   *  the primary server (servers[0]) — the common case. Set to a server URL
   *  only when that chunk had to fall back to a different candidate. */
  chunkServers?: (string | undefined)[];
}

export interface UploadProgressInfo {
  stage: string;
  progress?: number;
  currentChunk?: number;
  totalChunks?: number;
}

interface OpfsTempDir {
  dir: FileSystemDirectoryHandle;
  name: string;
}

async function tryCreateOpfsTempDir(): Promise<OpfsTempDir | null> {
  const storage = navigator.storage as StorageManager & {
    getDirectory?: () => Promise<FileSystemDirectoryHandle>;
  };
  if (!storage || typeof storage.getDirectory !== "function") {
    return null;
  }

  try {
    const root = await storage.getDirectory();
    const name = `formstr-upload-${crypto.randomUUID()}`;
    const dir = await root.getDirectoryHandle(name, { create: true });
    return { dir, name };
  } catch {
    return null;
  }
}

async function removeOpfsTempDir(name: string): Promise<void> {
  try {
    const storage = navigator.storage as StorageManager & {
      getDirectory?: () => Promise<FileSystemDirectoryHandle>;
    };
    const root = await storage.getDirectory!();
    await (root as unknown as { removeEntry(name: string, options?: { recursive?: boolean }): Promise<void> })
      .removeEntry(name, { recursive: true });
  } catch {
    // best-effort cleanup — a leftover OPFS temp dir doesn't break anything
  }
}

function toHexHash(digest: ArrayBuffer): string {
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Upload aborted", "AbortError");
  }
}

export interface PreparedUpload {
  chunkHashes: string[];
  totalSize: number;
  /** SHA-256 hex of the original (plaintext) file bytes — same field
   *  {@link uploadFile} produces, so a prepared (background) upload records
   *  the same NIP-FS integrity hash a foreground one does. */
  unencryptedFileHash: string;
  previewHash?: string;
  // In-memory ciphertext (only populated when no onBlob sink is supplied).
  chunkBlobs?: Uint8Array[];
  previewBlob?: Uint8Array;
  // Sink return values (paths) when an onBlob callback stages each blob.
  chunkRefs?: string[];
  previewRef?: string;
}

/**
 * Runs pass 1 (encrypt + hash every chunk, plus the optional preview) without
 * uploading anything. The chunk hashes are exactly what today's uploadFile()
 * pass 1 produces, so callers can sign an auth/metadata event against them
 * before any network I/O happens.
 *
 * If `onBlob` is supplied, each encrypted blob is handed off (e.g. staged to
 * native storage) and then dropped, so peak memory stays around one chunk
 * instead of the whole file. Its return value is collected into chunkRefs /
 * previewRef. Without `onBlob`, blobs are retained in chunkBlobs/previewBlob.
 *
 * `preview` may be a promise: it is awaited only after the chunk loop, so
 * preview generation overlaps chunk encryption exactly as it does in
 * {@link uploadFile}.
 */
export async function prepareUpload(
  file: File,
  encryptionKeyHex: string,
  signal?: AbortSignal,
  onProgress?: (info: UploadProgressInfo) => void,
  preview?: Uint8Array | null | Promise<Uint8Array | null>,
  onBlob?: (index: number, bytes: Uint8Array) => Promise<string>,
): Promise<PreparedUpload> {
  const convKey = deriveConversationKeyFromHex(encryptionKeyHex);
  const totalSize = file.size;
  const numChunks = Math.max(1, Math.ceil(totalSize / CHUNK_SIZE));
  const chunkHashes: string[] = [];
  const chunkBlobs: Uint8Array[] = [];
  const chunkRefs: string[] = [];
  // Streaming plaintext digest, updated per chunk before encryption — same
  // approach (and same resulting hash) as uploadFile's plaintextHasher.
  const plaintextHasher = sha256.create();

  for (let i = 0; i < numChunks; i++) {
    throwIfAborted(signal);
    onProgress?.({
      stage: "Encrypting...",
      progress: Math.round((i / numChunks) * 20),
      currentChunk: i + 1,
      totalChunks: numChunks,
    });

    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, totalSize);
    const bytes = new Uint8Array(await file.slice(start, end).arrayBuffer());
    plaintextHasher.update(bytes);
    const encBytes = await aesGcmEncryptBytes(bytes, convKey);

    const hashBuffer = await crypto.subtle.digest("SHA-256", encBytes as unknown as BufferSource);
    chunkHashes.push(toHexHash(hashBuffer));

    if (onBlob) {
      chunkRefs.push(await onBlob(i, encBytes));
      // encBytes goes out of scope here — memory bounded to ~one chunk.
    } else {
      chunkBlobs.push(encBytes);
    }
  }

  const result: PreparedUpload = {
    chunkHashes,
    totalSize,
    unencryptedFileHash: bytesToHex(plaintextHasher.digest()),
  };
  if (onBlob) {
    result.chunkRefs = chunkRefs;
  } else {
    result.chunkBlobs = chunkBlobs;
  }

  const previewBytesIn = await preview;
  if (previewBytesIn) {
    throwIfAborted(signal);
    const encryptedPreview = await encryptFileWithExistingKey(previewBytesIn, encryptionKeyHex);
    const previewBytes = new TextEncoder().encode(encryptedPreview);
    const hashBuffer = await crypto.subtle.digest("SHA-256", previewBytes as unknown as BufferSource);
    result.previewHash = toHexHash(hashBuffer);
    if (onBlob) {
      result.previewRef = await onBlob(numChunks, previewBytes);
    } else {
      result.previewBlob = previewBytes;
    }
  }

  return result;
}

/**
 * Uploads one chunk, retrying up to 3x against a candidate server before
 * falling through to the next one in `servers` (primary first). The BUD-02
 * auth header is server-agnostic, so it's replayed unchanged across
 * candidates — falling back costs no extra signer prompt. No extra backoff is
 * added between *different* servers; only same-server retries wait.
 *
 * `deadServers` is shared across every chunk (and the whole file) in one
 * uploadFile() call: once a server has exhausted its retries here, it's
 * skipped instantly by every subsequent chunk instead of being rediscovered
 * as broken from scratch each time. This is what keeps a bad server's total
 * cost at O(1) per upload instead of O(chunks) — without it, a 3GB/62-chunk
 * file re-runs the full failure cascade 62 times over.
 *
 * A permanent rejection (415/401/403, see isPermanentFailure) skips its
 * remaining same-server retries immediately — there's no point retrying a
 * foregone conclusion 3 times before moving on.
 *
 * Returns the server that actually succeeded, or `undefined` when it was the
 * primary (servers[0]) — the common case, letting callers skip recording a
 * per-chunk override.
 */
async function uploadChunkWithRetry(
  servers: string[],
  encBytes: Uint8Array,
  authHeader: string,
  chunkIndex: number,
  numChunks: number,
  startProgress: number,
  chunkWeight: number,
  onProgress: ((info: UploadProgressInfo) => void) | undefined,
  signal: AbortSignal | undefined,
  deadServers: Set<string>,
): Promise<string | undefined> {
  const failures: { server: string; error: unknown }[] = [];

  for (let s = 0; s < servers.length; s++) {
    const server = servers[s];
    if (deadServers.has(server)) continue;

    const client = new BlossomClient(server);
    let retries = 3;

    while (retries > 0) {
      throwIfAborted(signal);
      try {
        await client.upload(
          encBytes,
          authHeader,
          (percent) => {
            onProgress?.({
              stage: "Uploading...",
              progress: Math.round(startProgress + (percent / 100) * chunkWeight),
              currentChunk: chunkIndex + 1,
              totalChunks: numChunks,
            });
          },
          signal,
          (stage) => {
            onProgress?.({
              stage: stage === "connecting" ? "Connecting..." : `Still trying to reach ${server}...`,
              progress: Math.round(startProgress),
              currentChunk: chunkIndex + 1,
              totalChunks: numChunks,
            });
          },
        );
        return s === 0 ? undefined : server;
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          throw err;
        }
        failures.push({ server, error: err });
        if (isPermanentFailure(err)) {
          retries = 0;
          break;
        }
        retries--;
        if (retries > 0) {
          onProgress?.({
            stage: "Retrying...",
            progress: Math.round(startProgress),
            currentChunk: chunkIndex + 1,
            totalChunks: numChunks,
          });
          await sleep(3000);
        }
      }
    }
    // This server is exhausted (transient retries used up) or permanently
    // rejected this upload — mark it dead so every later chunk skips it.
    deadServers.add(server);
  }

  throw describeAllServersFailed(failures.length > 0 ? failures : servers.map((server) => ({ server, error: undefined })));
}

/**
 * Same retry+fallback+sticky-dead-server behavior as uploadChunkWithRetry,
 * for the un-chunked single-blob case. Shares the exact same progress/stage
 * contract — "Uploading...", "Connecting...", "Still trying...", and
 * "Retrying..." — so a small (single-chunk) file gets the same live feedback
 * a large (multi-chunk) one does, instead of sitting frozen on whatever stage
 * preceded the call for the whole retry cascade.
 */
async function uploadBlobWithFallback(
  servers: string[],
  blob: Uint8Array,
  authHeader: string,
  signal: AbortSignal | undefined,
  deadServers: Set<string>,
  onProgress?: (info: UploadProgressInfo) => void,
  startProgress = 20,
  weight = 78,
): Promise<string | undefined> {
  const failures: { server: string; error: unknown }[] = [];

  for (let s = 0; s < servers.length; s++) {
    const server = servers[s];
    if (deadServers.has(server)) continue;

    const client = new BlossomClient(server);
    let retries = 3;

    while (retries > 0) {
      throwIfAborted(signal);
      try {
        await client.upload(
          blob,
          authHeader,
          (percent) => {
            onProgress?.({
              stage: "Uploading...",
              progress: Math.round(startProgress + (percent / 100) * weight),
            });
          },
          signal,
          (stage) => {
            onProgress?.({
              stage: stage === "connecting" ? "Connecting..." : `Still trying to reach ${server}...`,
              progress: Math.round(startProgress),
            });
          },
        );
        return s === 0 ? undefined : server;
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          throw err;
        }
        failures.push({ server, error: err });
        if (isPermanentFailure(err)) {
          retries = 0;
          break;
        }
        retries--;
        if (retries > 0) {
          onProgress?.({ stage: "Retrying...", progress: Math.round(startProgress) });
          await sleep(3000);
        }
      }
    }
    deadServers.add(server);
  }

  throw describeAllServersFailed(failures.length > 0 ? failures : servers.map((server) => ({ server, error: undefined })));
}

/**
 * Retries the preview blob against the PRIMARY server only (servers[0]) — no
 * cross-server fallback. FileMetadata has no per-preview server field
 * (unlike ChunkRef.server), so a preview that fell back to a different server
 * would upload successfully but become permanently undownloadable (every
 * reader assumes previewHash lives at file.server). Previews are best-effort
 * already, so retrying-then-skipping is the correct tradeoff here, not
 * expanding the metadata schema for a thumbnail.
 */
async function uploadPreviewWithRetry(
  primaryServer: string,
  blob: Uint8Array,
  authHeader: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const client = new BlossomClient(primaryServer);
  let retries = 3;
  let lastErr: unknown;

  while (retries > 0) {
    throwIfAborted(signal);
    try {
      await client.upload(blob, authHeader, undefined, signal);
      return true;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw err;
      }
      lastErr = err;
      if (isPermanentFailure(err)) break;
      retries--;
      if (retries > 0) await sleep(3000);
    }
  }

  console.warn("[Upload] Preview upload failed after retries; continuing without preview", lastErr);
  return false;
}

export async function uploadFile(
  file: File,
  servers: string[],
  encryptionKeyHex: string,
  onProgress?: (info: UploadProgressInfo) => void,
  signal?: AbortSignal,
  previewPromise?: Promise<Uint8Array | null>,
): Promise<UploadResult> {
  const convKey = deriveConversationKeyFromHex(encryptionKeyHex);
  const totalSize = file.size;
  // Streaming SHA-256 of the plaintext, updated as each chunk's bytes are read
  // (before encryption). WebCrypto has no incremental digest, so we use noble's
  // streaming hasher to avoid a second full-file read. Finalized once per return
  // path via `.digest()`.
  const plaintextHasher = sha256.create();
  // Shared across every chunk in this file: once a candidate server is
  // discovered dead (exhausted retries or permanently rejected), every later
  // chunk skips it instantly instead of rediscovering the same failure.
  const deadServers = new Set<string>();

  // The preview (if any) is folded into the SAME upload auth as the file chunks
  // so the user signs only once. It's awaited at signing time — not up front —
  // so preview generation still overlaps chunk encryption, and it stays
  // best-effort: a failed preview upload never fails the file.
  async function finalizePreviewAuth(chunkHashesForAuth: string[]): Promise<{
    authHeader: string;
    previewHash?: string;
    encryptedPreview?: Uint8Array;
  }> {
    const previewBytes = previewPromise ? await previewPromise : null;
    let previewHash: string | undefined;
    let encryptedPreview: Uint8Array | undefined;
    if (previewBytes) {
      const encrypted = await encryptFileWithExistingKey(previewBytes, encryptionKeyHex);
      encryptedPreview = new TextEncoder().encode(encrypted);
      const digest = await crypto.subtle.digest("SHA-256", encryptedPreview as unknown as BufferSource);
      previewHash = toHexHash(digest);
    }
    const authHashes = previewHash ? [...chunkHashesForAuth, previewHash] : chunkHashesForAuth;
    // Scale expiration with chunk count: this one auth event is reused for
    // every chunk's upload, and a large file legitimately takes longer to
    // upload than the fixed 30-minute default budgets for. 90s/chunk is a
    // generous per-chunk allowance (upload + retries + inter-chunk sleep)
    // with no extra signer prompt — same idea as the native background-upload
    // path's much longer BACKGROUND_UPLOAD_AUTH_EXPIRATION_SECONDS (auth.ts).
    const expirationSeconds = Math.max(1800, chunkHashesForAuth.length * 90);
    const authHeader = await createAuthEvent("upload", `Upload ${file.name}`, authHashes, expirationSeconds);
    return { authHeader, previewHash, encryptedPreview };
  }

  async function uploadPreviewIfPresent(
    encryptedPreview: Uint8Array | undefined,
    authHeader: string,
  ): Promise<boolean> {
    if (!encryptedPreview) return false;
    onProgress?.({ stage: "Uploading preview...", progress: 99 });
    // uploadPreviewWithRetry only ever throws AbortError; every other failure
    // is caught, logged, and reported as `false` (skip the preview).
    return uploadPreviewWithRetry(servers[0], encryptedPreview, authHeader, signal);
  }

  if (totalSize <= CHUNK_SIZE) {
    // Single chunk — no chunking needed
    throwIfAborted(signal);
    onProgress?.({ stage: "Encrypting file...", progress: 0, currentChunk: 1, totalChunks: 1 });
    const bytes = new Uint8Array(await file.arrayBuffer());
    plaintextHasher.update(bytes);
    const encBytes = await aesGcmEncryptBytes(bytes, convKey);
    const hash = toHexHash(await crypto.subtle.digest("SHA-256", encBytes as unknown as BufferSource));
    throwIfAborted(signal);
    onProgress?.({ stage: "Waiting for signature approval...", progress: 20, currentChunk: 1, totalChunks: 1 });
    const { authHeader, previewHash, encryptedPreview } = await finalizePreviewAuth([hash]);
    const usedServer = await uploadBlobWithFallback(servers, encBytes, authHeader, signal, deadServers, onProgress);
    const previewUploaded = await uploadPreviewIfPresent(encryptedPreview, authHeader);
    onProgress?.({ stage: "Upload complete", progress: 100, currentChunk: 1, totalChunks: 1 });
    return {
      hashes: [hash],
      size: totalSize,
      unencryptedFileHash: bytesToHex(plaintextHasher.digest()),
      previewHash: previewUploaded ? previewHash : undefined,
      chunkServers: usedServer ? [usedServer] : undefined,
    };
  }

  const numChunks = Math.ceil(totalSize / CHUNK_SIZE);
  const hashes: string[] = [];
  const chunkServers: (string | undefined)[] = [];
  const opfsTemp = await tryCreateOpfsTempDir();

  try {
    if (opfsTemp) {
      // Pass 1: encrypt each chunk once, persist ciphertext to OPFS (off the JS
      // heap), and hash from those bytes. The in-memory encBytes is discarded
      // immediately after the write.
      for (let i = 0; i < numChunks; i++) {
        throwIfAborted(signal);
        onProgress?.({
          stage: "Encrypting...",
          progress: Math.round((i / numChunks) * 20), // first pass is 20%
          currentChunk: i + 1,
          totalChunks: numChunks,
        });

        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, totalSize);
        const bytes = new Uint8Array(await file.slice(start, end).arrayBuffer());
        plaintextHasher.update(bytes);
        const encBytes = await aesGcmEncryptBytes(bytes, convKey);

        const hashBuffer = await crypto.subtle.digest("SHA-256", encBytes as unknown as BufferSource);
        hashes.push(toHexHash(hashBuffer));

        const chunkHandle = await opfsTemp.dir.getFileHandle(`chunk-${i}.bin`, { create: true });
        const writable = await chunkHandle.createWritable();
        await writable.write(encBytes as unknown as BufferSource);
        await writable.close();
      }

      onProgress?.({
        stage: "Waiting for signature approval...",
        progress: 20,
        currentChunk: numChunks,
        totalChunks: numChunks,
      });
      const { authHeader, previewHash, encryptedPreview } = await finalizePreviewAuth(hashes);

      // Pass 2: read the already-encrypted ciphertext back from OPFS and
      // upload it directly — no re-encryption needed.
      for (let i = 0; i < numChunks; i++) {
        throwIfAborted(signal);
        const startProgress = 20 + (i / numChunks) * 80;
        const chunkWeight = 80 / numChunks;

        onProgress?.({
          stage: "Uploading...",
          progress: Math.round(startProgress),
          currentChunk: i + 1,
          totalChunks: numChunks,
        });

        const chunkHandle = await opfsTemp.dir.getFileHandle(`chunk-${i}.bin`);
        const chunkFile = await chunkHandle.getFile();
        const encBytes = new Uint8Array(await chunkFile.arrayBuffer());

        chunkServers.push(await uploadChunkWithRetry(
          servers, encBytes, authHeader, i, numChunks, startProgress, chunkWeight, onProgress, signal, deadServers
        ));

        if (i < numChunks - 1) {
          await sleep(1000);
        }
      }

      const previewUploaded = await uploadPreviewIfPresent(encryptedPreview, authHeader);
      return {
        hashes,
        size: totalSize,
        unencryptedFileHash: bytesToHex(plaintextHasher.digest()),
        previewHash: previewUploaded ? previewHash : undefined,
        chunkServers: chunkServers.some((s) => s) ? chunkServers : undefined,
      };
    }

    // Fallback (OPFS unavailable): the Blossom auth event must cover every
    // chunk hash before any upload starts, so all hashes have to be known up
    // front — but we don't want to hold the whole encrypted file in memory to
    // get them. Instead pass 1 encrypts each chunk with a fresh random nonce,
    // hashes the ciphertext, and keeps ONLY that 32-byte nonce (discarding the
    // ciphertext). Pass 2 re-reads the same plaintext chunk and re-encrypts it
    // with the SAME stored nonce: same key + same nonce + same plaintext
    // reproduces bit-identical ciphertext (AES-GCM is a deterministic function
    // of its inputs), so the hash still matches what was authorized — without
    // ever buffering more than one chunk's plaintext/ciphertext or 32 bytes of
    // nonce per chunk.
    const nonces: Uint8Array[] = [];
    for (let i = 0; i < numChunks; i++) {
      throwIfAborted(signal);
      onProgress?.({
        stage: "Encrypting...",
        progress: Math.round((i / numChunks) * 20),
        currentChunk: i + 1,
        totalChunks: numChunks,
      });
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, totalSize);
      const bytes = new Uint8Array(await file.slice(start, end).arrayBuffer());
      plaintextHasher.update(bytes);
      const nonce = crypto.getRandomValues(new Uint8Array(32));
      const encBytes = await aesGcmEncryptBytes(bytes, convKey, nonce);
      nonces.push(nonce);

      const hashBuffer = await crypto.subtle.digest("SHA-256", encBytes as unknown as BufferSource);
      hashes.push(toHexHash(hashBuffer));
    }

    onProgress?.({
      stage: "Waiting for signature approval...",
      progress: 20,
      currentChunk: numChunks,
      totalChunks: numChunks,
    });
    const { authHeader, previewHash, encryptedPreview } = await finalizePreviewAuth(hashes);

    for (let i = 0; i < numChunks; i++) {
      throwIfAborted(signal);
      const startProgress = 20 + (i / numChunks) * 80;
      const chunkWeight = 80 / numChunks;

      onProgress?.({
        stage: "Uploading...",
        progress: Math.round(startProgress),
        currentChunk: i + 1,
        totalChunks: numChunks,
      });

      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, totalSize);
      const bytes = new Uint8Array(await file.slice(start, end).arrayBuffer());
      const encBytes = await aesGcmEncryptBytes(bytes, convKey, nonces[i]);

      chunkServers.push(await uploadChunkWithRetry(
        servers, encBytes, authHeader, i, numChunks, startProgress, chunkWeight, onProgress, signal, deadServers
      ));

      if (i < numChunks - 1) {
        await sleep(1000);
      }
    }

    const previewUploaded = await uploadPreviewIfPresent(encryptedPreview, authHeader);
    return {
      hashes,
      size: totalSize,
      unencryptedFileHash: bytesToHex(plaintextHasher.digest()),
      previewHash: previewUploaded ? previewHash : undefined,
      chunkServers: chunkServers.some((s) => s) ? chunkServers : undefined,
    };
  } finally {
    if (opfsTemp) {
      await removeOpfsTempDir(opfsTemp.name);
    }
  }
}
