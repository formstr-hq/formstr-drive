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

  async upload(blob: Uint8Array, authHeader: string, onProgress?: (percent: number) => void): Promise<string> {
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

      if (onProgress && xhr.upload) {
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            onProgress(Math.round((event.loaded / event.total) * 100));
          }
        };
      }

      xhr.onload = () => {
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
        reject(
          new BlossomError(
            `Network error: Unable to reach ${this.baseUrl}. The server may have dropped the connection or rate-limited the request.`,
            { isCorsError: true }
          )
        );
      };

      xhr.send(new Blob([blob], { type: "application/octet-stream" }));
    });
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
}
