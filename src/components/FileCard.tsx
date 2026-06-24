import { useState, useEffect, useRef } from "react";
import type { FileMetadata } from "../types/metadata";
import { useFileIndex } from "../hooks/useFileContext";
import { decryptFileWithKey } from "../crypto";
import { createAuthEvent } from "../auth";
import { BlossomClient } from "../blossom";
import { saveFileToDownloads, openDownloadedFile } from "../native/driveManifest";
import { isNativePlatform } from "../utils/platform";
import { ShareDialog } from "./ShareDialog";

interface FileCardProps {
  file: FileMetadata;
  viewMode?: "grid" | "list";
  selected?: boolean;
  onToggleSelection?: (hash: string) => void;
  isShared?: boolean;
}

function getFileIcon(type: string): string {
  if (type.startsWith("image/")) return "img";
  if (type.startsWith("video/")) return "vid";
  if (type.startsWith("audio/")) return "aud";
  if (type === "application/pdf") return "pdf";
  if (type.includes("zip") || type.includes("archive")) return "zip";
  if (type.includes("text") || type.includes("json")) return "txt";
  return "file";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + " GB";
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString();
}

// Session-level preview cache: avoids re-fetching (and re-signing) when
// navigating between folders. Keyed by previewHash → blob URL.
const previewCache = new Map<string, string>();

async function getPreview(file: FileMetadata): Promise<string> {
  if (!file.previewHash) return "";

  const cached = previewCache.get(file.previewHash);
  if (cached) return cached;

  const client = new BlossomClient(file.server);
  const auth = await createAuthEvent("get", `Get preview ${file.previewHash}`, file.previewHash);
  const uint8arr = await client.download(file.previewHash, auth);
  const ciphertext = new TextDecoder().decode(uint8arr as Uint8Array<ArrayBuffer>);
  const decrypted = await decryptFileWithKey(ciphertext, file.encryptionKey);
  const blob = new Blob([decrypted as BlobPart], { type: "image/webp" });
  const imageUrl = URL.createObjectURL(blob);

  previewCache.set(file.previewHash, imageUrl);
  return imageUrl;
}

