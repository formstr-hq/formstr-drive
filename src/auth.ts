import { signerManager } from "./signer/manager";

async function computeSha256Hex(data: Uint8Array | Blob): Promise<string> {
  const buffer = data instanceof Blob ? await data.arrayBuffer() : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toBase64Utf8(value: unknown): string {
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
  fileOrHash?: Uint8Array | Blob | string,
  expirationSeconds = 60,
) {
  const signer = await signerManager.getSigner();
  const pubkey = await signer.getPublicKey();
  const now = Math.floor(Date.now() / 1000);

  const tags: string[][] = [
    ["t", verb],
    ["expiration", String(now + expirationSeconds)],
  ];

  if (fileOrHash !== undefined) {
    const sha256hex =
      typeof fileOrHash === "string"
        ? fileOrHash
        : await computeSha256Hex(fileOrHash);
    tags.push(["x", sha256hex]);
    tags.push(["payload", sha256hex]);
  }

  const event = {
    kind: 24242,
    pubkey,
    content,
    created_at: now,
    tags,
  };

  const signedEvent = await signer.signEvent(event);
  const b64 = toBase64Utf8(signedEvent);
  return `Nostr ${b64}`;
}
