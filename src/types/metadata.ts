export interface FileMetadata {
  name: string;
  hash: string;
  size: number;
  type: string;
  folder: string;
  uploadedAt: number;
  server: string;
  encryptionKey: string; // Hex-encoded private key used to encrypt this file
  deleted?: boolean;
  previewHash?: string;
  /**
   * Hex-encoded private key used to encrypt the preview blob. Optional for
   * backwards compatibility: legacy uploads encrypted the preview with the
   * signer's NIP-44 key and have no per-preview key stored here.
   */
  previewEncryptionKey?: string;
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
