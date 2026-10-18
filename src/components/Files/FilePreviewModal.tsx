import { useEffect, useState } from "react";
import { isLegacyBlobFormat, type FileMetadata } from '../../types/metadata';
import { resolvePreviewMode, MAX_PREVIEW_SIZE, browserMayPlayVideo, unsupportedVideoMessage, PREVIEW_UNAVAILABLE_MESSAGE } from '../../utils/fileTypeHelpers';
import { canOpenInPages, openFileInPages } from '../../utils/docsIntegrationHelpers';
import { downloadAndDecryptFile } from '../../services/downloadFile';
import { hasServiceWorkerSupport } from '../../services/swStreamDownload';
import { openMediaSession, type MediaSession } from '../../services/swMediaStream';
import { probeRangeSupport } from '../../services/rangeRead';
import { useToast } from '../../hooks/useToast';
import { useBackButton } from '../../hooks/useBackButton';
import { ImagePreview } from '../preview/ImagePreview';
import { VideoPreview } from '../preview/VideoPreview';
import { PdfPreview } from '../preview/PdfPreview';
import { TextPreview } from '../preview/TextPreview';
import { HtmlPreview } from '../preview/HtmlPreview';
import { DocxPreview } from '../preview/DocxPreview';
import { ExternalLinkIcon } from '../icons/Icons';

/**
 * Video/PDF are the only modes with a seekable streaming path (see
 * swMediaStream.ts / rangeRead.ts) — any NIP-FS segment decrypts in
 * isolation, so a Range request maps cleanly onto a plaintext byte range.
 * Images, text and HTML stay on the whole-file path: they're rendered once, not
 * scrubbed, so there's nothing seeking would buy them.
 *
 * Gated on `file.size > MAX_PREVIEW_SIZE`: a file the whole-file path can
 * already handle in one clean fetch has nothing to gain from the streaming
 * path, only extra cost — an SW handshake, a range-support probe request,
 * and per-range decrypt calls instead of a single decrypt. The streaming
 * path exists specifically to reach files that path CAN'T serve.
 */
function canStreamPreview(file: FileMetadata, mode: string): file is FileMetadata & { blobHash: string; chunkSize: number } {
  return (
    file.size > MAX_PREVIEW_SIZE &&
    (mode === "video" || mode === "pdf") &&
    !isLegacyBlobFormat(file) &&
    file.chunkSize !== undefined &&
    hasServiceWorkerSupport()
  );
}

interface FilePreviewModalProps {
  file: FileMetadata;
  onClose: () => void;
}

