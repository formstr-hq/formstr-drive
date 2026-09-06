import { BlossomClient } from "../blossom";
import { createAuthEvent } from "../auth";
import { chunkHashes, isLegacyBlobFormat, type FileMetadata } from "../types/metadata";

/**
 * Deletes every Blossom blob backing a file, plus the preview.
 *
 * NIP-FS single-blob files have exactly one blob (`blobHash`) to delete;
 * legacy chunk-per-blob files have one per chunk (`chunkHashes(file.chunks)`)
 * — get this branch wrong for a new-format file and nothing but the preview
 * gets deleted, permanently orphaning the real blob on the server.
 *
 * Best-effort by design: each blob is deleted independently so one failure
 * can't block the rest, and a blob left orphaned on a server is a better
 * outcome than a partially-deleted file stuck in the index forever. Callers
 * should proceed to the metadata tombstone regardless of what happens here.
 */
export async function deleteRemoteBlobs(file: FileMetadata): Promise<void> {
  const blobHashes = isLegacyBlobFormat(file)
    ? chunkHashes(file.chunks)
    : file.blobHash
      ? [file.blobHash]
      : [];

  // One auth event covering every blob (chunks + preview), so the user
  // signs only once per file.
  const allHashes = file.previewHash
    ? [...blobHashes, file.previewHash]
    : blobHashes;
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

  for (let i = 0; i < blobHashes.length; i++) {
    // Legacy metadata may carry chunks as bare hash strings; only the object
    // form can override the file's primary server.
    const chunk = file.chunks?.[i];
    const server =
      (typeof chunk === "object" ? chunk.server : undefined) ?? file.server;
    try {
      await clientFor(server).delete(blobHashes[i], auth);
    } catch (e) {
      console.warn(`Failed to delete blob ${blobHashes[i]} from ${server}`, e);
    }
  }

  if (file.previewHash) {
    try {
      await clientFor(file.server).delete(file.previewHash, auth);
    } catch {
      // Preview deletion failures are non-fatal: the primary blobs are gone
      // and the preview is unreferenced once the index event is updated.
    }
  }
}
