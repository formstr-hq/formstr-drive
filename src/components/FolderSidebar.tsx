import { useState } from "react";
import { useFileIndex } from "../hooks/useFileContext";

interface FolderSidebarProps {
  isOpen: boolean;
  onClose: () => void;
}

export function FolderSidebar({ isOpen, onClose }: FolderSidebarProps) {
  const { folders, currentFolder, setCurrentFolder, files, addCustomFolder } = useFileIndex();
  const [newFolderName, setNewFolderName] = useState("");
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const handleCreateFolder = () => {
    const name = newFolderName.trim();
    if (!name) return;

    const path = currentFolder === "/"
      ? "/" + name
      : currentFolder + "/" + name;

    // Check if folder already exists
    if (folders.includes(path)) {
      setFeedback("Folder already exists!");
      setTimeout(() => setFeedback(null), 2000);
      return;
    }

    // Add to custom folders
    addCustomFolder(path);
    setCurrentFolder(path);
    setNewFolderName("");
    setShowNewFolder(false);
    setFeedback(`Created "${name}"`);
    setTimeout(() => setFeedback(null), 2000);
  };

  const handleFolderClick = (folder: string) => {
    setCurrentFolder(folder);
    onClose();
  };

  const isDirectChildFolder = (parentFolder: string, candidateFolder: string) => {
    if (candidateFolder === "/" || candidateFolder === parentFolder) return false;

    if (parentFolder === "/") {
      return candidateFolder.split("/").filter(Boolean).length === 1;
    }

    if (!candidateFolder.startsWith(`${parentFolder}/`)) return false;
    const relative = candidateFolder.slice(parentFolder.length + 1);
    return relative.length > 0 && !relative.includes("/");
  };

  const getItemCount = (folder: string) => {
    const directFileCount = files.filter((f) => f.folder === folder).length;
    const directFolderCount = folders.filter((candidate) =>
      isDirectChildFolder(folder, candidate)
    ).length;
    return directFileCount + directFolderCount;
  };

  const getFolderName = (path: string) => {
    if (path === "/") return "My Drive";
    const parts = path.split("/");
    return parts[parts.length - 1];
  };

  const getIndent = (path: string) => {
    if (path === "/") return 0;
    return (path.split("/").length - 1) * 16;
  };

  return (
    <>
      {/* Backdrop — only visible on mobile when open */}
      {isOpen && (
        <div
          className="sidebar-backdrop"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      <aside className={`folder-sidebar ${isOpen ? "sidebar-open" : ""}`}>
        <nav className="folder-list" style={{ marginBottom: "20px" }}>
          <button
            className={`folder-item ${currentFolder === "shared" ? "active" : ""}`}
            onClick={() => handleFolderClick("shared")}
            style={{ paddingLeft: 12 }}
          >
            <span className="folder-icon">🤝</span>
            <span className="folder-name">Shared With Me</span>
          </button>
        </nav>

        <div className="sidebar-header">
          <span>Folders</span>
          <button
            className="new-folder-btn"
            onClick={() => setShowNewFolder(!showNewFolder)}
            title="New folder"
          >
            +
          </button>
        </div>

        {feedback && (
          <div className="folder-feedback">{feedback}</div>
        )}

        {showNewFolder && (
          <div className="new-folder-input">
            <input
              type="text"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreateFolder();
                if (e.key === "Escape") {
                  setShowNewFolder(false);
                  setNewFolderName("");
                }
              }}
              placeholder="Folder name"
              autoFocus
            />
            <button onClick={handleCreateFolder} title="Create folder">
              ✓
            </button>
            <button
              onClick={() => {
                setShowNewFolder(false);
                setNewFolderName("");
              }}
              className="cancel-btn"
              title="Cancel"
            >
              ✕
            </button>
          </div>
        )}

        <nav className="folder-list">
          {folders.map((folder) => (
            <button
              key={folder}
              className={`folder-item ${currentFolder === folder ? "active" : ""}`}
              onClick={() => handleFolderClick(folder)}
              style={{ paddingLeft: 12 + getIndent(folder) }}
            >
              <span className="folder-icon">
                {folder === "/" ? "◊" : "▸"}
              </span>
              <span className="folder-name">{getFolderName(folder)}</span>
              <span className="folder-count">{getItemCount(folder)}</span>
            </button>
          ))}
        </nav>
      </aside>
    </>
  );
}
