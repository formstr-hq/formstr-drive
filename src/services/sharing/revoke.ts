import { deriveConversationKeyFromHex, aesGcmDecrypt } from "../../crypto";
import { getDriveKeyByPubkey } from "../driveKey";
import { publishDeletionRequest } from "../deletionRequest";
import { METADATA_KIND, parseCoordinate } from "./link";
import { fetchEventByCoordinate } from "./relay";
import { publishSupersedingEvent, writeShareInfo } from "./shareInfo";
import type { RevokeResult, SharedByMeEntry } from "./types";

/** Resolves a folder share's member coordinates, falling back to fetching
 *  and decrypting the container event for a v1 entry (whose info event
 *  never recorded members). Returns `complete: false` if that fallback
 *  fetch fails — callers must not treat that as a clean, fully-resolved
 *  revoke. */
async function resolveMemberCoordinates(
  entry: SharedByMeEntry,
  conversationKey: Uint8Array,
): Promise<{ members: string[]; complete: boolean }> {
  if (entry.kind === "file") return { members: [], complete: true };
  if (entry.members !== null) return { members: entry.members.map((m) => m.coordinate), complete: true };

  const { pubkey, d } = parseCoordinate(entry.coordinate);
  const event = await fetchEventByCoordinate(METADATA_KIND, pubkey, d);
  if (!event) return { members: [], complete: false };

  try {
    const json = await aesGcmDecrypt(event.content, conversationKey);
    const container = JSON.parse(json) as { files: [string, string, string?][] };
    return { members: container.files.map(([, coordinate]) => coordinate), complete: true };
  } catch {
    return { members: [], complete: false };
  }
}

/**
 * Revokes a share: supersedes its primary coordinate (the container for a
 * folder, the shared-file event for a file) so the link stops resolving,
 * then every folder member, then the share-info bookkeeping event itself.
 * Also fires a best-effort NIP-09 courtesy request. Does NOT and cannot
 * un-disclose anything the recipient already fetched — see the caller-facing
 * copy in ShareModal / SharedByMeView for the honest framing of that limit.
 */
export async function revokeShare(entry: SharedByMeEntry): Promise<RevokeResult> {
  const { pubkey } = parseCoordinate(entry.coordinate);
  const key = await getDriveKeyByPubkey(pubkey);
  if (!key) {
    throw new Error("This share was created with a Drive Key this device no longer holds.");
  }

  const conversationKey = deriveConversationKeyFromHex(entry.encryptionKey);

  // Resolve members BEFORE superseding anything — supersede the container
  // first and a v1 folder's member list is gone forever, leaving orphaned
  // live shared-file copies with a disclosed key.
  const { members, complete } = await resolveMemberCoordinates(entry, conversationKey);
  const membersUnknown = !complete;

  const at = Math.floor(Date.now() / 1000);
  const revoked: string[] = [];
  const pending: string[] = [];

  // 1. The primary coordinate — synchronous, throws on total failure, since
  //    this is what the link resolves first and once it lands the link is
  //    dead even if the member sweep below is still running.
  const primaryTag = entry.kind === "folder" ? "shared-container" : "shared-file";
  await publishSupersedingEvent(key, entry.coordinate, primaryTag, conversationKey, {
    v: 1,
    revoked: true,
    at,
    kind: entry.kind,
  });
  revoked.push(entry.coordinate);

  // 2. Folder members, paced to avoid a revoke burst on a large folder.
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

  // 3. The info event itself, so the list reflects the revoke on reload.
  //    Reuse entry.members verbatim when we had it (preserves file-id
  //    tracking); the v1 fallback path has no ids to offer, so members are
  //    recorded coordinate-only — membersUnknown already flags this case.
  try {
    await writeShareInfo(key, entry.infoD, {
      kind: entry.kind,
      name: entry.name,
      source: entry.source,
      coordinate: entry.coordinate,
      members: entry.members ?? members.map((coordinate) => ({ id: "", coordinate })),
      encryptionKey: entry.encryptionKey,
      revokedAt: at,
    });
  } catch (e) {
    console.warn("[Sharing] Failed to publish revoked share-info event", e);
  }

  // 4. Courtesy NIP-09 — fire and forget, never gates the result.
  void publishDeletionRequest(
    [entry.coordinate, ...members, entry.infoCoordinate],
    `Revoked share: ${entry.name}`,
  );

  return { revoked, pending, primaryRevoked: true, membersUnknown };
}
