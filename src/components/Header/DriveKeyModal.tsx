import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  getDriveKeyring,
  getActiveDriveKey,
  restoreDriveKey,
  type DriveKeyEntry,
} from "../../services/driveKey";
import { useToast } from "../../hooks/useToast";
import "./DriveKeyModal.css";

interface DriveKeyModalProps {
  onClose: () => void;
}

const HEX_64 = /^[0-9a-fA-F]{64}$/;

/**
 * Drive Key backup/export/import. Did not exist before this — the only way
 * to move a Drive Key between devices, or recover after the mint hazard
 * described in restoreDriveKey's doc comment, was a browser devtools console.
 */
export function DriveKeyModal({ onClose }: DriveKeyModalProps) {
  const toast = useToast();
  const [keyring, setKeyring] = useState<DriveKeyEntry[] | null>(null);
  const [activeSecret, setActiveSecret] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [importValue, setImportValue] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [kr, active] = await Promise.all([getDriveKeyring(), getActiveDriveKey()]);
        if (cancelled) return;
        setKeyring(kr);
        setActiveSecret(active.secretKeyHex);
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : "Failed to load Drive Key");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleCopy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.info(`${label} copied to clipboard`);
    } catch {
      toast.error("Could not copy to clipboard");
    }
  };

  const handleImport = async () => {
    const trimmed = importValue.trim();
    if (!HEX_64.test(trimmed)) {
      setImportError("Expected a 64-character hex secret key.");
      return;
    }
    setImportError(null);
    setImporting(true);
    try {
      // Carries the pasted key as ACTIVE (the operator is deliberately
      // restoring/switching to it) plus every secret already in this
      // device's keyring, so importing can never drop a key that was
      // reachable a moment ago — see restoreDriveKey's doc comment for why
      // dropping one here would be the same mint hazard this screen exists
      // to let people recover from.
      const existingSecrets = (keyring ?? []).map((k) => k.secretKeyHex);
      await restoreDriveKey(trimmed, existingSecrets);
      toast.success("Drive Key imported. Reload the page to see files under it.");
      setImportValue("");
      const [kr, active] = await Promise.all([getDriveKeyring(), getActiveDriveKey()]);
      setKeyring(kr);
      setActiveSecret(active.secretKeyHex);
    } catch (e) {
      setImportError(e instanceof Error ? e.message : "Failed to import Drive Key");
    } finally {
      setImporting(false);
    }
  };

  return createPortal(
    <div className="move-dialog-overlay" onClick={onClose}>
      <div className="move-dialog drive-key-modal" onClick={(e) => e.stopPropagation()}>
        <div className="move-dialog-header">
          <h3>Drive Key</h3>
          <button onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="move-dialog-body drive-key-modal-body">
          <p className="drive-key-modal-warning">
            This key encrypts and locates every file in your drive. Anyone who has it can read
            your files; if it's lost with no backup, your files become permanently unreachable —
            there is no password reset. Back it up somewhere safe.
          </p>

          {loadError && <p className="drive-key-modal-error">{loadError}</p>}

          {keyring === null && !loadError && <p>Loading…</p>}

          {keyring !== null && (
            <>
              <div className="drive-key-modal-section">
                <p className="drive-key-modal-label">
                  {keyring.length} key{keyring.length === 1 ? "" : "s"} in this drive's keyring
                  (active key shown below)
                </p>
                <div className="drive-key-modal-field">
                  <input
                    type={revealed ? "text" : "password"}
                    readOnly
                    value={activeSecret ?? ""}
                    aria-label="Active Drive Key secret"
                  />
                  <button onClick={() => setRevealed((r) => !r)}>
                    {revealed ? "Hide" : "Reveal"}
                  </button>
                  <button
                    onClick={() => activeSecret && void handleCopy(activeSecret, "Drive Key")}
                    disabled={!activeSecret}
                  >
                    Copy
                  </button>
                </div>
              </div>

              <div className="drive-key-modal-section">
                <p className="drive-key-modal-label">Import Drive Key</p>
                <p className="drive-key-modal-hint">
                  Paste a Drive Key secret to make it active — for restoring a key from another
                  device, or recovering after a second key was accidentally created. Any key
                  already held here is kept; importing never drops one you can currently reach.
                </p>
                <div className="drive-key-modal-field">
                  <input
                    type="text"
                    placeholder="64-character hex secret"
                    value={importValue}
                    onChange={(e) => {
                      setImportValue(e.target.value);
                      setImportError(null);
                    }}
                  />
                  <button onClick={() => void handleImport()} disabled={importing}>
                    {importing ? "Importing…" : "Import"}
                  </button>
                </div>
                {importError && <p className="drive-key-modal-error">{importError}</p>}
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
