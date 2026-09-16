// Folder sharing — set aside per NIP-FS ("Folder sharing is TBD") and
// current product direction: not reachable from the UI. See ./create.ts for
// the full explanation. revokeShare (../revoke.ts) still calls into this for
// an EXISTING folder share, so anyone who already has one can still clean it
// up even though creating new ones is no longer exposed anywhere in the UI.
import type { DriveKeyEntry } from "../../driveKey";
import { publishSupersedingEvent } from "../shareInfo";

/** Supersedes every member's shared-file event, paced to avoid a revoke
 *  burst on a large folder. Returns which coordinates landed vs. are still
 *  queued — a partial failure here is reported back, not swallowed, since
 *  a "revoked" folder with live member copies is a meaningful gap the
 *  caller-facing UI needs to be honest about. */
export async function revokeFolderMembers(
  key: DriveKeyEntry,
  members: string[],
  conversationKey: Uint8Array,
  at: number,
): Promise<{ revoked: string[]; pending: string[] }> {
  const revoked: string[] = [];
  const pending: string[] = [];

  for (let i = 0; i < members.length; i++) {
    try {
      await publishSupersedingEvent(key, members[i], "shared-file", conversationKey, {
        v: 1,
        revoked: true,
        at,
        kind: "file",
      });
      revoked.push(members[i]);
    } catch {
      pending.push(members[i]);
    }
    if (i < members.length - 1) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  return { revoked, pending };
}
