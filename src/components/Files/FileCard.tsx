import { useEffect, useRef, useState, memo } from "react";
import { type FileMetadata } from '../../types/metadata';
import { isAndroidPlatform } from "../../utils/platform";
import {
  getFileIcon,
  MAX_PREVIEW_SIZE,
  resolvePreviewMode,
  browserMayPlayVideo,
  PREVIEW_UNAVAILABLE_MESSAGE,
  unsupportedVideoMessage,
} from '../../utils/fileTypeHelpers';
import { FILE_HASH_MIME } from '../../utils/constants';
import { formatSize, formatDate, getHostname } from '../../utils/format';
import { PreviewEyeIcon, ShareIcon } from '../icons/Icons';
import { fetchFilePreview, getCachedPreview, type PreviewData } from "../../services/Preview/fetchPreview";

export interface FileCardProps {
  file: FileMetadata;
  viewMode?: "grid" | "list";
  selected?: boolean;
  isSelectionMode?: boolean;
  isShared?: boolean;
  /** Ids to move when THIS card is dragged — the caller's full multi-selection
   *  when this card is part of one, otherwise just `[file.id]`. */
  dragIds?: string[];
  onToggleSelection: (id: string) => void;
  /** Tap on the card body (outside selection mode) — opens the preview. */
  onOpen: (file: FileMetadata) => void;
  /** Opens the actions sheet/popover, anchored to the ⋮ button. */
  onMenu: (file: FileMetadata, anchor: HTMLElement) => void;
  onDownload: (file: FileMetadata) => void;
  onShare: (file: FileMetadata) => void;
}

function ServerBadge({ server }: { server: string }) {
  return (
    <span className="file-server-badge" title={server}>
      {getHostname(server)}
    </span>
  );
}

export interface CardTapHandlerOptions {
  isSelectionMode: boolean;
  fileId: string;
  onToggleSelection?: (id: string) => void;
  onOpen: () => void;
}

/** Drive semantics: in selection mode a tap toggles; otherwise it opens. */
export function handleCardTapLogic(opts: CardTapHandlerOptions): void {
  if (opts.isSelectionMode) {
    opts.onToggleSelection?.(opts.fileId);
  } else {
    opts.onOpen();
  }
}

export interface CardKeyDownHandlerOptions extends CardTapHandlerOptions {
  key: string;
  isDirectTarget: boolean;
  preventDefault?: () => void;
}

export function handleCardKeyDownLogic(opts: CardKeyDownHandlerOptions): boolean {
  if (!opts.isDirectTarget) {
    return false;
  }
  if (opts.key === "Enter" || opts.key === " ") {
    opts.preventDefault?.();
    handleCardTapLogic(opts);
    return true;
  }
  return false;
}

export interface PreviewGateOptions {
  fileType: string;
  fileSize: number;
  isLegacyBlob: boolean;
  /** Only used to name the format in the "can't play" message. */
  fileName?: string;
  maxPreviewSize?: number;
}

export function canOpenPreview(opts: PreviewGateOptions): { allowed: boolean; reason?: string } {
  const mode = resolvePreviewMode(opts.fileType);
  if (mode === "video" && !browserMayPlayVideo(opts.fileType)) {
    return { allowed: false, reason: unsupportedVideoMessage(opts.fileName ?? "") };
  }
  const canStream = (mode === "video" || mode === "pdf") && !opts.isLegacyBlob;
  const limit = opts.maxPreviewSize ?? MAX_PREVIEW_SIZE;
  if (!canStream && opts.fileSize > limit) {
    return {
      allowed: false,
      reason: PREVIEW_UNAVAILABLE_MESSAGE,
    };
  }
  return { allowed: true };
}

const LONG_PRESS_MS = 450;
const LONG_PRESS_SLOP = 10;

const isTouch =
  isAndroidPlatform ||
  (typeof window !== "undefined" && "ontouchstart" in window) ||
  (typeof navigator !== "undefined" && navigator.maxTouchPoints > 0);

