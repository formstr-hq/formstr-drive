import { useState } from "react";
import { ExternalLinkIcon } from "../icons/Icons";
import "./HtmlPreview.css";

interface HtmlPreviewProps {
  htmlContent: string;
  name: string;
  blobUrl?: string | null;
}

export function HtmlPreview({ htmlContent, name, blobUrl }: HtmlPreviewProps) {
  const [viewMode, setViewMode] = useState<"preview" | "source">("preview");

  const handleOpenInNewTab = () => {
    if (blobUrl) {
      window.open(blobUrl, "_blank", "noopener,noreferrer");
    } else {
      const blob = new Blob([htmlContent], { type: "text/html;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener,noreferrer");
    }
  };

  return (
    <div className="preview-html-wrap">
      <div className="preview-html-toolbar">
        <div className="preview-html-tabs">
          <button
            type="button"
            className={`preview-html-tab${viewMode === "preview" ? " active" : ""}`}
            onClick={() => setViewMode("preview")}
          >
            Preview
          </button>
          <button
            type="button"
            className={`preview-html-tab${viewMode === "source" ? " active" : ""}`}
            onClick={() => setViewMode("source")}
          >
            Source
          </button>
        </div>

        <div className="preview-html-actions">
          <button
            type="button"
            className="preview-html-open-tab-btn"
            onClick={handleOpenInNewTab}
            title="Open HTML in a new browser tab"
          >
            <ExternalLinkIcon />
            <span>Open in new tab</span>
          </button>
          <span className="preview-html-badge" title="Isolated in a sandboxed iframe with null origin">
            Sandboxed
          </span>
        </div>
      </div>

      <div className="preview-html-body">
        {viewMode === "preview" ? (
          <iframe
            srcDoc={htmlContent}
            sandbox="allow-scripts"
            className="preview-media-html"
            title={`HTML preview: ${name}`}
          />
        ) : (
          <pre className="preview-text-content">{htmlContent}</pre>
        )}
      </div>
    </div>
  );
}
