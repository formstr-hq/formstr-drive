import { isAndroidPlatform } from '../../utils/platform';
import { openDownloadedFile } from '../../native/driveManifest';
import type { TransferItem } from '../../transfers/transferStore';
import { canRetryTransfer } from '../../transfers/transferQueue';
import "./UploadManager.css";

export function TransferManager({
  type,
  transfers,
  onCancel,
  onRetry,
  onDismiss,
}: {
  type: "upload" | "download";
  transfers: TransferItem[];
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  const isUpload = type === "upload";
  const verb = isUpload ? "Uploading" : "Downloading";
  const active = transfers.filter((t) => t.status === "running" || t.status === "pending");

  // Footer copy is platform-specific. On web, background tabs keep transferring,
  // so a persistent "don't close" banner is misleading — the real risk (closing
  // the tab) is handled by the beforeunload guard, not a banner. Only the app
  // needs an advisory, and only for uploads (which run in the webview and die if
  // the app is killed); native downloads survive in the foreground service.
  const showAndroidFooter = isAndroidPlatform && active.length > 0;

  const headerLabel =
    active.length > 0
      ? `${verb} ${active.length} ${active.length === 1 ? "item" : "items"}`
      : `${isUpload ? "Uploads" : "Downloads"}`;

  return (
    <div className="upload-manager">
      <div className="upload-manager-header">
        <span className="upload-manager-title">{headerLabel}</span>
      </div>
      <div className="upload-manager-body transfer-list-body">
        {transfers.map((transfer) => (
          <TransferRow
            key={transfer.id}
            transfer={transfer}
            isUpload={isUpload}
            onCancel={onCancel}
            onRetry={onRetry}
            onDismiss={onDismiss}
          />
        ))}
      </div>
      {showAndroidFooter && (
        <div className={isUpload ? "transfer-warning" : "transfer-info"}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="16" x2="12" y2="12"></line>
            <line x1="12" y1="8" x2="12.01" y2="8"></line>
          </svg>
          <span>
            {isUpload
              ? "Keep the app open — uploading needs it to stay active."
              : "Files are downloading. You'll be notified when they complete."}
          </span>
        </div>
      )}
    </div>
  );
}

function TransferRow({
  transfer,
  isUpload,
  onCancel,
  onRetry,
  onDismiss,
}: {
  transfer: TransferItem;
  isUpload: boolean;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  const percent = transfer.progress ?? 0;
  const radius = 10;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (percent / 100) * circumference;
  const totalChunks = transfer.totalChunks || 0;
  const currentChunk = transfer.currentChunk || 0;

  const isTerminal =
    transfer.status === "completed" || transfer.status === "failed" || transfer.status === "cancelled";
  // Terminal *and* actually restartable — an adopted native row has no job
  // behind it, so offering Retry there would be a button that does nothing.
  const isRetryable = canRetryTransfer(transfer.id);

  // Upload runs two passes: hash/encrypt then upload. The first pass tops out
  // around 50%. Driven off progress rather than a fragile stage-string compare.
  const isHashingPass = isUpload && transfer.status === "running" && percent < 50;

  const chunkClass = (index: number): string => {
    const idx = index + 1;
    if (transfer.status === "completed") return "done";
    if (isHashingPass) {
      if (idx < currentChunk) return "hashing-done";
      if (idx === currentChunk) return "hashing";
      return "pending";
    }
    if (idx < currentChunk) return "done";
    if (idx === currentChunk) return "uploading";
    return "pending";
  };

  const stageText =
    transfer.status === "failed"
      ? transfer.error || "Failed"
      : transfer.status === "cancelled"
        ? "Cancelled"
        : transfer.stage || transfer.status;

  return (
    <div className={`upload-item transfer-item--${transfer.status}`}>
      <div className="upload-item-icon">
        {isUpload ? (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
            <line x1="12" y1="18" x2="12" y2="12"></line>
            <polyline points="9 15 12 12 15 15"></polyline>
          </svg>
        ) : (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
            <polyline points="7 10 12 15 17 10"></polyline>
            <line x1="12" y1="15" x2="12" y2="3"></line>
          </svg>
        )}
      </div>
      <div className="upload-item-info">
        <span className="upload-item-name" title={transfer.fileDetails.name}>{transfer.fileDetails.name}</span>
        <span
          className={`upload-item-stage${transfer.status === "failed" ? " upload-item-stage--error" : ""}`}
          title={stageText}
        >
          {stageText}
        </span>

        {totalChunks > 1 && !isTerminal && (
          <div className="chunk-grid">
            {Array.from({ length: totalChunks }).map((_, i) => (
              <div key={i} className={`chunk-indicator ${chunkClass(i)}`} title={`Chunk ${i + 1}`} />
            ))}
          </div>
        )}
      </div>

      {transfer.status === "completed" ? (
        <span className="transfer-status-icon transfer-status-icon--done" aria-label="Completed">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
        </span>
      ) : isTerminal ? null : (
        <div className="upload-progress-wrapper">
          <svg className="circular-progress" width="28" height="28" viewBox="0 0 24 24">
            <circle className="progress-bg" cx="12" cy="12" r={radius} strokeWidth="2" />
            <circle
              className="progress-bar"
              cx="12" cy="12" r={radius} strokeWidth="2"
              style={{ strokeDasharray: circumference, strokeDashoffset }}
            />
          </svg>
          <span className="progress-text">{percent}%</span>
        </div>
      )}

      <div className="transfer-row-actions">
        {!isUpload && transfer.status === "completed" && transfer.resultUri && (
          <button
            className="transfer-action-btn"
            onClick={() => void openDownloadedFile(transfer.resultUri!, "application/octet-stream")}
            title="View file"
            aria-label="View file"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"></path>
              <circle cx="12" cy="12" r="3"></circle>
            </svg>
          </button>
        )}
        {isRetryable && (
          <button
            className="transfer-action-btn"
            onClick={() => onRetry(transfer.id)}
            title={`Retry ${isUpload ? "upload" : "download"}`}
            aria-label={`Retry ${isUpload ? "upload" : "download"}`}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10"></polyline>
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
            </svg>
          </button>
        )}
        {isTerminal ? (
          <button
            className="transfer-action-btn cancel-transfer-btn"
            onClick={() => onDismiss(transfer.id)}
            title="Dismiss"
            aria-label="Dismiss"
          >
            ×
          </button>
        ) : (
          <button
            className="transfer-action-btn cancel-transfer-btn"
            onClick={() => onCancel(transfer.id)}
            title={isUpload ? "Cancel upload" : "Cancel download"}
            aria-label={isUpload ? "Cancel upload" : "Cancel download"}
          >
            ×
          </button>
        )}
      </div>
    </div>
  );
}
