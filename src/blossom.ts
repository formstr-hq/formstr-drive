import { withTimeout } from "./transfers/withTimeout";

export class BlossomError extends Error {
  isCorsError: boolean;

  constructor(message: string, opts?: { isCorsError?: boolean }) {
    super(message);
    this.name = "BlossomError";
    this.isCorsError = opts?.isCorsError ?? false;
  }
}

export class BlossomClient {
  private baseUrl: string;

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
      blob.buffer.slice(
        blob.byteOffset,
        blob.byteOffset + blob.byteLength,
      ) as ArrayBuffer,
    );
    const hexHash = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", `${this.baseUrl}/upload`);
      xhr.setRequestHeader("Authorization", authHeader);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.setRequestHeader("X-SHA-256", hexHash);

      let idleTimer = setTimeout(() => {
        xhr.abort();
        reject(new Error("Upload timed out after 60s of inactivity"));
      }, 60000);

      if (xhr.upload) {
        xhr.upload.onprogress = (event) => {
          clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            xhr.abort();
            reject(new Error("Upload timed out after 60s of inactivity"));
          }, 60000);
          if (onProgress && event.lengthComputable) {
            onProgress(Math.round((event.loaded / event.total) * 100));
          }
        };
        // Once the whole body is sent, upload-progress events stop while the
        // server hashes and stores the blob. Without switching timers here, that
        // silent server-processing window trips the 60s idle timeout and aborts
        // an upload that actually succeeded. Give the server a generous window.
        xhr.upload.onload = () => {
          clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            xhr.abort();
            reject(new Error("Upload timed out: server did not respond after 120s"));
          }, 120000);
        };
      }

      xhr.onload = () => {
        clearTimeout(idleTimer);
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const json = JSON.parse(xhr.responseText);
            resolve(json.sha256 || json.x || xhr.responseText);
          } catch {
            resolve(xhr.responseText);
          }
        } else {
          reject(new BlossomError(xhr.getResponseHeader("X-Reason") || xhr.statusText));
        }
      };

      xhr.onerror = () => {
        clearTimeout(idleTimer);
        reject(
          new BlossomError(
            `Network error: Unable to reach ${this.baseUrl}. The server may have dropped the connection or rate-limited the request.`,
            { isCorsError: true }
          )
        );
      };

      xhr.onabort = () => {
        clearTimeout(idleTimer);
        reject(new DOMException("Upload aborted", "AbortError"));
      };

      if (signal) {
        signal.addEventListener("abort", () => xhr.abort(), { once: true });
      }

      xhr.send(new Blob([blob as any], { type: "application/octet-stream" }));
    });
  }

  async download(
    sha256: string,
    authHeader?: string,
    onProgress?: (loaded: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    let res: Response;
    try {
      res = await withTimeout(
        fetch(`${this.baseUrl}/${sha256}`, {
          headers: authHeader ? { Authorization: authHeader } : {},
          signal,
        }),
        60000,
        "fetch-timeout",
        `Blossom download timed out after 60s for ${sha256}`
      );
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        throw e;
      }
      if (e instanceof TypeError) {
        throw new BlossomError(
          `Network error: Unable to reach ${this.baseUrl}. This may be a CORS issue.`,
          { isCorsError: true },
        );
      }
      throw e;
    }

    if (!res.ok) {
      throw new BlossomError(res.headers.get("X-Reason") || res.statusText);
    }

    if (onProgress && res.body) {
      const total = Number(res.headers.get("content-length")) || 0;
      const reader = res.body.getReader();
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

    return new Uint8Array(await res.arrayBuffer());
  }

  /**
   * Checks whether a blob is actually stored on this server (BUD-01 `HEAD`).
   * Returns `true`/`false` only for a definitive answer (2xx / 404) — any
   * other outcome (network failure, unexpected status) throws, since callers
   * that use this to decide whether to trust a pending write must never treat
   * "couldn't check" the same as "confirmed absent".
   */
  async exists(sha256: string): Promise<boolean> {
    let res: Response;
    try {
      res = await withTimeout(
        fetch(`${this.baseUrl}/${sha256}`, { method: "HEAD" }),
        15000,
        "fetch-timeout",
        `Blossom existence check timed out after 15s for ${sha256}`,
      );
    } catch (e) {
      if (e instanceof TypeError) {
        throw new BlossomError(
          `Network error: Unable to reach ${this.baseUrl}. This may be a CORS issue.`,
          { isCorsError: true },
        );
      }
      throw e;
    }

    if (res.status === 404) return false;
    if (res.ok) return true;
    throw new BlossomError(res.headers.get("X-Reason") || res.statusText);
  }

  /**
   * Delete a blob from the server (Blossom BUD-02).
   * Returns true if the blob was deleted or was already gone (404).
   * Throws BlossomError on network or server errors so callers can retry.
   */
  async delete(sha256: string, authHeader: string): Promise<boolean> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/${sha256}`, {
        method: "DELETE",
        headers: {
          Authorization: authHeader,
        },
      });
    } catch (e) {
      if (e instanceof TypeError) {
        throw new BlossomError(
          `Network error: Unable to reach ${this.baseUrl}. This may be a CORS issue.`,
          { isCorsError: true },
        );
      }
      throw e;
    }

    // Treat "not found" as success — the blob is already gone.
    if (res.status === 404) {
      return true;
    }

    if (!res.ok) {
      throw new BlossomError(res.headers.get("X-Reason") || res.statusText);
    }

    return true;
  }
}
