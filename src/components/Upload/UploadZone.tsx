import { useState, useCallback, useRef } from "react";
import { useFileIndex } from '../../hooks/useFileContext';
import { useBlossomServer } from '../../hooks/useBlossomServer';
import { getUploadCandidateServers } from '../../Provider/BlossomServerProvider';
import { queueUpload } from '../../transfers/transferQueue';
import { useToast } from '../../hooks/useToast';

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

interface UploadZoneProps {
  /** True while the drive is in a "degraded" (uncertain Drive Key / partial
   *  decrypt failure) state — before this prop existed, the drop target was
   *  reachable in that state regardless, and dropping a file there only
   *  surfaced its failure later as a "Failed" chip in the transfer panel,
   *  after the upload had already tried and failed to encrypt/sign under a
   *  key that isn't reliably resolved. Disabling here fails fast, at the
   *  point of the action, instead. */
  disabled?: boolean;
}

export function UploadZone({ disabled = false }: UploadZoneProps) {
  const { currentFolder } = useFileIndex();
  const { selectedServer, servers } = useBlossomServer();
  const toast = useToast();
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback(
    (files: FileList) => {
      if (disabled) return;
      // Enqueue every file; the queue serializes uploads (concurrency 1) and the
      // transfer panel is the source of truth for progress, errors and retry.
      const candidateServers = getUploadCandidateServers(selectedServer, servers);
      for (const file of Array.from(files)) {
        queueUpload(file, selectedServer, currentFolder, candidateServers, {
          // Uploads fall back to another server when the selected one can't take
          // the file (size cap, auth, unreachable). Without a word, that looks
          // like the selection being ignored — so say where it actually went.
          onComplete: (metadata) => {
            if (metadata.server && metadata.server !== selectedServer) {
              toast.info(
                `${hostOf(selectedServer)} couldn't take "${file.name}", so it was saved on ${hostOf(metadata.server)} instead.`,
                { duration: 9000 },
              );
            }
          },
        });
      }
    },
    [disabled, selectedServer, servers, currentFolder, toast]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      if (!disabled && e.dataTransfer.files.length > 0) {
        handleFiles(e.dataTransfer.files);
      }
    },
    [disabled, handleFiles]
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      if (!disabled) setIsDragging(true);
    },
    [disabled]
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleClick = () => {
    if (disabled) return;
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!disabled && e.target.files && e.target.files.length > 0) {
      handleFiles(e.target.files);
      e.target.value = "";
    }
  };

  return (
    <div className="upload-zone-wrapper">
      <div
        className={`upload-zone ${isDragging ? "dragging" : ""} ${disabled ? "upload-zone--disabled" : ""}`}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={handleClick}
        aria-disabled={disabled}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          disabled={disabled}
          onChange={handleFileChange}
          style={{ display: "none" }}
        />
        <span className="upload-prompt">
          {disabled
            ? "Uploads are paused until your Drive Key is confirmed"
            : "Drop files here or click to upload"}
        </span>
      </div>
    </div>
  );
}
