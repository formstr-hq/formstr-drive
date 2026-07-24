import { useState, useEffect, useRef } from "react";
import type { FileMetadata } from '../../types/metadata';
import { useFileIndex } from '../../hooks/useFileContext';
import { decryptFileWithKey } from '../../crypto';
import { BlossomClient } from '../../blossom';
import { FilePreviewModal } from "./FilePreviewModal";
import { detectMimeTypeFromMagicBytes, getFileIcon, MAX_PREVIEW_SIZE } from '../../utils/fileTypeHelpers';
import { useToast } from '../../hooks/useToast';
import { FILE_HASH_MIME } from '../../utils/constants';
import { formatSize, formatDate, getHostname } from '../../utils/format';
import { PreviewEyeIcon } from '../icons/Icons';
import { queueDownload } from "../../transfers/transferQueue";

interface FileCardProps {
  file: FileMetadata;
  viewMode?: "grid" | "list";
  selected?: boolean;
  onToggleSelection?: (hash: string) => void;
}




function ServerBadge({ server }: { server: string }) {
  return (
    <span className="file-server-badge" title={server}>
      {getHostname(server)}
    </span>
  );
}

interface PreviewData {
  url: string;
  type: string;
}

// Session-level preview cache: avoids re-fetching (and re-signing) when
// navigating between folders. Keyed by previewHash → PreviewData.
const previewCache = new Map<string, PreviewData>();

async function getPreview(file: FileMetadata): Promise<PreviewData | null> {
  if (!file.previewHash) return null;

  const cached = previewCache.get(file.previewHash);
  if (cached) return cached;

  const client = new BlossomClient(file.server);
  const uint8arr = await client.download(file.previewHash);
  const ciphertext = new TextDecoder().decode(uint8arr as Uint8Array<ArrayBuffer>);
  const decrypted = await decryptFileWithKey(ciphertext, file.encryptionKey);
  
  const arr = new Uint8Array(decrypted as any);
  const mimeType = detectMimeTypeFromMagicBytes(arr) || "image/webp";

  const blob = new Blob([decrypted as BlobPart], { type: mimeType });
  const imageUrl = URL.createObjectURL(blob);
  const data = { url: imageUrl, type: mimeType };

  previewCache.set(file.previewHash, data);
  return data;
}

