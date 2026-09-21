import { deriveConversationKeyFromHex } from "../../crypto";
import { getDriveKeyByPubkey } from "../driveKey";
import { publishDeletionRequest } from "../deletionRequest";
import { parseCoordinate } from "./link";
import { publishSupersedingEvent, writeShareInfo } from "./shareInfo";
import { revokeFolderMembers } from "./folder/revoke";
import type { RevokeResult, SharedByMeEntry } from "./types";

/**
 * Revokes a share: supersedes its primary coordinate (the container for a
 * folder, the shared-file event for a file) so the link stops resolving,
 * then every folder member, then the bookkeeping event itself. Also fires a
 * best-effort NIP-09 courtesy request. Does NOT and cannot un-disclose
 * anything the recipient already fetched — see the caller-facing copy in
 * ShareModal / SharedByMeView for the honest framing of that limit.
 *
 * Folder sharing is set aside from the UI (see ./folder/create.ts) — this
 * still handles revoking a folder entry so anyone who already has one from
 * before that change can still clean it up.
 */
export async function revokeShare(entry: SharedByMeEntry): Promise<RevokeResult> {
  const { pubkey } = parseCoordinate(entry.coordinate);
  const key = await getDriveKeyByPubkey(pubkey);
  if (!key) {
    throw new Error("This share was created with a Drive Key this device no longer holds.");
  }

  const conversationKey = deriveConversationKeyFromHex(entry.encryptionKey);
  const memberCoordinates = entry.members.map((m) => m.coordinate);

  const at = Math.floor(Date.now() / 1000);

  // 1. The primary coordinate — synchronous, throws on total failure, since
  //    this is what the link resolves first and once it lands the link is
  //    dead even if the member sweep below is still running.
  const primarySubtype = entry.kind === "folder" ? "container" : "shared-file";
  await publishSupersedingEvent(key, entry.coordinate, primarySubtype, conversationKey, {
    v: 1,
    revoked: true,
    at,
    kind: entry.kind,
  });

  // 2. Folder members, paced to avoid a revoke burst on a large folder.
  const { revoked: revokedMembers, pending } = await revokeFolderMembers(
    key,
    memberCoordinates,
    conversationKey,
    at,
  );
  const revoked = [entry.coordinate, ...revokedMembers];

  // 3. The info event itself, so the list reflects the revoke on reload.
  try {
    await writeShareInfo(key, entry.infoD, {
      kind: entry.kind,
      name: entry.name,
      source: entry.source,
      coordinate: entry.coordinate,
      relays: entry.relays,
      members: entry.members,
      encryptionKey: entry.encryptionKey,
      revokedAt: at,
    });
  } catch (e) {
    console.warn("[Sharing] Failed to publish revoked share-info event", e);
  }

  // 4. Courtesy NIP-09 — fire and forget, never gates the result.
  void publishDeletionRequest(
    [entry.coordinate, ...memberCoordinates, entry.infoCoordinate],
    `Revoked share: ${entry.name}`,
  );

  return { revoked, pending, primaryRevoked: true };
}
