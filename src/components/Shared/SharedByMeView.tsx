import { useEffect, useState } from 'react';
import { loadSharedByMe, revokeShare, type SharedByMeEntry } from '../../services/sharing';
import { useToast } from '../../hooks/useToast';
import { useShares } from '../../context/SharesProvider';
import { formatUnixSeconds } from '../../utils/format';
import { FolderIcon } from '../icons/Icons';
import './SharedByMeView.css';
import '../ui/Loader.css';

interface SharedByMeViewProps {
  onBack: () => void;
}

// A "Shared by me" entry only carries a name and kind (not a MIME type — see
// SharedByMeEntry), so file rows use a plain generic document glyph rather
// than the file-type-specific badge FileCard/SharedView use.
function FileGenericIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M6 2h8l4 4v16H6z" />
      <path d="M14 2v4h4" />
    </svg>
  );
}

export const SharedByMeView: React.FC<SharedByMeViewProps> = ({ onBack }) => {
  const [shares, setShares] = useState<SharedByMeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<SharedByMeEntry | null>(null);
  const toast = useToast();
  const { refresh: refreshBadges } = useShares();

  const fetchShares = async () => {
    setLoading(true);
    try {
      const data = await loadSharedByMe();
      setShares(data);
    } catch {
      toast.error('Failed to load shared items');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchShares();
    // Intentionally runs once — toast is a stable useMemo'd api, refetching
    // on every render would just replay the same query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCopyLink = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Link copied to clipboard');
    } catch {
      toast.error('Failed to copy link');
    }
  };

  const handleRevoke = async (entry: SharedByMeEntry) => {
    setConfirmTarget(null);
    setRevoking(entry.infoD);
    try {
      const result = await revokeShare(entry);
      if (result.membersUnknown) {
        toast.info(`"${entry.name}" revoked, but some older files couldn't be confirmed removed.`);
      } else if (result.pending.length > 0) {
        toast.info(`"${entry.name}" revoked — ${result.pending.length} file(s) still retrying.`);
      } else {
        toast.success(`"${entry.name}" is no longer shared.`);
      }
      refreshBadges();
      await fetchShares();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to revoke share');
    } finally {
      setRevoking(null);
    }
  };

  return (
    <div className="shared-by-me">
      <header className="shared-by-me-header">
        <button onClick={onBack} className="back-btn" aria-label="Go back" title="Go back">
          ←
        </button>
        <h2>Shared by me</h2>
      </header>

      {loading ? (
        <div className="loader"></div>
      ) : shares.length === 0 ? (
        <div className="shared-by-me-empty">
          <p>You haven't shared anything yet.</p>
        </div>
      ) : (
        <div className="shared-by-me-list">
          {shares.map((share) => {
            const isRevoked = !!share.revokedAt;
            return (
              <div
                key={share.infoD}
                className={`shared-by-me-item${isRevoked ? ' is-revoked' : ''}`}
              >
                <div className="shared-by-me-info">
                  <span className="shared-by-me-icon" aria-hidden="true">
                    {share.kind === 'folder' ? <FolderIcon /> : <FileGenericIcon />}
                  </span>
                  <div className="shared-by-me-text">
                    <span className="shared-by-me-name" title={share.name}>{share.name}</span>
                    <span className="shared-by-me-date">
                      {isRevoked
                        ? `Revoked ${formatUnixSeconds(share.revokedAt!)}`
                        : `Shared ${formatUnixSeconds(share.sharedAtSeconds)}`}
                    </span>
                  </div>
                </div>
                <div className="shared-by-me-actions">
                  {isRevoked ? (
                    <span className="shared-by-me-revoked-label">Revoked</span>
                  ) : (
                    <>
                      <button
                        className="shared-by-me-copy-btn"
                        onClick={() => handleCopyLink(share.url)}
                      >
                        Copy link
                      </button>
                      <button
                        className="shared-by-me-revoke-btn"
                        onClick={() => setConfirmTarget(share)}
                        disabled={revoking === share.infoD}
                      >
                        {revoking === share.infoD ? 'Revoking…' : 'Revoke'}
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {confirmTarget && (
        <div className="move-dialog-overlay" onClick={() => setConfirmTarget(null)}>
          <div className="move-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="move-dialog-header">
              <h3>Revoke this link?</h3>
              <button onClick={() => setConfirmTarget(null)} aria-label="Close">×</button>
            </div>
            <div className="move-dialog-body">
              <p className="bulk-action-hint">
                The link will stop working for anyone who opens it from now on.
              </p>
              <p className="bulk-action-hint">
                <strong>This does not undo the sharing.</strong> Anyone who already opened the
                link may have saved the file's decryption key and can still download it directly
                from storage. To truly cut off access, re-upload the file (which gives it a new
                key) and delete the old copy.
              </p>
              <div className="rename-dialog-actions">
                <button onClick={() => setConfirmTarget(null)} className="cancel-btn">
                  Cancel
                </button>
                <button
                  onClick={() => void handleRevoke(confirmTarget)}
                  className="shared-by-me-revoke-btn"
                >
                  Revoke link
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
