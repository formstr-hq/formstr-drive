import { useMemo, useState } from "react";
import type { FileMetadata, ShareRole } from "../types/metadata";
import { useFileIndex } from "../hooks/useFileContext";

interface ShareDialogProps {
  file: FileMetadata;
  onClose: () => void;
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

export function ShareDialog({ file, onClose }: ShareDialogProps) {
  const { createShareLink, revokeShareLink } = useFileIndex();
  const [role, setRole] = useState<ShareRole>("viewer");
  const [canReshare, setCanReshare] = useState(false);
  const [expiresAtLocal, setExpiresAtLocal] = useState("");
  const [password, setPassword] = useState("");
  const [creating, setCreating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [generatedLink, setGeneratedLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const shareLinks = useMemo(() => file.shareLinks ?? [], [file.shareLinks]);

  const handleCreate = async () => {
    setActionError(null);
    setCopied(false);
    setCreating(true);
    try {
      const expiresAt = expiresAtLocal ? new Date(expiresAtLocal).getTime() : undefined;
      if (expiresAt && Number.isNaN(expiresAt)) {
        throw new Error("Invalid expiration date");
      }

      const result = await createShareLink({
        hash: file.hash,
        role,
        canReshare,
        expiresAt,
        password: password.trim() || undefined,
      });

      setGeneratedLink(result.link);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Failed to create link");
    } finally {
      setCreating(false);
    }
  };

  const handleCopy = async () => {
    if (!generatedLink) return;
    await navigator.clipboard.writeText(generatedLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const handleRevoke = async (shareId: string) => {
    setActionError(null);
    try {
      await revokeShareLink(file.hash, shareId);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Failed to revoke link");
    }
  };

  return (
    <div className="share-dialog-overlay" onClick={onClose}>
      <div className="share-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="share-dialog-header">
          <h3>Share {file.name}</h3>
          <button onClick={onClose} aria-label="Close share dialog">
            ×
          </button>
        </div>

        <div className="share-dialog-body">
          <div className="share-form-grid">
            <label>
              Role
              <select value={role} onChange={(event) => setRole(event.target.value as ShareRole)}>
                <option value="viewer">Viewer</option>
                <option value="commenter">Commenter</option>
                <option value="editor">Editor</option>
              </select>
            </label>

            <label>
              Expires at (optional)
              <input
                type="datetime-local"
                value={expiresAtLocal}
                onChange={(event) => setExpiresAtLocal(event.target.value)}
              />
            </label>

            <label>
              Password (optional)
              <input
                type="password"
                value={password}
                placeholder="Require password to open"
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>

            <label className="share-checkbox">
              <input
                type="checkbox"
                checked={canReshare}
                onChange={(event) => setCanReshare(event.target.checked)}
              />
              Allow re-share
            </label>
          </div>

          <div className="share-actions-row">
            <button onClick={handleCreate} disabled={creating}>
              {creating ? "Creating..." : "Create share link"}
            </button>
            {generatedLink && (
              <>
                <input readOnly value={generatedLink} aria-label="Generated share link" />
                <button onClick={handleCopy}>{copied ? "Copied" : "Copy"}</button>
              </>
            )}
          </div>

          {actionError && <div className="share-error">{actionError}</div>}

          <h4>Existing links</h4>
          {shareLinks.length === 0 ? (
            <p className="share-empty">No share links yet.</p>
          ) : (
            <div className="share-link-list">
              {shareLinks.map((share) => {
                const status = share.revokedAt
                  ? "Revoked"
                  : share.policy.expiresAt && share.policy.expiresAt < Date.now()
                    ? "Expired"
                    : "Active";

                return (
                  <div key={share.id} className="share-link-item">
                    <div className="share-link-main">
                      <strong>{status}</strong>
                      <span>Role: {share.policy.role}</span>
                      <span>Re-share: {share.policy.canReshare ? "Yes" : "No"}</span>
                      <span>Created: {formatTimestamp(share.createdAt)}</span>
                      {share.policy.expiresAt && <span>Expires: {formatTimestamp(share.policy.expiresAt)}</span>}
                    </div>
                    {!share.revokedAt && (
                      <button className="share-revoke-btn" onClick={() => handleRevoke(share.id)}>
                        Revoke
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
