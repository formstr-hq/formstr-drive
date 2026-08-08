import { useState, useEffect, useRef } from "react";
import { isLegacyFile, LEGACY_FILE_MESSAGE, type FileMetadata } from '../../types/metadata';
import { useFileIndex } from '../../hooks/useFileContext';
import { decryptFileWithKey } from '../../crypto';
import { BlossomClient } from '../../blossom';
import { FilePreviewModal } from "./FilePreviewModal";
import { detectMimeTypeFromMagicBytes, getFileIcon, MAX_PREVIEW_SIZE } from '../../utils/fileTypeHelpers';
import { useToast } from '../../hooks/useToast';
import { FILE_HASH_MIME } from '../../utils/constants';
import { formatSize, formatDate, getHostname } from '../../utils/format';
import { PreviewEyeIcon, ShareIcon } from '../icons/Icons';
import { queueDownload } from "../../transfers/transferQueue";
import { canvasToBlobWithFallback } from "../../utils/canvas";
import { ShareModal } from "./ShareModal";
import { useShares } from "../../context/SharesProvider";

interface FileCardProps {
  file: FileMetadata;
  viewMode?: "grid" | "list";
  selected?: boolean;
  onToggleSelection?: (hash: string) => void;
  /** Ids to move when THIS card is dragged — the caller's full multi-selection
   *  when this card is part of one, otherwise just `[file.id]`. Defaults to
   *  `[file.id]` so other call sites don't need to opt in. */
  dragIds?: string[];
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
  /** A static (non-animated) frame, only set for image/gif previews — shown
   *  by default so the animation only plays on hover, not continuously in
   *  the file list. Absent (falls back to `url`) if extraction failed. */
  staticUrl?: string;
}

// Session-level preview cache: avoids re-fetching (and re-signing) when
// navigating between folders. Keyed by previewHash → PreviewData.
const previewCache = new Map<string, PreviewData>();

/** Draws `blobUrl`'s current (first) frame to a canvas and re-exports it as a
 *  static webp — used to derive a non-animated poster frame from a GIF. */
async function extractStaticFrame(blobUrl: string): Promise<string> {
  const img = new Image();
  img.src = blobUrl;
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Failed to load image for static frame extraction"));
  });

  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Failed to get canvas 2D context");
  ctx.drawImage(img, 0, 0);

  const blob = await canvasToBlobWithFallback(canvas, 0.8);
  return URL.createObjectURL(blob);
}

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

  let staticUrl: string | undefined;
  if (mimeType === "image/gif") {
    try {
      staticUrl = await extractStaticFrame(imageUrl);
    } catch (e) {
      console.warn("Failed to extract a static frame for GIF preview; it will always animate", e);
    }
  }

  const data: PreviewData = { url: imageUrl, type: mimeType, staticUrl };

  previewCache.set(file.previewHash, data);
  return data;
}

