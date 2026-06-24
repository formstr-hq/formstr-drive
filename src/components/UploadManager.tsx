import { useFileIndex } from "../hooks/useFileContext";
import "./UploadManager.css";

export function UploadManager() {
  const { uploadProgress } = useFileIndex();

  if (!uploadProgress) return null;

  const progress = uploadProgress.progress ?? 0;
  const radius = 10;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (progress / 100) * circumference;

  const totalChunks = uploadProgress.totalChunks || 0;
  const currentChunk = uploadProgress.currentChunk || 0;
  
  // Determine if we are in pass 2 based on the stage text
  const isPass2 = uploadProgress.stage.includes("Uploading chunk") || uploadProgress.stage === "Upload complete";

  return (
    <div className="upload-manager">
      <div className="upload-manager-header">
        <span className="upload-manager-title">Uploading 1 item</span>
      </div>
      <div className="upload-manager-body">
        <div className="upload-item">
          <div className="upload-item-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
              <polyline points="14 2 14 8 20 8"></polyline>
              <line x1="12" y1="18" x2="12" y2="12"></line>
              <polyline points="9 15 12 12 15 15"></polyline>
            </svg>
          </div>
          <div className="upload-item-info">
            <span className="upload-item-name">{uploadProgress.fileName}</span>
            <span className="upload-item-stage">{uploadProgress.stage}</span>
            
            {totalChunks > 1 && (
              <div className="chunk-grid">
                {Array.from({ length: totalChunks }).map((_, i) => {
                  let status = "pending";
                  if (isPass2) {
                    if (i + 1 < currentChunk || uploadProgress.stage === "Upload complete") status = "done";
                    else if (i + 1 === currentChunk) status = "uploading";
                  } else {
                    if (i + 1 < currentChunk) status = "hashing-done";
                    else if (i + 1 === currentChunk) status = "hashing";
                  }
                  return <div key={i} className={`chunk-indicator ${status}`} title={`Chunk ${i + 1}`} />;
                })}
              </div>
            )}
          </div>
          
          <div className="upload-progress-wrapper">
            <svg className="circular-progress" width="28" height="28" viewBox="0 0 24 24">
              <circle className="progress-bg" cx="12" cy="12" r={radius} strokeWidth="2" />
              <circle
                className="progress-bar"
                cx="12" cy="12" r={radius} strokeWidth="2"
                style={{ strokeDasharray: circumference, strokeDashoffset }}
              />
            </svg>
            <span className="progress-text">{progress}%</span>
          </div>
        </div>
      </div>
    </div>
  );
}
