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
import { type FileMetadata } from "../types/metadata";
import {
  observeFileIndex,
  extractFolders,
  clearFileIndexStore,
} from "../services/fileIndex";
import { ensureDriveKeyMinted, type DriveKeyIssue, type DriveKeyStatus } from "../services/driveKey";
import {
  getRelayRefresh,
  subscribeRelayRefresh,
} from "../dataLayer/relayRefresh";
import { useProfileContext } from "../hooks/useProfileContext";
import { getStoredItem, setStoredItem, STORAGE_KEYS } from "../utils/persistence";
import { useBlossomServer } from "../hooks/useBlossomServer";
import { useFileMutations, type DeleteResult } from "../hooks/useFileMutations";
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
 *  - "uncertain": Drive Key resolution genuinely doesn't know yet — could not
 *    reach enough of the network to tell whether a key exists, found an
 *    event this build can't read, or a mint attempt failed (e.g. a signer
 *    without NIP-44). NEVER means "confirmed no key" — a proven
 *    first-time user (no key found, and that absence is proven) is `ready`
 *    with an empty file list, not `degraded`; see driveKey.ts's
 *    DriveKeyStatus for how that distinction is established. `degradedMessage`
 *    carries the specific reason instead of a generic line — driveKey.ts
 *    produces several distinct, actionable messages that used to all be
 *    collapsed into one ("keys unavailable") by fileIndex.ts's `.catch`.
 *  - "undecryptable": the keyring resolved with real keys, replay finished,
 *    but at least one file-index event failed to decrypt under it while the
 *    file list came back empty — the signature of the WRONG (but
 *    successfully-resolved) key being active, not of an empty drive.
 *
 * Deliberately NOT included: "this identity has published before" as a reason
 * to distrust an empty list. An identity with a Drive Key but no uploads yet
 * — or with a Nostr profile and a freshly minted Drive Key — has a genuinely,
 * correctly empty drive; flagging that would make every new user's real empty
 * state look suspicious.
 */
