/**
 * A reference to one encrypted chunk of a file. `server` is optional and only
 * set when the chunk lives on a different Blossom server than the file's
 * primary `server` (per-chunk routing). Older metadata stored chunks as a bare
 * array of hash strings — see {@link chunkHashes} for reading either shape.
 */
export interface ChunkRef {
  hash: string;
  server?: string;
}

export interface FileMetadata {
  name: string;
  /**
   * Random per-file identity (the event's `d` tag), 6-8 chars. This is the
   * stable handle used for updates (rename/move/delete republish under the same
   * `id`) and everywhere the UI needs to identify a file. Per NIP-FS it is a
   * random id, deliberately decoupled from any Blossom blob hash so the public
   * `d` tag leaks nothing about the stored data. The actual blob address lives
   * in `blobHash` (new format) or `chunks` (legacy format) — see those fields.
   */
  id: string;
  /** SHA-256 hex of the original (plaintext) file, for optional integrity
   *  verification on download. Optional per NIP-FS (`unencryptedFileHash`). */
  unencryptedFileHash?: string;
  size: number;
  type: string;
  folder: string;
  uploadedAt: number;
  /** Primary/display server — the one shown in the UI and tried first for
   *  upload/download. For new-format files this is always `servers[0]`; kept
   *  as its own field (rather than derived on every read) so every existing
   *  call site that reads `.server` keeps working unchanged across both blob
   *  formats. */
  server: string;
  encryptionKey: string; // Hex-encoded private key used to encrypt this file
  encryptionAlgorithm: string;
  deleted?: boolean;
  previewHash?: string;
  /**
   * NIP-FS server list (new format only): the servers a fallback upload
   * tried, in the order tried, with `servers[0] === server` always the one
   * the blob actually landed on first. This is fallback HISTORY, not a
   * mirror-to-all-of-them instruction — the blob lives on exactly one of
   * these, not all of them. Absent on legacy (`chunks`-based) files, which
   * predate this field and use the single `server` instead.
   */
  servers?: string[];
  /**
   * sha256 hex of the single stored blob (NIP-FS "File Encryption": every
   * segment, in order, concatenated into one blob). Present together with
   * `chunkSize` on every file uploaded by the current client. A file has
   * EITHER this ({@link blobHash} + {@link chunkSize}) OR the legacy
   * {@link chunks} — never both, never neither. See {@link isLegacyBlobFormat}.
   */
  blobHash?: string;
  /** Plaintext bytes per segment before encryption (NIP-FS: 65536 recommended
   *  default). Every segment is exactly this size except the last, which may
   *  be shorter (including empty). Read from here, never hardcoded, since a
   *  file can in principle have been uploaded with a different chunk size —
   *  see {@link segmentCount} in crypto.ts, which needs this plus `size` to
   *  compute the total segment count and which one is last. */
  chunkSize?: number;
  /**
   * Legacy chunk-per-blob layout: one Blossom blob per chunk, addressed
   * individually. Superseded by {@link blobHash} (one concatenated blob) but
   * kept for dual-read — files uploaded before this rewrite still carry this
   * shape and must keep downloading correctly via resolveChunks/chunkHashes.
   * Never produced by new uploads.
   */
  chunks?: ChunkRef[];
}

/**
 * True if this file predates the switch to a random `id` (its decrypted
 * content is the old `{ hash, ... }` shape with no `id` field at all — the
 * type says `id: string`, but that's only a guarantee for files saved by the
 * current client; JSON.parse of an old event doesn't enforce it). Such files
 * can't be moved, renamed, deleted, dragged or shared: their identity can't be
 * resolved, and because EVERY legacy file shares the same `undefined` id,
 * looking one up by id risks matching a different legacy file entirely. They
 * also can't be downloaded — their chunks were encrypted with a blob format
 * this client no longer reads.
 *
 * There is exactly one caller, and there should stay exactly one: the emit
 * filter in services/fileIndex.ts. Excluding them at that single boundary is
 * what lets everything downstream treat `id` as the guaranteed handle the type
 * already claims it is, instead of re-checking at every action.
 */
export function isLegacyFile(file: FileMetadata): boolean {
  return !file.id;
}

/**
 * True if this file was uploaded before the NIP-FS single-blob rewrite: its
 * metadata carries the old {@link ChunkRef}-per-blob layout (`chunks`)
 * instead of `blobHash`/`chunkSize` (segments concatenated into one blob).
 *
 * This is a DIFFERENT axis from {@link isLegacyFile} (no `id`) — the two
 * "legacy" concepts cover different, non-overlapping file sets:
 *   - {@link isLegacyFile}: no `id`. Dropped entirely at the index boundary
 *     (services/fileIndex.ts) and never reaches the UI.
 *   - {@link isLegacyBlobFormat}: has a valid `id`, just an older blob
 *     layout. These files DO reach the UI and MUST keep downloading
 *     correctly — see resolveChunks/chunkHashes for the dual-read path.
 * A file can be blob-format-legacy while having a perfectly good `id`; do
 * not conflate the two or a downloadable file gets treated as unrecoverable.
 */
export function isLegacyBlobFormat(file: FileMetadata): boolean {
  return file.blobHash === undefined;
}

/** A random 6-8 char id for a file's `d` tag (NIP-FS). Hex-encoded 4 bytes. */
export function generateFileId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Normalizes a file's `chunks` to a list of hash strings, accepting both the
 * current object form (`{ hash, server? }[]`) and the legacy string form
 * (`string[]`) that older published metadata still carries. Keeping this
 * coercion in one place is what makes the object-array migration non-breaking.
 */
export function chunkHashes(
  chunks: ReadonlyArray<ChunkRef | string> | undefined,
): string[] {
  if (!chunks) return [];
  return chunks.map((chunk) => (typeof chunk === "string" ? chunk : chunk.hash));
}

export interface ResolvedChunk {
  hash: string;
  server: string;
}

/**
 * Normalizes a file's `chunks` to `{ hash, server }` pairs, resolving each
 * chunk's actual server: its own override if the upload fell back to a
 * different server than the file's primary, otherwise `fileServer`. Same
 * shape-coercion as {@link chunkHashes}, but preserves per-chunk routing —
 * every download path MUST use this (not chunkHashes + a single client) once
 * a chunk can live on a different server than `file.server`.
 */
export function resolveChunks(
  chunks: ReadonlyArray<ChunkRef | string> | undefined,
  fileServer: string,
): ResolvedChunk[] {
  if (!chunks) return [];
  return chunks.map((chunk) =>
    typeof chunk === "string"
      ? { hash: chunk, server: fileServer }
      : { hash: chunk.hash, server: chunk.server ?? fileServer },
  );
}

export interface FolderInfo {
  path: string;
  name: string;
  fileCount: number;
}

export interface NostrEvent {
  id?: string;
  kind: number;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
  sig?: string;
}
