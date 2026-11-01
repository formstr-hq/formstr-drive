/**
 * src/components/preview/DocxPreview.tsx
 * In-app document viewer for Microsoft Word .docx files using docx-preview.
 * Renders complete multi-page documents with exact layouts, margins, tables,
 * typography, and page breaks, identical to Google Drive / Word Online.
 */

import React, { useEffect, useRef, useState } from "react";
import { renderAsync } from "docx-preview";

interface DocxPreviewProps {
  data: Uint8Array | Blob;
  onOpenInPages?: () => void;
}

export const DocxPreview: React.FC<DocxPreviewProps> = ({
  data,
  onOpenInPages,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [renderError, setRenderError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const render = async () => {
      if (!containerRef.current) return;
      containerRef.current.innerHTML = "";
      setLoading(true);
      setRenderError(null);

      try {
        await renderAsync(data, containerRef.current, undefined, {
          className: "docx",
          inWrapper: true,
          ignoreWidth: false,
          ignoreHeight: false,
          breakPages: true,
          useBase64URL: true,
        });

        if (!cancelled) {
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          console.error("Failed to render docx:", err);
          setRenderError(
            err instanceof Error ? err.message : "Failed to render document preview"
          );
          setLoading(false);
        }
      }
    };

    render();

    return () => {
      cancelled = true;
    };
  }, [data]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        minHeight: 0,
        gap: "10px",
      }}
    >
      {/* Document Viewport */}
      <div
        className="docx-preview-viewport"
        style={{
          flex: 1,
          overflowY: "auto",
          overflowX: "auto",
          backgroundColor: "#1b1f2a",
          borderRadius: "8px",
          position: "relative",
          minHeight: 0,
        }}
      >
        {loading && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              height: "200px",
              color: "#9ca3af",
              fontSize: "14px",
            }}
          >
            Rendering document...
          </div>
        )}

        {renderError && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              height: "200px",
              color: "#ef4444",
              fontSize: "14px",
              gap: "12px",
            }}
          >
            <div>Unable to render document pages: {renderError}</div>
            {onOpenInPages && (
              <button
                type="button"
                onClick={onOpenInPages}
                style={{
                  padding: "8px 16px",
                  backgroundColor: "#2563eb",
                  color: "#ffffff",
                  border: "none",
                  borderRadius: "6px",
                  fontSize: "13px",
                  cursor: "pointer",
                }}
              >
                Open in Pages
              </button>
            )}
          </div>
        )}

        <div
          ref={containerRef}
          className="docx-preview-container"
          style={{
            display: loading ? "none" : "block",
            padding: "16px 12px",
          }}
        />
        <style>{`
          .docx-preview-container .docx-wrapper { background: transparent; padding: 0; align-items: center; }
          .docx-preview-container .docx-wrapper > section.docx {
            background: #fff; color: #000; box-shadow: 0 2px 12px rgba(0,0,0,.4); margin-bottom: 16px; flex-shrink: 0;
          }
          .docx-preview-container .docx-wrapper > section.docx * { color: inherit; }
        `}</style>
      </div>
    </div>
  );
};
