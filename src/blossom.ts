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

  /**
   * `blob` is the exact bytes going over the wire and `sha256Hash` MUST be
   * its precomputed hash. This deliberately does not hash `blob` itself: the
   * NIP-FS single-blob format is built by concatenating many encrypted
   * segments (see uploadFile.ts), and by the time there's a `Blob` to upload
   * its hash was already computed incrementally, segment-by-segment, during
   * that assembly — re-hashing the whole (potentially multi-GB) blob here
   * would mean reading it fully into memory a second time for nothing.
   */
  async upload(
    blob: Blob,
    sha256Hash: string,
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

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", `${this.baseUrl}/upload`);
      xhr.setRequestHeader("Authorization", authHeader);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.setRequestHeader("X-SHA-256", sha256Hash);

      // Whether the entire request body has left the browser. A network-level
      // failure (xhr.onerror) BEFORE this is a real candidate for a CORS/
      // preflight block — a CORS rejection happens before any bytes move. The
      // same failure AFTER the body finished sending is something else
      // entirely (a proxy killing a long-lived connection, an upstream
      // timeout) and reporting it as CORS sends debugging in the wrong
      // direction, as happened with a 200 MB upload that a gateway 502'd
      // after accepting the full body: the browser can't read the 502's
      // status without CORS headers on it (which gateway error pages don't
      // add), so xhr.onerror fires and looks identical to a preflight block.
      let bodySent = false;

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
          bodySent = true;
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
          bodySent
            ? new BlossomError(
                // A real CORS block happens at the preflight/connection stage,
                // before any request body moves — the browser never lets bytes
                // out to a server that will end up rejected on that basis. A
                // network-level failure AFTER the full body was sent (`bodySent`)
                // is something else: a gateway/proxy in front of the server
                // dropped a long-lived connection or hit its own timeout/size
                // limit, then produced an error page without CORS headers of
                // its own (they don't run the app's CORS middleware) — which
                // is indistinguishable from a CORS block to `xhr.onerror`
                // unless this flag disambiguates it.
                `${this.baseUrl} accepted the upload but the connection was dropped before it finished (likely a gateway timeout or size limit) rather than a CORS error.`,
                { isCorsError: false },
              )
            : new BlossomError(
                // Before any bytes were sent, this genuinely could be a CORS
                // block, a DNS hiccup, or a dropped connection — JS can't tell
                // these apart, so `isCorsError` is a best guess here, not a
                // confirmed diagnosis.
                `Network error reaching ${this.baseUrl} — the connection was blocked or dropped. This can be a CORS misconfiguration, a network hiccup, or a temporary outage.`,
                { isCorsError: true },
              ),
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
      xhr.send(blob);
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
   * Like {@link download}, but hands back the raw response body reader
   * instead of buffering the whole blob into memory first. The NIP-FS
   * single-blob download path (segmented decrypt in downloadFile.ts /
   * swStreamDownload.ts) re-chunks this byte stream into segment-sized
   * frames as it goes, so a multi-gigabyte blob is never held whole in
   * memory the way {@link download} necessarily does.
   */
  async downloadStream(
    sha256: string,
    authHeader?: string,
    signal?: AbortSignal,
  ): Promise<{ reader: ReadableStreamDefaultReader<Uint8Array>; totalBytes: number }> {
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
    if (!res.body) {
      throw new BlossomError(`${this.baseUrl} returned no response body for ${sha256}`);
    }

    return { reader: res.body.getReader(), totalBytes: Number(res.headers.get("content-length")) || 0 };
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
   * BUD-06 upload requirements check (`HEAD /upload`): asks the server
   * whether it would accept a blob of this size/type/hash BEFORE sending any
   * bytes — the NIP-FS single-blob format can mean one PUT of several hundred
   * MB, and discovering a server's size cap by streaming the whole thing into
   * a gateway that silently drops it (502, no CORS headers on the error) is
   * slow and produces a misleading error. See uploadFile.ts's fallback loop.
   *
   * Must carry the real `authHeader` — this server (like most) checks auth
   * BEFORE size, so an unauthenticated probe returns 401 regardless of size
   * and tells the caller nothing.
   *
   * `ok: true` on either a definitive 2xx OR a network-level failure/timeout:
   * BUD-06 is optional in the spec, so a server that doesn't implement it (no
   * response, or a non-implementing 404/501) must not be treated as refusing
   * the upload — that would wrongly skip every server that just doesn't
   * support this check. Only an explicit non-2xx *response* (the server
   * looked at the request and said no) counts as a refusal.
   */
  async canAccept(
    sizeBytes: number,
    sha256Hash: string,
    mimeType: string,
    authHeader: string,
  ): Promise<{ ok: boolean; reason?: string; status?: number }> {
    let res: Response;
    try {
      res = await withTimeout(
        fetch(`${this.baseUrl}/upload`, {
          method: "HEAD",
          headers: {
            Authorization: authHeader,
            "X-Content-Length": String(sizeBytes),
            "X-Content-Type": mimeType || "application/octet-stream",
            "X-SHA-256": sha256Hash,
          },
        }),
        15000,
        "fetch-timeout",
        `Blossom upload requirements check timed out after 15s for ${this.baseUrl}`,
      );
    } catch {
      // Network failure or timeout — inconclusive, not a refusal. Let the
      // caller proceed to the real upload attempt rather than block on a
      // check that not every server can even answer.
      return { ok: true };
    }

    if (res.ok) return { ok: true };
    // A definitive non-2xx response IS a refusal — the server evaluated the
    // request and rejected it (too large, wrong type, etc). `status` lets the
    // caller run this through the same classifyUploadFailure() used for a
    // real upload attempt, so e.g. a 413 here reads as "too large" instead of
    // a generic network failure.
    return { ok: false, reason: res.headers.get("X-Reason") || res.statusText, status: res.status };
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
