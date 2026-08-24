// Folder sharing — set aside per NIP-FS ("Folder sharing is TBD") and
// current product direction: not reachable from the UI (no component in
// src/components imports from this directory), but kept compiling and
// exported here so it can be wired back in later without being rebuilt from
// scratch. See ../create.ts for the file-sharing counterpart that IS live.
import { finalizeEvent, type Event } from "nostr-tools";
import { hexToBytes } from "nostr-tools/utils";
import { generateFileId, isLegacyFile, type FileMetadata } from "../../../types/metadata";
import { getActiveDriveKey, getDriveKeyByPubkey } from "../../driveKey";
import { aesGcmEncrypt, deriveConversationKeyFromHex } from "../../../crypto";
import { enqueueMetadataEvent, publishAndDequeue, publishQueuedPaced } from "../../metadataOutbox";
import { METADATA_KIND, CLIENT_TAG, buildCoordinate, buildShareUrl, parseCoordinate } from "../link";
import { nextCreatedAt, fetchEventByCoordinate } from "../relay";
import { dedupeShareRequest } from "../dedupe";
import { generateEphemeralEncryptionKey, writeShareInfo, publishSupersedingEvent } from "../shareInfo";
import { findActiveShare } from "../list";
import type { ShareMember, ShareResult, ShareSource, SharedByMeEntry } from "../types";

async function createFolderShare(
  folderName: string,
  path: string,
  files: FileMetadata[],
  onProgress?: (done: number, total: number) => void,
): Promise<ShareResult> {
  const shareable = files.filter((f) => !isLegacyFile(f));
  if (shareable.length === 0) {
    throw new Error("This folder has no shareable files.");
  }

  const driveKey = await getActiveDriveKey();
  const ephemeral = generateEphemeralEncryptionKey();

  // Pre-generate every member's `d` tag, so the container's contents are
  // known up front and don't depend on any member publish having landed.
  const memberPlans = shareable.map((file) => ({ file, dTag: `s-${generateFileId()}` }));
  const members: ShareMember[] = memberPlans.map(({ file, dTag }) => ({
    id: file.id,
    coordinate: buildCoordinate(driveKey.publicKey, dTag),
  }));

  const memberEvents: Event[] = [];
  for (const { file, dTag } of memberPlans) {
    memberEvents.push(
      finalizeEvent(
        {
          kind: METADATA_KIND,
          created_at: nextCreatedAt(),
          tags: [
            ["d", dTag],
            ["t", "shared-file"],
            ["client", CLIENT_TAG],
            ["encrypted", "nip44"],
          ],
          content: await aesGcmEncrypt(JSON.stringify(file), ephemeral.conversationKey),
        },
        hexToBytes(driveKey.secretKeyHex),
      ),
    );
  }

  const containerDTag = `s-${generateFileId()}`;
  const containerContent = {
    name: folderName,
    files: members.map((m) => ["a", m.coordinate, ""]),
  };
  const containerEvent = finalizeEvent(
    {
      kind: METADATA_KIND,
      created_at: nextCreatedAt(),
      tags: [
        ["d", containerDTag],
        ["t", "shared-container"],
        ["client", CLIENT_TAG],
        ["encrypted", "nip44"],
      ],
      content: await aesGcmEncrypt(JSON.stringify(containerContent), ephemeral.conversationKey),
    },
    hexToBytes(driveKey.secretKeyHex),
  );

  // Durable before any network I/O — an app kill mid-share still completes
  // via the outbox's background drain.
  await Promise.all([...memberEvents, containerEvent].map((ev) => enqueueMetadataEvent(ev, folderName)));

  // The container is the coordinate the link resolves first — synchronous,
  // throws on total failure (the "return the URL only if it landed" contract).
  await publishAndDequeue(containerEvent);

  const containerCoordinate = buildCoordinate(driveKey.publicKey, containerDTag);
  const shareUrl = buildShareUrl({ v: 1, kind: "folder", a: containerCoordinate, k: ephemeral.secretKeyHex });

  // Best-effort, not on the critical path — see the matching comment in
  // createFileShare.
  void writeShareInfo(driveKey, `si-${generateFileId()}`, {
    kind: "folder",
    name: folderName,
    source: { type: "folder", path },
    coordinate: containerCoordinate,
    members,
    encryptionKey: ephemeral.secretKeyHex,
  }).catch((e) => {
    console.warn("[Sharing] Failed to publish share-info tracking event", e);
  });

  // Members publish in the background, paced at ~1/s — the link already
  // resolves (resolveSharedLink's `partial` handling covers files that
  // haven't landed yet).
  void publishQueuedPaced(memberEvents, { onProgress }).then(({ failed }) => {
    if (failed > 0) {
      console.warn(
        `[Sharing] ${failed} of ${memberEvents.length} shared-file event(s) for "${folderName}" are still queued`,
      );
    }
  });

  return { url: shareUrl, reused: false };
}

/**
 * Idempotent: hands back the folder's existing live share link if it has
 * one — diffing its current members against what's actually in the folder
 * now and publishing only the difference, so the link URL never changes —
 * otherwise creates a fresh one.
 */
