import type { FileMetadata } from '../../types/metadata';

interface MigrationPromptModalProps {
  files: FileMetadata[];
  onAccept: () => void;
  onDismiss: () => void;
}

export function MigrationPromptModal({ files, onAccept, onDismiss }: MigrationPromptModalProps) {
  if (files.length === 0) return null;

  return (
    <div className="preview-modal-overlay">
      <div className="preview-modal migration-modal">
        <div className="preview-modal-header">
          <h3 className="preview-modal-title">Legacy Files Found</h3>
          <button className="preview-modal-close" onClick={onDismiss} aria-label="Dismiss">
            X
          </button>
        </div>
        <div className="preview-modal-body">
          <p>
            We found {files.length} legacy file(s) that need to be migrated to the new Drive Key format.
          </p>
          <p>
            During migration, you might need to accept multiple decryption requests. 
            This process can take a few minutes. If you are ready, please accept the migration below.
          </p>
          <div className="migration-actions">
            <button className="preview-doc-btn" onClick={onAccept}>
              Accept and Migrate
            </button>
            <button className="cancel-btn" onClick={onDismiss}>
              Skip for now
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
