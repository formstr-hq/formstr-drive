import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { useFileIndex } from '../../hooks/useFileContext';
import { useToast } from '../../hooks/useToast';
import { FileCard, canOpenPreview } from "./FileCard";
import { PREVIEW_UNAVAILABLE_MESSAGE } from "../../utils/fileTypeHelpers";
import { FileActionSheet } from "./FileActionSheet";
import { FilePreviewModal } from "./FilePreviewModal";
import { ShareModal } from "./ShareModal";
import { useShares } from "../../context/SharesProvider";
import { queueDownload } from "../../transfers/transferQueue";
import { getCachedPreview } from "../../services/Preview/fetchPreview";
import { isLegacyBlobFormat } from "../../types/metadata";
import { UploadZone } from '../Upload/UploadZone';
import { SearchIcon, GridViewIcon, ListViewIcon, FolderIcon } from '../icons/Icons';

import { isDirectChildFolder, getFolderName, getFolderItemCount } from '../../utils/folder';
import { type SortKey, SORT_LABEL } from '../../utils/constants';
import { FILE_HASH_MIME } from '../../utils/constants';
import { refreshDriveKeyring } from '../../services/driveKey';
import { PullToRefresh } from '../ui/PullToRefresh';
import { isAndroidPlatform } from '../../utils/platform';

import type { FileMetadata } from '../../types/metadata';

export const PAGE_SIZE = 40;

export function calculateDisplayedFiles(files: FileMetadata[], visibleCount: number): FileMetadata[] {
  return files.slice(0, visibleCount);
}

export function advanceVisibleCount(currentCount: number, totalCount: number, pageSize: number = PAGE_SIZE): number {
  return Math.min(currentCount + pageSize, totalCount);
}

export function shouldResetPagination(
  prevFolder: string,
  newFolder: string,
  prevQuery: string,
  newQuery: string,
  prevSort: SortKey,
  newSort: SortKey
): boolean {
  return prevFolder !== newFolder || prevQuery !== newQuery || prevSort !== newSort;
}

export function filterAndSortFiles(
  files: FileMetadata[],
  folder: string,
  normalizedQuery: string,
  sortKey: SortKey
): FileMetadata[] {
  const matches = files
    .filter((f) => f.folder === folder)
    .filter((f) => f.name.toLowerCase().includes(normalizedQuery));

  return [...matches].sort((a, b) => {
    switch (sortKey) {
      case "name":
        return a.name.localeCompare(b.name);
      case "oldest":
        return a.uploadedAt - b.uploadedAt;
      case "largest":
        return b.size - a.size;
      case "smallest":
        return a.size - b.size;
      case "newest":
      default:
        return b.uploadedAt - a.uploadedAt;
    }
  });
}

export function pruneSelectedHashes(prevSelected: Set<string>, validHashes: Set<string>): Set<string> {
  const next = new Set(Array.from(prevSelected).filter((hash) => validHashes.has(hash)));
  return next.size === prevSelected.size ? prevSelected : next;
}

