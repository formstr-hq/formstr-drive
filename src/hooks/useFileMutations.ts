import { useCallback, useMemo } from "react";
import type { FileMetadata } from "../types/metadata";
import { deleteFileMetadata, saveFileMetadata } from "../services/fileIndex";
import { deleteRemoteBlobs } from "../services/fileOperations";
import { loadSharedByMe, revokeShare, type SharedByMeEntry } from "../services/sharing";
import { SHARES_CHANGED_EVENT, getLoadedShareEntries } from "../context/sharesEvents";

/** Share links that survived a delete because they couldn't be revoked. */
export interface DeleteResult {
  unrevokedShares: string[];
}

export interface FileMutations {
  deleteFile: (id: string) => Promise<DeleteResult>;
  deleteFiles: (ids: string[]) => Promise<DeleteResult>;
  moveFile: (id: string, newFolder: string) => Promise<void>;
  moveFiles: (ids: string[], newFolder: string) => Promise<void>;
  renameFile: (id: string, newName: string) => Promise<void>;
}

/** The share list, from the provider's last load when there is one — a delete
 *  shouldn't wait on a relay round trip just to find out nothing is shared. */
async function loadShareEntries(): Promise<SharedByMeEntry[] | null> {
  const cached = getLoadedShareEntries();
  if (cached) return cached;
  try {
    return await loadSharedByMe();
  } catch (e) {
    console.warn("[Delete] Couldn't load share links to revoke", e);
    return null;
  }
}

/**
 * The per-file edits the drive exposes, resolved against the current file list.
 *
 * None of these touch React state: `saveFileMetadata` and `deleteFileMetadata`
 * write straight into the shared file-index store (synchronously, before their
 * own network publish), and the store re-emits the list. So there is no
 * optimistic update to keep in sync here, and no way for one to disagree with
 * what the store already reflects.
 */
export function useFileMutations(files: FileMetadata[]): FileMutations {
  // A share link is its own relay event carrying the blob location and key, so
  // deleting the file (blob + index tombstone) leaves the link resolving and
  // its viewer retrying a blob that's gone. Revoke a file's live links once its
  // delete has actually gone through — revoking first would kill the link for a
  // file that then fails to delete (e.g. the user declines the signer prompt).
  // Never fails the delete: links that couldn't be revoked are returned so the
  // caller can tell the user.
  const revokeLiveShares = useCallback(
    async (file: FileMetadata, entries: SharedByMeEntry[] | null): Promise<string[]> => {
      if (!entries) return [file.name];
      const live = entries.filter((e) => !e.revokedAt && e.source?.type === "file" && e.source.id === file.id);
      const failed: string[] = [];
      for (const entry of live) {
        try {
          await revokeShare(entry);
        } catch (e) {
          console.warn(`[Delete] Failed to revoke share link for ${entry.name}`, e);
          failed.push(entry.name);
        }
      }
      if (live.length > 0) window.dispatchEvent(new Event(SHARES_CHANGED_EVENT));
      return failed;
    },
    [],
  );

  const deleteFile = useCallback(
    async (id: string): Promise<DeleteResult> => {
      const file = files.find((f) => f.id === id);
      if (!file) return { unrevokedShares: [] };

      await deleteRemoteBlobs(file);
      await deleteFileMetadata(id, file);
      return { unrevokedShares: await revokeLiveShares(file, await loadShareEntries()) };
    },
    [files, revokeLiveShares],
  );

  const deleteFiles = useCallback(
    async (ids: string[]): Promise<DeleteResult> => {
      const idSet = new Set(ids);
      const targetFiles = files.filter((file) => idSet.has(file.id));
      const entries = await loadShareEntries();
      const unrevokedShares: string[] = [];

      for (const file of targetFiles) {
        // On failure, files already deleted this batch stay deleted — the
        // store reflects that without help from here.
        //
        // Pass the whole batch as alsoDeleting so two deduped copies being
        // deleted together get one consistent "still referenced?" answer,
        // rather than the first iteration deleting the shared blob out from
        // under the second.
        await deleteRemoteBlobs(file, targetFiles);
        await deleteFileMetadata(file.id, file);
        unrevokedShares.push(...(await revokeLiveShares(file, entries)));
      }
      return { unrevokedShares };
    },
    [files, revokeLiveShares],
  );

  const moveFile = useCallback(
    async (id: string, newFolder: string) => {
      const file = files.find((f) => f.id === id);
      if (!file) return;

      await saveFileMetadata({ ...file, folder: newFolder });
    },
    [files],
  );

  const moveFiles = useCallback(
    async (ids: string[], newFolder: string) => {
      const idSet = new Set(ids);
      const targetFiles = files.filter((file) => idSet.has(file.id));

      for (const file of targetFiles) {
        await saveFileMetadata({ ...file, folder: newFolder });
      }
    },
    [files],
  );

  const renameFile = useCallback(
    async (id: string, newName: string) => {
      const file = files.find((f) => f.id === id);
      if (!file) return;

      await saveFileMetadata({ ...file, name: newName });
    },
    [files],
  );

  return useMemo(
    () => ({ deleteFile, deleteFiles, moveFile, moveFiles, renameFile }),
    [deleteFile, deleteFiles, moveFile, moveFiles, renameFile],
  );
}
