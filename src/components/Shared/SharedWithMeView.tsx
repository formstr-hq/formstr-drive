import { useEffect, useState } from "react";
import {
  forgetOpenedShare,
  listOpenedShares,
  type OpenedShare,
} from "../../services/sharedWithMe";
import { FolderIcon } from "../icons/Icons";
import "./SharedByMeView.css";
import "../ui/Loader.css";

interface SharedWithMeViewProps {
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
 * Local history of share links this device has opened. There is deliberately
 * no relay query here: a NIP-FS link is a bearer capability, not a recipient-
 * addressed inbox entry, so the only shares we can honestly call "with me"
 * are the ones this device has actually opened.
 */
export function SharedWithMeView({ onBack }: SharedWithMeViewProps) {
  const [shares, setShares] = useState<OpenedShare[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    void listOpenedShares()
      .then((items) => {
        if (alive) setShares(items);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  function open(share: OpenedShare) {
    try {
      window.location.hash = new URL(share.url).hash;
    } catch {
      window.location.hash = share.url;
    }
  }

  async function remove(url: string) {
    await forgetOpenedShare(url);
    setShares((prev) => prev.filter((item) => item.url !== url));
  }

  return (
    <div className="shared-by-me">
      <header className="shared-by-me-header">
        <button onClick={onBack} className="back-btn" aria-label="Go back" title="Go back">
          ←
        </button>
        <h2>Shared with me</h2>
      </header>

      <p className="bulk-action-hint" style={{ padding: "0 16px" }}>
        Share links you open on this device show up here. This list is local only.
      </p>

      {loading ? (
        <div className="loader"></div>
      ) : shares.length === 0 ? (
        <div className="shared-by-me-empty">
          <p>No shares opened yet. Open a share link and it will appear here.</p>
        </div>
      ) : (
        <div className="shared-by-me-list">
          {shares.map((share) => (
            <div key={share.url} className="shared-by-me-item">
              <div className="shared-by-me-info">
                <span className="shared-by-me-icon" aria-hidden="true">
                  {share.kind === "folder" ? <FolderIcon /> : <FileGenericIcon />}
                </span>
                <div className="shared-by-me-text">
                  <span className="shared-by-me-name" title={share.name}>
                    {share.name}
                  </span>
                  <span className="shared-by-me-date">
                    Opened {new Date(share.openedAt).toLocaleString()}
                  </span>
                </div>
              </div>
              <div className="shared-by-me-actions">
                <button className="shared-by-me-copy-btn" onClick={() => open(share)}>
                  Open
                </button>
                <button className="shared-by-me-revoke-btn" onClick={() => void remove(share.url)}>
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
