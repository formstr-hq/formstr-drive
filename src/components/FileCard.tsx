import { useState } from "react";
import type { FileMetadata } from "../types/metadata";
import { useFileIndex } from "../hooks/useFileContext";
import { decryptFileWithKey } from "../crypto";
import { createAuthEvent } from "../auth";
import { BlossomClient } from "../blossom";

interface FileCardProps {
  file: FileMetadata;
  viewMode?: "grid" | "list";
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

export function FileCard({ file, viewMode = "list" }: FileCardProps) {
  const { deleteFile, moveFile, folders } = useFileIndex();
  const [downloading, setDownloading] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [showMoveDialog, setShowMoveDialog] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDownload = async () => {
    setDownloading(true);
    setError(null);
    try {
      const client = new BlossomClient(file.server);
      const auth = await createAuthEvent("get", `Get ${file.hash}`);
      const blob = await client.download(file.hash, auth);
      const ciphertext = new TextDecoder().decode(blob);
      const decrypted = await decryptFileWithKey(ciphertext, file.encryptionKey);

      const url = URL.createObjectURL(new Blob([decrypted as BlobPart], { type: file.type }));
      const a = document.createElement("a");
      a.href = url;
      a.download = file.name;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Download failed");
    } finally {
      setDownloading(false);
    }
  };

  const handleDelete = async () => {
    if (confirm(`Delete "${file.name}"?`)) {
      await deleteFile(file.hash);
    }
    setShowMenu(false);
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
  const isImage = file.type.startsWith("image/");

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
        <div className="file-tile">
          {/* Preview area */}
          <div className="file-tile-preview">
            {isImage ? (
              <img
                src={`${file.server}/${file.hash}`}
                alt={file.name}
                className="file-tile-img"
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.display = "none";
                  (e.currentTarget.nextElementSibling as HTMLElement)!.style.display = "flex";
                }}
              />
            ) : null}
            <div
              className="file-tile-icon-fallback"
              style={{ display: isImage ? "none" : "flex" }}
            >
              <span className="file-tile-ext">{icon.toUpperCase()}</span>
            </div>

            {/* Hover overlay */}
            <div className="file-tile-overlay">
              <button
                className="tile-action-btn"
                onClick={handleDownload}
                disabled={downloading}
                title="Download"
              >
                {downloading ? "…" : "↓"}
              </button>
              <button
                className="tile-action-btn"
                onClick={() => setShowMenu(!showMenu)}
                title="More"
              >
                ⋮
              </button>
              {showMenu && (
                <div className="file-menu tile-menu">
                  <button onClick={handleMoveClick} className="move-btn">Move to Folder</button>
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
        {moveDialog}
      </>
    );
  }


  return (
    <>
      <div className="file-card">
        <div className="file-icon" data-type={icon}>
          {icon.toUpperCase()}
        </div>
        <div className="file-info">
          <span className="file-name" title={file.name}>{file.name}</span>
          <span className="file-meta">{formatSize(file.size)} · {formatDate(file.uploadedAt)}</span>
        </div>
        <div className="file-actions">
          <button className="action-btn" onClick={handleDownload} disabled={downloading} title="Download">
            {downloading ? "..." : "↓"}
          </button>
          <button className="action-btn menu-btn" onClick={() => setShowMenu(!showMenu)} title="More">
            ⋮
          </button>
          {showMenu && (
            <div className="file-menu">
              <button onClick={handleMoveClick} className="move-btn">Move to Folder</button>
              <button onClick={handleDelete} className="delete-btn">Delete</button>
            </div>
          )}
        </div>
        {error && <div className="file-error">{error}</div>}
      </div>
      {moveDialog}
    </>
  );
}
