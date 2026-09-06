// Public surface of the sharing feature (NIP-FS "File/Folder Sharing").
// Implementation is split by concern — see the individual modules — this
// file is just the barrel so callers keep importing from
// "services/sharing" without caring how it's organized internally.

export { SHARE_HASH_PREFIX } from "./types";
export type {
  ShareSource,
  ShareMember,
  SharedByMeEntry,
  ShareResult,
  ShareLinkPayload,
  SharedFilePayload,
  SharedFolderPayload,
  SharedFolderResult,
  ResolvedShare,
  RevokeResult,
  RevokedSharePayload,
} from "./types";

export { parseShareHash } from "./link";
// Folder sharing (ensureFolderShare) is set aside — not exported here. It
// lives at "services/sharing/folder" if it's ever wired back into the UI.
export { ensureFileShare } from "./create";
export { resolveSharedLink } from "./resolve";
export { loadSharedByMe, findActiveShare } from "./list";
export { revokeShare } from "./revoke";
