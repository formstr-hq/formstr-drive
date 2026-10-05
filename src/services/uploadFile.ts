import { sha256 } from "@noble/hashes/sha256";
import { createStreamHasher } from "./sha256Stream";
import { bytesToHex } from "nostr-tools/utils";
import { BlossomClient, BlossomError } from "../blossom";
import { encryptSegment, deriveConversationKeyFromHex, encryptFileWithExistingKey, segmentCount } from "../crypto";
import { createAuthEvent } from "../auth";
import { describeAllServersFailed, isPermanentFailure } from "./uploadErrors";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * NIP-FS default segment size: plaintext bytes encrypted per segment before
 * every segment's ciphertext is concatenated into the single stored blob.
 * Recorded per file as `chunkSize` (types/metadata.ts) so a different value
 * never breaks decoding — this constant is only ever the default for NEW
 * uploads, never hardcoded on the read side.
 */
export const SEGMENT_SIZE = 65536;

/** Read granularity for {@link computePlaintextHash} — independent of
 *  SEGMENT_SIZE since this pass never encrypts, so there's no reason to tie
 *  it to the segment framing; a larger read reduces the number of
 *  `file.slice().arrayBuffer()` round trips for a plaintext-only pass. */
const HASH_READ_SIZE = 4 * 1024 * 1024;

/**
 * Streaming plaintext-only hash — no encryption, no network I/O. Used ahead
 * of the real upload to compute the NIP-FS `unencryptedFileHash` early
 * enough to check for a client-level duplicate (see
 * fileIndex.ts's findDuplicateByHash) before paying for a full encrypt+
 * upload of content the drive already has.
 */
export async function computePlaintextHash(file: File, signal?: AbortSignal): Promise<string> {
  const hasher = sha256.create();
  const read = (start: number) =>
    file.slice(start, Math.min(start + HASH_READ_SIZE, file.size)).arrayBuffer();
  // Reads the next slice while the current one is being hashed, so disk/bridge
  // latency overlaps the CPU-bound digest instead of adding to it.
  let next = file.size > 0 ? read(0) : null;
  for (let start = 0; start < file.size; start += HASH_READ_SIZE) {
    throwIfAborted(signal);
    const buf = await next!;
    const following = start + HASH_READ_SIZE;
    next = following < file.size ? read(following) : null;
    hasher.update(new Uint8Array(buf));
  }
  return bytesToHex(hasher.digest());
}

export interface UploadResult {
  /** sha256 hex of the single concatenated ciphertext blob (NIP-FS `blobHash`). */
  blobHash: string;
  size: number;
  chunkSize: number;
  /** SHA-256 hex of the original (plaintext) file bytes, computed incrementally
   *  during upload for NIP-FS `unencryptedFileHash`. */
  unencryptedFileHash: string;
  previewHash?: string;
  /** The server the blob actually landed on, when it wasn't the primary
   *  (servers[0]) — undefined means the primary succeeded (the common case). */
  usedServer?: string;
}