export function FileCard({
  file,
  viewMode = "list",
  selected = false,
  onToggleSelection,
}: FileCardProps) {
  const { deleteFile, moveFile, folders, renameFile } = useFileIndex();
  const toast = useToast();
  const [showMenu, setShowMenu] = useState(false);
  const [showMoveDialog, setShowMoveDialog] = useState(false);
  const [showRenameModal, setShowRenameModal] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [showPreview, setShowPreview] = useState(false);

  const [previewloaded, setPreviewloaded] = useState(false);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const handleTileMouseEnter = () => {
    videoRef.current?.play().catch(() => {});
  };

  const handleTileMouseLeave = () => {
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.currentTime = 0;
    }
  };

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
      .then((data) => {
        if (cancelled) return;
        setPreview(data || null);
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

  const handlePreviewClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    // Surface large-file (>5MB) previews as a per-card inline error instead of
    // opening the modal. Mirrors MAX_PREVIEW_SIZE handling in FilePreviewModal,
    // but kept here so the modal never opens just to show a one-line notice.
    if (file.size > MAX_PREVIEW_SIZE) {
      toast.error("File is too large to preview (over 5 MB). Please download it.");
      return;
    }
    setShowPreview(true);
  };

  const handleDownload = () => {
    // The transfer panel is the source of truth for progress, errors and retry,
    // so there's no success toast here. Only tell the user when the click was a
    // no-op because the file is already downloading.
    const started = queueDownload(file);
    if (!started) {
      toast.info("This file is already downloading");
    }
  };

  const handleDelete = async () => {
    if (confirm(`Delete "${file.name}"?`)) {
      try {
        await deleteFile(file.hash);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Delete failed");
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
        toast.error(e instanceof Error ? e.message : "Rename failed");
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
      toast.error(e instanceof Error ? e.message : "Move failed");
    }
  };

  const icon = getFileIcon(file.type);
  const hasPreview = previewloaded && !!preview;

  const handleSelectionToggle = () => {
    onToggleSelection?.(file.hash);
  };




  const selectionControl = (
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
  );

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
        <div
          className={`file-tile ${showMenu ? "menu-open" : ""} ${selected ? "selected" : ""}`}
          onMouseEnter={handleTileMouseEnter}
          onMouseLeave={handleTileMouseLeave}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(FILE_HASH_MIME, file.hash);
            e.dataTransfer.effectAllowed = "move";
          }}
        >
          {/* Preview area */}
          <div className={`file-tile-preview ${showMenu ? "menu-open" : ""}`}>
            {selectionControl}
            {hasPreview ? (
              preview?.type.startsWith("video/") ? (
                <video
                  ref={videoRef}
                  src={preview.url}
                  className="file-tile-img"
                  muted
                  loop
                  playsInline
                />
              ) : (
                <img src={preview!.url} alt={file.name} className="file-tile-img" />
              )
            ) : null}
            <div
              className="file-tile-icon-fallback"
              data-type={icon}
              style={{ display: hasPreview ? "none" : "flex" }}
            >
              <span className="file-tile-ext">{icon.toUpperCase()}</span>
            </div>

            {/* Hover overlay — pure CSS, no JS hover tracking */}
            <div className="file-tile-overlay">
              <button
                className="tile-action-btn"
                onClick={handlePreviewClick}
                title="Preview"
              >
                <PreviewEyeIcon />
              </button>
              <button
                className="tile-action-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  handleDownload();
                }}
                title="Download"
              >
                ↓
              </button>
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

              {showMenu && (
                <div className="file-menu tile-menu" onClick={(e) => e.stopPropagation()}>
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
            <ServerBadge server={file.server} />
          </div>
        </div>
        {showPreview && <FilePreviewModal file={file} onClose={() => setShowPreview(false)} />}
        {moveDialog}
        {renameModal}
      </>
    );
  }

  // List view
  return (
    <>
      {showMenu && <div className="file-menu-backdrop" onClick={() => setShowMenu(false)} />}
      <div
        className={`file-card ${selected ? "selected" : ""}`}
        onMouseEnter={handleTileMouseEnter}
        onMouseLeave={handleTileMouseLeave}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(FILE_HASH_MIME, file.hash);
          e.dataTransfer.effectAllowed = "move";
        }}
      >
        {selectionControl}
        {previewloaded && preview ? (
          <div className="file-icon" data-type={icon}>
            {preview.type.startsWith("video/") ? (
              <video
                ref={videoRef}
                src={preview.url}
                muted
                loop
                playsInline
              />
            ) : (
              <img src={preview.url} alt="" />
            )}
          </div>
        ) : (
          <div className="file-icon" data-type={icon}>
            {icon.toUpperCase()}
          </div>
        )}
        <div className="file-info">
          <span className="file-name" title={file.name}>{file.name}</span>
          <span className="file-meta">
            {formatSize(file.size)} · {formatDate(file.uploadedAt)}
            <ServerBadge server={file.server} />
          </span>
        </div>
        <div className="file-actions">
          <button className="action-btn" onClick={handleDownload} title="Download">
            ↓
          </button>
          <button 
            className="action-btn" 
            onClick={handlePreviewClick}
            title="Preview"
          >
            <PreviewEyeIcon />
          </button>
          <button className="action-btn menu-btn" onClick={() => setShowMenu(!showMenu)} title="More">
            ⋮
          </button>
          {showMenu && (
            <div className="file-menu" onClick={(e) => e.stopPropagation()}>
              <button onClick={handleMoveClick} className="move-btn">Move to Folder</button>
              <button onClick={handleRenameOpen} className="rename-btn">Rename</button>
              <button onClick={handleDelete} className="delete-btn">Delete</button>
            </div>
          )}
        </div>
      </div>
      {showPreview && <FilePreviewModal file={file} onClose={() => setShowPreview(false)} />}
      {moveDialog}
      {renameModal}
    </>
  );
}
