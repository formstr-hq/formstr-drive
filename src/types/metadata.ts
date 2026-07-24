/**
 * Compatibility facade for application imports.
 *
 * Reusable metadata contracts now live in @formstr/drive-sdk. Keeping this
 * module avoids a broad application import rewrite in the behavior-neutral
 * extraction PR.
 */
import type { FileMetadata as SdkLegacyFileMetadata } from "@formstr/drive-sdk";

export { chunkHashes } from "@formstr/drive-sdk";
export type { ChunkRef, FolderInfo, NostrEvent } from "@formstr/drive-sdk";

/** UI-compatible view of SDK files; `hash` is the stable NIP-FS `d` value. */
export interface FileMetadata extends SdkLegacyFileMetadata {
  protocol?: "nip-fs" | "legacy";
}
