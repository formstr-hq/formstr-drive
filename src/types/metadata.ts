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
   * `d` tag leaks nothing about the stored data. The actual blob addresses live
   * in `chunks`.
   */
  id: string;
  /** SHA-256 hex of the original (plaintext) file, for optional integrity
   *  verification on download. Optional per NIP-FS (`unencryptedFileHash`). */
  unencryptedFileHash?: string;
  size: number;
  type: string;
  folder: string;
  uploadedAt: number;
  server: string;
  encryptionKey: string; // Hex-encoded private key used to encrypt this file
  encryptionAlgorithm: string;
  deleted?: boolean;
  previewHash?: string;
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
