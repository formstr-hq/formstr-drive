import { useState, useCallback, useRef } from "react";
import { useFileIndex } from '../../hooks/useFileContext';
import { useBlossomServer } from '../../hooks/useBlossomServer';
import { queueUpload } from '../../transfers/transferQueue';
import { useToast } from '../../hooks/useToast';
import { DuplicateUploadError } from '../../services/uploadErrors';

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
  const { selectedServer, openServerChooser } = useBlossomServer();
  const toast = useToast();
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback(
    (files: FileList) => {
      if (disabled) return;
      // No server is chosen until the user chooses one - ask first.
      if (!selectedServer) {
        openServerChooser();
        return;
      }
      // Enqueue every file; the queue serializes uploads (concurrency 1) and the
      // transfer panel is the source of truth for progress, errors and retry.
      // Only the selected server is tried: there is no silent fallback, so a
      // failed upload reports that server's own reason.
      for (const file of Array.from(files)) {
        queueUpload(file, selectedServer, currentFolder, [selectedServer], {
          // The transfer panel truncates the reason, and a failure there doesn't
          // say what to do about it. Say why it failed and offer the way out.
          onSettled: (outcome, error) => {
            if (outcome !== "failed") return;
            // Not a server problem: the same file is already here on this
            // server. Say so plainly - choosing another server isn't the fix.
            if (error instanceof DuplicateUploadError) {
              toast.info(
                error.existingName === file.name
                  ? `${error.message}`
                  : `"${file.name}" is the same file as "${error.existingName}", which already exists in your drive on this server.`,
                { duration: 8000 },
              );
              return;
            }
            const raw = (error instanceof Error ? error.message : "The upload failed.").trim();
            const reason = /[.!?]$/.test(raw) ? raw : `${raw}.`;
            toast.error(`${reason} Choose another server, then upload "${file.name}" again.`, {
              duration: 12000,
              action: { label: "Choose server", onClick: openServerChooser },
            });
          },
        });
      }
    },
    [disabled, selectedServer, currentFolder, openServerChooser, toast]
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
    // Don't open the file picker just to refuse the files afterwards.
    if (!selectedServer) {
      openServerChooser();
      return;
    }
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
