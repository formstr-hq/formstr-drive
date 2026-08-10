import { useMemo, useState } from "react";
import { useFileIndex } from '../../hooks/useFileContext';

interface FolderSidebarProps {
  isOpen: boolean;
  onClose: () => void;
  currentView?: "files" | "shared-by-me";
  onSelectSharedByMe?: () => void;
  onSelectFolder?: () => void;
}

import { isDirectChildFolder, getFolderName, ancestorsOf, getFolderItemCount, filesUnderFolder } from '../../utils/folder';
import { FILE_HASH_MIME } from '../../utils/constants';
import { HomeIcon, FolderIcon, ChevronIcon, ShareIcon } from '../icons/Icons';
import { ShareModal } from '../Files/ShareModal';
import { useShares } from '../../context/SharesProvider';


interface FolderNodeProps {
  path: string;
  depth: number;
  folders: string[];
  currentFolder: string;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  getItemCount: (path: string) => number;
  dragOverFolder: string | null;
  onDropFiles: (path: string, hashes: string[]) => void;
  setDragOverFolder: (path: string | null) => void;
  onShare: (path: string) => void;
  isShared: (path: string) => boolean;
}

function FolderNode({
  path,
  depth,
  folders,
  currentFolder,
  expanded,
  onToggle,
  onSelect,
  getItemCount,
  dragOverFolder,
  onDropFiles,
  setDragOverFolder,
  onShare,
  isShared,
}: FolderNodeProps) {
  const children = folders.filter((f) => isDirectChildFolder(path, f));
  const hasChildren = children.length > 0;
  const isExpanded = expanded.has(path);

  return (
    <>
      <div
        className={`folder-item ${currentFolder === path ? "active" : ""} ${
          dragOverFolder === path ? "drag-over" : ""
        }`}
        style={{ paddingLeft: 12 + depth * 16 }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOverFolder(path);
        }}
        onDragLeave={() => setDragOverFolder(null)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOverFolder(null);
          const raw = e.dataTransfer.getData(FILE_HASH_MIME);
          if (!raw) return;
          onDropFiles(path, raw.split(","));
        }}
      >
        {hasChildren ? (
          <button
            className="folder-toggle"
            onClick={(e) => {
              e.stopPropagation();
              onToggle(path);
            }}
            aria-label={isExpanded ? "Collapse" : "Expand"}
          >
            <ChevronIcon expanded={isExpanded} />
          </button>
        ) : (
          <span className="folder-toggle folder-toggle--spacer" />
        )}
        <button className="folder-item-btn" onClick={() => onSelect(path)}>
          <span className="folder-item-icon">
            <FolderIcon />
          </span>
          <span className="folder-name">{getFolderName(path)}</span>
          <span className="folder-count">{getItemCount(path)}</span>
        </button>
        <button
          className={`folder-share-btn${isShared(path) ? " is-shared" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            onShare(path);
          }}
          title={isShared(path) ? "Shared — click to manage" : "Share folder"}
          aria-label={`Share ${getFolderName(path)}`}
        >
          <ShareIcon />
        </button>
      </div>

      {hasChildren && isExpanded && (
        <div className="folder-children">
          {children
            .sort((a, b) => getFolderName(a).localeCompare(getFolderName(b)))
            .map((child) => (
              <FolderNode
                key={child}
                path={child}
                depth={depth + 1}
                folders={folders}
                currentFolder={currentFolder}
                expanded={expanded}
                onToggle={onToggle}
                onSelect={onSelect}
                getItemCount={getItemCount}
                dragOverFolder={dragOverFolder}
                onDropFiles={onDropFiles}
                setDragOverFolder={setDragOverFolder}
                onShare={onShare}
                isShared={isShared}
              />
            ))}
        </div>
      )}
    </>
  );
}

export function FolderSidebar({ 
  isOpen, 
  onClose,
  currentView = "files",
  onSelectSharedByMe,
  onSelectFolder
}: FolderSidebarProps) {
  const { folders, currentFolder, setCurrentFolder, files, addCustomFolder, moveFiles } =
    useFileIndex();
  const { isFolderShared } = useShares();
  const [newFolderName, setNewFolderName] = useState("");
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(ancestorsOf(currentFolder))
  );
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);
  const [dragOverRoot, setDragOverRoot] = useState(false);
  const [shareFolderPath, setShareFolderPath] = useState<string | null>(null);

  const topLevelFolders = useMemo(
    () => folders.filter((f) => isDirectChildFolder("/", f)),
    [folders]
  );

  const handleCreateFolder = () => {
    const name = newFolderName.trim();
    if (!name) return;

    const path = currentFolder === "/" ? "/" + name : currentFolder + "/" + name;

    if (folders.includes(path)) {
      setFeedback("Folder already exists!");
      setTimeout(() => setFeedback(null), 2000);
      return;
    }

    addCustomFolder(path);
    setCurrentFolder(path);
    setExpanded((prev) => new Set(prev).add(currentFolder === "/" ? "/" : currentFolder));
    setNewFolderName("");
    setShowNewFolder(false);
    setFeedback(`Created "${name}"`);
    setTimeout(() => setFeedback(null), 2000);
  };

  const handleFolderClick = (folder: string) => {
    setCurrentFolder(folder);
    onSelectFolder?.();
    onClose();
  };

  const toggleExpanded = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const getItemCount = (folder: string) => getFolderItemCount(files, folders, folder);

  const handleDropFiles = (folder: string, hashes: string[]) => {
    if (hashes.length === 0) return;
    void moveFiles(hashes, folder);
  };

  const shareTarget = useMemo(() => {
    if (!shareFolderPath) return null;
    return {
      mode: "folder" as const,
      folderName: getFolderName(shareFolderPath),
      path: shareFolderPath,
      files: filesUnderFolder(files, shareFolderPath),
    };
  }, [shareFolderPath, files]);

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
        <div className="sidebar-section sidebar-section--grow">
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
            <div
              className={`folder-item folder-item--root ${currentFolder === "/" && currentView === "files" ? "active" : ""} ${
                dragOverRoot ? "drag-over" : ""
              }`}
              style={{ paddingLeft: 12 }}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOverRoot(true);
              }}
              onDragLeave={() => setDragOverRoot(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOverRoot(false);
                const raw = e.dataTransfer.getData(FILE_HASH_MIME);
                if (!raw) return;
                handleDropFiles("/", raw.split(","));
              }}
            >
              <span className="folder-toggle folder-toggle--spacer" />
              <button className="folder-item-btn" onClick={() => handleFolderClick("/")}>
                <span className="folder-item-icon">
                  <HomeIcon />
                </span>
                <span className="folder-name">My Drive</span>
                <span className="folder-count">{getItemCount("/")}</span>
              </button>
              <button
                className={`folder-share-btn${isFolderShared("/") ? " is-shared" : ""}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setShareFolderPath("/");
                }}
                title={isFolderShared("/") ? "Shared — click to manage" : "Share My Drive"}
                aria-label="Share My Drive"
              >
                <ShareIcon />
              </button>
            </div>

            {topLevelFolders
              .sort((a, b) => getFolderName(a).localeCompare(getFolderName(b)))
              .map((folder) => (
                <FolderNode
                  key={folder}
                  path={folder}
                  depth={0}
                  folders={folders}
                  currentFolder={currentView === "files" ? currentFolder : ""}
                  expanded={expanded}
                  onToggle={toggleExpanded}
                  onSelect={handleFolderClick}
                  getItemCount={getItemCount}
                  dragOverFolder={dragOverFolder}
                  onDropFiles={handleDropFiles}
                  setDragOverFolder={setDragOverFolder}
                  onShare={setShareFolderPath}
                  isShared={isFolderShared}
                />
              ))}
          </nav>
        </div>
        <div className="sidebar-section">
          <nav className="folder-list">
            <div
              className={`folder-item ${currentView === "shared-by-me" ? "active" : ""}`}
              style={{ paddingLeft: 12, marginTop: 8, marginBottom: 8 }}
            >
              <span className="folder-toggle folder-toggle--spacer" />
              <button 
                className="folder-item-btn" 
                onClick={() => { 
                  onSelectSharedByMe?.(); 
                  onClose(); 
                }}
              >
                <span className="folder-item-icon">
                  <ShareIcon />
                </span>
                <span className="folder-name">Shared by me</span>
              </button>
            </div>
          </nav>
        </div>
      </aside>
      {shareTarget && (
        <ShareModal target={shareTarget} onClose={() => setShareFolderPath(null)} />
      )}
    </>
  );
}