export function FileCard({
  file,
  viewMode = "list",
  selected = false,
  onToggleSelection,
  dragIds,
}: FileCardProps) {
  const { deleteFile, moveFile, folders, renameFile } = useFileIndex();
  const toast = useToast();
  // Files uploaded before the random-id refactor share no resolvable identity
  // (see isLegacyFile) — every action below must be blocked at this layer,
  // since the context functions can only defend against a falsy hash, not
  // against this component handing them one in the first place.
  const isLegacy = isLegacyFile(file);
  const { isFileShared } = useShares();
  const isShared = !isLegacy && isFileShared(file.id);
  const [showMenu, setShowMenu] = useState(false);
  const [showMoveDialog, setShowMoveDialog] = useState(false);
  const [showRenameModal, setShowRenameModal] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [showPreview, setShowPreview] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);

  const [previewloaded, setPreviewloaded] = useState(false);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [isHovering, setIsHovering] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);

  // GIF previews only animate while hovered — shows the static frame
  // otherwise, matching the still-image behavior of every other file type.
  const previewSrc =
    preview?.type === "image/gif" && preview.staticUrl && !isHovering ? preview.staticUrl : preview?.url;

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
    if (isLegacy) {
      toast.error(LEGACY_FILE_MESSAGE);
      return;
    }
    // The transfer panel is the source of truth for progress, errors and retry,
    // so there's no success toast here. Only tell the user when the click was a
    // no-op because the file is already downloading.
    const started = queueDownload(file);
    if (!started) {
      toast.info("This file is already downloading");
    }
  };

  const handleDelete = async () => {
    if (isLegacy) {
      toast.error(LEGACY_FILE_MESSAGE);
      setShowMenu(false);
      return;
    }
    if (confirm(`Delete "${file.name}"?`)) {
      try {
        await deleteFile(file.id);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Delete failed");
      }
    }
    setShowMenu(false);
  };

  const handleRenameOpen = () => {
    if (isLegacy) {
      toast.error(LEGACY_FILE_MESSAGE);
      setShowMenu(false);
      return;
    }
    setRenameValue(file.name);
    setShowRenameModal(true);
    setShowMenu(false);
  };

  const handleRenameSubmit = async () => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== file.name) {
      try {
        await renameFile(file.id, trimmed);
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
    if (isLegacy) {
      toast.error(LEGACY_FILE_MESSAGE);
      setShowMenu(false);
      return;
    }
    setShowMenu(false);
    setShowMoveDialog(true);
  };

  const handleMove = async (newFolder: string) => {
    try {
      await moveFile(file.id, newFolder);
      setShowMoveDialog(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Move failed");
    }
  };

  const handleShareClick = () => {
    if (isLegacy) {
      toast.error(LEGACY_FILE_MESSAGE);
      setShowMenu(false);
      return;
    }
    setShowMenu(false);
    setShowShareModal(true);
  };

  const icon = getFileIcon(file.type);
  const hasPreview = previewloaded && !!preview;

  const handleSelectionToggle = () => {
    // Every legacy file shares the same undefined id — letting one into the
    // selected set would select all of them together and let bulk move/delete
    // act on the wrong files.
    if (isLegacy) {
      toast.error(LEGACY_FILE_MESSAGE);
      return;
    }
    onToggleSelection?.(file.id);
  };




  const selectionControl = (
    <label
      className={`file-select ${viewMode === "grid" ? "file-select-tile" : "file-select-list"}`}
      onClick={(e) => e.stopPropagation()}
    >
      <input
        type="checkbox"
        checked={!isLegacy && selected}
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
          draggable={!isLegacy}
          onDragStart={(e) => {
            e.dataTransfer.setData(FILE_HASH_MIME, (dragIds ?? [file.id]).join(","));
            e.dataTransfer.effectAllowed = "move";
          }}
          onMouseEnter={() => setIsHovering(true)}
          onMouseLeave={() => setIsHovering(false)}
        >
          {/* Preview area */}
          <div className={`file-tile-preview ${showMenu ? "menu-open" : ""}`}>
            {selectionControl}
            {hasPreview ? (
              <img src={previewSrc} alt={file.name} className="file-tile-img" />
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
                className={`tile-action-btn${isShared ? " is-shared" : ""}`}
                onClick={(e) => {
                  e.stopPropagation();
                  handleShareClick();
                }}
                title={isShared ? "Shared — click to manage" : "Share"}
              >
                <ShareIcon />
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
        {showShareModal && (
          <ShareModal target={{ mode: "file", file }} onClose={() => setShowShareModal(false)} />
        )}
      </>
    );
  }

  // List view
  return (
    <>
      {showMenu && <div className="file-menu-backdrop" onClick={() => setShowMenu(false)} />}
      <div
        className={`file-card ${selected ? "selected" : ""}`}
        draggable={!isLegacy}
        onDragStart={(e) => {
          e.dataTransfer.setData(FILE_HASH_MIME, (dragIds ?? [file.id]).join(","));
          e.dataTransfer.effectAllowed = "move";
        }}
        onMouseEnter={() => setIsHovering(true)}
        onMouseLeave={() => setIsHovering(false)}
      >
        {selectionControl}
        {previewloaded && preview ? (
          <div className="file-icon" data-type={icon}>
            <img src={previewSrc} alt="" />
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
          <button
            className={`action-btn${isShared ? " is-shared" : ""}`}
            onClick={handleShareClick}
            title={isShared ? "Shared — click to manage" : "Share"}
          >
            <ShareIcon />
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
      {showShareModal && (
        <ShareModal target={{ mode: "file", file }} onClose={() => setShowShareModal(false)} />
      )}
    </>
  );
}
