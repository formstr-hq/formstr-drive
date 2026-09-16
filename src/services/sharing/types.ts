import type { FileMetadata } from "../../types/metadata";

/** Marks the fragment of a share URL — never sent to any server, matching
 *  how the app already avoids putting sensitive data in query strings. */
export const SHARE_HASH_PREFIX = "#shared=";

/**
 * A share link, decoded. `naddr` is the standard NIP-19 pointer (kind,
 * pubkey, `d` identifier, optional relay hints) to the `shared-file` or
 * `container` event; `k` is the hex secret of the ephemeral encryption key
 * (S-EC per NIP-FS). There is deliberately no `kind: "file"|"folder"` field
 * here — which subtype a link points at is read off the fetched event's own
 * `t` tag once resolved, not asserted twice in two places that could
 * disagree. `naddr` has no TLV for a secret, so it isn't inside the naddr
 * itself: the link is `#shared=<naddr>&k=<hex>`, two parts joined by `&`.
 */
export interface ShareLinkPayload {
  naddr: string;
  k: string;
}

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
 *  `shared-container`-tagged bookkeeping events encrypted to their own
 *  Drive Key (NIP-FS's "Shared container Information subtype"). */
export interface SharedByMeEntry {
  kind: "file" | "folder";
  name: string;
  source: ShareSource;
  /** Unix SECONDS — this is the raw event created_at, not milliseconds. */
  sharedAtSeconds: number;
  /** The full share URL, reconstructed from the stored payload — carries
   *  the same relay hints the original share published with, so "copy link
   *  again" from this list stays resolvable the same way the first copy
   *  was. */
  url: string;
  /** `d` tag of the bookkeeping event itself — needed to supersede it. */
  infoD: string;
  /** Full coordinate of the info event, for the NIP-09 courtesy request. */
  infoCoordinate: string;
  /** Coordinate the link resolves to: the container (folder) or the
   *  shared-file event (file). */
  coordinate: string;
  /** Relays the primary coordinate's event actually landed on, at last
   *  publish — the source for `url`'s hints and for revoking it. */
  relays: string[];
  /** S-EC hex. */
  encryptionKey: string;
  /** [] for a file share (the member IS `coordinate`). */
  members: ShareMember[];
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
}
