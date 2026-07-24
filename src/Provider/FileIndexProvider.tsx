import {
  createContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { FileMetadata } from "../types/metadata";
import {
  observeFileIndex,
  autoMigrateLegacyFiles,
} from "../services/fileIndex";
import {
  getRelayRefresh,
  subscribeRelayRefresh,
} from "../dataLayer/relayRefresh";
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
import { driveFileToMetadata, getDriveSdk } from "../services/driveSdk";

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
  const [manualRefreshCount, setManualRefreshCount] = useState(0);
  const processingPendingImportsRef = useRef(false);

  // Bumps when the relay worker can newly serve cached data it couldn't a
  // moment ago (IndexedDB hydration finished, or the worker restarted after a
  // mobile suspend and lost its interests) — the effect below re-declares the
  // file-index observe against the now-populated store.
  const relayRefresh = useSyncExternalStore(subscribeRelayRefresh, getRelayRefresh);

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

  // Standing file-index interest: cache replay streams files in instantly on a
  // warm start, EOSE (onReady) replaces the old 10-second timeout, and the live
  // tail keeps the list updated as metadata events arrive — including our own
  // publishes, which the local relay stores before any upstream ack.
  useEffect(() => {
    if (restoring) return;
    if (!isSignedIn || !pubkey) {
      setFiles([]);
      setHasHydratedIndex(false);
      return;
    }

    setLoading(true);
    setError(null);
    const unobserve = observeFileIndex(pubkey, {
      onFiles: setFiles,
      onReady: () => {
        setHasHydratedIndex(true);
        setLoading(false);
      },
      onLegacyFilesFound: setLegacyFiles,
    });

    return unobserve;
  }, [isSignedIn, pubkey, restoring, relayRefresh, manualRefreshCount]);

  // With a standing observe the worker keeps the index synced on its own;
  // a manual refresh just re-declares the interest (cache replay + re-sync).
  const refresh = useCallback(async () => {
    if (!isSignedIn || !pubkey) return;
    setManualRefreshCount((n) => n + 1);
  }, [isSignedIn, pubkey]);

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

  const deleteFile = useCallback(
    async (hash: string) => {
      const file = files.find((f) => f.hash === hash);
      if (!file) return;

      const sdk = await getDriveSdk(selectedServer);
      await sdk.deleteFile(hash);
      setFiles((prev) => prev.filter((f) => f.hash !== hash));
    },
    [files, selectedServer]
  );

  const deleteFiles = useCallback(
    async (hashes: string[]) => {
      const hashSet = new Set(hashes);
      const targetFiles = files.filter((file) => hashSet.has(file.hash));
      const deletedHashes = new Set<string>();
      const sdk = await getDriveSdk(selectedServer);

      for (const file of targetFiles) {
        try {
          await sdk.deleteFile(file.hash);
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
    [files, selectedServer]
  );

  const moveFile = useCallback(
    async (hash: string, newFolder: string) => {
      const file = files.find((f) => f.hash === hash);
      if (!file) return;

      const sdk = await getDriveSdk(selectedServer);
      const updated = driveFileToMetadata(await sdk.moveFile(hash, newFolder));
      setFiles((prev) => prev.map((f) => (f.hash === hash ? updated : f)));
    },
    [files, selectedServer]
  );

  const moveFiles = useCallback(
    async (hashes: string[], newFolder: string) => {
      const hashSet = new Set(hashes);
      const targetFiles = files.filter((file) => hashSet.has(file.hash));
      const sdk = await getDriveSdk(selectedServer);
      const updatedFiles = new Map<string, FileMetadata>();

      for (const file of targetFiles) {
        const updated = driveFileToMetadata(await sdk.moveFile(file.hash, newFolder));
        updatedFiles.set(file.hash, updated);
      }

      setFiles((prev) =>
        prev.map((file) =>
          updatedFiles.get(file.hash) ?? file
        )
      );
    },
    [files, selectedServer]
  );

  const renameFile = useCallback(
    async (hash: string, newName: string) => {
      const file = files.find((f) => f.hash === hash);
      if (!file) return;

      const sdk = await getDriveSdk(selectedServer);
      const updated = driveFileToMetadata(await sdk.renameFile(hash, newName));
      setFiles((prev) => prev.map((f) => (f.hash === hash ? updated : f)));
    },
    [files, selectedServer]
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

function extractFolders(files: readonly FileMetadata[]): string[] {
  const folders = new Set<string>(["/"]);
  for (const file of files) {
    const parts = file.folder.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current += `/${part}`;
      folders.add(current);
    }
  }
  return [...folders].sort();
}
