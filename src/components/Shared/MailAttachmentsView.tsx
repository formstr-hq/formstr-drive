import { useEffect, useState } from "react";
import {
  deleteMailAttachmentKey,
  loadMailAttachmentKeys,
  type MailAttachmentKey,
} from "../../services/mailAttachments";
import { useToast } from "../../hooks/useToast";
import "./SharedByMeView.css";
import "../Dialogs/MoveDialog.css";
import "../Dialogs/RenameDialog.css";
import "../ui/Loader.css";

interface MailAttachmentsViewProps {
  onBack: () => void;
}

function FileGenericIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M6 2h8l4 4v16H6z" />
      <path d="M14 2v4h4" />
    </svg>
  );
}

/**
 * The sender-side management list for mail attachments. The mail app retains
 * each attachment's throwaway upload/share signing keys in the encrypted
 * mail-settings event; this view can therefore revoke the share and delete the
 * Blob without ever linking the public share to the user's npub.
 */
export function MailAttachmentsView({ onBack }: MailAttachmentsViewProps) {
  const [items, setItems] = useState<MailAttachmentKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmTarget, setConfirmTarget] = useState<MailAttachmentKey | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const toast = useToast();

  useEffect(() => {
    let alive = true;
    void loadMailAttachmentKeys()
      .then((keys) => {
        if (alive) setItems(keys);
      })
      .catch(() => {
        if (alive) toast.error("Failed to load mail attachment keys");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // Toast is stable; this runs once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function copyKeys(item: MailAttachmentKey) {
    try {
      await navigator.clipboard.writeText(JSON.stringify(item, null, 2));
      toast.success("Keys copied — keep them safe; they can delete this attachment");
    } catch {
      toast.error("Failed to copy keys");
    }
  }

  async function copyLink(item: MailAttachmentKey) {
    try {
      await navigator.clipboard.writeText(item.shareUrl);
      toast.success("Link copied to clipboard");
    } catch {
      toast.error("Failed to copy link");
    }
  }

  async function remove(item: MailAttachmentKey) {
    setConfirmTarget(null);
    setDeleting(item.shareUrl);
    try {
      await deleteMailAttachmentKey(item);
      setItems((prev) => prev.filter((entry) => entry.shareUrl !== item.shareUrl));
      toast.success(`"${item.filename}" revoked and deleted`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to delete attachment");
    } finally {
      setDeleting(null);
    }
  }

  return (
    <div className="shared-by-me">
      <header className="shared-by-me-header">
        <button onClick={onBack} className="back-btn" aria-label="Go back" title="Go back">
          ←
        </button>
        <h2>Mail attachments</h2>
      </header>

      <p className="bulk-action-hint" style={{ padding: "0 16px" }}>
        Attachments you sent by mail. Delete revokes the share link and removes the encrypted
        Blob from Blossom.
      </p>

      {loading ? (
        <div className="loader"></div>
      ) : items.length === 0 ? (
        <div className="shared-by-me-empty">
          <p>No mail attachments have been sent from this account yet.</p>
        </div>
      ) : (
        <div className="shared-by-me-list">
          {items.map((item) => (
            <div key={item.shareUrl} className="shared-by-me-item">
              <div className="shared-by-me-info">
                <span className="shared-by-me-icon" aria-hidden="true">
                  <FileGenericIcon />
                </span>
                <div className="shared-by-me-text">
                  <span className="shared-by-me-name" title={item.filename}>
                    {item.filename}
                  </span>
                  <span className="shared-by-me-date">
                    {new Date(item.createdAt).toLocaleString()}
                    {item.server ? ` · ${item.server}` : ""}
                  </span>
                </div>
              </div>
              <div className="shared-by-me-actions">
                <button
                  className="shared-by-me-copy-btn"
                  onClick={() => void copyKeys(item)}
                  title="Copy the retained throwaway keys"
                >
                  Keys
                </button>
                <button
                  className="shared-by-me-copy-btn"
                  onClick={() => void copyLink(item)}
                >
                  Copy link
                </button>
                <button
                  className="shared-by-me-revoke-btn"
                  onClick={() => setConfirmTarget(item)}
                  disabled={deleting === item.shareUrl}
                >
                  {deleting === item.shareUrl ? "Deleting…" : "Delete"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {confirmTarget && (
        <div className="move-dialog-overlay" onClick={() => setConfirmTarget(null)}>
          <div className="move-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="move-dialog-header">
              <h3>Delete this attachment?</h3>
              <button onClick={() => setConfirmTarget(null)} aria-label="Close">
                ×
              </button>
            </div>
            <div className="move-dialog-body">
              <p className="bulk-action-hint">
                The share link will stop working, and the encrypted Blob will be deleted from{" "}
                {confirmTarget.server}. Anyone who already saved the file can keep their copy.
              </p>
              <div className="rename-dialog-actions">
                <button className="cancel-btn" onClick={() => setConfirmTarget(null)}>
                  Cancel
                </button>
                <button
                  className="shared-by-me-revoke-btn"
                  onClick={() => void remove(confirmTarget)}
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
