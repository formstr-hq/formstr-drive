import { useState } from "react";
import { nip19 } from "nostr-tools";
import type { FileMetadata } from "../types/metadata";
import { shareFileMetadata } from "../services/fileIndex";

interface ShareDialogProps {
  file: FileMetadata;
  onClose: () => void;
}

export function ShareDialog({ file, onClose }: ShareDialogProps) {
  const [recipient, setRecipient] = useState("");
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleShare = async () => {
    setError(null);
    setSuccess(false);

    let pubkey = recipient.trim();
    if (!pubkey) {
      setError("Please enter a valid npub or hex pubkey");
      return;
    }

    try {
      if (pubkey.startsWith("npub1")) {
        const decoded = nip19.decode(pubkey);
        if (decoded.type !== "npub") {
          throw new Error("Invalid npub");
        }
        pubkey = decoded.data as string;
      } else if (pubkey.length !== 64 || !/^[0-9a-f]+$/i.test(pubkey)) {
        throw new Error("Invalid hex pubkey");
      }

      setSharing(true);
      await shareFileMetadata(pubkey, file);
      setSuccess(true);
      setRecipient("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to share file");
    } finally {
      setSharing(false);
    }
  };

  // Public share links are meant to be decrypted by the person clicking the link using the key directly.
  const publicLink = `${window.location.origin}/#hash=${file.hash}&server=${encodeURIComponent(file.server)}&key=${file.encryptionKey}&name=${encodeURIComponent(file.name)}&type=${encodeURIComponent(file.type)}`;

  const handleCopyLink = () => {
    navigator.clipboard.writeText(publicLink);
    alert("Public link copied to clipboard!");
  };

  return (
    <div className="move-dialog-overlay" onClick={onClose}>
      <div className="move-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="move-dialog-header">
          <h3>Share "{file.name}"</h3>
          <button onClick={onClose}>×</button>
        </div>
        <div className="move-dialog-body" style={{ padding: "20px" }}>
          
          <div style={{ marginBottom: "20px" }}>
            <h4>Secure Sharing (NIP-44)</h4>
            <p style={{ fontSize: "12px", color: "var(--text-secondary)", marginBottom: "10px" }}>
              Share directly to a Nostr user. They will see this file in their "Shared With Me" tab.
            </p>
            <input
              type="text"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder="Enter npub or hex pubkey..."
              className="rename-input"
              style={{ width: "100%", boxSizing: "border-box" }}
            />
            <button 
              onClick={handleShare} 
              disabled={sharing}
              className="action-btn"
              style={{ width: "100%", marginTop: "10px", padding: "10px", backgroundColor: "var(--primary-color)", color: "white" }}
            >
              {sharing ? "Sharing..." : "Share via Nostr"}
            </button>
            {error && <div style={{ color: "var(--error-color)", marginTop: "10px", fontSize: "14px" }}>{error}</div>}
            {success && <div style={{ color: "var(--success-color, green)", marginTop: "10px", fontSize: "14px" }}>File shared successfully!</div>}
          </div>

          <hr style={{ border: "1px solid var(--border-color)", margin: "20px 0" }} />

          <div>
            <h4>Public Share Link</h4>
            <p style={{ fontSize: "12px", color: "var(--text-secondary)", marginBottom: "10px" }}>
              Anyone with this link can view and download the file. The decryption key is included in the URL fragment.
            </p>
            <div style={{ display: "flex", gap: "10px" }}>
              <input
                type="text"
                readOnly
                value={publicLink}
                className="rename-input"
                style={{ flex: 1 }}
              />
              <button className="action-btn" onClick={handleCopyLink} style={{ padding: "0 15px" }}>Copy</button>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
