import type { FileMetadata } from "../../types/metadata";

/** Marks the fragment of a share URL — never sent to any server, matching
 *  how the app already avoids putting sensitive data in query strings. */
export const SHARE_HASH_PREFIX = "#shared=";

export interface SharedFilePayload {
  v: 1;
  kind: "file";
  /** Addressable coordinate of the shared-file event: "34578:<pubkey>:<d>". */
  a: string;
  /** Hex secret of the ephemeral encryption key (S-EC per NIP-FS). */
  k: string;
}

export interface SharedFolderPayload {
  v: 1;
  kind: "folder";
  /** Addressable coordinate of the Shared Container event. */
  a: string;
  k: string;
}

export type ShareLinkPayload = SharedFilePayload | SharedFolderPayload;

export interface SharedFolderResult {
  name: string;
  /** Files that resolved successfully; a coordinate that failed to fetch,
   *  decrypt, or turned out revoked is skipped rather than failing the whole
   *  folder. */
  files: FileMetadata[];
  /** True if at least one referenced file could not be resolved. */
  partial: boolean;
}

/** A member of a shared folder: the owner's own file id (for drift
 *  detection — was this file added/removed since the folder was last
 *  shared) plus the coordinate of its `shared-file` copy. */
export interface ShareMember {
  id: string;
  coordinate: string;
}

/** What a share points at in the user's own drive — lets `ensureFileShare` /
 *  `ensureFolderShare` look up "does this item already have a live link"
 *  before publishing anything, so sharing the same item twice is a no-op
 *  that just hands back the existing link. */
export type ShareSource =
  | { type: "file"; id: string }
  | { type: "folder"; path: string };

/** An entry in the user's "Shared by me" list, derived from the
 *  `share-info` bookkeeping events encrypted to their own Drive Key. */
export interface SharedByMeEntry {
  kind: "file" | "folder";
  name: string;
  /** What this share points at in the drive. Null for a share created
   *  before this field existed (v1) — such a share can still be listed and
   *  revoked, just not found by `findActiveShare` or drift-updated. */
  source: ShareSource | null;
  /** Unix SECONDS — this is the raw event created_at, not milliseconds. */
  sharedAtSeconds: number;
  /** The full share URL (reconstructed from the stored payload). */
  url: string;
  /** `d` tag of the `share-info` event itself — needed to supersede it. */
  infoD: string;
  /** Full coordinate of the info event, for the NIP-09 courtesy request. */
  infoCoordinate: string;
  /** Coordinate the link resolves to: the container (folder) or the
   *  shared-file event (file). */
  coordinate: string;
  /** S-EC hex. */
  encryptionKey: string;
  /** Null means "unknown, this is a v1 record" — the member list has to be
   *  resolved lazily (see resolveMemberCoordinates) before it can be revoked
   *  or drift-updated. [] for a file share (the member IS `coordinate`). */
  members: ShareMember[] | null;
  /** Set once the share has been revoked; the entry stays in the list. */
  revokedAt?: number;
}

export interface ShareResult {
  url: string;
  /** True if this call didn't publish anything — an existing live share for
   *  this item was found and handed back unchanged. */
  reused: boolean;
  /** Set if some part of a folder update (new members, or the update itself)
   *  couldn't be confirmed and is queued for retry. */
  pending?: number;
  /** Set on a v1 folder share whose member list can't be diffed — new files
   *  added to the folder since won't be added to this link automatically. */
  membersUnknown?: boolean;
}

export interface RevokedSharePayload {
  v: 1;
  revoked: true;
  at: number;
  kind: "file" | "folder";
}

export function isRevoked(parsed: unknown): parsed is RevokedSharePayload {
  return (
    !!parsed &&
    typeof parsed === "object" &&
    (parsed as RevokedSharePayload).revoked === true
  );
}

export type ResolvedShare =
  | { kind: "file"; file: FileMetadata }
  | { kind: "folder"; result: SharedFolderResult }
  | { kind: "revoked"; target: "file" | "folder"; at: number };

export interface RevokeResult {
  /** Coordinates whose superseding event landed on >=1 relay. */
  revoked: string[];
  /** Coordinates that didn't land and are left queued for retry. */
  pending: string[];
  /** True once the coordinate the link itself resolves to is dead — the
   *  practical thing a user cares about. */
  primaryRevoked: boolean;
  /** True if this was a v1 folder share whose member list couldn't be
   *  resolved, so some individual file copies may still be live. */
  membersUnknown: boolean;
}
