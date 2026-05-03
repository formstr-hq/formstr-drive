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

  async upload(blob: Uint8Array, authHeader: string): Promise<string> {
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

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/upload`, {
        method: "PUT",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/octet-stream",
          "X-SHA-256": hexHash,
        },
        body: blob as BodyInit, // cast fixes TS
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

    if (!res.ok) {
      throw new BlossomError(res.headers.get("X-Reason") || res.statusText);
    }

    // Blossom servers return JSON with file info
    const responseText = await res.text();
    try {
      const json = JSON.parse(responseText);
      // Return just the sha256 hash
      return json.sha256 || json.x || responseText;
    } catch {
      // If not JSON, return as-is (some servers might return just the hash)
      return responseText;
    }
  }

  async download(sha256: string, authHeader?: string): Promise<Uint8Array> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/${sha256}`, {
        headers: authHeader ? { Authorization: authHeader } : {},
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

    if (!res.ok) {
      throw new BlossomError(res.headers.get("X-Reason") || res.statusText);
    }

    return new Uint8Array(await res.arrayBuffer());
  }

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

    if (res.status === 404) {
      return true;
    }

    if (!res.ok) {
      throw new BlossomError(res.headers.get("X-Reason") || res.statusText);
    }

    return true;
  }
}
