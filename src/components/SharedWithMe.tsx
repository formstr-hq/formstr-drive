import { useState, useEffect } from "react";
import { useProfileContext } from "../hooks/useProfileContext";
import { fetchSharedWithMe } from "../services/fileIndex";
import type { FileMetadata } from "../types/metadata";
import { FileCard } from "./FileCard";

export function SharedWithMe() {
  const { pubkey } = useProfileContext();
  const [sharedFiles, setSharedFiles] = useState<{ file: FileMetadata; sender: string; eventId: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (!pubkey) {
      setLoading(false);
      return;
    }

    setLoading(true);
    fetchSharedWithMe(pubkey)
      .then((files) => {
        if (!cancelled) {
          setSharedFiles(files);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [pubkey]);

  if (loading) {
    return <div className="file-list-empty">Loading shared files...</div>;
  }

  if (error) {
    return <div className="file-list-empty" style={{ color: "red" }}>Error: {error}</div>;
  }

  if (sharedFiles.length === 0) {
    return (
      <div className="file-list-empty">
        <span className="empty-icon">🤝</span>
        <h3>No shared files yet</h3>
        <p>Files shared with you will appear here.</p>
      </div>
    );
  }

  return (
    <div className="file-list-grid">
      {sharedFiles.map(({ file, eventId }) => (
        <FileCard key={eventId} file={file} viewMode="grid" isShared={true} />
      ))}
    </div>
  );
}
