import {
  createContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import type { FileMetadata } from "../types/metadata";
import {
  fetchFileIndex,
  saveFileMetadata,
  deleteFileMetadata,
  extractFolders,
} from "../services/fileIndex";
import { encryptFileWithKey, encryptFileWithExistingKey } from "../crypto";
import { createAuthEvent } from "../auth";
import { BlossomClient } from "../blossom";
import { useProfileContext } from "../hooks/useProfileContext";
import { previewFile } from "../services/Preview/previewManager";
import { getStoredItem, setStoredItem, STORAGE_KEYS } from "../utils/persistence";
import {
  clearNativeDriveManifest,
  listPendingNativeImports,
  readPendingNativeImport,
  removePendingNativeImport,
  syncNativeDriveManifest,
} from "../native/driveManifest";
import { useBlossomServer } from "../hooks/useBlossomServer";

export interface UploadProgress {
  fileName: string;
  stage: string;
}

export interface UploadProgress {
  fileName: string;
  stage: string;
}

export interface FileIndexContextType {
  files: FileMetadata[];
  folders: string[];
  customFolders: string[];
  addCustomFolder: (path: string) => void;
  currentFolder: string;
  setCurrentFolder: (folder: string) => void;
  loading: boolean;
  error: string | null;
  uploadProgress: UploadProgress | null;
  uploadFile: (file: File, server: string) => Promise<void>;
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
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [customFolders, setCustomFolders] = useState<string[]>([]);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [hasHydratedIndex, setHasHydratedIndex] = useState(false);
  const processingPendingImportsRef = useRef(false);

  const foldersFromFiles = extractFolders(files);
  const folders = Array.from(new Set([...foldersFromFiles, ...customFolders])).sort();

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
      const index = await fetchFileIndex(pubkey);
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

  const uploadPreparedFile = useCallback(
    async (file: File, server: string, targetFolder: string) => {
      setError(null);

      try {
        setUploadProgress({ fileName: file.name, stage: "Reading file..." });
        const bytes = new Uint8Array(await file.arrayBuffer());

        setUploadProgress({ fileName: file.name, stage: "Encrypting..." });
        const { ciphertext, privateKeyHex } = await encryptFileWithKey(bytes);

        setUploadProgress({ fileName: file.name, stage: "Uploading..." });
        const client = new BlossomClient(server);
        const encryptedBytes = new TextEncoder().encode(ciphertext);
        const auth = await createAuthEvent("upload", `Upload ${file.name}`, encryptedBytes);
        const hash = await client.upload(encryptedBytes, auth);

        let previewHash: string | undefined;
        const preview = await previewFile(file);
        if (preview) {
          setUploadProgress({ fileName: file.name, stage: "Uploading preview..." });
          const encrypted = await encryptFileWithExistingKey(preview, privateKeyHex);
          const encryptedPreviewBytes = new TextEncoder().encode(encrypted);
          const previewAuth = await createAuthEvent(
            "upload",
            "Upload preview image",
            encryptedPreviewBytes,
          );
          previewHash = await client.upload(encryptedPreviewBytes, previewAuth);
        }

        setUploadProgress({ fileName: file.name, stage: "Saving metadata..." });
        const metadata: FileMetadata = {
          name: file.name,
          hash,
          size: file.size,
          type: file.type || "application/octet-stream",
          folder: targetFolder,
          uploadedAt: Date.now(),
          server,
          ...(previewHash ? { previewHash } : {}),
          encryptionKey: privateKeyHex,
          encryptionAlgorithm: "aes-gcm",
        };

        await saveFileMetadata(metadata);
        setFiles((prev) => [metadata, ...prev]);
        return metadata;
      } catch (e) {
        const errorMsg = e instanceof Error ? e.message : "Upload failed";
        setError(errorMsg);
        throw e;
      } finally {
        setUploadProgress(null);
      }
    },
    [],
  );

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

      await deleteFileMetadata(hash, file);
      setFiles((prev) => prev.filter((f) => f.hash !== hash));
    },
    [files]
  );

  const deleteFiles = useCallback(
    async (hashes: string[]) => {
      const hashSet = new Set(hashes);
      const targetFiles = files.filter((file) => hashSet.has(file.hash));

      for (const file of targetFiles) {
        await deleteFileMetadata(file.hash, file);
      }

      setFiles((prev) => prev.filter((file) => !hashSet.has(file.hash)));
    },
    [files]
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
        error,
        uploadProgress,
        uploadFile,
        deleteFile,
        deleteFiles,
        moveFile,
        moveFiles,
        renameFile,
        refresh,
      }}
    >
      {children}
    </FileIndexContext.Provider>
  );
}