export function FilePreviewModal({ file, onClose }: FilePreviewModalProps) {
  useBackButton(onClose);
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [docxBytes, setDocxBytes] = useState<Uint8Array | null>(null);
  const [pagesHint, setPagesHint] = useState<string | null>(null);

  const mode = resolvePreviewMode(file.type, file.name);
  const supportsPages = canOpenInPages(file);



  useEffect(() => {
    let cancelled = false;
    let createdUrl: string | null = null;
    let mediaSession: MediaSession | null = null;

    const loadPreview = async () => {
      setLoading(true);
      setError(null);
      setBlobUrl(null);
      setTextContent(null);
      setDocxBytes(null);

      if (mode === "unsupported") {
        setLoading(false);
        return;
      }

      // Don't spend minutes (and GBs) streaming a file the browser has already
      // said it can't play — e.g. MKV in Firefox, which has no Matroska
      // demuxer. canPlayType only rules out the container type: an empty
      // answer is a firm "no", anything else may still fail on its codec
      // (VideoPreview reports that when it happens).
      if (mode === "video" && !browserMayPlayVideo(file.type)) {
        setError(unsupportedVideoMessage(file.name));
        setLoading(false);
        return;
      }

      if (canStreamPreview(file, mode)) {
        try {
          // A server that ignores Range would only decode correctly from
          // byte 0, then fail every subsequent seek — probe before
          // committing to the streaming path rather than discovering that
          // mid-playback.
          const supportsRange = await probeRangeSupport(file);
          if (supportsRange) {
            const session = await openMediaSession(file);
            if (cancelled) {
              session.release();
              return;
            }
            mediaSession = session;
            setBlobUrl(session.url);
            setLoading(false);
            return;
          }
        } catch (e) {
          console.warn("Seekable preview unavailable, falling back to full download:", e);
        }
      }

      if (file.size > MAX_PREVIEW_SIZE) {
        setError(PREVIEW_UNAVAILABLE_MESSAGE);
        setLoading(false);
        return;
      }

      try {
        const decryptedBytes = await downloadAndDecryptFile(file);

        if (cancelled) return;

        if (mode === "html") {
          const blob = new Blob([decryptedBytes as BlobPart], { type: "text/html;charset=utf-8" });
          createdUrl = URL.createObjectURL(blob);
          setBlobUrl(createdUrl);
          const decoded = new TextDecoder().decode(decryptedBytes);
          setTextContent(decoded);
          return;
        }

        if (mode === "docx") {
          setDocxBytes(decryptedBytes);
          return;
        }

        if (mode === "text") {
          const decoded = new TextDecoder().decode(decryptedBytes);
          setTextContent(decoded);
          return;
        }

        const blob = new Blob([decryptedBytes as BlobPart], { type: file.type || "application/octet-stream" });
        createdUrl = URL.createObjectURL(blob);
        setBlobUrl(createdUrl);
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        const isNotFound = /404|not found/i.test(msg);
        const message = isNotFound
          ? "This file is no longer available (it may have been deleted by the owner)."
          : (e instanceof Error ? e.message : "Failed to load preview");
        setError(message);
        toast.error(message);
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    loadPreview();

    return () => {
      cancelled = true;
      if (createdUrl) {
        URL.revokeObjectURL(createdUrl);
      }
      mediaSession?.release();
    };
  }, [file, mode, toast]);

  const handleOpenInPages = async () => {
    try {
      await openFileInPages(file, {
        textContent,
        notify: (hint) => {
          setPagesHint(hint);
          toast.info(hint);
        },
      });
    } catch {
      toast.error("Failed to open file in Formstr Pages");
    }
  };

  const handleOpenInNewTab = () => {
    if (blobUrl) {
      window.open(blobUrl, "_blank", "noopener,noreferrer");
      return;
    }
    if (textContent !== null) {
      const mime = mode === "html" ? "text/html;charset=utf-8" : "text/plain;charset=utf-8";
      const blob = new Blob([textContent], { type: mime });
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener,noreferrer");
      return;
    }
  };

  return (
    <div className="preview-modal-overlay" onClick={onClose}>
      <div className="preview-modal" data-surface="inverse" onClick={(e) => e.stopPropagation()}>
        <div className="preview-modal-header">
          <div className="preview-modal-title-wrap">
            <h3 className="preview-modal-title" title={file.name}>{file.name}</h3>
            <span className="preview-modal-subtitle">{file.type || "Unknown type"}</span>
          </div>
          <div className="preview-modal-header-actions">
            {supportsPages && (
              <button
                type="button"
                className="preview-header-pages-btn"
                onClick={handleOpenInPages}
                title="Open in Formstr Pages"
              >
                <img src="/pages-favicon.svg" alt="" width={18} height={18} />
                <span>Open in Pages</span>
              </button>
            )}
            {(blobUrl || textContent !== null) && (
              <button
                type="button"
                className="preview-header-tab-btn"
                onClick={handleOpenInNewTab}
                title="Open in new tab"
                aria-label="Open in new tab"
              >
                <ExternalLinkIcon />
              </button>
            )}
            <button className="preview-modal-close" onClick={onClose} aria-label="Close preview">×</button>
          </div>
        </div>

        <div className="preview-modal-body">
          {loading && <div className="preview-modal-state">Loading preview...</div>}

          {!loading && error && <div className="preview-modal-state error">{error}</div>}

          {!loading && !error && mode === "unsupported" && (
            <div className="preview-modal-state">
              This file type is uploaded successfully, but in-app preview is not available yet.
              {supportsPages && (
                <>
                  <br />
                  <button className="preview-open-docs-btn" onClick={handleOpenInPages}>
                    Open in Formstr Pages
                  </button>
                </>
              )}
            </div>
          )}

          {!loading && !error && mode === "image" && blobUrl && (
            <ImagePreview blobUrl={blobUrl} name={file.name} />
          )}

          {!loading && !error && mode === "video" && blobUrl && (
            <VideoPreview key={blobUrl} blobUrl={blobUrl} />
          )}

          {!loading && !error && mode === "pdf" && blobUrl && (
            <PdfPreview blobUrl={blobUrl} name={file.name} />
          )}

          {!loading && !error && mode === "docx" && docxBytes !== null && (
            <DocxPreview
              data={docxBytes}
              onOpenInPages={handleOpenInPages}
            />
          )}

          {!loading && !error && mode === "html" && textContent !== null && (
            <HtmlPreview htmlContent={textContent} name={file.name} blobUrl={blobUrl} />
          )}

          {!loading && !error && mode === "text" && textContent !== null && (
            <TextPreview
              textContent={textContent}
              pagesHint={pagesHint}
              setPagesHint={setPagesHint}
              onOpenInPages={handleOpenInPages}
            />
          )}
        </div>
      </div>
    </div>
  );
}
