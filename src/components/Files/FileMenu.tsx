import { PreviewEyeIcon, ShareIcon } from "../icons/Icons";

export interface FileMenuProps {
  onView: () => void;
  onDownload: () => void;
  onShare: () => void;
  onMove: () => void;
  onRename: () => void;
  onDelete: () => void;
  isShared?: boolean;
}

/** The list of file actions. Presentation only — FileActionSheet owns
 *  positioning, scrim and dismissal. */
export function FileMenu({
  onView,
  onDownload,
  onShare,
  onMove,
  onRename,
  onDelete,
  isShared = false,
}: FileMenuProps) {
  return (
    <div className="file-menu" role="menu" aria-label="File actions">
      <button type="button" role="menuitem" className="file-menu-item" onClick={onView}>
        <PreviewEyeIcon />
        <span>View</span>
      </button>

      <button type="button" role="menuitem" className="file-menu-item" onClick={onDownload}>
        <span className="file-menu-icon-arrow" aria-hidden="true">↓</span>
        <span>Download</span>
      </button>

      <button
        type="button"
        role="menuitem"
        className={`file-menu-item share-btn${isShared ? " is-shared" : ""}`}
        onClick={onShare}
      >
        <ShareIcon />
        <span>{isShared ? "Manage share link" : "Share"}</span>
      </button>

      <div className="file-menu-divider" role="separator" />

      <button type="button" role="menuitem" className="file-menu-item" onClick={onMove}>
        <svg viewBox="0 0 24 16" fill="none" className="file-menu-icon" aria-hidden="true">
          <path
            d="M2 2.5C2 1.67 2.67 1 3.5 1H8.7C9.14 1 9.56 1.2 9.84 1.54L11.18 3.2C11.47 3.56 11.9 3.76 12.36 3.76H20.5C21.33 3.76 22 4.43 22 5.26V13.5C22 14.33 21.33 15 20.5 15H3.5C2.67 15 2 14.33 2 13.5V2.5Z"
            fill="currentColor"
          />
        </svg>
        <span>Move to folder</span>
      </button>

      <button type="button" role="menuitem" className="file-menu-item" onClick={onRename}>
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="file-menu-icon"
          aria-hidden="true"
        >
          <path d="M11.5 2.5l2 2L5 13H3v-2l8.5-8.5z" />
        </svg>
        <span>Rename</span>
      </button>

      <div className="file-menu-divider" role="separator" />

      <button type="button" role="menuitem" className="file-menu-item delete-btn" onClick={onDelete}>
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="file-menu-icon"
          aria-hidden="true"
        >
          <path d="M3 4.5h10M5.5 4.5v8a1 1 0 001 1h3a1 1 0 001-1v-8M6.5 2.5h3" />
        </svg>
        <span>Delete</span>
      </button>
    </div>
  );
}
