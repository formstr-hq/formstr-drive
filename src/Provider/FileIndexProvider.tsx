import {
  createContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import { chunkHashes, type FileMetadata } from "../types/metadata";
import { BlossomClient } from "../blossom";
import { createAuthEvent } from "../auth";
import {
  fetchFileIndex,
  saveFileMetadata,
  deleteFileMetadata,
  extractFolders,
  autoMigrateLegacyFiles,
} from "../services/fileIndex";
import { MigrationPromptModal } from "../components/MigrationPromptModal";
import { useProfileContext } from "../hooks/useProfileContext";
import { getStoredItem, setStoredItem, STORAGE_KEYS } from "../utils/persistence";
import {
  clearNativeDriveManifest,
  listPendingNativeImports,
  readPendingNativeImport,
  removePendingNativeImport,
  syncNativeDriveManifest,
} from "../native/driveManifest";
import { useBlossomServer } from "../hooks/useBlossomServer";
import { isAndroidPlatform } from "../utils/platform";
import { useUploader, type UploadProgress } from "../hooks/useUploader";
import { useDownloader, type DownloadProgress } from "../hooks/useDownloader";

export type { UploadProgress, DownloadProgress };

export interface FileIndexContextType {
  files: FileMetadata[];
  folders: string[];
  customFolders: string[];
  addCustomFolder: (path: string) => void;
  currentFolder: string;
  setCurrentFolder: (folder: string) => void;
  loading: boolean;
  hasHydratedIndex: boolean;
  error: string | null;
  uploadProgress: UploadProgress | null;
  uploadFile: (file: File, server: string) => Promise<void>;
  cancelUpload: () => void;
  downloadProgress: DownloadProgress | null;
  downloadFile: (file: FileMetadata) => Promise<{ uri: string | null }>;
  cancelDownload: () => void;
  deleteFile: (hash: string) => Promise<void>;
  deleteFiles: (hashes: string[]) => Promise<void>;
  moveFile: (hash: string, newFolder: string) => Promise<void>;
  moveFiles: (hashes: string[], newFolder: string) => Promise<void>;
  renameFile: (hash: string, newName: string) => Promise<void>;
  refresh: () => Promise<void>;
}

export const FileIndexContext = createContext<FileIndexContextType | null>(null);

export function FileIndexProvider({ children }: { children: ReactNode }) {
  const { isSignedIn, pubkey, restoring } = useProfileContext();
  const { selectedServer } = useBlossomServer();

  const [files, setFiles] = useState<FileMetadata[]>([]);
  const [currentFolder, setCurrentFolder] = useState("/");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [customFolders, setCustomFolders] = useState<string[]>([]);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [hasHydratedIndex, setHasHydratedIndex] = useState(false);
  const [legacyFiles, setLegacyFiles] = useState<FileMetadata[]>([]);
  const processingPendingImportsRef = useRef(false);

  const { uploadProgress, uploadPreparedFile, cancelUpload } = useUploader({ setFiles, setError });
  const { downloadProgress, downloadFile, cancelDownload } = useDownloader();

  const foldersFromFiles = extractFolders(files);
  const folders = Array.from(new Set([...foldersFromFiles, ...customFolders])).sort();

  useEffect(() => {
    // Android downloads run in a foreground service and uploads stay alive via
    // the upload service's notification, so there's nothing to warn about here.
    if (isAndroidPlatform || (!uploadProgress && !downloadProgress)) {
      return;
    }

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [uploadProgress, downloadProgress]);

  useEffect(() => {
    const loadCustomFolders = async () => {
      const storedCustomFolders = await getStoredItem<string[]>(
        STORAGE_KEYS.CUSTOM_FOLDERS,
        [],
      );
      setCustomFolders(storedCustomFolders);
      setSettingsLoaded(true);
    };

    void loadCustomFolders();
  }, []);

  useEffect(() => {
    if (!settingsLoaded) return;
    void setStoredItem(STORAGE_KEYS.CUSTOM_FOLDERS, customFolders);
  }, [customFolders, settingsLoaded]);

  useEffect(() => {
    if (restoring) {
      return;
    }

    if (!isSignedIn || !pubkey) {
      void clearNativeDriveManifest().catch((manifestError) => {
        console.error("Failed to clear Android Drive manifest", manifestError);
      });
    }
  }, [isSignedIn, pubkey, restoring]);

  const addCustomFolder = useCallback((path: string) => {
    setCustomFolders((prev) => {
      if (prev.includes(path)) return prev;
      return [...prev, path];
    });
  }, []);

  const refresh = useCallback(async () => {
    if (!isSignedIn || !pubkey) return;

    setLoading(true);
    setError(null);
    try {
      const index = await fetchFileIndex(pubkey, (foundLegacyFiles) => {
        setLegacyFiles(foundLegacyFiles);
      });
      setFiles(index);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load files");
    } finally {
      setHasHydratedIndex(true);
      setLoading(false);
    }
  }, [isSignedIn, pubkey]);

  useEffect(() => {
    if (restoring) return;
    if (isSignedIn) {
      void refresh();
    } else {
      setFiles([]);
      setHasHydratedIndex(false);
    }
  }, [isSignedIn, refresh, restoring]);

  useEffect(() => {
    if (
      restoring ||
      !settingsLoaded ||
      !isSignedIn ||
      !pubkey ||
      loading ||
      !hasHydratedIndex
    ) {
      return;
    }

    void syncNativeDriveManifest(files, customFolders).catch((manifestError) => {
      console.error("Failed to sync Android Drive manifest", manifestError);
    });
  }, [
    customFolders,
    files,
    isSignedIn,
    loading,
    pubkey,
    restoring,
    settingsLoaded,
    hasHydratedIndex,
  ]);

  const uploadFile = useCallback(
    async (file: File, server: string) => {
      await uploadPreparedFile(file, server, currentFolder);
    },
    [currentFolder, uploadPreparedFile],
  );

  const deleteRemoteBlobs = useCallback(async (file: FileMetadata) => {
    // Chunked files store one blob per chunk; legacy files store a single
    // blob under file.hash.
    const blobHashes = chunkHashes(file.chunks);
    if (blobHashes.length === 0) {
      blobHashes.push(file.hash);
    }

    // One auth event covering every blob (chunks + preview), so the user
    // signs only once per file.
    const allHashes = file.previewHash
      ? [...blobHashes, file.previewHash]
      : blobHashes;
    // Generous expiration: large chunked files need one DELETE per chunk and
    // the whole sequence must finish before the auth event expires.
    const auth = await createAuthEvent(
      "delete",
      `Delete ${file.name}`,
      allHashes,
      600,
    );

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
      // Legacy metadata may carry chunks as bare hash strings; only the
      // object form can override the file's primary server.
      const chunk = file.chunks?.[i];
      const server =
        (typeof chunk === "object" ? chunk.server : undefined) ?? file.server;
      await clientFor(server).delete(blobHashes[i], auth);
    }

    if (file.previewHash) {
      try {
        await clientFor(file.server).delete(file.previewHash, auth);
      } catch {
        // Preview deletion failures are non-fatal: the primary blobs are gone
        // and the preview is unreferenced once the index event is updated.
      }
    }
  }, []);

  const deleteFile = useCallback(
    async (hash: string) => {
      const file = files.find((f) => f.hash === hash);
      if (!file) return;

      await deleteRemoteBlobs(file);
      await deleteFileMetadata(hash, file);
      setFiles((prev) => prev.filter((f) => f.hash !== hash));
    },
    [files, deleteRemoteBlobs]
  );

  const deleteFiles = useCallback(
    async (hashes: string[]) => {
      const hashSet = new Set(hashes);
      const targetFiles = files.filter((file) => hashSet.has(file.hash));
      const deletedHashes = new Set<string>();

      for (const file of targetFiles) {
        try {
          await deleteRemoteBlobs(file);
          await deleteFileMetadata(file.hash, file);
          deletedHashes.add(file.hash);
        } catch (e) {
          // Stop on first failure so the user can see and retry; files
          // already deleted in this batch stay deleted.
          setFiles((prev) => prev.filter((f) => !deletedHashes.has(f.hash)));
          throw e;
        }
      }

      setFiles((prev) => prev.filter((file) => !hashSet.has(file.hash)));
    },
    [files, deleteRemoteBlobs]
  );

  const moveFile = useCallback(
    async (hash: string, newFolder: string) => {
      const file = files.find((f) => f.hash === hash);
      if (!file) return;

      const updated: FileMetadata = { ...file, folder: newFolder };
      await saveFileMetadata(updated);
      setFiles((prev) => prev.map((f) => (f.hash === hash ? updated : f)));
    },
    [files]
  );

  const moveFiles = useCallback(
    async (hashes: string[], newFolder: string) => {
      const hashSet = new Set(hashes);
      const targetFiles = files.filter((file) => hashSet.has(file.hash));

      for (const file of targetFiles) {
        const updated: FileMetadata = { ...file, folder: newFolder };
        await saveFileMetadata(updated);
      }

      setFiles((prev) =>
        prev.map((file) =>
          hashSet.has(file.hash) ? { ...file, folder: newFolder } : file
        )
      );
    },
    [files]
  );

  const renameFile = useCallback(
    async (hash: string, newName: string) => {
      const file = files.find((f) => f.hash === hash);
      if (!file) return;

      const updated: FileMetadata = { ...file, name: newName };
      await saveFileMetadata(updated);
      setFiles((prev) => prev.map((f) => (f.hash === hash ? updated : f)));
    },
    [files]
  );

  const processPendingImports = useCallback(async () => {
    if (!isSignedIn || !pubkey || loading || !hasHydratedIndex) {
      return;
    }

    if (processingPendingImportsRef.current) {
      return;
    }

    processingPendingImportsRef.current = true;
    try {
      const pendingImports = await listPendingNativeImports();
      if (pendingImports.length === 0) {
        return;
      }

      for (const pendingImport of pendingImports) {
        const importPayload = await readPendingNativeImport(pendingImport.id);
        if (!importPayload) {
          continue;
        }

        try {
          const importedFileBuffer = importPayload.bytes.buffer.slice(
            importPayload.bytes.byteOffset,
            importPayload.bytes.byteOffset + importPayload.bytes.byteLength,
          ) as ArrayBuffer;

          const importedFile = new File([importedFileBuffer], importPayload.name, {
            type: importPayload.mimeType || "application/octet-stream",
          });

          await uploadPreparedFile(
            importedFile,
            selectedServer,
            importPayload.folderPath,
          );
          await removePendingNativeImport(importPayload.id);
        } catch (pendingError) {
          console.error("Failed to process pending Android Files import", pendingError);
          setError(
            pendingError instanceof Error
              ? pendingError.message
              : "Failed to import file saved from Android Files",
          );
          continue;
        }
      }
    } finally {
      processingPendingImportsRef.current = false;
    }
  }, [
    hasHydratedIndex,
    isSignedIn,
    loading,
    pubkey,
    selectedServer,
    uploadPreparedFile,
  ]);

  useEffect(() => {
    if (
      restoring ||
      !settingsLoaded ||
      !isSignedIn ||
      !pubkey ||
      loading ||
      !hasHydratedIndex
    ) {
      return;
    }

    void processPendingImports();
  }, [
    hasHydratedIndex,
    isSignedIn,
    loading,
    processPendingImports,
    pubkey,
    restoring,
    settingsLoaded,
  ]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (
        document.visibilityState === "visible" &&
        isSignedIn &&
        !restoring &&
        hasHydratedIndex
      ) {
        void processPendingImports();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [hasHydratedIndex, isSignedIn, processPendingImports, restoring]);

  const handleAcceptMigration = async () => {
    await autoMigrateLegacyFiles(legacyFiles);
    setLegacyFiles([]);
  };

  const handleDismissMigration = () => {
    setLegacyFiles([]);
  };

  return (
    <FileIndexContext.Provider
      value={{
        files,
        folders,
        customFolders,
        addCustomFolder,
        currentFolder,
        setCurrentFolder,
        loading,
        hasHydratedIndex,
        error,
        uploadProgress,
        uploadFile,
        cancelUpload,
        downloadProgress,
        downloadFile,
        cancelDownload,
        deleteFile,
        deleteFiles,
        moveFile,
        moveFiles,
        renameFile,
        refresh,
      }}
    >
      <MigrationPromptModal
        files={legacyFiles}
        onAccept={handleAcceptMigration}
        onDismiss={handleDismissMigration}
      />
      {children}
    </FileIndexContext.Provider>
  );
}
