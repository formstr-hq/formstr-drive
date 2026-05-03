import {
  createContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import type { FileMetadata } from "../types/metadata";
import {
  fetchFileIndex,
  saveFileMetadata,
  deleteFileMetadata,
  extractFolders,
} from "../services/fileIndex";
import { encryptFileWithKey } from "../crypto";
import { createAuthEvent } from "../auth";
import { BlossomClient } from "../blossom";
import { useProfileContext } from "../hooks/useProfileContext";
import { previewFile } from "../services/Preview/previewManager";
import { getStoredItem, setStoredItem, STORAGE_KEYS } from "../utils/persistence";

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

  const [files, setFiles] = useState<FileMetadata[]>([]);
  const [currentFolder, setCurrentFolder] = useState("/");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [customFolders, setCustomFolders] = useState<string[]>([]);
  const [settingsLoaded, setSettingsLoaded] = useState(false);

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
      setLoading(false);
    }
  }, [isSignedIn, pubkey]);

  useEffect(() => {
    if (restoring) return;
    if (isSignedIn) {
      void refresh();
    } else {
      setFiles([]);
    }
  }, [isSignedIn, refresh, restoring]);

  const uploadFile = useCallback(
    async (file: File, server: string) => {
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

        let previewHash: string | undefined = undefined;
        let previewEncryptionKey: string | undefined = undefined;
        const preview = await previewFile(file);
        if (preview) {
          setUploadProgress({ fileName: file.name, stage: "Uploading preview..." });
          const { ciphertext: previewCiphertext, privateKeyHex: previewKeyHex } =
            await encryptFileWithKey(preview);
          const encryptedPreviewBytes = new TextEncoder().encode(previewCiphertext);
          const previewAuth = await createAuthEvent("upload", "Upload preview image", encryptedPreviewBytes);
          previewHash = await client.upload(encryptedPreviewBytes, previewAuth);
          previewEncryptionKey = previewKeyHex;
        }

        setUploadProgress({ fileName: file.name, stage: "Saving metadata..." });
        const metadata: FileMetadata = {
          name: file.name,
          hash,
          size: file.size,
          type: file.type || "application/octet-stream",
          folder: currentFolder,
          uploadedAt: Date.now(),
          server,
          ...(previewHash ? { previewHash } : {}),
          ...(previewEncryptionKey ? { previewEncryptionKey } : {}),
          encryptionKey: privateKeyHex,
        };

        await saveFileMetadata(metadata);
        setFiles((prev) => [metadata, ...prev]);
      } catch (e) {
        const errorMsg = e instanceof Error ? e.message : "Upload failed";
        setError(errorMsg);
        throw e;
      } finally {
        setUploadProgress(null);
      }
    },
    [currentFolder]
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
