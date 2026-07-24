import type { DriveBlobClient } from "./types";

export class BlossomError extends Error {
  isCorsError: boolean;

  constructor(message: string, opts?: { isCorsError?: boolean }) {
    super(message);
    this.name = "BlossomError";
    this.isCorsError = opts?.isCorsError ?? false;
  }
}

/** The existing Formstr Drive Blossom client, extracted without wire changes. */
export class BlossomClient implements DriveBlobClient {
  private baseUrl: string;
  private authEncoding: "base64url" | "base64" | null = null;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  async upload(
    blob: Uint8Array,
    authHeader: string,
    onProgress?: (percent: number) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    if (signal?.aborted) {
      throw new DOMException("Upload aborted", "AbortError");
    }

    const hashBuffer = await crypto.subtle.digest(
      "SHA-256",
      blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength) as ArrayBuffer,
    );
    const hexHash = Array.from(new Uint8Array(hashBuffer))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const compatibleAuth = await this.resolveUploadAuth(
      authHeader,
      hexHash,
      blob.byteLength,
      signal,
    );

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const removeAbortListener = () => {
        if (signal) signal.removeEventListener("abort", abortHandler);
      };
      const abortHandler = () => xhr.abort();
      xhr.open("PUT", `${this.baseUrl}/upload`);
      xhr.setRequestHeader("Authorization", compatibleAuth);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.setRequestHeader("X-SHA-256", hexHash);

      if (onProgress && xhr.upload) {
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            onProgress(Math.round((event.loaded / event.total) * 100));
          }
        };
      }

      xhr.onload = () => {
        removeAbortListener();
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const json = JSON.parse(xhr.responseText) as { sha256?: string; x?: string };
            resolve(json.sha256 || json.x || xhr.responseText);
          } catch {
            resolve(xhr.responseText);
          }
        } else {
          reject(
            new BlossomError(
              xhr.getResponseHeader("X-Reason") ||
                xhr.responseText ||
                `Blossom upload failed with HTTP ${xhr.status}`,
            ),
          );
        }
      };

      xhr.onerror = () => {
        removeAbortListener();
        reject(
          new BlossomError(
            `Network error: Unable to reach ${this.baseUrl}. The server may have dropped the connection or rate-limited the request.`,
            { isCorsError: true },
          ),
        );
      };

      xhr.onabort = () => {
        removeAbortListener();
        reject(new DOMException("Upload aborted", "AbortError"));
      };
      if (signal) {
        signal.addEventListener("abort", abortHandler, { once: true });
      }

      xhr.send(new Blob([blob as BlobPart], { type: "application/octet-stream" }));
    });
  }

  async download(
    sha256: string,
    authHeader?: string,
    onProgress?: (loaded: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/${sha256}`, {
        headers: authHeader ? { Authorization: authHeader } : {},
        signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      if (error instanceof TypeError) {
        throw new BlossomError(
          `Network error: Unable to reach ${this.baseUrl}. This may be a CORS issue.`,
          { isCorsError: true },
        );
      }
      throw error;
    }

    if (!response.ok) {
      throw new BlossomError(response.headers.get("X-Reason") || response.statusText);
    }

    if (onProgress && response.body) {
      const total = Number(response.headers.get("content-length")) || 0;
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;

      for (;;) {
        if (signal?.aborted) {
          await reader.cancel();
          throw new DOMException("Download aborted", "AbortError");
        }
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        onProgress(received, total);
      }

      const result = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
      }
      return result;
    }

    return new Uint8Array(await response.arrayBuffer());
  }

  async delete(sha256: string, authHeader: string): Promise<boolean> {
    let response: Response;
    const initialAuth = this.authEncoding === "base64"
      ? toStandardBase64Auth(authHeader)
      : authHeader;
    try {
      response = await fetch(`${this.baseUrl}/${sha256}`, {
        method: "DELETE",
        headers: { Authorization: initialAuth },
      });
      if (
        this.authEncoding !== "base64" &&
        (response.status === 400 || response.status === 401 || response.status === 403)
      ) {
        response = await fetch(`${this.baseUrl}/${sha256}`, {
          method: "DELETE",
          headers: { Authorization: toStandardBase64Auth(authHeader) },
        });
        if (response.ok || response.status === 404) this.authEncoding = "base64";
      } else if (response.ok) {
        this.authEncoding ??= "base64url";
      }
    } catch (error) {
      if (error instanceof TypeError) {
        throw new BlossomError(
          `Network error: Unable to reach ${this.baseUrl}. This may be a CORS issue.`,
          { isCorsError: true },
        );
      }
      throw error;
    }

    if (response.status === 404) return true;
    if (!response.ok) {
      throw new BlossomError(response.headers.get("X-Reason") || response.statusText);
    }
    return true;
  }

  private async resolveUploadAuth(
    authHeader: string,
    sha256: string,
    contentLength: number,
    signal?: AbortSignal,
  ): Promise<string> {
    if (this.authEncoding === "base64") return toStandardBase64Auth(authHeader);
    if (this.authEncoding === "base64url") return authHeader;

    const preflight = async (authorization: string) =>
      fetch(`${this.baseUrl}/upload`, {
        method: "HEAD",
        headers: {
          Authorization: authorization,
          "X-Content-Length": String(contentLength),
          "X-Content-Type": "application/octet-stream",
          "X-SHA-256": sha256,
        },
        signal,
      });

    try {
      const urlSafeResponse = await preflight(authHeader);
      if (urlSafeResponse.ok) {
        this.authEncoding = "base64url";
        return authHeader;
      }

      if (
        urlSafeResponse.status === 400 ||
        urlSafeResponse.status === 401 ||
        urlSafeResponse.status === 403
      ) {
        const standardAuth = toStandardBase64Auth(authHeader);
        const standardResponse = await preflight(standardAuth);
        if (standardResponse.ok) {
          this.authEncoding = "base64";
          return standardAuth;
        }
        throw new BlossomError(
          standardResponse.headers.get("X-Reason") ||
            `Blossom upload preflight failed with HTTP ${standardResponse.status}`,
        );
      }

      // Older servers may not implement BUD-06 HEAD preflight. Their auth
      // parsers generally expect the original padded Base64 representation.
      if ([404, 405, 501].includes(urlSafeResponse.status)) {
        this.authEncoding = "base64";
        return toStandardBase64Auth(authHeader);
      }

      throw new BlossomError(
        urlSafeResponse.headers.get("X-Reason") ||
          `Blossom upload preflight failed with HTTP ${urlSafeResponse.status}`,
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      if (error instanceof BlossomError) throw error;

      // A server or browser that blocks HEAD may still allow PUT. Standard
      // Base64 is accepted by both current default servers and older servers.
      this.authEncoding = "base64";
      return toStandardBase64Auth(authHeader);
    }
  }
}

export function toStandardBase64Auth(authHeader: string): string {
  const prefix = "Nostr ";
  if (!authHeader.startsWith(prefix)) return authHeader;
  const payload = authHeader
    .slice(prefix.length)
    .replaceAll("-", "+")
    .replaceAll("_", "/");
  return `${prefix}${payload.padEnd(Math.ceil(payload.length / 4) * 4, "=")}`;
}
