/** A reference to one encrypted file chunk on a Blossom server. */
export interface ChunkRef {
  hash: string;
  server?: string;
}

/**
 * The metadata shape currently used by Formstr Drive.
 *
 * This extraction intentionally preserves the existing wire contract for
 * backward compatibility.
 */
export interface FileMetadata {
  name: string;
  hash: string;
  size: number;
  type: string;
  folder: string;
  uploadedAt: number;
  server: string;
  encryptionKey: string;
  encryptionAlgorithm: string;
  unencryptedFileHash?: string;
  deleted?: boolean;
  previewHash?: string;
  chunks?: ChunkRef[];
}

/** File metadata written by NIP-FS clients. */
export interface NipFsFileMetadata {
  name: string;
  unencryptedFileHash?: string;
  size: number;
  type: string;
  folder: string;
  uploadedAt: number;
  server: string;
  encryptionKey: string;
  encryptionAlgorithm: "aes-gcm";
  previewHash?: string;
  chunks: ChunkRef[];
}

/** Decrypted file information safe to expose to SDK consumers. */
export interface DriveFile {
  id: string;
  eventId?: string;
  createdAt: number;
  format: "nip-fs" | "legacy";
  name: string;
  unencryptedFileHash?: string;
  size: number;
  type: string;
  folder: string;
  uploadedAt: number;
  server: string;
  encryptionKey: string;
  encryptionAlgorithm: string;
  previewHash?: string;
  chunks: ChunkRef[];
}

export type DriveBinarySource = Blob | Uint8Array | ArrayBuffer;

export interface DriveUploadOptions {
  name?: string;
  folder?: string;
  type?: string;
  server?: string;
  chunkSize?: number;
  preview?: DriveBinarySource;
  includeUnencryptedHash?: boolean;
}

export interface DriveDownloadOptions {
  verifyHash?: boolean;
}

/** Accept both current object refs and older bare-hash arrays. */
export function chunkHashes(
  chunks: ReadonlyArray<ChunkRef | string> | undefined,
): string[] {
  if (!chunks) return [];
  return chunks.map((chunk) => (typeof chunk === "string" ? chunk : chunk.hash));
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

export interface DriveSigner {
  getPublicKey(): Promise<string>;
  signEvent(event: NostrEvent): Promise<NostrEvent>;
  nip44Encrypt?(pubkey: string, plaintext: string): Promise<string>;
  nip44Decrypt?(pubkey: string, ciphertext: string): Promise<string>;
}

export interface DriveRelayFilter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
  [tagFilter: `#${string}`]: string[] | number[] | undefined;
}

export interface DriveRelayAdapter {
  query(relays: readonly string[], filter: DriveRelayFilter): Promise<NostrEvent[]>;
  publish(relays: readonly string[], event: NostrEvent): Promise<void>;
}

export interface DriveBlobClient {
  upload(
    blob: Uint8Array,
    authHeader: string,
    onProgress?: (percent: number) => void,
    signal?: AbortSignal,
  ): Promise<string>;
  download(
    sha256: string,
    authHeader?: string,
    onProgress?: (loaded: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
  delete(sha256: string, authHeader: string): Promise<boolean>;
}

export interface DriveKeyValueStore {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface DrivePlatformAdapter {
  readonly platform: "browser" | "android" | "custom";
  readonly supportsBackgroundTransfers: boolean;
}

export type DriveTransferState =
  | "queued"
  | "preparing"
  | "awaiting-signature"
  | "publishing-metadata"
  | "uploading-preview"
  | "uploading-chunks"
  | "downloading"
  | "completed"
  | "failed"
  | "cancelled";

export interface DriveTransferProgress {
  id: string;
  state: DriveTransferState;
  percent?: number;
  bytesTransferred?: number;
  totalBytes?: number;
  currentChunk?: number;
  totalChunks?: number;
  message?: string;
}

export interface DriveTransferTask<T> {
  readonly id: string;
  readonly result: Promise<T>;
  subscribe(listener: (progress: DriveTransferProgress) => void): () => void;
  cancel(): Promise<void>;
  retry(): Promise<T>;
}
