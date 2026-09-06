import { useCallback, useMemo } from "react";
import type { FileMetadata } from "../types/metadata";
import { deleteFileMetadata, saveFileMetadata } from "../services/fileIndex";
import { deleteRemoteBlobs } from "../services/fileOperations";

export interface FileMutations {
  deleteFile: (id: string) => Promise<void>;
  deleteFiles: (ids: string[]) => Promise<void>;
  moveFile: (id: string, newFolder: string) => Promise<void>;
  moveFiles: (ids: string[], newFolder: string) => Promise<void>;
  renameFile: (id: string, newName: string) => Promise<void>;
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
  const deleteFile = useCallback(
    async (id: string) => {
      const file = files.find((f) => f.id === id);
      if (!file) return;

      await deleteRemoteBlobs(file);
      await deleteFileMetadata(id, file);
    },
    [files],
  );

  const deleteFiles = useCallback(
    async (ids: string[]) => {
      const idSet = new Set(ids);
      const targetFiles = files.filter((file) => idSet.has(file.id));

      for (const file of targetFiles) {
        // On failure, files already deleted this batch stay deleted — the
        // store reflects that without help from here.
        await deleteRemoteBlobs(file);
        await deleteFileMetadata(file.id, file);
      }
    },
    [files],
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
