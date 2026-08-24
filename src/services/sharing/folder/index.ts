// Folder sharing — set aside per NIP-FS ("Folder sharing is TBD") and
// current product direction: not reachable from the UI (no component
// imports from this directory). Kept compiling and exported here so it can
// be wired back into a UI entry point later without being rebuilt from
// scratch — see create.ts for the fuller explanation.
export { ensureFolderShare } from "./create";
export { resolveFolderShare } from "./resolve";
export { resolveFolderMemberCoordinates, revokeFolderMembers } from "./revoke";