export type DriveIndexDegradedReason = "uncertain" | "undecryptable";

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
  /** The specific reason, when `degradedReason === "uncertain"` — driveKey.ts's
   *  actual message, not a generic line. Null otherwise. */
  degradedMessage: string | null;
  /** Which Drive Key problem it is, when `degradedReason === "uncertain"` —
   *  lets the UI offer the one action that fits (e.g. starting a new key
   *  only for "seen-on-device"). Null otherwise. */
  degradedIssue: DriveKeyIssue | null;
  error: string | null;
  deleteFile: (hash: string) => Promise<DeleteResult>;
  deleteFiles: (hashes: string[]) => Promise<DeleteResult>;
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
  const [error, setError] = useState<string | null>(null);
  const [customFolders, setCustomFolders] = useState<string[]>([]);
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  // The raw signals driveStatus is computed from. None of these is
  // meaningful read alone — that was the problem with the flags they
  // replace — so nothing outside the useMemo below should read them
  // directly; everything downstream consumes `driveStatus`/`degradedReason`.
  //
  // null = "Drive Key resolution has not settled yet". Once settled, the full
  // DriveKeyStatus verdict is kept (not just a boolean) so "empty-confirmed"
  // (proven, safe) and "unresolved" (genuinely unknown, carries a reason) stay
  // distinguishable all the way to the UI.
  const [keyStatus, setKeyStatus] = useState<DriveKeyStatus | null>(null);
  // Which identity `keyStatus` describes — see the subscription effect.
  const keyStatusPubkeyRef = useRef<string | null>(null);
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
  // the raw signals above by hand — see DriveIndexStatus's doc comment for
  // what each branch means and why an identity's publishing history is
  // deliberately NOT consulted here.
  //
  // "empty-confirmed" deliberately falls through to the SAME hydration/
  // decrypt-failure checks as "ready" rather than being its own terminal
  // branch: a proven-empty keyring still needs the file-index subscription
  // to hydrate before the (correctly empty) file list can be trusted, same
  // as any other keyring would.
  const { driveStatus, degradedReason, degradedMessage, degradedIssue } = useMemo<{
    driveStatus: DriveIndexStatus;
    degradedReason: DriveIndexDegradedReason | null;
    degradedMessage: string | null;
    degradedIssue: DriveKeyIssue | null;
  }>(() => {
    const none = { degradedReason: null, degradedMessage: null, degradedIssue: null };
    if (keyStatus === null) return { driveStatus: "resolving", ...none };
    if (keyStatus.kind === "unresolved") {
      return {
        driveStatus: "degraded",
        degradedReason: "uncertain",
        degradedMessage: keyStatus.reason,
        degradedIssue: keyStatus.issue,
      };
    }
    if (!hydrated) return { driveStatus: "resolving", ...none };
    if (files.length === 0 && hadDecryptFailures) {
      return { driveStatus: "degraded", ...none, degradedReason: "undecryptable" };
    }
    return { driveStatus: "ready", ...none };
  }, [keyStatus, hydrated, hadDecryptFailures, files.length]);

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
      // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronous reset when the subscription key changes
      setFiles([]);
      setKeyStatus(null);
      keyStatusPubkeyRef.current = null;
      setHydrated(false);
      setHadDecryptFailures(false);
      return;
    }

    // Fresh subscription: none of the file-index signals from a previous
    // subscription is valid evidence about this one. The key verdict is kept
    // across a re-check of the SAME identity (retry, relay refresh) until the
    // new one arrives — clearing it would flip a degraded screen to
    // "resolving" and back every auto-retry, resetting anything the user was
    // in the middle of there.
    if (keyStatusPubkeyRef.current !== pubkey) setKeyStatus(null);
    keyStatusPubkeyRef.current = pubkey;
    setHydrated(false);
    setHadDecryptFailures(false);
    setError(null);

    let active = true;
    const unobserve = observeFileIndex(pubkey, {
      onFiles: setFiles,
      onKeyStatus: (status) => {
        setKeyStatus(status);
        // The ONE place this fires from: a PROVEN empty keyring, reported by
        // the read path itself, never a guess or a timeout. ensureDriveKeyMinted
        // is idempotent per identity (in-session + persisted guards), so
        // calling it again on every relayRefresh-triggered resubscribe is
        // harmless — it only ever actually mints once. A failed mint would
        // otherwise leave a "ready" empty drive that can't upload, so it's
        // surfaced as uncertain instead, which also arms the auto-retry below.
        if (status.kind === "empty-confirmed") {
          void ensureDriveKeyMinted().then((result) => {
            if (active && !result.ok) {
              setKeyStatus({ kind: "unresolved", reason: result.reason, issue: result.issue });
            }
          });
        }
      },
      onReady: () => setHydrated(true),
      onDecryptFailures: () => setHadDecryptFailures(true),
    });

    return () => {
      active = false;
      unobserve();
    };
  }, [isSignedIn, pubkey, restoring, relayRefresh, manualRefreshCount]);

  // With a standing observe the worker keeps the index synced on its own;
  // a manual refresh just re-declares the interest (cache replay + re-sync).
  const refresh = useCallback(async () => {
    if (!isSignedIn || !pubkey) return;
    setManualRefreshCount((n) => n + 1);
  }, [isSignedIn, pubkey]);

  // Auto-retry while genuinely uncertain (see DriveIndexDegradedReason —
  // "uncertain" means the network hasn't yet proven either a key exists or
  // that it definitely doesn't; a relay that's temporarily unreachable — the
  // whole reason this state exists — can recover at any moment on its own).
  // Without this, a user who first opens the drive during a relay outage
  // would stay stuck until they manually clicked Retry, even long after the
  // relay came back — resolveDriveKeyStatusCached() deliberately never
  // caches "unresolved" so each of these re-checks gets a genuinely fresh
  // answer, not a stale one.
  useEffect(() => {
    if (driveStatus !== "degraded" || degradedReason !== "uncertain") return;
    const interval = setInterval(() => {
      void refresh();
    }, 20000);
    return () => clearInterval(interval);
  }, [driveStatus, degradedReason, refresh]);

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
    servers,
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
      degradedMessage,
      degradedIssue,
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
      degradedMessage,
      degradedIssue,
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
