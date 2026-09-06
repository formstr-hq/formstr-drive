import { useState, useCallback, useRef } from "react";
import { useFileIndex } from '../../hooks/useFileContext';
import { useBlossomServer } from '../../hooks/useBlossomServer';
import { getUploadCandidateServers } from '../../Provider/BlossomServerProvider';
import { queueUpload } from '../../transfers/transferQueue';

export function UploadZone() {
  const { currentFolder } = useFileIndex();
  const { selectedServer, servers } = useBlossomServer();
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback(
    (files: FileList) => {
      // Enqueue every file; the queue serializes uploads (concurrency 1) and the
      // transfer panel is the source of truth for progress, errors and retry.
      const candidateServers = getUploadCandidateServers(selectedServer, servers);
      for (const file of Array.from(files)) {
        queueUpload(file, selectedServer, currentFolder, candidateServers);
      }
    },
    [selectedServer, servers, currentFolder]
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

  return (
    <div className="upload-zone-wrapper">
      <div
        className={`upload-zone ${isDragging ? "dragging" : ""}`}
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
        <span className="upload-prompt">
          Drop files here or click to upload
        </span>
      </div>
    </div>
  );
}
