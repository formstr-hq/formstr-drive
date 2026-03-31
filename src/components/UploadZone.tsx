import { useState, useCallback, useRef } from "react";
import { useFileIndex } from "../hooks/useFileContext";
import { useBlossomServer } from "../hooks/useBlossomServer";

export function UploadZone() {
  const { uploadFile } = useFileIndex();
  const { servers, selectedServer, setSelectedServer, addCustomServer } = useBlossomServer();
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showServerMenu, setShowServerMenu] = useState(false);
  const [customUrl, setCustomUrl] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback(
    async (files: FileList) => {
      setError(null);
      setUploading(true);
      try {
        for (const file of Array.from(files)) {
          await uploadFile(file, selectedServer);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Upload failed");
      } finally {
        setUploading(false);
      }
    },
    [uploadFile, selectedServer]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      if (e.dataTransfer.files.length > 0) {
        handleFiles(e.dataTransfer.files);
      }
    },
    [handleFiles]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFiles(e.target.files);
      e.target.value = "";
    }
  };

  const handleAddCustom = () => {
    if (customUrl.trim()) {
      addCustomServer(customUrl);
      setCustomUrl("");
    }
  };

  return (
    <div className="upload-zone-wrapper">
      <div
        className={`upload-zone ${isDragging ? "dragging" : ""} ${uploading ? "uploading" : ""}`}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={handleClick}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={handleFileChange}
          style={{ display: "none" }}
        />
        {uploading ? (
          <span className="upload-status">Uploading...</span>
        ) : (
          <span className="upload-prompt">
            Drop files here or click to upload
          </span>
        )}
        {error && <span className="upload-error">{error}</span>}
      </div>

      <div className="upload-server-selector">
        <span className="server-label">Upload to:</span>
        {showServerMenu && (
          <div
            className="server-menu-backdrop"
            onClick={() => setShowServerMenu(false)}
          />
        )}
        <div className="server-dropdown">
          <button
            className="server-btn"
            onClick={(e) => {
              e.stopPropagation();
              setShowServerMenu(!showServerMenu);
            }}
          >
            {new URL(selectedServer).hostname} ▼
          </button>

          {showServerMenu && (
            <div className="server-menu">
              {servers.map((s) => (
                <button
                  key={s.url}
                  className={selectedServer === s.url ? "active" : ""}
                  onClick={() => {
                    setSelectedServer(s.url);
                    setShowServerMenu(false);
                  }}
                >
                  {new URL(s.url).hostname}
                  {s.source !== "default" && (
                    <span className="server-source">{s.source}</span>
                  )}
                </button>
              ))}
              <div className="server-menu-divider" />
              <div className="custom-server-row">
                <input
                  type="text"
                  value={customUrl}
                  onChange={(e) => setCustomUrl(e.target.value)}
                  placeholder="Add server..."
                  onKeyDown={(e) => e.key === "Enter" && handleAddCustom()}
                />
                <button onClick={handleAddCustom}>+</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
