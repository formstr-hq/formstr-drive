import { signerManager } from "./signer/manager";

/**
 * Expiration window for an upload auth event that must survive a background
 * (native) upload after the foreground signs it. Generous because the native
 * worker's chunk PUTs can run long after signing, but tunable per-server since
 * some Blossom servers cap how far into the future `expiration` can be.
 */
export const BACKGROUND_UPLOAD_AUTH_EXPIRATION_SECONDS = 6 * 60 * 60; // 6 hours

async function computeSha256Hex(data: Uint8Array | Blob): Promise<string> {
  const buffer = data instanceof Blob ? await data.arrayBuffer() : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toBase64(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

export async function createAuthEvent(
  verb: "upload" | "get" | "delete",
  content: string,
  fileOrHashOrHashes?: Uint8Array | Blob | string | string[],
  expirationSeconds = 60,
) {
  const signer = await signerManager.getSigner();
  const pubkey = await signer.getPublicKey();
  const now = Math.floor(Date.now() / 1000);

  const tags: string[][] = [
    ["t", verb],
    ["expiration", String(now + expirationSeconds)],
  ];

  if (fileOrHashOrHashes !== undefined) {
    if (Array.isArray(fileOrHashOrHashes)) {
      // Multiple hashes (BUD-11 Tag Scoping)
      for (const hash of fileOrHashOrHashes) {
        tags.push(["x", hash]);
      }
    } else {
      // Single payload
      const sha256hex =
        typeof fileOrHashOrHashes === "string"
          ? fileOrHashOrHashes
          : await computeSha256Hex(fileOrHashOrHashes);
      tags.push(["x", sha256hex]);
    }
  }

  const event = {
    kind: 24242,
    pubkey,
    content,
    created_at: now,
    tags,
  };

  const signedEvent = await signer.signEvent(event);
  const b64 = toBase64(signedEvent);
  return `Nostr ${b64}`;
}
