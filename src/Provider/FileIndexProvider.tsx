import {
  createContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { type FileMetadata } from "../types/metadata";
import {
  observeFileIndex,
  extractFolders,
  clearFileIndexStore,
} from "../services/fileIndex";
import {
  getRelayRefresh,
  subscribeRelayRefresh,
} from "../dataLayer/relayRefresh";
import { useProfileContext } from "../hooks/useProfileContext";
import { getStoredItem, setStoredItem, STORAGE_KEYS } from "../utils/persistence";
import { useBlossomServer } from "../hooks/useBlossomServer";
import { useFileMutations } from "../hooks/useFileMutations";
import { useMetadataOutboxDrain } from "../hooks/useMetadataOutboxDrain";
import { useNativeManifestSync } from "../hooks/useNativeManifestSync";
import { useNativeTransferAdoption } from "../hooks/useNativeTransferAdoption";
import { usePendingNativeImports } from "../hooks/usePendingNativeImports";
import { useTransferExitWarning } from "../hooks/useTransferExitWarning";

// Re-export type if needed anywhere else
export type { FileMetadata };

/**
 * Replaces three independent booleans (`loading`, `hasHydratedIndex`,
 * `keyReady`) that used to have to be combined in the right order to reach a
 * correct conclusion — nothing enforced that order, and the wrong one is
 * exactly what let a failed Drive Key resolution silently read as "confirmed
 * empty drive" (see the WARNING doc below). This union makes the two
 * findings the DriveState below reflects unrepresentable by mistake:
 *
 *  - "resolving": not enough is known yet to render either files or an
 *    empty-drive conclusion. The UI should show a loading state, full stop.
 *  - "degraded": we have SOME information (`files` may be non-empty from a
 *    partial replay) but cannot currently vouch for completeness — see
 *    `DriveIndexDegradedReason`. An EMPTY `files` here must never be shown
 *    as "no files exist"; it means "couldn't confirm".
 *  - "ready": `files` is the confirmed, complete current list. An empty
 *    array here is a genuine, trustworthy empty drive.
 */
export type DriveIndexStatus = "resolving" | "degraded" | "ready";

/**
 * Why `status` is "degraded" — always paired with `status`, never read alone.
 *  - "keys-unavailable": the Drive Key keyring failed to resolve, or
 *    resolved to zero usable keys. Previously this was silently swallowed
 *    into an empty keyring (`getDriveConversationKeys().catch(() => [])`
 *    in fileIndex.ts), which then produced an empty — and entirely
 *    believable — file list. This is the exact gap the mint-hazard
 *    incident exposed.
 *  - "undecryptable": the keyring resolved with keys, replay finished, but
 *    at least one file-index event failed to decrypt under it while the
 *    file list came back empty — the signature of the WRONG (but
 *    successfully-resolved) key being active, not of an empty drive.
 *
 * Deliberately NOT included: "identity has no prior history" as a reason to
 * distrust an empty list. That signal (identityHistory.ts) answers "should
 * we ever mint a replacement key" correctly, but it is too coarse for this
 * decision — an identity that has published a Drive Key event but never
 * uploaded a single file is `existing` by that check and STILL has a
 * genuinely, correctly empty drive. Using it here would flag every
 * brand-new user's real empty state as suspicious the moment their own
 * key-creation event round-trips back to them.
 */
export type DriveIndexDegradedReason = "keys-unavailable" | "undecryptable";

export interface FileIndexContextType {
  files: FileMetadata[];
  folders: string[];
  customFolders: string[];
  addCustomFolder: (path: string) => void;
  currentFolder: string;
  setCurrentFolder: (folder: string) => void;
  driveStatus: DriveIndexStatus;
  /** Non-null exactly when `driveStatus === "degraded"`. */
  degradedReason: DriveIndexDegradedReason | null;
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
  const [error, setError] = useState<string | null>(null);
  const [customFolders, setCustomFolders] = useState<string[]>([]);
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  // The three raw signals driveStatus is computed from. None of these is
  // meaningful read alone — that was the problem with the flags they
  // replace — so nothing outside the useMemo below should read them
  // directly; everything downstream consumes `driveStatus`/`degradedReason`.
  //
  // null = "the keyring attempt has not settled yet" (distinct from `false`,
  // which is a confirmed empty/failed resolution — see onKeyStatus below).
  const [hasKeys, setHasKeys] = useState<boolean | null>(null);
  // True once at least one EOSE has been received for the current
  // subscription — the local relay's cache-or-network replay is done.
  const [hydrated, setHydrated] = useState(false);
  // True once at least one file-index event under the current keyring
  // failed to decrypt. Reset per subscription (sign-in / relay refresh /
  // manual refresh), not per-file, since it is evidence about the KEYRING,
  // not about any specific file.
  const [hadDecryptFailures, setHadDecryptFailures] = useState(false);

  const [manualRefreshCount, setManualRefreshCount] = useState(0);

  // The single source of truth every consumer must use instead of combining
  // the three raw signals above by hand — see DriveIndexStatus's doc comment
  // for what each branch means and why identityHistory is deliberately NOT
  // consulted here (it is the right signal for driveKey.ts's mint decision,
  // and the wrong one for this: an existing identity's genuinely-empty
  // drive must never be flagged as suspicious just because that identity
  // has published something, anything, before).
  const { driveStatus, degradedReason } = useMemo<{
    driveStatus: DriveIndexStatus;
    degradedReason: DriveIndexDegradedReason | null;
  }>(() => {
    if (hasKeys === null) return { driveStatus: "resolving", degradedReason: null };
    if (!hasKeys) return { driveStatus: "degraded", degradedReason: "keys-unavailable" };
    if (!hydrated) return { driveStatus: "resolving", degradedReason: null };
    if (files.length === 0 && hadDecryptFailures) {
      return { driveStatus: "degraded", degradedReason: "undecryptable" };
    }
    return { driveStatus: "ready", degradedReason: null };
  }, [hasKeys, hydrated, hadDecryptFailures, files.length]);

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
      setHasKeys(null);
      setHydrated(false);
      setHadDecryptFailures(false);
      return;
    }

    // Fresh subscription: none of the three raw signals from a previous
    // identity/subscription is valid evidence about this one.
    setHasKeys(null);
    setHydrated(false);
    setHadDecryptFailures(false);
    setError(null);

    const unobserve = observeFileIndex(pubkey, {
      onFiles: setFiles,
      onKeyStatus: setHasKeys,
      onReady: () => setHydrated(true),
      onDecryptFailures: () => setHadDecryptFailures(true),
    });

    return unobserve;
  }, [isSignedIn, pubkey, restoring, relayRefresh, manualRefreshCount]);

  // With a standing observe the worker keeps the index synced on its own;
  // a manual refresh just re-declares the interest (cache replay + re-sync).
  const refresh = useCallback(async () => {
    if (!isSignedIn || !pubkey) return;
    setManualRefreshCount((n) => n + 1);
  }, [isSignedIn, pubkey]);

  const { deleteFile, deleteFiles, moveFile, moveFiles, renameFile } =
    useFileMutations(files);

  useTransferExitWarning();
  useNativeTransferAdoption();
  useMetadataOutboxDrain({ isSignedIn, pubkey, restoring, relayRefresh });
  useNativeManifestSync({
    files,
    customFolders,
    isSignedIn,
    pubkey,
    restoring,
    settingsLoaded,
    indexReady: driveStatus === "ready",
  });
  usePendingNativeImports({
    isSignedIn,
    pubkey,
    restoring,
    settingsLoaded,
    indexReady: driveStatus === "ready",
    selectedServer,
    onError: setError,
  });

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
      driveStatus,
      degradedReason,
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
      driveStatus,
      degradedReason,
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
