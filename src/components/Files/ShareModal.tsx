import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { FileMetadata } from "../../types/metadata";
import { ensureFileShare, ensureFolderShare, type ShareResult } from "../../services/sharing";
import { useToast } from "../../hooks/useToast";
import { useShares } from "../../context/SharesProvider";
import "./ShareModal.css";

type ShareTarget =
  | { mode: "file"; file: FileMetadata }
  | { mode: "folder"; folderName: string; path: string; files: FileMetadata[] };

interface ShareModalProps {
  target: ShareTarget;
  onClose: () => void;
}

/**
 * Generates (or, if the item already has a live one, reuses) a read-only
 * share link on open — NIP-FS "File/Folder Sharing": anyone with the link
 * can view and download, no sign-in required — see docs/NIP-FS.md. Sharing
 * is idempotent: opening this on an already-shared item never publishes a
 * second copy, it just hands back the existing link. Follows the same
 * ad-hoc portal-modal convention as AddAccountModal/FileCard's move & rename
 * dialogs.
 */
export function ShareModal({ target, onClose }: ShareModalProps) {
  const toast = useToast();
  const shares = useShares();
  const [result, setResult] = useState<ShareResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [memberProgress, setMemberProgress] = useState<{ done: number; total: number } | null>(null);

  const label =
    target.mode === "file" ? target.file.name : `"${target.folderName}" folder`;

  useEffect(() => {
    let cancelled = false;

    async function run() {
      setLoading(true);
      setError(null);
      try {
        // Once SharesProvider's initial load has completed, its cached list
        // answers "does this already have a link" synchronously — skipping
        // an ~8s-capped relay round trip on every Share click. Before that
        // first load finishes, an empty cache is indistinguishable from
        // "never shared" and would risk creating a duplicate, so fall back
        // to the network lookup ensureFileShare/ensureFolderShare do on
        // their own when knownEntries is omitted.
        const knownEntries = shares.loaded ? shares.entries : undefined;
        const shareResult =
          target.mode === "file"
            ? await ensureFileShare(target.file, knownEntries)
            : await ensureFolderShare(
                target.folderName,
                target.path,
                target.files,
                (done, total) => {
                  if (!cancelled) setMemberProgress({ done, total });
                },
                knownEntries,
              );
        if (!cancelled) {
          setResult(shareResult);
          shares.refresh();
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to create share link");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
    // Intentionally runs once per mount — target is fixed for the modal's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCopy = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.url);
      setCopied(true);
      toast.success("Link copied to clipboard");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Couldn't copy automatically — select and copy the link manually");
    }
  };

  return createPortal(
    <div className="move-dialog-overlay" onClick={onClose}>
      <div className="move-dialog share-modal" onClick={(e) => e.stopPropagation()}>
        <div className="move-dialog-header">
          <h3>Share {label}</h3>
          <button onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="move-dialog-body">
          {loading && <p className="share-modal-status">Generating share link…</p>}

          {error && (
            <p className="share-modal-status share-modal-error">{error}</p>
          )}

          {result && !loading && (
            <>
              {result.reused && (
                <p className="share-modal-status share-modal-reused">
                  This {target.mode} already has a share link — here it is.
                </p>
              )}
              <p className="share-modal-hint">
                Anyone with this link can view and download {target.mode === "file" ? "this file" : "these files"} —
                no account needed. You can revoke it later from "Shared by me", but anyone who
                already opened it may retain access.
              </p>
              <div className="share-link-row">
                <input
                  type="text"
                  readOnly
                  value={result.url}
                  onFocus={(e) => e.currentTarget.select()}
                  className="share-link-input"
                />
                <button onClick={handleCopy} className="rename-btn">
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              {target.mode === "folder" && memberProgress && memberProgress.done < memberProgress.total && (
                <p className="share-modal-status share-modal-progress">
                  Preparing files… {memberProgress.done} of {memberProgress.total}. The link
                  works now; files appear as they're ready.
                </p>
              )}
              {result.membersUnknown && (
                <p className="share-modal-status share-modal-warning">
                  This folder's link predates update tracking — files added since won't be
                  included automatically.
                </p>
              )}
              {typeof result.pending === "number" && result.pending > 0 && (
                <p className="share-modal-status share-modal-warning">
                  {result.pending} update{result.pending === 1 ? "" : "s"} couldn't be confirmed
                  yet and will retry automatically.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