export interface UploadProgressInfo {
  stage: string;
  progress?: number;
  currentChunk?: number;
  totalChunks?: number;
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

/** Plaintext read per batch in the encrypt pass. A multiple of any sane
 *  `chunkSize`; segments inside a batch are encrypted concurrently. */
const ENCRYPT_BATCH_BYTES = 4 * 1024 * 1024;

/**
 * The one encrypt+hash pass both {@link prepareUpload} and {@link uploadFile}
 * run. Reads the file in multi-segment batches (one `slice().arrayBuffer()` per
 * batch instead of per 64KB segment, with the next batch prefetched), encrypts
 * a batch's segments concurrently — WebCrypto does the AES off the main thread —
 * then feeds them to `sink` and the ciphertext hasher strictly in order.
 *
 * `knownPlaintextHash` (from the dedup pre-check) skips re-hashing the
 * plaintext: that SHA-256 runs in JS and is the slowest part of the pass.
 */
async function encryptSegments(
  file: File,
  blobKey: Uint8Array,
  chunkSize: number,
  signal: AbortSignal | undefined,
  onProgress: ((info: UploadProgressInfo) => void) | undefined,
  knownPlaintextHash: string | undefined,
  sink: (index: number, encBytes: Uint8Array) => Promise<void>,
): Promise<{ blobHash: string; unencryptedFileHash: string }> {
  const totalSize = file.size;
  const totalSegments = segmentCount(totalSize, chunkSize);
  const perBatch = Math.max(1, Math.floor(ENCRYPT_BATCH_BYTES / chunkSize));
  const batchCount = Math.ceil(totalSegments / perBatch);
  // Both digests run on their own worker threads, in parallel with each other
  // and with the (also off-thread) AES — JS SHA-256 is the slowest part here.
  const blobHasher = createStreamHasher();
  const plaintextHasher = knownPlaintextHash ? null : createStreamHasher();

  const readBatch = async (batch: number) => {
    const first = batch * perBatch;
    const start = first * chunkSize;
    const end = Math.min(start + perBatch * chunkSize, totalSize);
    return { first, bytes: new Uint8Array(await file.slice(start, end).arrayBuffer()) };
  };

  try {
    let next: Promise<{ first: number; bytes: Uint8Array }> | null = readBatch(0);
    for (let batch = 0; batch < batchCount; batch++) {
      throwIfAborted(signal);
      const { first, bytes } = await next!;
      next = batch + 1 < batchCount ? readBatch(batch + 1) : null;

      onProgress?.({
        stage: "Encrypting...",
        progress: Math.round((first / totalSegments) * 20),
        currentChunk: first + 1,
        totalChunks: totalSegments,
      });

      const inBatch = Math.min(perBatch, totalSegments - first);
      const encrypted = await Promise.all(
        Array.from({ length: inBatch }, (_, j) => {
          const index = first + j;
          const segment = bytes.subarray(j * chunkSize, Math.min((j + 1) * chunkSize, bytes.length));
          return encryptSegment(segment, blobKey, index, index === totalSegments - 1);
        }),
      );

      // Encryption is done with `bytes`, so it can be handed to the hasher.
      await plaintextHasher?.update(bytes, true);
      const merged = new Uint8Array(encrypted.reduce((n, e) => n + e.length, 0));
      let offset = 0;
      for (const e of encrypted) {
        merged.set(e, offset);
        offset += e.length;
      }
      await blobHasher.update(merged, true);
      for (let j = 0; j < inBatch; j++) {
        throwIfAborted(signal);
        await sink(first + j, encrypted[j]);
      }
    }

    return {
      blobHash: await blobHasher.digest(),
      unencryptedFileHash: knownPlaintextHash ?? (await plaintextHasher!.digest()),
    };
  } finally {
    blobHasher.dispose();
    plaintextHasher?.dispose();
  }
}

export interface PreparedUpload {
  blobHash: string;
  totalSize: number;
  chunkSize: number;
  /** SHA-256 hex of the original (plaintext) file bytes — same field
   *  {@link uploadFile} produces, so a prepared (background) upload records
   *  the same NIP-FS integrity hash a foreground one does. */
  unencryptedFileHash: string;
  previewHash?: string;
  // In-memory ciphertext parts (only populated when no onBlob sink is
  // supplied), meant to be assembled into one upload body via
  // `new Blob(blobParts)`.
  blobParts?: Uint8Array[];
  previewBlob?: Uint8Array;
  // Sink return value (staged path) when an onBlob callback handles each
  // segment. Every segment appends to the SAME destination (a single growing
  // blob, not one file per segment — see nativeUploadDriver.ts), so this is
  // just the last call's return value.
  blobRef?: string;
  previewRef?: string;
}

/**
 * Runs pass 1 (encrypt + hash every segment, plus the optional preview)
 * without uploading anything. `blobHash` is exactly what a caller needs to
 * sign an auth/metadata event against before any network I/O happens.
 *
 * If `onBlob` is supplied, each encrypted segment is handed off (e.g.
 * appended onto one growing native-staged file) and then dropped, so peak
 * memory stays around one segment instead of the whole file. Its return
 * value is collected into `blobRef`. Without `onBlob`, every segment's
 * ciphertext is kept in `blobParts` — meant to be assembled into a `Blob`,
 * which the browser backs without requiring one contiguous JS buffer, so
 * this still doesn't materialize the whole file on the JS heap at once.
 *
 * `preview` may be a promise: it is awaited only after the segment loop, so
 * preview generation overlaps segment encryption exactly as it does in
 * {@link uploadFile}.
 */
export async function prepareUpload(
  file: File,
  encryptionKeyHex: string,
  signal?: AbortSignal,
  onProgress?: (info: UploadProgressInfo) => void,
  preview?: Uint8Array | null | Promise<Uint8Array | null>,
  onBlob?: (index: number, bytes: Uint8Array) => Promise<string>,
  chunkSize: number = SEGMENT_SIZE,
  knownPlaintextHash?: string,
): Promise<PreparedUpload> {
  const blobKey = deriveConversationKeyFromHex(encryptionKeyHex);
  const totalSize = file.size;
  const totalSegments = segmentCount(totalSize, chunkSize);
  const blobParts: Uint8Array[] = [];
  let blobRef: string | undefined;

  const { blobHash, unencryptedFileHash } = await encryptSegments(
    file,
    blobKey,
    chunkSize,
    signal,
    onProgress,
    knownPlaintextHash,
    async (index, encBytes) => {
      if (onBlob) {
        blobRef = await onBlob(index, encBytes);
        // encBytes goes out of scope here — memory bounded to ~one batch.
      } else {
        blobParts.push(encBytes);
      }
    },
  );

  const result: PreparedUpload = {
    blobHash,
    totalSize,
    chunkSize,
    unencryptedFileHash,
  };
  if (onBlob) {
    result.blobRef = blobRef;
  } else {
    result.blobParts = blobParts;
  }

  const previewBytesIn = await preview;
  if (previewBytesIn) {
    throwIfAborted(signal);
    const encryptedPreview = await encryptFileWithExistingKey(previewBytesIn, encryptionKeyHex);
    const previewBytes = new TextEncoder().encode(encryptedPreview);
    const hashBuffer = await crypto.subtle.digest("SHA-256", previewBytes as unknown as BufferSource);
    result.previewHash = toHexHash(hashBuffer);
    if (onBlob) {
      // A distinct index from every chunk (which use 0..totalSegments-1), so
      // the preview lands at its own destination rather than appending onto
      // the file blob.
      result.previewRef = await onBlob(totalSegments, previewBytes);
    } else {
      result.previewBlob = previewBytes;
    }
  }

  return result;
}

/**
 * Uploads the single concatenated blob, retrying up to 3x against a
 * candidate server before falling through to the next one in `servers`
 * (primary first). The BUD-02 auth header is server-agnostic, so it's
 * replayed unchanged across candidates — falling back costs no extra signer
 * prompt.
 *
 * A permanent rejection (415/401/403, see isPermanentFailure) skips its
 * remaining same-server retries immediately — there's no point retrying a
 * foregone conclusion 3 times before moving on.
 *
 * Returns the server that actually succeeded, or `undefined` when it was the
 * primary (servers[0]) — the common case.
 */
async function uploadBlobWithFallback(
  servers: string[],
  blob: Blob,
  sha256Hash: string,
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

    // BUD-06 preflight: ask before sending. The single-blob format can mean
    // one PUT of several hundred MB — discovering a size cap by streaming
    // the whole thing into a gateway that silently drops it (502, no CORS
    // headers on the error) burns minutes and reports a misleading network
    // error. A server that doesn't implement BUD-06 returns { ok: true } here
    // (see canAccept's doc comment) so this never blocks a compliant upload.
    // canAccept only returns ok:false for a definitive, retry-proof refusal
    // (413/415/403) — a transient probe failure (429, 5xx, timeout) reads as
    // ok:true and falls through to the real upload attempt instead of
    // landing here. deadServers is shared with the preview-upload path, so
    // this add must stay reserved for "this server permanently rejects this
    // blob", not "the probe couldn't answer right now" — a spurious add
    // would also cost the thumbnail its upload target.
    const precheck = await client.canAccept(blob.size, sha256Hash, blob.type, authHeader);
    if (!precheck.ok) {
      failures.push({
        server,
        error: new BlossomError(precheck.reason || "Server rejected this upload", { status: precheck.status }),
      });
      deadServers.add(server);
      continue;
    }

    let retries = 3;

    while (retries > 0) {
      throwIfAborted(signal);
      try {
        await client.upload(
          blob,
          sha256Hash,
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
    // This server is exhausted (transient retries used up) or permanently
    // rejected this upload — mark it dead so a preview upload (which also
    // reads deadServers indirectly via the caller) doesn't retry it either.
    deadServers.add(server);
  }

  throw describeAllServersFailed(failures.length > 0 ? failures : servers.map((server) => ({ server, error: undefined })));
}

/**
 * Retries the preview blob against ONE server — the caller must pass whichever
 * server the file's own blob actually landed on (usedServer ?? servers[0]),
 * never unconditionally servers[0]. FileMetadata has no per-preview server
 * field, so previewHash is always looked up at file.server; uploading the
 * preview anywhere else would make it upload successfully but become
 * permanently undownloadable. No cross-server fallback beyond that: previews
 * are best-effort already, so retrying-then-skipping the one right server is
 * the correct tradeoff, not expanding the metadata schema for a thumbnail.
 */
async function uploadPreviewWithRetry(
  targetServer: string,
  blob: Uint8Array,
  authHeader: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const client = new BlossomClient(targetServer);
  const hash = toHexHash(await crypto.subtle.digest("SHA-256", blob as unknown as BufferSource));
  const previewBlob = new Blob([blob as BlobPart]);
  let retries = 3;
  let lastErr: unknown;

  while (retries > 0) {
    throwIfAborted(signal);
    try {
      await client.upload(previewBlob, hash, authHeader, undefined, signal);
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

/**
 * NIP-FS "File Encryption": splits `file` into `chunkSize` segments, encrypts
 * each independently (see crypto.ts's encryptSegment — a counter+last-flag
 * nonce, no HKDF, no version byte), and concatenates every segment's
 * ciphertext into ONE blob. That single blob is what gets uploaded — not one
 * PUT per segment, unlike the pre-NIP-FS chunked-blob format this supersedes.
 *
 * Two full passes over the plaintext don't happen here: this is single-pass.
 * The auth event needs `blobHash` before it can be requested (signing costs a
 * prompt, so it happens once, after the hash is known), so the segment loop
 * runs to completion, THEN the auth header is requested, THEN the single PUT
 * happens — but nothing is re-encrypted or re-read for that; the loop's
 * output (`blobParts`, Blobs the browser can page to disk) is simply held until upload time. The browser backs a
 * multi-part `Blob` without requiring the parts to be contiguous JS memory,
 * so this doesn't hold the whole file in one buffer despite the two logical
 * phases.
 */
export async function uploadFile(
  file: File,
  servers: string[],
  encryptionKeyHex: string,
  onProgress?: (info: UploadProgressInfo) => void,
  signal?: AbortSignal,
  previewPromise?: Promise<Uint8Array | null>,
  chunkSize: number = SEGMENT_SIZE,
  knownPlaintextHash?: string,
): Promise<UploadResult> {
  const blobKey = deriveConversationKeyFromHex(encryptionKeyHex);
  const totalSize = file.size;
  const totalSegments = segmentCount(totalSize, chunkSize);
  // Ciphertext is wrapped into Blobs as it's produced (a few MB each) instead
  // of kept as Uint8Arrays: the browser can page Blob data out to disk, so the
  // JS heap stays small however big the file is. Holding every segment as a
  // typed array until upload time kept the whole file's ciphertext in RAM.
  const blobParts: Blob[] = [];
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  const flushPending = () => {
    if (pending.length === 0) return;
    blobParts.push(new Blob(pending as BlobPart[]));
    pending = [];
    pendingBytes = 0;
  };
  // Shared across the whole upload: once a candidate server is discovered
  // dead (exhausted retries or permanently rejected), later fallback
  // attempts (the preview) skip re-discovering the same failure.
  const deadServers = new Set<string>();

  const { blobHash, unencryptedFileHash } = await encryptSegments(
    file,
    blobKey,
    chunkSize,
    signal,
    onProgress,
    knownPlaintextHash,
    async (_index, encBytes) => {
      pending.push(encBytes);
      pendingBytes += encBytes.length;
      if (pendingBytes >= ENCRYPT_BATCH_BYTES) flushPending();
    },
  );
  flushPending();

  // The preview is folded into the SAME upload auth as the file blob so the
  // user signs only once. Awaited here (at signing time, not up front) so
  // preview generation overlaps segment encryption; best-effort — a failed
  // preview upload never fails the file.
  throwIfAborted(signal);
  const previewBytesIn = previewPromise ? await previewPromise : null;
  let previewHash: string | undefined;
  let encryptedPreview: Uint8Array | undefined;
  if (previewBytesIn) {
    const encrypted = await encryptFileWithExistingKey(previewBytesIn, encryptionKeyHex);
    encryptedPreview = new TextEncoder().encode(encrypted);
    const digest = await crypto.subtle.digest("SHA-256", encryptedPreview as unknown as BufferSource);
    previewHash = toHexHash(digest);
  }

  onProgress?.({
    stage: "Waiting for signature approval...",
    progress: 20,
    currentChunk: totalSegments,
    totalChunks: totalSegments,
  });

  const authHashes = previewHash ? [blobHash, previewHash] : [blobHash];
  // One auth event scoped to the single blob hash (+ optional preview hash)
  // — one BUD-02 PUT now, not one per chunk, so expiration scales with the
  // file's byte size (how long the PUT itself might legitimately take) rather
  // than a chunk count that no longer corresponds to separate network calls.
  const expirationSeconds = Math.max(1800, Math.ceil(totalSize / (1024 * 1024)) * 2);
  const authHeader = await createAuthEvent("upload", `Upload ${file.name}`, authHashes, expirationSeconds);

  const blob = new Blob(blobParts);
  const usedServer = await uploadBlobWithFallback(servers, blob, blobHash, authHeader, signal, deadServers, onProgress);

  let previewUploaded = false;
  if (encryptedPreview) {
    onProgress?.({ stage: "Uploading preview...", progress: 99 });
    // Must follow the blob to whichever server it actually landed on, not
    // always servers[0]: every reader (fetchPreview.ts) fetches the preview
    // from file.server, which the caller sets to usedServer ?? servers[0] —
    // uploading to servers[0] unconditionally would strand the preview on a
    // different server than file.server whenever the primary failed over.
    previewUploaded = await uploadPreviewWithRetry(
      usedServer ?? servers[0],
      encryptedPreview,
      authHeader,
      signal,
    );
  }

  onProgress?.({ stage: "Upload complete", progress: 100, currentChunk: totalSegments, totalChunks: totalSegments });

  return {
    blobHash,
    size: totalSize,
    chunkSize,
    unencryptedFileHash,
    previewHash: previewUploaded ? previewHash : undefined,
    usedServer,
  };
}
