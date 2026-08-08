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
import { chunkHashes, LEGACY_FILE_MESSAGE, type FileMetadata } from "../types/metadata";
import { BlossomClient } from "../blossom";
import { createAuthEvent } from "../auth";
import {
  observeFileIndex,
  saveFileMetadata,
  deleteFileMetadata,
  extractFolders,
  clearFileIndexStore,
} from "../services/fileIndex";
import { drainMetadataOutbox } from "../services/metadataOutbox";
import {
  getRelayRefresh,
  subscribeRelayRefresh,
} from "../dataLayer/relayRefresh";
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
import { getUploadCandidateServers } from "./BlossomServerProvider";
import { isAndroidPlatform } from "../utils/platform";
import { queueUpload } from "../transfers/transferQueue";
import { getTransfers } from "../transfers/transferStore";
import {
  adoptActiveNativeDownloads,
  adoptActiveNativeUploads,
  startNativeEventBridge,
} from "../transfers/nativeAdoption";

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
  /** True once the Drive Key is ready — the file list UI should gate only on
   *  this, rendering `files` as they stream in rather than waiting for
   *  hasHydratedIndex (full replay). */
  keyReady: boolean;
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
  const { selectedServer, servers } = useBlossomServer();

  const [files, setFiles] = useState<FileMetadata[]>([]);
  const [currentFolder, setCurrentFolder] = useState("/");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [customFolders, setCustomFolders] = useState<string[]>([]);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [hasHydratedIndex, setHasHydratedIndex] = useState(false);
  // True once the Drive Key keyring has resolved (or definitively failed) —
  // fires well before hasHydratedIndex (which waits for the full relay
  // replay/EOSE). The file list UI should only block on this: once the key
  // is ready, files render as they stream in via onFiles rather than waiting
  // for the whole index to finish hydrating. hasHydratedIndex keeps its
  // existing meaning for the things that genuinely need a complete picture
  // (pending-import processing, native manifest sync) — unaffected by this.
  const [keyReady, setKeyReady] = useState(false);
  const [manualRefreshCount, setManualRefreshCount] = useState(0);
  const processingPendingImportsRef = useRef(false);
  const drainingOutboxRef = useRef(false);

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
  // would be lost. On Android a download always runs in a foreground service
  // and survives; an upload survives only once it has handed off to the upload
  // service (`survivesAppClose`) — before that it's still encrypting in the
  // WebView and dies with it. On web nothing survives a close, so any active
  // transfer warns.
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      const active = getTransfers().filter(
        (t) => t.status === "running" || t.status === "pending",
      );
      if (active.length === 0) return;
      const allSurvive = active.every(
        (t) =>
          isAndroidPlatform && (t.type === "download" || t.survivesAppClose === true),
      );
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

  // Android only: re-adopt native transfers that outlived the JS context (app
  // killed/relaunched mid-transfer) so they reappear as cancellable rows, and
  // keep a single app-lifetime listener routing their progress/completion.
  useEffect(() => {
    if (!isAndroidPlatform) return;

    let teardown: (() => void) | undefined;
    void startNativeEventBridge().then((fn) => {
      teardown = fn;
    });
    void adoptActiveNativeDownloads();
    void adoptActiveNativeUploads();

    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void adoptActiveNativeDownloads();
        void adoptActiveNativeUploads();
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
      // Drop the shared store's state too — otherwise a subsequent sign-in
      // (possibly a different account) would see the previous account's
      // files replayed immediately on subscribe.
      clearFileIndexStore();
      setFiles([]);
      setHasHydratedIndex(false);
      setKeyReady(false);
      return;
    }

    setLoading(true);
    setError(null);

    const unobserve = observeFileIndex(pubkey, {
      onFiles: setFiles,
      onKeyReady: () => setKeyReady(true),
      onReady: () => {
        setHasHydratedIndex(true);
        setLoading(false);
      },
    });

    return unobserve;
  }, [isSignedIn, pubkey, restoring, relayRefresh, manualRefreshCount]);

  // Drain any metadata events that were signed (with the Drive Key — free,
  // no signer prompt) but never confirmed published: the app may have been
  // killed between chunkedUploadFile resolving and saveFileMetadata's publish
  // call, or every relay may have rate-limited the attempt. Retrying costs
  // zero prompts, so this can run freely on mount, on reconnect, and whenever
  // the tab becomes visible again.
  const drainOutbox = useCallback(async () => {
    if (drainingOutboxRef.current) return;
    drainingOutboxRef.current = true;
    try {
      const { published } = await drainMetadataOutbox();
      if (published > 0) {
        console.log(`[FileIndex] Drained ${published} queued metadata event(s)`);
      }
    } catch (e) {
      console.warn("[FileIndex] Metadata outbox drain failed", e);
    } finally {
      drainingOutboxRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (restoring || !isSignedIn || !pubkey) return;
    void drainOutbox();
  }, [isSignedIn, pubkey, restoring, relayRefresh, drainOutbox]);

  useEffect(() => {
    const handleVisible = () => {
      if (document.visibilityState === "visible" && isSignedIn && !restoring) {
        void drainOutbox();
      }
    };
    document.addEventListener("visibilitychange", handleVisible);
    return () => document.removeEventListener("visibilitychange", handleVisible);
  }, [isSignedIn, restoring, drainOutbox]);

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
    // One Blossom blob per chunk.
    const blobHashes = chunkHashes(file.chunks);

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
      // Every legacy file (pre-dating the random `id`) shares the same
      // undefined id — matching on a falsy hash risks deleting a DIFFERENT
      // legacy file than the one the user actually selected. Reject up front
      // rather than resolve to the wrong file.
      if (!hash) throw new Error(LEGACY_FILE_MESSAGE);
      const file = files.find((f) => f.id === hash);
      if (!file) return;

      await deleteRemoteBlobs(file);
      // deleteFileMetadata (via saveFileMetadata) writes the tombstone
      // straight into the shared file-index store, which re-emits the
      // filtered list synchronously — no separate optimistic setFiles needed,
      // and no risk of it disagreeing with what the store already reflects.
      await deleteFileMetadata(hash, file);
    },
    [files, deleteRemoteBlobs]
  );

  const deleteFiles = useCallback(
    async (hashes: string[]) => {
      if (hashes.some((h) => !h)) throw new Error(LEGACY_FILE_MESSAGE);
      const hashSet = new Set(hashes);
      const targetFiles = files.filter((file) => hashSet.has(file.id));

      for (const file of targetFiles) {
        // Each successful delete already updates the shared store (see
        // deleteFile above); on failure, files already deleted this batch
        // stay deleted — the store reflects that without help from here.
        await deleteRemoteBlobs(file);
        await deleteFileMetadata(file.id, file);
      }
    },
    [files, deleteRemoteBlobs]
  );

  const moveFile = useCallback(
    async (hash: string, newFolder: string) => {
      if (!hash) throw new Error(LEGACY_FILE_MESSAGE);
      const file = files.find((f) => f.id === hash);
      if (!file) return;

      const updated: FileMetadata = { ...file, folder: newFolder };
      // saveFileMetadata writes this straight into the shared file-index
      // store (synchronously, before its own network publish), which
      // re-emits the list — no separate optimistic setFiles needed here.
      await saveFileMetadata(updated);
    },
    [files]
  );

  const moveFiles = useCallback(
    async (hashes: string[], newFolder: string) => {
      if (hashes.some((h) => !h)) throw new Error(LEGACY_FILE_MESSAGE);
      const hashSet = new Set(hashes);
      const targetFiles = files.filter((file) => hashSet.has(file.id));

      for (const file of targetFiles) {
        const updated: FileMetadata = { ...file, folder: newFolder };
        await saveFileMetadata(updated);
      }
    },
    [files]
  );

  const renameFile = useCallback(
    async (hash: string, newName: string) => {
      if (!hash) throw new Error(LEGACY_FILE_MESSAGE);
      const file = files.find((f) => f.id === hash);
      if (!file) return;

      const updated: FileMetadata = { ...file, name: newName };
      await saveFileMetadata(updated);
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
          queueUpload(
            importedFile,
            selectedServer,
            importPayload.folderPath,
            getUploadCandidateServers(selectedServer, servers),
            {
              onComplete: () => {
                void removePendingNativeImport(importPayload.id);
              },
            },
          );
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
    servers,
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
      keyReady,
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
      keyReady,
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
      {children}
    </FileIndexContext.Provider>
  );
}
