import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  getDriveKeyring,
  restoreDriveKey,
  type DriveKeyEntry,
} from "../../services/driveKey";
import "./DriveKeyModal.css";

interface DriveKeyModalProps {
  onClose: () => void;
}

const HEX_64 = /^[0-9a-fA-F]{64}$/;

/**
 * Drive Key import — recovery-only, deliberately one-directional. There is
 * no reveal/copy/export of the active secret here: this modal only ever
 * ACCEPTS a secret the caller already has and holds elsewhere, it never
 * DISPLAYS one back. A raw secp256k1 secret rendered into a copyable text
 * field (even behind a "reveal" toggle) is a real exposure — screen capture,
 * shoulder surfing, a malicious extension reading the DOM — that a
 * key-management UI shouldn't introduce just to make backup convenient.
 * `getDriveKeyring()` is used only for its length (a plain count), never
 * its contents.
 */
export function DriveKeyModal({ onClose }: DriveKeyModalProps) {
  const [keyring, setKeyring] = useState<DriveKeyEntry[] | null>(null);
  const [importValue, setImportValue] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importedOk, setImportedOk] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const kr = await getDriveKeyring();
        if (!cancelled) setKeyring(kr);
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : "Failed to load Drive Key");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
      setImportValue("");
      setImportedOk(true);
      setKeyring(await getDriveKeyring());
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
          <h3>Import Drive Key</h3>
          <button onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="move-dialog-body drive-key-modal-body">
          <p className="drive-key-modal-warning">
            This key encrypts and locates every file in your drive. Paste one you already hold
            (from another device, or to recover after a second key was accidentally created) to
            make it active. This screen never displays or copies a key — only accepts one.
          </p>

          {/* Shown for context only, never blocks the form below — someone
              whose key resolution is failing is exactly who needs to import,
              so the form must stay usable even when this line is an error. */}
          {keyring !== null ? (
            <p className="drive-key-modal-label">
              {keyring.length} key{keyring.length === 1 ? "" : "s"} currently held on this device
            </p>
          ) : (
            loadError && <p className="drive-key-modal-error">{loadError}</p>
          )}

          <div className="drive-key-modal-section">
            <div className="drive-key-modal-field">
              <input
                type="password"
                placeholder="64-character hex secret"
                value={importValue}
                autoComplete="off"
                onChange={(e) => {
                  setImportValue(e.target.value);
                  setImportError(null);
                  setImportedOk(false);
                }}
              />
              <button onClick={() => void handleImport()} disabled={importing || !importValue}>
                {importing ? "Importing…" : "Import"}
              </button>
            </div>
            {importError && <p className="drive-key-modal-error">{importError}</p>}
            {importedOk && (
              <p className="drive-key-modal-hint">Imported. Files under it will appear shortly.</p>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