export function FileCard({
  file,
  viewMode = "list",
  selected = false,
  onToggleSelection,
  isShared = false,
}: FileCardProps) {
  const { deleteFile, moveFile, folders, renameFile } = useFileIndex();
  const [downloading, setDownloading] = useState(false);
  const [downloadedUri, setDownloadedUri] = useState<string | null>(null);
  const [showToast, setShowToast] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [showMoveDialog, setShowMoveDialog] = useState(false);
  const [showRenameModal, setShowRenameModal] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [showShareDialog, setShowShareDialog] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewloaded, setPreviewloaded] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;

    // Check cache first — if cached, set immediately without async work
    if (file.previewHash && previewCache.has(file.previewHash)) {
      setPreview(previewCache.get(file.previewHash)!);
      setPreviewloaded(true);
      return;
    }

    setPreviewloaded(false);
    setPreview(null);

    getPreview(file)
      .then((url) => {
        if (cancelled) return;
        setPreview(url || null);
      })
      .catch(() => {
        if (cancelled) return;
        setPreview(null);
      })
      .finally(() => {
        if (cancelled) return;
        setPreviewloaded(true);
      });

    return () => {
      cancelled = true;
      // Don't revoke — cached URLs are reused across folder navigation
    };
  }, [file]);

  useEffect(() => {
    if (showRenameModal) {
      setTimeout(() => {
        renameInputRef.current?.focus();
        renameInputRef.current?.select();
      }, 0);
    }
  }, [showRenameModal]);

  const handleDownload = async () => {
    setDownloading(true);
    setError(null);
    try {
      const client = new BlossomClient(file.server);
      const auth = await createAuthEvent("get", `Get ${file.hash}`, file.hash);
      const blob = await client.download(file.hash, auth);
      const ciphertext = new TextDecoder().decode(blob);
      const decrypted = await decryptFileWithKey(ciphertext, file.encryptionKey);

      const result = await saveFileToDownloads(decrypted as Uint8Array, file.name, file.type || "application/octet-stream");
      setDownloadedUri(result?.uri ?? null);
      setShowToast(true);
      setTimeout(() => setShowToast(false), 5000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Download failed");
    } finally {
      setDownloading(false);
    }
  };

  const handleDelete = async () => {
    if (confirm(`Delete "${file.name}"?`)) {
      setError(null);
      try {
        await deleteFile(file.hash);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Delete failed");
      }
    }
    setShowMenu(false);
  };

  const handleRenameOpen = () => {
    setRenameValue(file.name);
    setShowRenameModal(true);
    setShowMenu(false);
  };

  const handleRenameSubmit = async () => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== file.name) {
      try {
        await renameFile(file.hash, trimmed);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Rename failed");
      }
    }
    setShowRenameModal(false);
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") handleRenameSubmit();
    if (e.key === "Escape") setShowRenameModal(false);
  };

  const handleMoveClick = () => {
    setShowMenu(false);
    setShowMoveDialog(true);
  };

  const handleMove = async (newFolder: string) => {
    try {
      await moveFile(file.hash, newFolder);
      setShowMoveDialog(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Move failed");
    }
  };

  const icon = getFileIcon(file.type);
  const hasPreview = previewloaded && !!preview;

  const downloadToast = showToast && (
    <div className="download-toast">
      <span>Downloaded successfully</span>
      {isNativePlatform && downloadedUri && (
        <button
          className="download-toast-view"
          onClick={() => openDownloadedFile(downloadedUri, file.type || "application/octet-stream")}
        >
          View
        </button>
      )}
      <button className="download-toast-close" onClick={() => setShowToast(false)}>×</button>
    </div>
  );

  const handleSelectionToggle = () => {
    onToggleSelection?.(file.hash);
  };

  const selectionControl = !isShared ? (
    <label
      className={`file-select ${viewMode === "grid" ? "file-select-tile" : "file-select-list"}`}
      onClick={(e) => e.stopPropagation()}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={handleSelectionToggle}
        aria-label={`Select ${file.name}`}
      />
      <span className="file-select-box" aria-hidden="true" />
    </label>
  ) : null;

  const renameModal = showRenameModal && (
    <div className="move-dialog-overlay" onClick={() => setShowRenameModal(false)}>
      <div className="move-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="move-dialog-header">
          <h3>Rename File</h3>
          <button onClick={() => setShowRenameModal(false)}>×</button>
        </div>
        <div className="move-dialog-body">
          <input
            ref={renameInputRef}
            type="text"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={handleRenameKeyDown}
            className="rename-input"
          />
          <div className="rename-dialog-actions">
            <button onClick={() => setShowRenameModal(false)} className="cancel-btn">
              Cancel
            </button>
            <button onClick={handleRenameSubmit} className="rename-btn">
              Rename
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  const moveDialog = showMoveDialog && (
    <div className="move-dialog-overlay" onClick={() => setShowMoveDialog(false)}>
      <div className="move-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="move-dialog-header">
          <h3>Move to Folder</h3>
          <button onClick={() => setShowMoveDialog(false)}>×</button>
        </div>
        <div className="move-dialog-body">
          <div className="folder-list-move">
            {folders.map((folder) => (
              <button
                key={folder}
                className={`folder-option ${folder === file.folder ? "current" : ""}`}
                onClick={() => handleMove(folder)}
                disabled={folder === file.folder}
              >
                <span className="folder-icon">📁</span>
                <span className="folder-path">{folder}</span>
                {folder === file.folder && <span className="current-badge">Current</span>}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );


  if (viewMode === "grid") {
    return (
      <>
        {showMenu && (
          <div
            className="file-menu-backdrop"
            onClick={() => setShowMenu(false)}
          />
        )}
        <div className={`file-tile ${showMenu ? "menu-open" : ""} ${selected ? "selected" : ""}`}>
          {/* Preview area */}
          <div className={`file-tile-preview ${showMenu ? "menu-open" : ""}`}>
            {selectionControl}
            {hasPreview ? (
              <img src={preview} alt={file.name} className="file-tile-img" />
            ) : null}
            <div
              className="file-tile-icon-fallback"
              style={{ display: hasPreview ? "none" : "flex" }}
            >
              <span className="file-tile-ext">{icon.toUpperCase()}</span>
            </div>

            {/* Hover overlay — pure CSS, no JS hover tracking */}
            <div className="file-tile-overlay">
              <button
                className="tile-action-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  handleDownload();
                }}
                disabled={downloading}
                title="Download"
              >
                {downloading ? "…" : "↓"}
              </button>
              {!isShared && (
                <button
                  className="tile-action-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowMenu((prev) => !prev);
                  }}
                  title="More"
                >
                  ⋮
                </button>
              )}

              {showMenu && !isShared && (
                <div className="file-menu tile-menu" onClick={(e) => e.stopPropagation()}>
                  <button onClick={() => { setShowShareDialog(true); setShowMenu(false); }} className="action-btn">Share</button>
                  <button onClick={handleMoveClick} className="move-btn">Move to Folder</button>
                  <button onClick={handleRenameOpen} className="rename-btn">Rename</button>
                  <button onClick={handleDelete} className="delete-btn">Delete</button>
                </div>
              )}
            </div>
          </div>

          {/* Footer */}
          <div className="file-tile-footer">
            <span className="file-tile-name" title={file.name}>{file.name}</span>
            <span className="file-tile-meta">{formatSize(file.size)} · {formatDate(file.uploadedAt)}</span>
          </div>

          {error && <div className="file-error">{error}</div>}
        </div>
        {showShareDialog && <ShareDialog file={file} onClose={() => setShowShareDialog(false)} />}
        {moveDialog}
        {renameModal}
        {downloadToast}
      </>
    );
  }

  // List view
  return (
    <>
      {showMenu && <div className="file-menu-backdrop" onClick={() => setShowMenu(false)} />}
      <div className={`file-card ${selected ? "selected" : ""}`}>
        {selectionControl}
        {previewloaded && preview ? (
          <div className="file-icon" data-type={icon}>
            <img src={preview} alt="" />
          </div>
        ) : (
          <div className="file-icon" data-type={icon}>
            {icon.toUpperCase()}
          </div>
        )}
        <div className="file-info">
          <span className="file-name" title={file.name}>{file.name}</span>
          <span className="file-meta">{formatSize(file.size)} · {formatDate(file.uploadedAt)}</span>
        </div>
        <div className="file-actions">
          <button className="action-btn" onClick={handleDownload} disabled={downloading} title="Download">
            {downloading ? "..." : "↓"}
          </button>
          {!isShared && (
            <button className="action-btn menu-btn" onClick={() => setShowMenu(!showMenu)} title="More">
              ⋮
            </button>
          )}
          {showMenu && !isShared && (
            <div className="file-menu" onClick={(e) => e.stopPropagation()}>
              <button onClick={() => { setShowShareDialog(true); setShowMenu(false); }} className="action-btn">Share</button>
              <button onClick={handleMoveClick} className="move-btn">Move to Folder</button>
              <button onClick={handleRenameOpen} className="rename-btn">Rename</button>
              <button onClick={handleDelete} className="delete-btn">Delete</button>
            </div>
          )}
        </div>
        {error && <div className="file-error">{error}</div>}
      </div>
      {showShareDialog && <ShareDialog file={file} onClose={() => setShowShareDialog(false)} />}
      {moveDialog}
      {renameModal}
      {downloadToast}
    </>
  );
}
