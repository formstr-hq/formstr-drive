import type { SharedByMeEntry } from "../services/sharing";

/** Fired when share links change outside the Share UI (e.g. a file delete
 *  revokes its links), so SharesProvider can refresh its badges. It is an event
 *  rather than a context call because the file-mutation hooks live in
 *  FileIndexProvider, which is mounted above SharesProvider. */
export const SHARES_CHANGED_EVENT = "formstr:shares-changed";

// Last share list SharesProvider loaded. Shared the same way (module-level)
// so the hooks above it can reuse it instead of paying a relay round trip on
// every delete. Null until the first load and after sign-out.
let loadedEntries: SharedByMeEntry[] | null = null;

export function setLoadedShareEntries(entries: SharedByMeEntry[] | null): void {
  loadedEntries = entries;
}

export function getLoadedShareEntries(): SharedByMeEntry[] | null {
  return loadedEntries;
}
