import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { loadSharedByMe, type SharedByMeEntry } from "../services/sharing";
import { useProfileContext } from "../hooks/useProfileContext";

export interface SharesApi {
  /** True if this file currently has a live (non-revoked) share link. */
  isFileShared: (fileId: string) => boolean;
  /** True if this folder path currently has a live (non-revoked) share link. */
  isFolderShared: (path: string) => boolean;
  /** Re-fetches the share list — call after creating or revoking a share so
   *  badges update without waiting for the next full reload. */
  refresh: () => void;
  /** The full "Shared by me" list as of the last (re)load. Pass this to
   *  ensureFileShare/ensureFolderShare's `knownEntries` param so opening the
   *  Share modal on an already-shared item skips a fresh ~8s-capped relay
   *  query — only meaningful once `loaded` is true; see that field. */
  entries: SharedByMeEntry[];
  /** False until the first load (or a refresh()) has completed. Callers
   *  MUST NOT treat an empty `entries` as "nothing is shared" while this is
   *  false — that's indistinguishable from "haven't checked yet" and would
   *  risk creating a duplicate share. */
  loaded: boolean;
}

const SharesContext = createContext<SharesApi | null>(null);

/**
 * Loads the user's "Shared by me" list once (and on refresh()) and indexes
 * it by drive item, so FileCard / FolderSidebar / FileList can cheaply show
 * a "this is shared" badge without each one re-querying relays. Also what
 * makes ShareModal's "does this already have a link" check fast on open.
 */
export function SharesProvider({ children }: { children: ReactNode }) {
  const { isSignedIn } = useProfileContext();
  const [entries, setEntries] = useState<SharedByMeEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!isSignedIn) {
      setEntries([]);
      setLoaded(false);
      return;
    }
    let cancelled = false;
    void loadSharedByMe()
      .then((result) => {
        if (!cancelled) {
          setEntries(result);
          setLoaded(true);
        }
      })
      .catch((e) => {
        console.warn("[SharesProvider] Failed to load shared-by-me list", e);
        if (!cancelled) {
          setEntries([]);
          setLoaded(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isSignedIn, version]);

  const fileIds = useMemo(() => {
    const ids = new Set<string>();
    for (const e of entries) {
      if (!e.revokedAt && e.source?.type === "file") ids.add(e.source.id);
    }
    return ids;
  }, [entries]);

  const folderPaths = useMemo(() => {
    const paths = new Set<string>();
    for (const e of entries) {
      if (!e.revokedAt && e.source?.type === "folder") paths.add(e.source.path);
    }
    return paths;
  }, [entries]);

  const value = useMemo<SharesApi>(
    () => ({
      isFileShared: (fileId) => fileIds.has(fileId),
      isFolderShared: (path) => folderPaths.has(path),
      refresh: () => setVersion((v) => v + 1),
      entries,
      loaded,
    }),
    [fileIds, folderPaths, entries, loaded],
  );

  return <SharesContext.Provider value={value}>{children}</SharesContext.Provider>;
}

export function useShares(): SharesApi {
  const context = useContext(SharesContext);
  if (!context) {
    throw new Error("useShares must be used within a SharesProvider");
  }
  return context;
}