/**
 * Pure presentational card. All dialogs and menus are owned by FileList so a
 * card never re-renders for index updates that don't touch its own props.
 */
export const FileCard = memo(function FileCard({
  file,
  viewMode = "list",
  selected = false,
  isSelectionMode = false,
  isShared = false,
  dragIds,
  onToggleSelection,
  onOpen,
  onMenu,
  onDownload,
  onShare,
}: FileCardProps) {
  const canDrag = !isTouch;

  const [previewloaded, setPreviewloaded] = useState(false);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [isHovering, setIsHovering] = useState(false);

  const pressTimer = useRef<number | null>(null);
  const pressStart = useRef<{ x: number; y: number } | null>(null);
  const longPressed = useRef(false);

  // GIF previews only animate while hovered with a real mouse.
  const previewSrc =
    preview?.type === "image/gif" && preview.staticUrl && !isHovering ? preview.staticUrl : preview?.url;

  useEffect(() => {
    let cancelled = false;

    const cached = file.previewHash ? getCachedPreview(file.previewHash) : undefined;
    if (cached) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronous reset when the subscription key changes
      setPreview(cached);
      setPreviewloaded(true);
      return;
    }

    setPreviewloaded(false);
    setPreview(null);

    fetchFilePreview(file)
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

  useEffect(() => () => {
    if (pressTimer.current !== null) window.clearTimeout(pressTimer.current);
  }, []);

  const cancelPress = () => {
    if (pressTimer.current !== null) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
    pressStart.current = null;
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse") return;
    longPressed.current = false;
    pressStart.current = { x: e.clientX, y: e.clientY };
    pressTimer.current = window.setTimeout(() => {
      pressTimer.current = null;
      longPressed.current = true;
      if (navigator.vibrate) navigator.vibrate(10);
      onToggleSelection(file.id);
    }, LONG_PRESS_MS);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const s = pressStart.current;
    if (!s) return;
    if (Math.abs(e.clientX - s.x) > LONG_PRESS_SLOP || Math.abs(e.clientY - s.y) > LONG_PRESS_SLOP) {
      cancelPress();
    }
  };

  const handleCardTap = () => {
    // The click that ends a long press must not also open/toggle.
    if (longPressed.current) {
      longPressed.current = false;
      return;
    }
    handleCardTapLogic({
      isSelectionMode,
      fileId: file.id,
      onToggleSelection,
      onOpen: () => onOpen(file),
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    handleCardKeyDownLogic({
      key: e.key,
      isDirectTarget: e.target === e.currentTarget,
      preventDefault: () => e.preventDefault(),
      isSelectionMode,
      fileId: file.id,
      onToggleSelection,
      onOpen: () => onOpen(file),
    });
  };

  const hoverProps = {
    onPointerEnter: (e: React.PointerEvent) => {
      if (e.pointerType === "mouse") setIsHovering(true);
    },
    onPointerLeave: (e: React.PointerEvent) => {
      if (e.pointerType === "mouse") setIsHovering(false);
    },
  };

  const gestureProps = {
    onClick: handleCardTap,
    onKeyDown: handleKeyDown,
    onPointerDown: handlePointerDown,
    onPointerMove: handlePointerMove,
    onPointerUp: cancelPress,
    onPointerCancel: cancelPress,
    onPointerLeave: cancelPress,
    onContextMenu: isTouch ? (e: React.MouseEvent) => e.preventDefault() : undefined,
    role: "button" as const,
    tabIndex: 0,
    draggable: canDrag,
    onDragStart: canDrag
      ? (e: React.DragEvent) => {
          e.dataTransfer.setData(FILE_HASH_MIME, (dragIds ?? [file.id]).join(","));
          e.dataTransfer.effectAllowed = "move";
        }
      : undefined,
  };

  const icon = getFileIcon(file.type);
  const hasPreview = previewloaded && !!preview;

  const selectionControl = (
    <label
      className={`file-select ${viewMode === "grid" ? "file-select-tile" : "file-select-list"}`}
      onClick={(e) => e.stopPropagation()}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={() => onToggleSelection(file.id)}
        aria-label={`Select ${file.name}`}
      />
      <span className="file-select-box" aria-hidden="true" />
    </label>
  );

  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };

  const moreButton = (className: string) => (
    <button
      type="button"
      className={className}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onMenu(file, e.currentTarget);
      }}
      title="More"
      aria-label="More actions"
      aria-haspopup="menu"
    >
      ⋮
    </button>
  );

  const cardClass = (base: string) => `${base}${selected ? " selected" : ""}`;

  if (viewMode === "grid") {
    return (
      <div
        className={cardClass("file-tile")}
        {...gestureProps}
        onPointerEnter={hoverProps.onPointerEnter}
        onPointerLeave={(e) => {
          hoverProps.onPointerLeave(e);
          cancelPress();
        }}
      >
        <div className="file-tile-preview">
          {selectionControl}
          {hasPreview ? (
            <img src={previewSrc} alt={file.name} className="file-tile-img" draggable={false} />
          ) : null}
          <div
            className="file-tile-icon-fallback"
            data-type={icon}
            style={{ display: hasPreview ? "none" : "flex" }}
          >
            <span className="file-tile-ext">{icon.toUpperCase()}</span>
          </div>

          <div className="file-tile-overlay">
            <button
              type="button"
              className="tile-action-btn tile-action-btn--hover-only"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={stop(() => onOpen(file))}
              title="Preview"
              aria-label="Preview"
            >
              <PreviewEyeIcon />
            </button>
            <button
              type="button"
              className="tile-action-btn tile-action-btn--hover-only"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={stop(() => onDownload(file))}
              title="Download"
              aria-label="Download"
            >
              ↓
            </button>
            <button
              type="button"
              className={`tile-action-btn tile-action-btn--hover-only${isShared ? " is-shared" : ""}`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={stop(() => onShare(file))}
              title={isShared ? "Shared — click to manage" : "Share"}
              aria-label="Share"
            >
              <ShareIcon />
            </button>
            {moreButton("tile-action-btn tile-action-btn--more")}
          </div>
        </div>

        <div className="file-tile-footer">
          <span className="file-tile-name" title={file.name}>{file.name}</span>
          <span className="file-tile-meta">{formatSize(file.size)} · {formatDate(file.uploadedAt)}</span>
          <ServerBadge server={file.server} />
        </div>
      </div>
    );
  }

  return (
    <div
      className={cardClass("file-card")}
      {...gestureProps}
      onPointerEnter={hoverProps.onPointerEnter}
      onPointerLeave={(e) => {
        hoverProps.onPointerLeave(e);
        cancelPress();
      }}
    >
      {selectionControl}
      <div className="file-icon" data-type={icon}>
        {hasPreview ? <img src={previewSrc} alt="" draggable={false} /> : icon.toUpperCase()}
      </div>
      <div className="file-info">
        <span className="file-name" title={file.name}>{file.name}</span>
        <span className="file-meta">
          {formatSize(file.size)} · {formatDate(file.uploadedAt)}
          <ServerBadge server={file.server} />
        </span>
      </div>
      <div className="file-actions">
        <button
          type="button"
          className="action-btn action-btn--hover-only"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={stop(() => onDownload(file))}
          title="Download"
          aria-label="Download"
        >
          ↓
        </button>
        <button
          type="button"
          className="action-btn action-btn--hover-only"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={stop(() => onOpen(file))}
          title="Preview"
          aria-label="Preview"
        >
          <PreviewEyeIcon />
        </button>
        <button
          type="button"
          className={`action-btn action-btn--hover-only${isShared ? " is-shared" : ""}`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={stop(() => onShare(file))}
          title={isShared ? "Shared — click to manage" : "Share"}
          aria-label="Share"
        >
          <ShareIcon />
        </button>
        {moreButton("action-btn menu-btn")}
      </div>
    </div>
  );
});