export async function ensureFolderShare(
  folderName: string,
  path: string,
  files: FileMetadata[],
  onProgress?: (done: number, total: number) => void,
  knownEntries?: SharedByMeEntry[],
): Promise<ShareResult> {
  const source: ShareSource = { type: "folder", path };
  return dedupeShareRequest(source, () =>
    doEnsureFolderShare(folderName, path, files, onProgress, knownEntries),
  );
}

async function doEnsureFolderShare(
  folderName: string,
  path: string,
  files: FileMetadata[],
  onProgress: ((done: number, total: number) => void) | undefined,
  knownEntries: SharedByMeEntry[] | undefined,
): Promise<ShareResult> {
  const existing = await findActiveShare({ type: "folder", path }, knownEntries);
  if (!existing) return createFolderShare(folderName, path, files, onProgress);

  if (existing.members === null) {
    // Pre-upgrade (v1) share: no per-member id tracking, so diffing would
    // risk creating a duplicate share for a file rather than safely no-op'ing.
    // Leave the link exactly as it was rather than guess.
    console.warn(
      `[Sharing] "${folderName}" has a share link from before folder updates were tracked; ` +
        `new files won't be added to it automatically.`,
    );
    return { url: existing.url, reused: true, membersUnknown: true };
  }

  const shareable = files.filter((f) => !isLegacyFile(f));
  const currentIds = new Set(shareable.map((f) => f.id));
  const existingIds = new Set(existing.members.map((m) => m.id));

  const toAdd = shareable.filter((f) => !existingIds.has(f.id));
  const toRemove = existing.members.filter((m) => !currentIds.has(m.id));

  if (toAdd.length === 0 && toRemove.length === 0) {
    return { url: existing.url, reused: true };
  }

  const { pubkey: driveOwnerPubkey } = parseCoordinate(existing.coordinate);
  const driveKey = await getDriveKeyByPubkey(driveOwnerPubkey);
  if (!driveKey) {
    throw new Error("This folder's share was created with a Drive Key this device no longer holds.");
  }
  const conversationKey = deriveConversationKeyFromHex(existing.encryptionKey);
  let pending = 0;

  const addedMembers: ShareMember[] = [];
  const addEvents: Event[] = [];
  for (const file of toAdd) {
    const dTag = `s-${generateFileId()}`;
    addEvents.push(
      finalizeEvent(
        {
          kind: METADATA_KIND,
          created_at: nextCreatedAt(),
          tags: [
            ["d", dTag],
            ["t", "shared-file"],
            ["client", CLIENT_TAG],
            ["encrypted", "nip44"],
          ],
          content: await aesGcmEncrypt(JSON.stringify(file), conversationKey),
        },
        hexToBytes(driveKey.secretKeyHex),
      ),
    );
    addedMembers.push({ id: file.id, coordinate: buildCoordinate(driveKey.publicKey, dTag) });
  }
  if (addEvents.length > 0) {
    await Promise.all(addEvents.map((ev) => enqueueMetadataEvent(ev, folderName)));
    const { failed } = await publishQueuedPaced(addEvents, { onProgress });
    pending += failed;
  }

  for (const member of toRemove) {
    try {
      await publishSupersedingEvent(driveKey, member.coordinate, "shared-file", conversationKey, {
        v: 1,
        revoked: true,
        at: Math.floor(Date.now() / 1000),
        kind: "file",
      });
    } catch (e) {
      console.warn(`[Sharing] Failed to remove a file from the shared folder "${folderName}"`, e);
      pending++;
    }
  }

  const newMembers = [...existing.members.filter((m) => currentIds.has(m.id)), ...addedMembers];

  // Republish the container at the SAME `d` tag — the link URL never changes.
  const { d: containerD } = parseCoordinate(existing.coordinate);
  const originalContainer = await fetchEventByCoordinate(METADATA_KIND, driveKey.publicKey, containerD);
  const createdAt = originalContainer
    ? Math.max(nextCreatedAt(), originalContainer.created_at + 1)
    : nextCreatedAt();

  const containerEvent = finalizeEvent(
    {
      kind: METADATA_KIND,
      created_at: createdAt,
      tags: [
        ["d", containerD],
        ["t", "shared-container"],
        ["client", CLIENT_TAG],
        ["encrypted", "nip44"],
      ],
      content: await aesGcmEncrypt(
        JSON.stringify({ name: folderName, files: newMembers.map((m) => ["a", m.coordinate, ""]) }),
        conversationKey,
      ),
    },
    hexToBytes(driveKey.secretKeyHex),
  );
  await enqueueMetadataEvent(containerEvent, folderName);
  await publishAndDequeue(containerEvent);

  try {
    await writeShareInfo(driveKey, existing.infoD, {
      kind: "folder",
      name: folderName,
      source: { type: "folder", path },
      coordinate: existing.coordinate,
      members: newMembers,
      encryptionKey: existing.encryptionKey,
    });
  } catch (e) {
    console.warn("[Sharing] Failed to update share-info tracking event", e);
    pending++;
  }

  return { url: existing.url, reused: true, pending: pending > 0 ? pending : undefined };
}
