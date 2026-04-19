export type ShareRole = "viewer" | "commenter" | "editor";

export interface SharePolicy {
  role: ShareRole;
  canReshare: boolean;
  expiresAt?: number;
  requiresPassword: boolean;
  passwordSalt?: string;
  passwordVerifier?: string;
}

export interface ShareLink {
  id: string;
  createdAt: number;
  revokedAt?: number;
  capabilitySecret?: string;
  policy: SharePolicy;
}

export interface PublicSharePayload {
  shareId: string;
  fileHash: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  server: string;
  encryptionKey: string;
  createdAt: number;
  revokedAt?: number;
  policy: SharePolicy;
}

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
  shareLinks?: ShareLink[];
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
