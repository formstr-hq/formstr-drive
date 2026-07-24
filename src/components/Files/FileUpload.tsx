import React, { useState } from "react";
import { encryptFileWithKey } from '../../crypto';
import { createAuthEvent } from '../../auth';
import { BlossomClient, BlossomError } from '../../blossom';
import { useBlossomServer } from '../../hooks/useBlossomServer';

export const FileUpload: React.FC = () => {
  const { selectedServer } = useBlossomServer();
  const [file, setFile] = useState<File | null>(null);
  const [sha256, setSha256] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ message: string; isCorsError: boolean } | null>(null);

  const handleUpload = async () => {
    if (!file) return;

    setLoading(true);
    setError(null);
    setSha256(null);

    try {
      const client = new BlossomClient(selectedServer);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { ciphertext } = await encryptFileWithKey(bytes);
      const encryptedBytes = new TextEncoder().encode(ciphertext);
      const auth = await createAuthEvent("upload", `Upload ${file.name}`, encryptedBytes);
      const sha = await client.upload(encryptedBytes, auth);
      setSha256(sha);
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
        type="file"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
      />
      <button onClick={handleUpload} disabled={!file || loading}>
        {loading ? "Uploading..." : "Upload"}
      </button>
      {sha256 && <p>Uploaded SHA256: {sha256}</p>}
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
