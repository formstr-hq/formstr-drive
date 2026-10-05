import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { FileMetadata } from "../../types/metadata";
import { getFileIcon } from "../../utils/fileTypeHelpers";
import { formatSize, formatDate } from "../../utils/format";
import { useBackButton } from "../../hooks/useBackButton";
import { useIsMobile } from "../../hooks/useIsMobile";
import { FileMenu, type FileMenuProps } from "./FileMenu";
import "./FileActionSheet.css";

export interface FileActionSheetProps extends FileMenuProps {
  file: FileMetadata;
  /** The ⋮ button that opened the menu — used to anchor the desktop popover. */
  anchor: HTMLElement | null;
  thumbUrl?: string;
  onClose: () => void;
}

const POPOVER_GAP = 6;
const VIEWPORT_PAD = 8;

/**
 * Single, portaled file-actions surface. Rendered once by FileList (not per
 * card) so opening it never touches card stacking/overflow. Bottom sheet on
 * phones, anchored popover on desktop.
 */
export function FileActionSheet({
  file,
  anchor,
  thumbUrl,
  onClose,
  onView,
  onDownload,
  onShare,
  onMove,
  onRename,
  onDelete,
  isShared,
}: FileActionSheetProps) {
  const isMobile = useIsMobile(768);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useBackButton(onClose);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Desktop: place under the anchor, flipping up/left when it would overflow.
  useLayoutEffect(() => {
    if (isMobile || !anchor || !panelRef.current) return;
    const a = anchor.getBoundingClientRect();
    const p = panelRef.current.getBoundingClientRect();
    let top = a.bottom + POPOVER_GAP;
    if (top + p.height > window.innerHeight - VIEWPORT_PAD) {
      top = Math.max(VIEWPORT_PAD, a.top - POPOVER_GAP - p.height);
    }
    let left = a.right - p.width;
    left = Math.min(Math.max(VIEWPORT_PAD, left), window.innerWidth - p.width - VIEWPORT_PAD);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- measured placement needs the rendered panel size
    setPos({ top, left });
  }, [isMobile, anchor]);

  // Close first so the menu is gone before the action's dialog mounts.
  const run = (fn: () => void) => () => {
    onClose();
    fn();
  };

  const icon = getFileIcon(file.type);

  return createPortal(
    <div className="file-sheet-root">
      <div className="file-sheet-scrim" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        className={isMobile ? "file-sheet" : "file-popover"}
        style={!isMobile ? (pos ?? { top: 0, left: 0, visibility: "hidden" }) : undefined}
      >
        {isMobile && (
          <>
            <div className="file-sheet-handle" aria-hidden="true" />
            <div className="file-sheet-header">
              <div className="file-icon" data-type={icon}>
                {thumbUrl ? <img src={thumbUrl} alt="" /> : icon.toUpperCase()}
              </div>
              <div className="file-sheet-title">
                <span className="file-sheet-name">{file.name}</span>
                <span className="file-sheet-meta">
                  {formatSize(file.size)} · {formatDate(file.uploadedAt)}
                </span>
              </div>
            </div>
          </>
        )}
        <FileMenu
          isShared={isShared}
          onView={run(onView)}
          onDownload={run(onDownload)}
          onShare={run(onShare)}
          onMove={run(onMove)}
          onRename={run(onRename)}
          onDelete={run(onDelete)}
        />
      </div>
    </div>,
    document.body,
  );
}
