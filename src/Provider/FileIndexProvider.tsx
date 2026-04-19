import {
  createContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import type { FileMetadata, ShareLink, ShareRole } from "../types/metadata";
import {
  fetchFileIndex,
  saveFileMetadata,
  deleteFileMetadata,
  extractFolders,
  publishPublicShareEvent,
} from "../services/fileIndex";
import { encryptFileWithKey , encryptFile } from "../crypto";
import { createAuthEvent } from "../auth";
import { BlossomClient } from "../blossom";
import { useProfileContext } from "../hooks/useProfileContext";
import { previewFile } from "../services/Preview/previewManager";
import {
  buildShareLink,
  createPasswordVerifier,
  createShareToken,
} from "../utils/shareTokens";

const CUSTOM_FOLDERS_KEY = "formstr-drive-custom-folders";

export interface FileIndexContextType {
  files: FileMetadata[];
  folders: string[];
  customFolders: string[];
  addCustomFolder: (path: string) => void;
  currentFolder: string;
  setCurrentFolder: (folder: string) => void;
  loading: boolean;
  error: string | null;
  uploadFile: (file: File, server: string) => Promise<void>;
  deleteFile: (hash: string) => Promise<void>;
  moveFile: (hash: string, newFolder: string) => Promise<void>;
  renameFile: (hash: string, newName: string) => Promise<void>;
  createShareLink: (input: {
    hash: string;
    role: ShareRole;
    canReshare: boolean;
    expiresAt?: number;
    password?: string;
  }) => Promise<{ link: string; share: ShareLink }>;
  revokeShareLink: (hash: string, shareId: string) => Promise<void>;
  refresh: () => Promise<void>;
}

export const FileIndexContext = createContext<FileIndexContextType | null>(null);

export function FileIndexProvider({ children }: { children: ReactNode }) {
  const { isSignedIn , pubkey } = useProfileContext();

  const [files, setFiles] = useState<FileMetadata[]>([]);
  const [currentFolder, setCurrentFolder] = useState("/");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [customFolders, setCustomFolders] = useState<string[]>(() => {
    const stored = localStorage.getItem(CUSTOM_FOLDERS_KEY);
    return stored ? JSON.parse(stored) : [];
  });

  const foldersFromFiles = extractFolders(files);
  const folders = Array.from(new Set([...foldersFromFiles, ...customFolders])).sort();

  useEffect(() => {
    localStorage.setItem(CUSTOM_FOLDERS_KEY, JSON.stringify(customFolders));
  }, [customFolders]);

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
    if (isSignedIn) {
      refresh();
    } else {
      setFiles([]);
    }
  }, [isSignedIn, refresh]);

  const uploadFile = useCallback(
    async (file: File, server: string) => {
      setError(null);
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const { ciphertext, privateKeyHex } = await encryptFileWithKey(bytes);

        const client = new BlossomClient(server);
        const encryptedBytes = new TextEncoder().encode(ciphertext);
        const auth = await createAuthEvent("upload", `Upload ${file.name}`, encryptedBytes);
        const hash = await client.upload(encryptedBytes, auth);

        let previewHash: string | undefined = undefined;
        const preview = await previewFile(file);
        if (preview) {
          const encrypted = await encryptFile(preview);
          const encryptedPreviewBytes = new TextEncoder().encode(encrypted);
          const previewAuth = await createAuthEvent("upload", "Upload preview image", encryptedPreviewBytes);
          previewHash = await client.upload(encryptedPreviewBytes, previewAuth);
        }
        const metadata: FileMetadata = {
          name: file.name,
          hash,
          size: file.size,
          type: file.type || "application/octet-stream",
          folder: currentFolder,
          uploadedAt: Date.now(),
          server,
          ...(previewHash ? { previewHash } : {}),
          encryptionKey: privateKeyHex,
        };

        await saveFileMetadata(metadata);
        setFiles((prev) => [metadata, ...prev]);
      } catch (e) {
        const errorMsg = e instanceof Error ? e.message : "Upload failed";
        setError(errorMsg);
        throw e;
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

  const createShareLink = useCallback(
    async (input: {
      hash: string;
      role: ShareRole;
      canReshare: boolean;
      expiresAt?: number;
      password?: string;
    }) => {
      const file = files.find((f) => f.hash === input.hash);
      if (!file) {
        throw new Error("File not found");
      }

      const token = createShareToken();
      const now = Date.now();

      const passwordConfig = input.password
        ? await createPasswordVerifier(input.password)
        : undefined;

      const share: ShareLink = {
        id: token.shareId,
        createdAt: now,
        capabilitySecret: token.secret,
        policy: {
          role: input.role,
          canReshare: input.canReshare,
          requiresPassword: !!input.password,
          ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
          ...(passwordConfig
            ? {
                passwordSalt: passwordConfig.salt,
                passwordVerifier: passwordConfig.verifier,
              }
            : {}),
        },
      };

      const updated: FileMetadata = {
        ...file,
        shareLinks: [share, ...(file.shareLinks ?? [])],
      };

      await Promise.all([
        saveFileMetadata(updated),
        publishPublicShareEvent(
          {
            shareId: token.shareId,
            fileHash: file.hash,
            fileName: file.name,
            fileType: file.type,
            fileSize: file.size,
            server: file.server,
            encryptionKey: file.encryptionKey,
            createdAt: now,
            policy: share.policy,
          },
          token.secret
        ),
      ]);
      setFiles((prev) => prev.map((f) => (f.hash === input.hash ? updated : f)));

      return {
        link: buildShareLink(window.location.origin, {
          shareId: token.shareId,
          secret: token.secret,
        }),
        share,
      };
    },
    [files]
  );

  const revokeShareLink = useCallback(
    async (hash: string, shareId: string) => {
      const file = files.find((f) => f.hash === hash);
      if (!file) {
        throw new Error("File not found");
      }

      const shareLinks = file.shareLinks ?? [];
      const existingShare = shareLinks.find((share) => share.id === shareId);
      if (!existingShare) {
        throw new Error("Share not found");
      }

      if (!existingShare.capabilitySecret) {
        throw new Error("Cannot revoke legacy share without stored capability key");
      }

      const revokedAt = Date.now();

      const updated: FileMetadata = {
        ...file,
        shareLinks: shareLinks.map((share) =>
          share.id === shareId ? { ...share, revokedAt } : share
        ),
      };

      await Promise.all([
        saveFileMetadata(updated),
        publishPublicShareEvent(
          {
            shareId: existingShare.id,
            fileHash: file.hash,
            fileName: file.name,
            fileType: file.type,
            fileSize: file.size,
            server: file.server,
            encryptionKey: file.encryptionKey,
            createdAt: existingShare.createdAt,
            revokedAt,
            policy: existingShare.policy,
          },
          existingShare.capabilitySecret
        ),
      ]);
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
        uploadFile,
        deleteFile,
        moveFile,
        renameFile,
        createShareLink,
        revokeShareLink,
        refresh,
      }}
    >
      {children}
    </FileIndexContext.Provider>
  );
}