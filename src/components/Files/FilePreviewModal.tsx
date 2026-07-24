import { useEffect, useState } from "react";
import type { FileMetadata } from '../../types/metadata';
import { resolvePreviewMode, MAX_PREVIEW_SIZE } from '../../utils/fileTypeHelpers';
import { canOpenInNostrDocs, openInNostrDocs } from '../../utils/docsIntegrationHelpers';
import { downloadAndDecryptFile } from '../../services/downloadFile';
import { useToast } from '../../hooks/useToast';

interface FilePreviewModalProps {
  file: FileMetadata;
  onClose: () => void;
}
import { ImagePreview } from '../preview/ImagePreview';
import { VideoPreview } from '../preview/VideoPreview';
import { PdfPreview } from '../preview/PdfPreview';
import { TextPreview } from '../preview/TextPreview';

export function FilePreviewModal({ file, onClose }: FilePreviewModalProps) {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [pagesHint, setPagesHint] = useState<string | null>(null);

  const mode = resolvePreviewMode(file.type);
  const supportsNostrDocsDeepLink = canOpenInNostrDocs(file);



  useEffect(() => {
    let cancelled = false;
    let createdUrl: string | null = null;

    const loadPreview = async () => {
      setLoading(true);
      setError(null);
      setBlobUrl(null);
      setTextContent(null);

      if (mode === "unsupported") {
        setLoading(false);
        return;
      }

      if (file.size > MAX_PREVIEW_SIZE) {
        setError("File is too large to preview (over 5 MB). Please download it to view.");
        setLoading(false);
        return;
      }

      try {
        const decryptedBytes = await downloadAndDecryptFile(file);

        if (cancelled) return;

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
        const message = e instanceof Error ? e.message : "Failed to load preview";
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
    };
  }, [file, mode, toast]);

  return (
    <div className="preview-modal-overlay" onClick={onClose}>
      <div className="preview-modal" data-surface="inverse" onClick={(e) => e.stopPropagation()}>
        <div className="preview-modal-header">
          <div className="preview-modal-title-wrap">
            <h3 className="preview-modal-title" title={file.name}>{file.name}</h3>
            <span className="preview-modal-subtitle">{file.type || "Unknown type"}</span>
          </div>
          <button className="preview-modal-close" onClick={onClose} aria-label="Close preview">X</button>
        </div>

        <div className="preview-modal-body">
          {loading && <div className="preview-modal-state">Loading preview...</div>}

          {!loading && error && <div className="preview-modal-state error">{error}</div>}

          {!loading && !error && mode === "unsupported" && (
            <div className="preview-modal-state">
              This file type is uploaded successfully, but in-app preview is not available yet.
              {supportsNostrDocsDeepLink && (
                <>
                  <br />
                  <button className="preview-open-docs-btn" onClick={() => openInNostrDocs(file)}>
                    Open in Nostr Docs
                  </button>
                </>
              )}
            </div>
          )}

          {!loading && !error && mode === "image" && blobUrl && (
            <ImagePreview blobUrl={blobUrl} name={file.name} />
          )}

          {!loading && !error && mode === "video" && blobUrl && (
            <VideoPreview blobUrl={blobUrl} />
          )}

          {!loading && !error && mode === "pdf" && blobUrl && (
            <PdfPreview blobUrl={blobUrl} name={file.name} />
          )}

          {!loading && !error && mode === "text" && textContent !== null && (
            <TextPreview textContent={textContent} pagesHint={pagesHint} setPagesHint={setPagesHint} />
          )}
        </div>
      </div>
    </div>
  );
}
