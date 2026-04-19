import { useEffect, useMemo, useState } from "react";
import { BlossomClient } from "../blossom";
import { decryptFileWithKey } from "../crypto";
import { resolvePublicShareEvent } from "../services/fileIndex";
import { verifyPassword } from "../utils/shareTokens";
import type { PublicSharePayload } from "../types/metadata";

interface ShareAccessPageProps {
  shareId: string;
}

function readSecretFromHash(): string | null {
  const hash = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash;
  const params = new URLSearchParams(hash);
  return params.get("k");
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function ShareAccessPage({ shareId }: ShareAccessPageProps) {
  const [payload, setPayload] = useState<PublicSharePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [passwordUnlocked, setPasswordUnlocked] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const secret = useMemo(() => readSecretFromHash(), []);

  useEffect(() => {
    let mounted = true;

    const load = async () => {
      if (!secret) {
        setError("Missing share key in URL fragment");
        setLoading(false);
        return;
      }

      try {
        const resolved = await resolvePublicShareEvent(shareId, secret);
        if (!mounted) return;

        if (!resolved) {
          setError("Share not found or invalid key");
          return;
        }

        if (resolved.revokedAt) {
          setError("This share link has been revoked");
          return;
        }

        if (resolved.policy.expiresAt && resolved.policy.expiresAt < Date.now()) {
          setError("This share link has expired");
          return;
        }

        setPayload(resolved);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to resolve share link");
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    };

    load();

    return () => {
      mounted = false;
    };
  }, [secret, shareId]);

  const handleUnlock = async () => {
    if (!payload || !payload.policy.requiresPassword) {
      setPasswordUnlocked(true);
      return;
    }

    if (!payload.policy.passwordSalt || !payload.policy.passwordVerifier) {
      setError("Share password settings are incomplete");
      return;
    }

    const isValid = await verifyPassword(
      password,
      payload.policy.passwordSalt,
      payload.policy.passwordVerifier
    );

    if (!isValid) {
      setError("Incorrect password");
      return;
    }

    setError(null);
    setPasswordUnlocked(true);
  };

  const handleDownload = async () => {
    if (!payload) return;
    setDownloading(true);
    setError(null);

    try {
      const client = new BlossomClient(payload.server);
      const blob = await client.download(payload.fileHash);
      const ciphertext = new TextDecoder().decode(blob);
      const decrypted = await decryptFileWithKey(ciphertext, payload.encryptionKey);

      const url = URL.createObjectURL(
        new Blob([decrypted as BlobPart], { type: payload.fileType || "application/octet-stream" })
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = payload.fileName;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Download failed");
    } finally {
      setDownloading(false);
    }
  };

  return (
    <main className="share-page">
      <section className="share-card">
        <h1>Shared file</h1>

        {loading && <p>Resolving secure link...</p>}

        {!loading && payload && (
          <>
            <div className="share-file-meta">
              <strong>{payload.fileName}</strong>
              <span>{formatSize(payload.fileSize)}</span>
              <span>Permission: {payload.policy.role}</span>
              {payload.policy.expiresAt && (
                <span>Expires: {new Date(payload.policy.expiresAt).toLocaleString()}</span>
              )}
            </div>

            {payload.policy.requiresPassword && !passwordUnlocked && (
              <div className="share-password-row">
                <input
                  type="password"
                  placeholder="Enter share password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
                <button onClick={handleUnlock}>Unlock</button>
              </div>
            )}

            {(!payload.policy.requiresPassword || passwordUnlocked) && (
              <button className="share-download-btn" onClick={handleDownload} disabled={downloading}>
                {downloading ? "Downloading..." : "Download file"}
              </button>
            )}
          </>
        )}

        {error && <p className="share-error">{error}</p>}
      </section>
    </main>
  );
}
