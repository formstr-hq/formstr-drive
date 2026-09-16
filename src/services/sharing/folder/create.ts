// Folder sharing — set aside per NIP-FS ("Folder sharing is TBD") and
// current product direction: not reachable from the UI (no component in
// src/components imports from this directory), but kept compiling and
// exported here so it can be wired back in later without being rebuilt from
// scratch. See ../create.ts for the file-sharing counterpart that IS live.
import { hexToBytes } from "nostr-tools/utils";
import { type Event } from "nostr-tools";
import { generateFileId, isLegacyFile, type FileMetadata } from "../../../types/metadata";
import { getActiveDriveKey, getDriveKeyByPubkey } from "../../driveKey";
import { deriveConversationKeyFromHex } from "../../../crypto";
import { enqueueMetadataEvent, publishAndDequeue, publishQueuedPaced } from "../../metadataOutbox";
import { buildShareEvent } from "../event";
import { relaysFromPublish } from "../hints";
import { METADATA_KIND, buildCoordinate, encodeShareLink, parseCoordinate } from "../link";
import { fetchEventByCoordinate, nextCreatedAt } from "../relay";
import { dedupeShareRequest } from "../dedupe";
import { generateEphemeralEncryptionKey, writeShareInfo, publishSupersedingEvent } from "../shareInfo";
import { findActiveShare } from "../list";
import type { ShareMember, ShareResult, ShareSource, SharedByMeEntry } from "../types";

/** NIP-FS's container schema is `["a", coordinate, "Relay Hint"]` — one hint
 *  slot per member, not a list. The first relay the member's own event
 *  actually landed on is the honest single hint to offer. */
function firstRelay(relays: string[]): string {
  return relays[0] ?? "";
}

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
  const signingKey = hexToBytes(driveKey.secretKeyHex);

  // Pre-generate every member's `d` tag, so the container's contents are
  // known up front and don't depend on any member publish having landed.
  const memberPlans = shareable.map((file) => ({ file, dTag: `s-${generateFileId()}` }));
  const memberEvents: Event[] = memberPlans.map(({ file, dTag }) =>
    buildShareEvent({
      subtype: "shared-file",
      dTag,
      payload: file,
      conversationKey: ephemeral.conversationKey,
      signingKey,
    }),
  );

  // Durable before any network I/O — an app kill mid-share still completes
  // via the outbox's background drain.
  await Promise.all(memberEvents.map((ev) => enqueueMetadataEvent(ev, folderName)));

  // Members publish paced (~1/s, same rate-limit-safety reasoning as
  // publishQueuedPaced's other callers) and AWAITED — unlike the old
  // fire-and-forget background publish, this call now needs each member's
  // real landing relay before it can build the container's per-member
  // hints, so folder creation no longer returns before members do. Trades
  // latency (N seconds for N files) for hints that are actually correct
  // instead of the empty placeholder the container used to ship with.
  const { results: memberPublishResults } = await publishQueuedPaced(memberEvents, { onProgress });
  const members: ShareMember[] = memberPlans.map(({ file, dTag }) => ({
    id: file.id,
    coordinate: buildCoordinate(driveKey.publicKey, dTag),
  }));
  const memberRelays = memberPublishResults.map((r) => (r ? relaysFromPublish(r) : []));

  const containerDTag = `s-${generateFileId()}`;
  const containerContent = {
    name: folderName,
    metadata: members.map((m, i) => ["a", m.coordinate, firstRelay(memberRelays[i])]),
  };
  const containerEvent = buildShareEvent({
    subtype: "container",
    dTag: containerDTag,
    payload: containerContent,
    conversationKey: ephemeral.conversationKey,
    signingKey,
  });
  await enqueueMetadataEvent(containerEvent, folderName);

  // The container is the coordinate the link resolves first — synchronous,
  // throws on total failure (the "return the URL only if it landed" contract).
  const containerPublish = await publishAndDequeue(containerEvent);
  const containerRelays = relaysFromPublish(containerPublish);

  const shareUrl = encodeShareLink({
    pubkey: driveKey.publicKey,
    dTag: containerDTag,
    relays: containerRelays,
    secretKeyHex: ephemeral.secretKeyHex,
  });

  // Best-effort, not on the critical path — see the matching comment in
  // ../create.ts.
  void writeShareInfo(driveKey, `si-${generateFileId()}`, {
    kind: "folder",
    name: folderName,
    source: { type: "folder", path },
    coordinate: buildCoordinate(driveKey.publicKey, containerDTag),
    relays: containerRelays,
    members,
    encryptionKey: ephemeral.secretKeyHex,
  }).catch((e) => {
    console.warn("[Sharing] Failed to publish share-info tracking event", e);
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
  const signingKey = hexToBytes(driveKey.secretKeyHex);
  let pending = 0;

  const addedMembers: ShareMember[] = [];
  const addedRelays = new Map<string, string[]>(); // coordinate -> relays
  const addEvents: Event[] = [];
  for (const file of toAdd) {
    const dTag = `s-${generateFileId()}`;
    addEvents.push(
      buildShareEvent({
        subtype: "shared-file",
        dTag,
        payload: file,
        conversationKey,
        signingKey,
      }),
    );
    addedMembers.push({ id: file.id, coordinate: buildCoordinate(driveKey.publicKey, dTag) });
  }
  if (addEvents.length > 0) {
    await Promise.all(addEvents.map((ev) => enqueueMetadataEvent(ev, folderName)));
    const { failed, results } = await publishQueuedPaced(addEvents, { onProgress });
    pending += failed;
    for (let i = 0; i < addedMembers.length; i++) {
      const r = results?.[i];
      if (r) addedRelays.set(addedMembers[i].coordinate, relaysFromPublish(r));
    }
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

  const survivingMembers = existing.members.filter((m) => currentIds.has(m.id));
  const newMembers = [...survivingMembers, ...addedMembers];

  // Republish the container at the SAME `d` tag — the link URL never changes.
  const { d: containerD } = parseCoordinate(existing.coordinate);
  const originalContainer = await fetchEventByCoordinate(METADATA_KIND, driveKey.publicKey, containerD);
  const createdAt = originalContainer
    ? Math.max(nextCreatedAt(), originalContainer.created_at + 1)
    : nextCreatedAt();

  // Surviving members keep whatever hint the folder's existing `relays`
  // covers (the container's own hint list is the best we have for a member
  // this call didn't just publish); newly-added members use their own.
  const containerEvent = buildShareEvent({
    subtype: "container",
    dTag: containerD,
    payload: {
      name: folderName,
      metadata: newMembers.map((m) => [
        "a",
        m.coordinate,
        addedRelays.get(m.coordinate)?.[0] ?? firstRelay(existing.relays),
      ]),
    },
    conversationKey,
    signingKey,
    createdAt,
  });
  await enqueueMetadataEvent(containerEvent, folderName);
  const containerPublish = await publishAndDequeue(containerEvent);
  const containerRelays = relaysFromPublish(containerPublish);

  try {
    await writeShareInfo(driveKey, existing.infoD, {
      kind: "folder",
      name: folderName,
      source: { type: "folder", path },
      coordinate: existing.coordinate,
      relays: containerRelays.length > 0 ? containerRelays : existing.relays,
      members: newMembers,
      encryptionKey: existing.encryptionKey,
    });
  } catch (e) {
    console.warn("[Sharing] Failed to update share-info tracking event", e);
    pending++;
  }

  return { url: existing.url, reused: true, pending: pending > 0 ? pending : undefined };
}