export function FileList() {
  const {
    files,
    folders,
    currentFolder,
    setCurrentFolder,
    driveStatus,
    degradedReason,
    degradedMessage,
    deleteFiles,
    moveFiles,
    deleteFile,
    moveFile,
    renameFile,
    refresh,
  } = useFileIndex();
  const toast = useToast();
  const { isFileShared } = useShares();
  const [menuTarget, setMenuTarget] = useState<{ file: FileMetadata; anchor: HTMLElement } | null>(null);
  const [dialog, setDialog] = useState<{ kind: "preview" | "share" | "move" | "rename"; file: FileMetadata } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("newest");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [selectedFileHashes, setSelectedFileHashes] = useState<Set<string>>(new Set());
  const [bulkAction, setBulkAction] = useState<"move" | "delete" | null>(null);
  const [showMoveDialog, setShowMoveDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(searchQuery);
    }, 150);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const normalizedQuery = debouncedQuery.trim().toLowerCase();
  const isGridView = viewMode === "grid";

  // Reset pagination when folder, debounced search query, or sort order changes
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [currentFolder, normalizedQuery, sortKey]);

  const currentFolders = useMemo(
    () =>
      folders
        .filter((folder) => isDirectChildFolder(currentFolder, folder))
        .filter((folder) => getFolderName(folder).toLowerCase().includes(normalizedQuery)),
    [folders, currentFolder, normalizedQuery]
  );

  const currentFiles = useMemo(() => {
    return filterAndSortFiles(files, currentFolder, normalizedQuery, sortKey);
  }, [files, currentFolder, normalizedQuery, sortKey]);

  const displayedFiles = useMemo(
    () => calculateDisplayedFiles(currentFiles, visibleCount),
    [currentFiles, visibleCount]
  );

  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (visibleCount >= currentFiles.length) return;
    const el = sentinelRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisibleCount((prev) => advanceVisibleCount(prev, currentFiles.length, PAGE_SIZE));
        }
      },
      { rootMargin: "250px" }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [visibleCount, currentFiles.length]);

  const currentFileHashes = useMemo(
    () => new Set(currentFiles.map((file) => file.id)),
    [currentFiles]
  );
  const selectedFiles = useMemo(
    () => currentFiles.filter((file) => selectedFileHashes.has(file.id)),
    [currentFiles, selectedFileHashes]
  );
  const selectedCount = selectedFiles.length;
  const allVisibleSelected = currentFiles.length > 0 && selectedCount === currentFiles.length;

  const hasItems = currentFolders.length > 0 || currentFiles.length > 0;

  useEffect(() => {
    setSelectedFileHashes((prev) => pruneSelectedHashes(prev, currentFileHashes));
  }, [currentFileHashes]);

  useEffect(() => {
    if (selectedCount === 0) {
      setShowMoveDialog(false);
      setShowDeleteDialog(false);
    }
  }, [selectedCount]);

  const toggleFileSelection = useCallback((hash: string) => {
    setSelectedFileHashes((prev) => {
      const next = new Set(prev);
      if (next.has(hash)) {
        next.delete(hash);
      } else {
        next.add(hash);
      }
      return next;
    });
  }, []);

  const multiDragIds = useMemo(
    () => (selectedFileHashes.size > 1 ? Array.from(selectedFileHashes) : undefined),
    [selectedFileHashes]
  );

  const handleToggleSelectAll = () => {
    setSelectedFileHashes(() => {
      if (allVisibleSelected) {
        return new Set();
      }
      return new Set(currentFiles.map((file) => file.id));
    });
  };

  const handleClearSelection = () => {
    setSelectedFileHashes(new Set());
  };

  const handleRequestBulkDelete = () => {
    if (selectedCount === 0 || bulkAction !== null) return;

    setShowDeleteDialog(true);
  };

  // The files are already gone by the time this runs — it only says that a
  // share link outlived one of them, so it can't be an error that aborts the
  // delete flow (which would leave the selection and dialog stuck open).
  const warnUnrevokedShares = useCallback(
    (names: string[]) => {
      if (names.length > 0) {
        toast.error(
          `Deleted, but the share link for ${names.join(", ")} couldn't be revoked — revoke it from "Shared by me".`,
        );
      }
    },
    [toast],
  );

  const handleBulkDelete = async () => {
    if (selectedCount === 0) return;

    setBulkAction("delete");

    try {
      const { unrevokedShares } = await deleteFiles(selectedFiles.map((file) => file.id));
      setSelectedFileHashes(new Set());
      setShowDeleteDialog(false);
      warnUnrevokedShares(unrevokedShares);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Bulk delete failed");
    } finally {
      setBulkAction(null);
    }
  };

  const handleDropOnFolder = (folder: string, e: React.DragEvent) => {
    e.preventDefault();
    setDragOverFolder(null);
    const raw = e.dataTransfer.getData(FILE_HASH_MIME);
    if (!raw) return;
    void moveFiles(raw.split(","), folder);
  };

  const handleBulkMove = async (folder: string) => {
    if (selectedCount === 0) return;

    setBulkAction("move");

    try {
      await moveFiles(selectedFiles.map((file) => file.id), folder);
      setSelectedFileHashes(new Set());
      setShowMoveDialog(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Bulk move failed");
    } finally {
      setBulkAction(null);
    }
  };

  // Per-file actions: one instance shared by every card.
  const closeMenu = useCallback(() => setMenuTarget(null), []);
  const closeDialog = useCallback(() => setDialog(null), []);

  const openMenu = useCallback((file: FileMetadata, anchor: HTMLElement) => {
    setMenuTarget({ file, anchor });
  }, []);

  const openPreview = useCallback(
    (file: FileMetadata) => {
      // Video/PDF on the new blob format stream via Range requests, so the
      // 5MB gate only applies to modes without a seekable path.
      const gate = canOpenPreview({
        fileType: file.type,
        fileSize: file.size,
        isLegacyBlob: isLegacyBlobFormat(file),
        fileName: file.name,
      });
      if (!gate.allowed) {
        toast.error(gate.reason ?? PREVIEW_UNAVAILABLE_MESSAGE);
        return;
      }
      setDialog({ kind: "preview", file });
    },
    [toast],
  );

  const downloadFile = useCallback(
    (file: FileMetadata) => {
      // The transfer panel owns progress and errors; only speak up when the
      // click was a no-op because the file is already downloading.
      if (!queueDownload(file)) toast.info("This file is already downloading");
    },
    [toast],
  );

  const shareFile = useCallback((file: FileMetadata) => setDialog({ kind: "share", file }), []);
  const moveFileDialog = useCallback((file: FileMetadata) => setDialog({ kind: "move", file }), []);
  const renameFileDialog = useCallback((file: FileMetadata) => {
    setRenameValue(file.name);
    setDialog({ kind: "rename", file });
  }, []);

  const deleteOne = useCallback(
    async (file: FileMetadata) => {
      if (!confirm(`Delete "${file.name}"?`)) return;
      try {
        const { unrevokedShares } = await deleteFile(file.id);
        warnUnrevokedShares(unrevokedShares);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Delete failed");
      }
    },
    [deleteFile, toast, warnUnrevokedShares],
  );

  const submitRename = async () => {
    if (dialog?.kind !== "rename") return;
    const trimmed = renameValue.trim();
    const target = dialog.file;
    setDialog(null);
    if (trimmed && trimmed !== target.name) {
      try {
        await renameFile(target.id, trimmed);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Rename failed");
      }
    }
  };

  const submitMove = async (folder: string) => {
    if (dialog?.kind !== "move") return;
    try {
      await moveFile(dialog.file.id, folder);
      setDialog(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Move failed");
    }
  };

  useEffect(() => {
    if (dialog?.kind !== "rename") return;
    const t = setTimeout(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }, 0);
    return () => clearTimeout(t);
  }, [dialog?.kind]);

  const renameModal = dialog?.kind === "rename" && (
    <div className="move-dialog-overlay" onClick={closeDialog}>
      <div className="move-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="move-dialog-header">
          <h3>Rename File</h3>
          <button onClick={closeDialog}>×</button>
        </div>
        <div className="move-dialog-body">
          <input
            ref={renameInputRef}
            type="text"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitRename();
              if (e.key === "Escape") closeDialog();
            }}
            className="rename-input"
          />
          <div className="rename-dialog-actions">
            <button onClick={closeDialog} className="cancel-btn">Cancel</button>
            <button onClick={() => void submitRename()} className="rename-btn">Rename</button>
          </div>
        </div>
      </div>
    </div>
  );

  const singleMoveDialog = dialog?.kind === "move" && (
    <div className="move-dialog-overlay" onClick={closeDialog}>
      <div className="move-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="move-dialog-header">
          <h3>Move to Folder</h3>
          <button onClick={closeDialog}>×</button>
        </div>
        <div className="move-dialog-body">
          <div className="folder-list-move">
            {folders.map((folder) => (
              <button
                key={folder}
                className={`folder-option ${folder === dialog.file.folder ? "current" : ""}`}
                onClick={() => void submitMove(folder)}
                disabled={folder === dialog.file.folder}
              >
                <span className="folder-icon">📁</span>
                <span className="folder-path">{folder}</span>
                {folder === dialog.file.folder && <span className="current-badge">Current</span>}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );

  const bulkMoveDialog = showMoveDialog && (
    <div className="move-dialog-overlay" onClick={() => setShowMoveDialog(false)}>
      <div className="move-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="move-dialog-header">
          <h3>Move {selectedCount} Files</h3>
          <button onClick={() => setShowMoveDialog(false)}>×</button>
        </div>
        <div className="move-dialog-body">
          <p className="bulk-action-hint">
            Selected files will be updated one by one. Your signer may ask for
            multiple approvals.
          </p>
          <div className="folder-list-move">
            {folders.map((folder) => (
              <button
                key={folder}
                className={`folder-option ${folder === currentFolder ? "current" : ""}`}
                onClick={() => handleBulkMove(folder)}
                disabled={folder === currentFolder || bulkAction === "move"}
              >
                <span className="folder-icon">📁</span>
                <span className="folder-path">{folder}</span>
                {folder === currentFolder && (
                  <span className="current-badge">Current</span>
                )}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );

  const bulkDeleteDialog = showDeleteDialog && (
    <div
      className="move-dialog-overlay"
      onClick={() => {
        if (bulkAction !== "delete") {
          setShowDeleteDialog(false);
        }
      }}
    >
      <div className="move-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="move-dialog-header">
          <h3>Delete {selectedCount === 1 ? "File" : `${selectedCount} Files`}</h3>
          <button
            onClick={() => setShowDeleteDialog(false)}
            disabled={bulkAction === "delete"}
          >
            ×
          </button>
        </div>
        <div className="move-dialog-body">
          <p className="bulk-action-hint">
            These files will be deleted one by one. Your signer may ask for
            multiple approvals.
          </p>
          <ul className="bulk-delete-list">
            {selectedFiles.map((file) => (
              <li key={file.id} className="bulk-delete-list-item">
                <span className="bulk-delete-file-name" title={file.name}>
                  {file.name}
                </span>
              </li>
            ))}
          </ul>
          <div className="rename-dialog-actions">
            <button
              onClick={() => setShowDeleteDialog(false)}
              className="cancel-btn"
              disabled={bulkAction === "delete"}
            >
              Cancel
            </button>
            <button
              onClick={handleBulkDelete}
              className="bulk-danger-btn"
              disabled={bulkAction === "delete"}
            >
              {bulkAction === "delete"
                ? "Deleting..."
                : `Delete ${selectedCount === 1 ? "file" : "files"}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  // "resolving" covers both "Drive Key resolution not settled yet" and
  // "settled, but the relay replay hasn't EOSE'd". Files stream into `files`
  // incrementally as they decrypt, well before EOSE — once anything is
  // visible there's no reason to keep hiding it behind a spinner. Only block
  // on the spinner while resolving AND still empty; this also preserves the
  // invariant the empty-state branch below relies on: reaching it with
  // hasItems false means driveStatus is never "resolving" here, only
  // "degraded" or "ready". Copy is deliberately generic ("Looking for your
  // files…") rather than claiming a specific activity — during this window
  // the app may actually be proving whether a Drive Key exists at all, not
  // "fetching files" in any literal sense.
  if (driveStatus === "resolving" && !hasItems) {
    return (
      <div className="loading-container">
        <div className="loading-state">Looking for your files…</div>
        <div className="loader"></div>
      </div>
    );
  }

  const scrollContent = (
    <>
      {/* Only "uncertain" means no key is actually resolved — uploading would
          genuinely fail. "undecryptable" still has a real, working key (some
          EXISTING files just can't decrypt under it); new uploads work fine
          there, so gating on driveStatus alone would wrongly block them. */}
      <UploadZone disabled={degradedReason === "uncertain"} />

      {driveStatus === "resolving" && (
        <div className="file-list-syncing-hint">Still syncing…</div>
      )}

        <div className="file-list-toolbar">
          <div className="search-wrap">
            <SearchIcon className="search-icon" />
            <input
              type="text"
              className="search-input"
              placeholder="Search in Drive"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          <div className="file-list-toolbar-actions">
            <select
              className="sort-select"
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
              aria-label="Sort by"
            >
              {(Object.keys(SORT_LABEL) as SortKey[]).map((key) => (
                <option key={key} value={key}>
                  {SORT_LABEL[key]}
                </option>
              ))}
            </select>

            <button
              className="bulk-secondary-btn bulk-select-toggle"
              onClick={handleToggleSelectAll}
              disabled={bulkAction !== null || currentFiles.length === 0}
            >
              {allVisibleSelected ? "Deselect all" : "Select all"}
            </button>

            <div className="view-toggle">
              <button
                className={`view-btn ${viewMode === "grid" ? "active" : ""}`}
                onClick={() => setViewMode("grid")}
                title="Grid view"
              >
                <GridViewIcon />
              </button>
              <button
                className={`view-btn ${viewMode === "list" ? "active" : ""}`}
                onClick={() => setViewMode("list")}
                title="List view"
              >
                <ListViewIcon />
              </button>
            </div>
          </div>
        </div>

        {!hasItems ? (
          // driveStatus is "resolving" only before the early return above, so
          // this only ever sees "degraded" or "ready" — an empty list is safe
          // to call genuinely empty ONLY under "ready". Under "degraded", an
          // empty `files` means "couldn't confirm", never "confirmed empty"
          // (see DriveIndexStatus's doc comment in FileIndexProvider.tsx) —
          // showing the upload-hint empty state here is exactly the bug that
          // made a real drive-key/decrypt failure look like ordinary data loss.
          degradedReason && !normalizedQuery ? (
            <div className="empty-state error-state">
              <p>
                {degradedReason === "uncertain"
                  ? degradedMessage ?? "Couldn't confirm your Drive Key yet."
                  : "Some of your files couldn't be decrypted under the current Drive Key — this may " +
                    "not be your complete file list."}
              </p>
              <p className="empty-hint">
                {degradedReason === "uncertain"
                  ? "This resolves automatically once the network is reachable — nothing will be lost " +
                    "or created in the meantime."
                  : "Check your connection and retry, or open the drive on a device that already has " +
                    "the right key."}
              </p>
              <button
                className="empty-state-retry"
                onClick={() => {
                  // refresh() alone only re-declares the file-index interest —
                  // it does nothing for the more common cause of "degraded",
                  // which is the Drive Key resolution itself being stuck (see
                  // refreshDriveKeyring's doc comment: once resolved, nothing
                  // otherwise ever rechecks relays for the rest of the tab's
                  // life). Both together cover "the key was the problem" and
                  // "the file-index subscription was the problem".
                  void refreshDriveKeyring();
                  void refresh();
                }}
              >
                Retry
              </button>
            </div>
          ) : (
            <div className="empty-state">
              <p>{normalizedQuery ? "No files or folders match your search" : "No files or folders in this folder"}</p>
              <p className="empty-hint">{!normalizedQuery && "Drop files above to upload"}</p>
            </div>
          )
        ) : (
          <div className={isGridView ? "file-grid" : "file-list-view"}>
            {currentFolders.map((folderPath) => {
              const itemCount = getFolderItemCount(files, folders, folderPath);
              const itemsLabel = `${itemCount} item${itemCount === 1 ? "" : "s"}`;
              const dragHandlers = {
                onDragOver: (e: React.DragEvent) => {
                  e.preventDefault();
                  setDragOverFolder(folderPath);
                },
                onDragLeave: () => setDragOverFolder(null),
                onDrop: (e: React.DragEvent) => handleDropOnFolder(folderPath, e),
              };

              return isGridView ? (
                <div
                  key={folderPath}
                  role="button"
                  tabIndex={0}
                  className={`folder-tile${dragOverFolder === folderPath ? " drag-over" : ""}`}
                  onClick={() => setCurrentFolder(folderPath)}
                  title={`Open ${getFolderName(folderPath)}`}
                  {...dragHandlers}
                >
                  <div className="folder-tile-preview">
                    <FolderIcon className="folder-tile-icon" />
                  </div>
                  <div className="folder-tile-footer">
                    <span className="folder-tile-name" title={getFolderName(folderPath)}>
                      {getFolderName(folderPath)}
                    </span>
                    <span className="folder-tile-meta">{itemsLabel}</span>
                  </div>
                </div>
              ) : (
                <div
                  key={folderPath}
                  role="button"
                  tabIndex={0}
                  className={`folder-row${dragOverFolder === folderPath ? " drag-over" : ""}`}
                  onClick={() => setCurrentFolder(folderPath)}
                  title={`Open ${getFolderName(folderPath)}`}
                  {...dragHandlers}
                >
                  <div className="folder-row-icon" aria-hidden="true">
                    <FolderIcon />
                  </div>
                  <div className="folder-row-info">
                    <span className="folder-row-name" title={getFolderName(folderPath)}>
                      {getFolderName(folderPath)}
                    </span>
                    <span className="folder-row-meta">{itemsLabel}</span>
                  </div>
                </div>
              );
            })}

            {displayedFiles.map((file, index) => (
              <FileCard
                // Legacy files (pre-dating the random id) all have id === undefined —
                // falling back to `file.id` alone would give every such row the exact
                // same React key, which is invalid and can destabilize reconciliation
                // for the whole list (React warns and may reuse DOM nodes across
                // unrelated rows when siblings share a key).
                key={file.id ?? `legacy-${index}`}
                file={file}
                viewMode={viewMode}
                selected={selectedFileHashes.has(file.id)}
                isShared={isFileShared(file.id)}
                onToggleSelection={toggleFileSelection}
                onOpen={openPreview}
                onMenu={openMenu}
                onDownload={downloadFile}
                onShare={shareFile}
                isSelectionMode={selectedCount > 0}
                // If this card is part of a multi-selection, dragging it should move
                // the WHOLE selection, matching standard file-manager behavior — not
                // just the one card that happened to receive the native dragstart.
                dragIds={selectedFileHashes.has(file.id) ? multiDragIds : undefined}
              />
            ))}
            {visibleCount < currentFiles.length && (
              <div
                ref={sentinelRef}
                className="file-list-sentinel"
                data-testid="file-list-sentinel"
                style={{ height: 20, width: "100%", opacity: 0, pointerEvents: "none" }}
                aria-hidden="true"
              />
            )}
          </div>
        )}
    </>
  );

  const scrollStyle = selectedCount > 0 ? { paddingBottom: 120 } : undefined;

  return (
    <div className="file-list-container">
      {isAndroidPlatform ? (
        <PullToRefresh className="file-list-scroll" style={scrollStyle} onRefresh={refresh}>
          {scrollContent}
        </PullToRefresh>
      ) : (
        <div className="file-list-scroll" style={scrollStyle}>
          {scrollContent}
        </div>
      )}

      {selectedCount > 0 && (
        <div className="bulk-action-bar">
          <div className="bulk-action-summary">
            <strong>{selectedCount}</strong> file{selectedCount === 1 ? "" : "s"} selected
          </div>
          <div className="bulk-action-buttons">
            <button
              className="bulk-secondary-btn"
              onClick={() => setShowMoveDialog(true)}
              disabled={bulkAction !== null}
            >
              {bulkAction === "move" ? "Moving..." : "Move selected"}
            </button>
            <button
              className="bulk-danger-btn"
              onClick={handleRequestBulkDelete}
              disabled={bulkAction !== null}
            >
              {bulkAction === "delete" ? "Deleting..." : "Delete selected"}
            </button>
            <button
              className="bulk-clear-btn"
              onClick={handleClearSelection}
              disabled={bulkAction !== null}
            >
              Clear
            </button>
          </div>
        </div>
      )}
      {bulkDeleteDialog}
      {bulkMoveDialog}
      {menuTarget && (
        <FileActionSheet
          file={menuTarget.file}
          anchor={menuTarget.anchor}
          thumbUrl={
            menuTarget.file.previewHash
              ? (getCachedPreview(menuTarget.file.previewHash)?.staticUrl ??
                 getCachedPreview(menuTarget.file.previewHash)?.url)
              : undefined
          }
          isShared={isFileShared(menuTarget.file.id)}
          onClose={closeMenu}
          onView={() => openPreview(menuTarget.file)}
          onDownload={() => downloadFile(menuTarget.file)}
          onShare={() => shareFile(menuTarget.file)}
          onMove={() => moveFileDialog(menuTarget.file)}
          onRename={() => renameFileDialog(menuTarget.file)}
          onDelete={() => void deleteOne(menuTarget.file)}
        />
      )}
      {dialog?.kind === "preview" && <FilePreviewModal file={dialog.file} onClose={closeDialog} />}
      {dialog?.kind === "share" && (
        <ShareModal target={{ mode: "file", file: dialog.file }} onClose={closeDialog} />
      )}
      {singleMoveDialog}
      {renameModal}
    </div>
  );
}
