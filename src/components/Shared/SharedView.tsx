import { useEffect, useState } from "react";
import { parseShareHash, resolveSharedLink } from "../../services/sharing";
import { downloadFileStreaming, type DownloadProgressInfo } from "../../services/downloadFile";
import type { FileMetadata } from "../../types/metadata";
import { formatSize, formatUnixSeconds } from "../../utils/format";
import { getFileIcon } from "../../utils/fileTypeHelpers";
import { fetchFilePreview, getCachedPreview, type PreviewData } from "../../services/Preview/fetchPreview";
import "../ui/Loader.css";
import "./SharedView.css";

/**
 * The small `previewHash` thumbnail (same one FileCard shows in the signed-in
 * drive), independent of the file's own size — a multi-GB video still has a
 * capped-at-300px thumbnail. Falls back to the generic type-letter badge
 * while loading, on failure, or when the file has no thumbnail at all.
 * No signer or identity needed: fetchFilePreview only needs the file's own
 * (already-decrypted) `encryptionKey`, matching resolveSharedLink's own
 * "no signer required" guarantee.
 */
function SharedFileThumbnail({ file }: { file: FileMetadata }) {
  const [preview, setPreview] = useState<PreviewData | null>(
    file.previewHash ? getCachedPreview(file.previewHash) ?? null : null,
  );

  useEffect(() => {
    if (preview || !file.previewHash) return;
    let cancelled = false;
    fetchFilePreview(file)
      .then((data) => {
        if (!cancelled) setPreview(data);
      })
      .catch(() => {
        if (!cancelled) setPreview(null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.previewHash]);

  const icon = getFileIcon(file.type);
  if (!preview) {
    return (
      <div className="shared-file-icon" data-type={icon}>
        {icon.toUpperCase()}
      </div>
    );
  }

  return (
    <div className="shared-file-icon shared-file-thumbnail">
      <img src={preview.staticUrl ?? preview.url} alt="" />
    </div>
  );
}

type ResolvedState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "revoked"; target: "file" | "folder"; at: number }
  | { status: "file"; file: FileMetadata }
  | { status: "folder"; name: string; files: FileMetadata[]; partial: boolean };

/**
 * Public, no-login view for a NIP-FS share link (see docs/NIP-FS.md
 * "File/Folder Sharing"). Rendered instead of the whole signed-in app —
 * resolveSharedLink and downloadFileStreaming both work without a signer or
 * signed-in identity: relay reads and Blossom GETs need neither (only
 * uploads/deletes require a signed auth event).
 */
export function SharedView() {
  const [state, setState] = useState<ResolvedState>({ status: "loading" });
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [progress, setProgress] = useState<DownloadProgressInfo | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      const payload = parseShareHash(window.location.hash);
      if (!payload) {
        setState({ status: "error", message: "This link is not a valid share link." });
        return;
      }
      try {
        const resolved = await resolveSharedLink(payload);
        if (cancelled) return;
        if (resolved.kind === "revoked") {
          setState({ status: "revoked", target: resolved.target, at: resolved.at });
        } else if (resolved.kind === "file") {
          setState({ status: "file", file: resolved.file });
        } else {
          setState({
            status: "folder",
            name: resolved.result.name,
            files: resolved.result.files,
            partial: resolved.result.partial,
          });
        }
      } catch (e) {
        if (cancelled) return;
        setState({
          status: "error",
          message: e instanceof Error ? e.message : "Failed to load shared content.",
        });
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  const [downloadingAll, setDownloadingAll] = useState(false);

  const handleDownload = async (file: FileMetadata) => {
    setDownloadError(null);
    setProgress(null);
    setDownloadingId(file.id);
    try {
      await downloadFileStreaming(file, (info) => setProgress(info));
    } catch (e) {
      setDownloadError(e instanceof Error ? e.message : "Download failed");
    } finally {
      setDownloadingId(null);
      setProgress(null);
    }
  };

  const handleDownloadAll = async (files: FileMetadata[]) => {
    setDownloadError(null);
    setDownloadingAll(true);
    try {
      for (const file of files) {
        setDownloadingId(file.id);
        setProgress(null);
        await downloadFileStreaming(file, (info) => setProgress(info));
      }
    } catch (e) {
      setDownloadError(e instanceof Error ? e.message : "Download failed");
    } finally {
      setDownloadingId(null);
      setProgress(null);
      setDownloadingAll(false);
    }
  };

  const fileRow = (file: FileMetadata) => {
    return (
      <div className="shared-file-row" key={file.id}>
        <SharedFileThumbnail file={file} />
        <div className="shared-file-info">
          <span className="shared-file-name">{file.name}</span>
          <span className="shared-file-meta">
            {formatSize(file.size)} · {file.type || "file"}
          </span>
        </div>
        <button
          className="shared-download-btn"
          onClick={() => handleDownload(file)}
          disabled={downloadingId !== null}
        >
          {downloadingId === file.id ? progress?.stage ?? "Downloading…" : "Download"}
        </button>
      </div>
    );
  };

  const revokedMessage = (target: "file" | "folder") =>
    target === "folder"
      ? "The owner turned off sharing for this folder."
      : "The owner turned off sharing for this file.";

  return (
    <div className="shared-view">
      <div className="shared-view-card">
        <h1 className="shared-view-title">Formstr Drive — Shared</h1>

        {state.status === "loading" && (
          <div className="shared-view-loading">
            <div className="loader"></div>
            <p className="shared-view-status">Loading shared content…</p>
          </div>
        )}

        {state.status === "error" && (
          <div className="shared-view-error-card">
            <div className="error-icon">⚠️</div>
            <p className="shared-view-status shared-view-error">{state.message}</p>
            <button className="shared-download-btn retry-btn" onClick={() => window.location.reload()}>
              Retry
            </button>
          </div>
        )}

        {state.status === "revoked" && (
          <div className="shared-view-error-card">
            <div className="error-icon" aria-hidden="true">🔒</div>
            <p className="shared-view-status">
              <strong>This link has been revoked.</strong>
              <br />
              {revokedMessage(state.target)} ({formatUnixSeconds(state.at)}). Ask them for a new
              link if you still need access.
            </p>
          </div>
        )}

        {state.status === "file" && fileRow(state.file)}

        {state.status === "folder" && (
          <>
            <div className="shared-folder-header">
              <h2 className="shared-folder-name">{state.name}</h2>
              {state.files.length > 1 && (
                <button
                  className="shared-download-btn"
                  onClick={() => handleDownloadAll(state.files)}
                  disabled={downloadingId !== null}
                >
                  {downloadingAll ? progress?.stage ?? "Downloading…" : "Download all"}
                </button>
              )}
            </div>
            {state.partial && (
              <p className="shared-view-status shared-view-warning">
                Some files in this folder couldn't be loaded — they may have been removed or
                individually revoked.
              </p>
            )}
            {state.files.length === 0 ? (
              <p className="shared-view-status">This folder has no files.</p>
            ) : (
              <div className="shared-file-list">{state.files.map(fileRow)}</div>
            )}
          </>
        )}

        {downloadError && (
          <p className="shared-view-status shared-view-error">{downloadError}</p>
        )}
      </div>
    </div>
  );
}
