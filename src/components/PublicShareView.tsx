import { useState, useEffect } from "react";
import type { FileMetadata } from "../types/metadata";
import { FileCard } from "./FileCard";

export function PublicShareView() {
  const [file, setFile] = useState<FileMetadata | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      const hashParams = new URLSearchParams(window.location.hash.slice(1));
      const hash = hashParams.get("hash");
      const server = hashParams.get("server");
      const key = hashParams.get("key");
      const name = hashParams.get("name") || "Shared File";
      const type = hashParams.get("type") || "application/octet-stream";

      if (!hash || !server || !key) {
        throw new Error("Invalid public share link. Missing required parameters.");
      }

      setFile({
        hash,
        server,
        encryptionKey: key,
        name,
        type,
        size: 0,
        folder: "/",
        uploadedAt: Date.now(),
        encryptionAlgorithm: "nip44",
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to parse link");
    }
  }, []);

  if (error) {
    return (
      <div className="loading-container">
        <div className="error-state" style={{ textAlign: "center", color: "var(--error-color)" }}>
          <h3>Error</h3>
          <p>{error}</p>
        </div>
      </div>
    );
  }

  if (!file) {
    return <div className="loading-container">Loading shared file...</div>;
  }

  return (
    <div className="drive-layout">
      <header className="header">
        <div className="header-left">
          <span className="app-title">Formstr Drive - Public Share</span>
        </div>
        <div className="header-right">
          <button className="action-btn" onClick={() => window.location.href = "/"}>Sign In / Go to Drive</button>
        </div>
      </header>
      <main className="drive-main" style={{ display: "flex", justifyContent: "center", alignItems: "center", padding: "40px" }}>
        <div style={{ maxWidth: "400px", width: "100%" }}>
          <h2 style={{ marginBottom: "20px", textAlign: "center" }}>Shared File</h2>
          <FileCard file={file} viewMode="list" isShared={true} />
        </div>
      </main>
    </div>
  );
}
