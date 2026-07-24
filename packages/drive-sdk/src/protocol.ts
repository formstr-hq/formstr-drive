import { generateSecretKey, nip44 } from "nostr-tools";
import { bytesToHex } from "nostr-tools/utils";
import { deriveConversationKeyFromHex, uint8ArrayToBase64 } from "./crypto";
import { DriveSdkError } from "./errors";
import type {
  DriveSigner,
  FileMetadata,
  NipFsFileMetadata,
  NostrEvent,
} from "./types";

export const METADATA_KIND = 34578;
export const BLOSSOM_AUTH_KIND = 24242;
export const DELETE_KIND = 5;
export const DEFAULT_CHUNK_SIZE = 50 * 1024 * 1024;

const HEX_64 = /^[0-9a-f]{64}$/i;
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export interface DriveKeyEntry {
  secretKeyHex: string;
  conversationKey: Uint8Array;
  createdAt: number;
}

export function parseDriveKeyPayload(plaintext: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(plaintext);
  } catch {
    return null;
  }

  let candidate: unknown;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    candidate = (value as { encryptionKey?: unknown }).encryptionKey;
  } else if (Array.isArray(value)) {
    const tag = value.find(
      (item): item is unknown[] =>
        Array.isArray(item) && item[0] === "encryptionKey",
    );
    candidate = tag?.[1];
  }

  return typeof candidate === "string" && HEX_64.test(candidate)
    ? candidate.toLowerCase()
    : null;
}

export function createDriveKeyEntry(createdAt = Math.floor(Date.now() / 1000)): DriveKeyEntry {
  const secretKeyHex = bytesToHex(generateSecretKey());
  return {
    secretKeyHex,
    conversationKey: deriveConversationKeyFromHex(secretKeyHex),
    createdAt,
  };
}

export function generateFileId(length = 8): string {
  if (!Number.isInteger(length) || length < 1) {
    throw new DriveSdkError("INVALID_CONFIGURATION", "File ID length must be a positive integer");
  }

  let id = "";
  while (id.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length - id.length));
    for (const byte of bytes) {
      // Reject the biased tail of 0...255 because 248 is divisible by 62.
      if (byte < 248) id += BASE62[byte % BASE62.length];
      if (id.length === length) break;
    }
  }
  return id;
}

export function normalizeFolder(folder = "/"): string {
  const parts = folder.split("/").filter(Boolean);
  return parts.length === 0 ? "/" : `/${parts.join("/")}`;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const source = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", source));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function isNipFsFileMetadata(value: unknown): value is NipFsFileMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const metadata = value as Partial<NipFsFileMetadata>;
  return (
    typeof metadata.name === "string" &&
    typeof metadata.size === "number" &&
    typeof metadata.type === "string" &&
    typeof metadata.folder === "string" &&
    typeof metadata.uploadedAt === "number" &&
    typeof metadata.server === "string" &&
    typeof metadata.encryptionKey === "string" &&
    HEX_64.test(metadata.encryptionKey) &&
    metadata.encryptionAlgorithm === "aes-gcm" &&
    Array.isArray(metadata.chunks) &&
    metadata.chunks.every(
      (chunk) =>
        chunk &&
        typeof chunk.hash === "string" &&
        (chunk.server === undefined || typeof chunk.server === "string"),
    )
  );
}

export function isLegacyFileMetadata(value: unknown): value is FileMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const metadata = value as Partial<FileMetadata>;
  return (
    typeof metadata.name === "string" &&
    typeof metadata.hash === "string" &&
    typeof metadata.size === "number" &&
    typeof metadata.type === "string" &&
    typeof metadata.folder === "string" &&
    typeof metadata.uploadedAt === "number" &&
    typeof metadata.server === "string" &&
    typeof metadata.encryptionKey === "string" &&
    HEX_64.test(metadata.encryptionKey)
  );
}

export function encryptFileMetadata(
  metadata: NipFsFileMetadata | FileMetadata,
  conversationKey: Uint8Array,
): string {
  return nip44.v2.encrypt(JSON.stringify(metadata), conversationKey);
}

export function decryptFileMetadata(
  ciphertext: string,
  conversationKey: Uint8Array,
): unknown {
  return JSON.parse(nip44.v2.decrypt(ciphertext, conversationKey));
}

export function buildFileMetadataEvent(
  pubkey: string,
  id: string,
  metadata: NipFsFileMetadata | FileMetadata,
  conversationKey: Uint8Array,
  createdAt = Math.floor(Date.now() / 1000),
): NostrEvent {
  return {
    kind: METADATA_KIND,
    pubkey,
    created_at: createdAt,
    tags: [
      ["d", id],
      ["t", "files"],
      ["encrypted", "nip44"],
      ["client", "formstr-drive"],
    ],
    content: encryptFileMetadata(metadata, conversationKey),
  };
}

export function buildDriveKeyEvent(
  pubkey: string,
  encryptedContent: string,
  createdAt = Math.floor(Date.now() / 1000),
): NostrEvent {
  return {
    kind: METADATA_KIND,
    pubkey,
    created_at: createdAt,
    tags: [
      ["d", `0:${pubkey}`],
      ["client", "formstr-drive"],
    ],
    content: encryptedContent,
  };
}

function toBase64Url(value: unknown): string {
  return uint8ArrayToBase64(new TextEncoder().encode(JSON.stringify(value)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export async function createBlossomAuthHeader(
  signer: DriveSigner,
  pubkey: string,
  verb: "upload" | "get" | "delete",
  hashes: readonly string[],
  content: string,
  expirationSeconds = 60 * 60,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const event: NostrEvent = {
    kind: BLOSSOM_AUTH_KIND,
    pubkey,
    created_at: now,
    tags: [
      ["t", verb],
      ["expiration", String(now + expirationSeconds)],
      ...hashes.map((hash) => ["x", hash]),
    ],
    content,
  };
  const signed = await signer.signEvent(event);
  return `Nostr ${toBase64Url(signed)}`;
}

export function buildFileDeletionEvent(
  pubkey: string,
  id: string,
  createdAt = Math.floor(Date.now() / 1000),
): NostrEvent {
  return {
    kind: DELETE_KIND,
    pubkey,
    created_at: createdAt,
    tags: [
      ["a", `${METADATA_KIND}:${pubkey}:${id}`],
      ["k", String(METADATA_KIND)],
    ],
    content: "Deleted file from Formstr Drive",
  };
}
