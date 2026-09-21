import { BlossomClient } from "../blossom";
import { createAuthEvent } from "../auth";
import { chunkHashes, isLegacyBlobFormat, type FileMetadata } from "../types/metadata";
import { findHashesStillReferenced, isFileIndexPopulated } from "./fileIndex";

/**
 * Deletes every Blossom blob backing a file, plus the preview.
 *
 * NIP-FS single-blob files have exactly one blob (`blobHash`) to delete;
 * legacy chunk-per-blob files have one per chunk (`chunkHashes(file.chunks)`)
 * — get this branch wrong for a new-format file and nothing but the preview
 * gets deleted, permanently orphaning the real blob on the server.
 *
 * A blob is NOT owned by the file that references it. Dedup (fileIndex.ts's
 * findDuplicateByHash) points a re-upload of identical bytes at the original's
 * existing blobHash/previewHash rather than storing them twice, so several
 * files can share one blob and deleting per-file would take the bytes out from
 * under the survivors — they keep listing normally and only fail later, at
 * download, with a 404 from the server the blob correctly landed on. Hence
 * `alsoDeleting`: every hash still referenced from OUTSIDE that set is skipped.
 *
 * Deliberately asymmetric about uncertainty. The reference check reads this
 * device's synced index, so it can under-report references; leaving a blob
 * orphaned costs storage, deleting one that's still referenced destroys data
 * with no way back. So an unpopulated index means "delete nothing", never
 * "nothing else references it".
 *
 * Best-effort by design: each blob is deleted independently so one failure
 * can't block the rest, and a blob left orphaned on a server is a better
 * outcome than a partially-deleted file stuck in the index forever. Callers
 * should proceed to the metadata tombstone regardless of what happens here.
 *
 * @param alsoDeleting Every file being deleted in this same operation,
 *   including `file` — so a bulk delete of several copies sharing a blob gets
 *   one consistent answer instead of one that flips as tombstones land.
 */
export async function deleteRemoteBlobs(
  file: FileMetadata,
  alsoDeleting: FileMetadata[] = [file],
): Promise<void> {
  const ownHashes = isLegacyBlobFormat(file)
    ? chunkHashes(file.chunks)
    : file.blobHash
      ? [file.blobHash]
      : [];

  // An index that hasn't synced yet can't distinguish "no other file uses this"
  // from "no other file loaded yet" — the one reading that would delete a blob
  // still in use, so decline to delete anything at all.
  if (!isFileIndexPopulated()) {
    console.warn(
      `[Delete] File index not populated — leaving ${file.name}'s blobs on the server rather than risk deleting data another file still references.`,
    );
    return;
  }

  // Resolve hash+server together, indexed by the ORIGINAL chunk position —
  // filtering ownHashes down below must not disturb which server each
  // surviving hash's chunk actually lives on (legacy chunks may override
  // file.server per-chunk).
  const ownHashServerPairs = ownHashes.map((hash, i) => {
    const chunk = file.chunks?.[i];
    const server = (typeof chunk === "object" ? chunk.server : undefined) ?? file.server;
    return { hash, server };
  });

  const stillReferenced = findHashesStillReferenced(alsoDeleting);
  const blobsToDelete = ownHashServerPairs.filter(({ hash }) => !stillReferenced.has(hash));
  const previewHash =
    file.previewHash && !stillReferenced.has(file.previewHash) ? file.previewHash : undefined;

  const sharedCount =
    ownHashServerPairs.length - blobsToDelete.length + (file.previewHash && !previewHash ? 1 : 0);
  if (sharedCount > 0) {
    console.log(
      `[Delete] Keeping ${sharedCount} blob(s) of ${file.name} — still referenced by another file (deduplicated upload).`,
    );
  }

  if (blobsToDelete.length === 0 && !previewHash) return;

  // One auth event covering every blob (chunks + preview), so the user
  // signs only once per file.
  const allHashes = previewHash
    ? [...blobsToDelete.map((b) => b.hash), previewHash]
    : blobsToDelete.map((b) => b.hash);
  // Generous expiration: large chunked files need one DELETE per chunk and
  // the whole sequence must finish before the auth event expires.
  const auth = await createAuthEvent("delete", `Delete ${file.name}`, allHashes, 600);

  const clients = new Map<string, BlossomClient>();
  const clientFor = (server: string) => {
    let client = clients.get(server);
    if (!client) {
      client = new BlossomClient(server);
      clients.set(server, client);
    }
    return client;
  };

  for (const { hash, server } of blobsToDelete) {
    try {
      await clientFor(server).delete(hash, auth);
    } catch (e) {
      console.warn(`Failed to delete blob ${hash} from ${server}`, e);
    }
  }

  if (previewHash) {
    try {
      await clientFor(file.server).delete(previewHash, auth);
    } catch {
      // Preview deletion failures are non-fatal: the primary blobs are gone
      // and the preview is unreferenced once the index event is updated.
    }
  }
}
