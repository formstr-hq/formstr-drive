import { withTimeout } from "./transfers/withTimeout";

export class BlossomError extends Error {
  isCorsError: boolean;
  /** The server's HTTP status, when the request reached it and got a real
   *  response (as opposed to a network-level failure, which has no status).
   *  Callers use this to tell a permanent rejection (415 unsupported media
   *  type, 401/403 not authorized) apart from a transient one worth retrying. */
  status?: number;

  constructor(message: string, opts?: { isCorsError?: boolean; status?: number }) {
    super(message);
    this.name = "BlossomError";
    this.isCorsError = opts?.isCorsError ?? false;
    this.status = opts?.status;
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
    /**
     * Coarse phase transitions, independent of `onProgress`'s byte counter —
     * callers use this to keep a stage label truthful even when zero bytes
     * ever move (a blocked CORS preflight or a black-holed connection never
     * fires `xhr.upload.onprogress`, so a caller relying on that alone shows a
     * stale "Encrypting..." label for the entire retry cascade).
     *  - "connecting": the request has been opened and is being sent.
     *  - "stalled": no upload progress for STALL_TIMEOUT_MS while a request is
     *    in flight — the connection may still succeed or may be dead; this is
     *    a "still trying" signal, not a failure.
     */
    onStage?: (stage: "connecting" | "stalled") => void,
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

      // Fires once while no real progress has been seen, so a stalled request
      // (nothing sent, nothing received — the CORS/black-hole case) surfaces
      // as "still trying" well before the 60s idle timeout gives up on it.
      const STALL_TIMEOUT_MS = 10000;
      let stallTimer: ReturnType<typeof setTimeout> | undefined = onStage
        ? setTimeout(() => {
            onStage("stalled");
          }, STALL_TIMEOUT_MS)
        : undefined;
      const clearStallTimer = () => {
        if (stallTimer) {
          clearTimeout(stallTimer);
          stallTimer = undefined;
        }
      };

      if (xhr.upload) {
        xhr.upload.onprogress = (event) => {
          clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            xhr.abort();
            reject(new Error("Upload timed out after 60s of inactivity"));
          }, 60000);
          clearStallTimer();
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
          clearStallTimer();
          idleTimer = setTimeout(() => {
            xhr.abort();
            reject(new Error("Upload timed out: server did not respond after 120s"));
          }, 120000);
        };
      }

      xhr.onload = () => {
        clearTimeout(idleTimer);
        clearStallTimer();
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const json = JSON.parse(xhr.responseText);
            resolve(json.sha256 || json.x || xhr.responseText);
          } catch {
            resolve(xhr.responseText);
          }
        } else {
          reject(new BlossomError(xhr.getResponseHeader("X-Reason") || xhr.statusText, { status: xhr.status }));
        }
      };

      xhr.onerror = () => {
        clearTimeout(idleTimer);
        clearStallTimer();
        reject(
          new BlossomError(
            // The browser reports any network-level failure this way — an actual
            // CORS block, a dropped/reset connection, a DNS hiccup, or rate
            // limiting all look identical to JS. `isCorsError` is a best guess,
            // not a confirmed diagnosis.
            `Network error reaching ${this.baseUrl} — the connection was blocked or dropped. This can be a CORS misconfiguration, a network hiccup, or a temporary outage.`,
            { isCorsError: true }
          )
        );
      };

      xhr.onabort = () => {
        clearTimeout(idleTimer);
        clearStallTimer();
        reject(new DOMException("Upload aborted", "AbortError"));
      };

      if (signal) {
        signal.addEventListener("abort", () => xhr.abort(), { once: true });
      }

      onStage?.("connecting");
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
          `Network error reaching ${this.baseUrl} — the connection was blocked or dropped. This can be a CORS misconfiguration, a network hiccup, or a temporary outage.`,
          { isCorsError: true },
        );
      }
      throw e;
    }

    if (!res.ok) {
      throw new BlossomError(res.headers.get("X-Reason") || res.statusText, { status: res.status });
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
          `Network error reaching ${this.baseUrl} — the connection was blocked or dropped.`,
          { isCorsError: true },
        );
      }
      throw e;
    }

    if (res.status === 404) return false;
    if (res.ok) return true;
    throw new BlossomError(res.headers.get("X-Reason") || res.statusText, { status: res.status });
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
          `Network error reaching ${this.baseUrl} — the connection was blocked or dropped. This can be a CORS misconfiguration, a network hiccup, or a temporary outage.`,
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
      throw new BlossomError(res.headers.get("X-Reason") || res.statusText, { status: res.status });
    }

    return true;
  }
}
