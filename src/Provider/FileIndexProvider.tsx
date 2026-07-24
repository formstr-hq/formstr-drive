import {
  createContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { chunkHashes, type FileMetadata } from "../types/metadata";
import { BlossomClient } from "../blossom";
import { createAuthEvent } from "../auth";
import {
  observeFileIndex,
  saveFileMetadata,
  deleteFileMetadata,
  extractFolders,
  autoMigrateLegacyFiles,
} from "../services/fileIndex";
import {
  getRelayRefresh,
  subscribeRelayRefresh,
} from "../dataLayer/relayRefresh";
import { MigrationPromptModal } from "../components/Dialogs/MigrationPromptModal";
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
import { queueUpload } from "../transfers/transferQueue";
import { getTransfers } from "../transfers/transferStore";
import { adoptActiveNativeDownloads, startNativeEventBridge } from "../transfers/nativeAdoption";

// Re-export type if needed anywhere else
export type { FileMetadata };

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

  // Memoized so `folders` keeps a stable reference across re-renders that
  // don't actually touch files/customFolders — without this, every render
  // (uploadProgress ticks, unrelated parent re-renders, etc.) built a brand
  // new array, which cascaded into a brand new context value below and
  // forced every consumer (sidebar, file list, header) to re-render too.
  const folders = useMemo(() => {
    const foldersFromFiles = extractFolders(files);
    return Array.from(new Set([...foldersFromFiles, ...customFolders])).sort();
  }, [files, customFolders]);

  // Warn before the tab/window closes while transfers are still in flight and
  // would be lost. A native download runs in a foreground service and survives,
  // so it needs no warning; a native upload runs in the webview (background
  // upload is disabled) and DOES die — so the rule is: warn unless every active
  // transfer is a native download. On web nothing survives a close, so any
  // active transfer warns.
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      const active = getTransfers().filter(
        (t) => t.status === "running" || t.status === "pending",
      );
      if (active.length === 0) return;
      const allSurvive = active.every((t) => t.type === "download" && isAndroidPlatform);
      if (allSurvive) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, []);

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

  // Android only: re-adopt native downloads that outlived the JS context (app
  // killed/relaunched mid-download) so they reappear as cancellable rows, and
  // keep a single app-lifetime listener routing their progress/completion.
  useEffect(() => {
    if (!isAndroidPlatform) return;

    let teardown: (() => void) | undefined;
    void startNativeEventBridge().then((fn) => {
      teardown = fn;
    });
    void adoptActiveNativeDownloads();

    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void adoptActiveNativeDownloads();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      teardown?.();
    };
  }, []);

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

    // Each blob is deleted independently and best-effort: one failed chunk
    // must not block the rest, and a blob orphaned on the server is a better
    // outcome than a partially-deleted file stuck in the index forever.
    for (let i = 0; i < blobHashes.length; i++) {
      // Legacy metadata may carry chunks as bare hash strings; only the
      // object form can override the file's primary server.
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

          // Delete the on-device pending import ONLY after the upload confirms
          // success. If the upload fails, is cancelled, or the app is killed
          // before it finishes, the import is retained and retried on the next
          // launch (at-least-once) rather than being lost. A still-running
          // upload with the same id dedupes, so re-scanning is safe.
          queueUpload(importedFile, selectedServer, importPayload.folderPath, {
            onComplete: () => {
              void removePendingNativeImport(importPayload.id);
            },
          });
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

  // Memoized so the context value's identity only changes when something in
  // it actually changed — otherwise every re-render of this provider (for
  // any reason) handed every consumer a brand new object, forcing them all
  // to re-render too.
  const value = useMemo(
    () => ({
      files,
      folders,
      customFolders,
      addCustomFolder,
      currentFolder,
      setCurrentFolder,
      loading,
      hasHydratedIndex,
      error,
      deleteFile,
      deleteFiles,
      moveFile,
      moveFiles,
      renameFile,
      refresh,
    }),
    [
      files,
      folders,
      customFolders,
      addCustomFolder,
      currentFolder,
      loading,
      hasHydratedIndex,
      error,
      deleteFile,
      deleteFiles,
      moveFile,
      moveFiles,
      renameFile,
      refresh,
    ],
  );

  return (
    <FileIndexContext.Provider value={value}>
      <MigrationPromptModal
        files={legacyFiles}
        onAccept={handleAcceptMigration}
        onDismiss={handleDismissMigration}
      />
      {children}
    </FileIndexContext.Provider>
  );
}
