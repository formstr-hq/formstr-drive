import { finalizeEvent } from "nostr-tools";
import { hexToBytes } from "nostr-tools/utils";
import { generateFileId, isLegacyFile, type FileMetadata } from "../../types/metadata";
import { getActiveDriveKey } from "../driveKey";
import { aesGcmEncrypt } from "../../crypto";
import { enqueueMetadataEvent, publishAndDequeue } from "../metadataOutbox";
import { METADATA_KIND, CLIENT_TAG, buildCoordinate, buildShareUrl } from "./link";
import { nextCreatedAt } from "./relay";
import { dedupeShareRequest } from "./dedupe";
import { generateEphemeralEncryptionKey, writeShareInfo } from "./shareInfo";
import { findActiveShare } from "./list";
import type { ShareResult, ShareSource, SharedByMeEntry } from "./types";

// Folder sharing (createFolderShare/ensureFolderShare) has moved to
// ./folder/create.ts — set aside per NIP-FS ("Folder sharing is TBD") and
// not currently reachable from the UI. See that file for why.

async function createFileShare(file: FileMetadata): Promise<ShareResult> {
  const driveKey = await getActiveDriveKey();
  const ephemeral = generateEphemeralEncryptionKey();
  const dTag = `s-${generateFileId()}`;

  const event = finalizeEvent(
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
  );

  await enqueueMetadataEvent(event, file.name);
  await publishAndDequeue(event);

  const coordinate = buildCoordinate(driveKey.publicKey, dTag);
  const shareUrl = buildShareUrl({ v: 1, kind: "file", a: coordinate, k: ephemeral.secretKeyHex });

  // Best-effort and not on the critical path: the link itself already works
  // without this landing, and it's a second full relay round trip a caller
  // shouldn't have to wait on just to get the URL back.
  void writeShareInfo(driveKey, `si-${generateFileId()}`, {
    kind: "file",
    name: file.name,
    source: { type: "file", id: file.id },
    coordinate,
    members: [],
    encryptionKey: ephemeral.secretKeyHex,
  }).catch((e) => {
    console.warn("[Sharing] Failed to publish share-info tracking event", e);
  });

  return { url: shareUrl, reused: false };
}

/** Idempotent: hands back the file's existing live share link if it has one,
 *  otherwise creates a fresh one. */
export async function ensureFileShare(
  file: FileMetadata,
  knownEntries?: SharedByMeEntry[],
): Promise<ShareResult> {
  if (isLegacyFile(file)) {
    throw new Error("This file predates sharing support and can't be shared.");
  }

  const source: ShareSource = { type: "file", id: file.id };
  return dedupeShareRequest(source, async () => {
    const existing = await findActiveShare(source, knownEntries);
    if (existing) return { url: existing.url, reused: true };
    return createFileShare(file);
  });
}
