import React, { useState } from "react";
import { decryptFileWithKey } from '../../crypto';
import { BlossomClient, BlossomError } from '../../blossom';
import { useBlossomServer } from '../../hooks/useBlossomServer';

function detectFileType(bytes: Uint8Array): { mime: string; ext: string } {
  // Check magic bytes
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { mime: "image/png", ext: "png" };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: "image/jpeg", ext: "jpg" };
  }
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return { mime: "image/gif", ext: "gif" };
  }
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    return { mime: "application/pdf", ext: "pdf" };
  }

  // Check text-based formats
  const text = new TextDecoder().decode(bytes.slice(0, 100));
  if (text.startsWith("<svg") || text.startsWith("<?xml") && text.includes("<svg")) {
    return { mime: "image/svg+xml", ext: "svg" };
  }
  if (text.startsWith("<!DOCTYPE html") || text.startsWith("<html")) {
    return { mime: "text/html", ext: "html" };
  }
  if (text.startsWith("{") || text.startsWith("[")) {
    return { mime: "application/json", ext: "json" };
  }

  return { mime: "application/octet-stream", ext: "bin" };
}

export const FileDownload: React.FC = () => {
  const { selectedServer } = useBlossomServer();
  const [sha256, setSha256] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [content, setContent] = useState<Uint8Array | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ message: string; isCorsError: boolean } | null>(null);

  const handleDownload = async () => {
    setLoading(true);
    setError(null);
    setContent(null);

    try {
      const client = new BlossomClient(selectedServer);
      const blob = await client.download(sha256);
      const ciphertext = new TextDecoder().decode(blob);
      const decrypted = await decryptFileWithKey(ciphertext, privateKey);
      setContent(decrypted);
    } catch (e) {
      if (e instanceof BlossomError) {
        setError({ message: e.message, isCorsError: e.isCorsError });
      } else if (e instanceof Error) {
        setError({ message: e.message, isCorsError: false });
      } else {
        setError({ message: "An unknown error occurred", isCorsError: false });
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <input
        type="text"
        value={sha256}
        onChange={(e) => setSha256(e.target.value)}
        placeholder="SHA256"
      />
      <input
        type="text"
        value={privateKey}
        onChange={(e) => setPrivateKey(e.target.value)}
        placeholder="Private Key (hex)"
      />
      <button onClick={handleDownload} disabled={!sha256 || !privateKey || loading}>
        {loading ? "Downloading..." : "Download"}
      </button>
      {content && (
        <div>
          <p>Decrypted {content.length} bytes ({detectFileType(content).ext})</p>
          <button
            onClick={() => {
              const { mime, ext } = detectFileType(content);
              const blob = new Blob([content as BlobPart], { type: mime });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `${sha256.slice(0, 8)}.${ext}`;
              a.click();
              URL.revokeObjectURL(url);
            }}
          >
            Save File
          </button>
        </div>
      )}
      {error && (
        <div className="error-message">
          <p>{error.message}</p>
          {error.isCorsError && (
            <p className="cors-help">
              This server may not allow requests from your browser. Try selecting a different server or adding a server that supports CORS.
            </p>
          )}
        </div>
      )}
    </div>
  );
};
