import { describe, expect, it } from "vitest";
import {
  base64ToUint8Array,
  buildFileDeletionEvent,
  createBlossomAuthHeader,
  decryptNipFsChunk,
  encryptNipFsChunk,
  generateFileId,
  normalizeFolder,
  parseDriveKeyPayload,
  type DriveSigner,
  type NostrEvent,
} from "../src";

const PUBKEY = "ab".repeat(32);
const PRIVATE_KEY = "01".padStart(64, "0");

describe("NIP-FS protocol helpers", () => {
  it("writes eight-character Base62 file IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateFileId()));
    expect(ids.size).toBe(100);
    for (const id of ids) expect(id).toMatch(/^[0-9A-Za-z]{8}$/u);
  });

  it("reads both object drive keys and the legacy tag-array shape", () => {
    const secret = "12".repeat(32);
    expect(parseDriveKeyPayload(JSON.stringify({ encryptionKey: secret }))).toBe(secret);
    expect(parseDriveKeyPayload(JSON.stringify([["encryptionKey", secret]]))).toBe(secret);
    expect(parseDriveKeyPayload(JSON.stringify({ encryptionKey: "invalid" }))).toBeNull();
  });

  it("normalizes virtual folders", () => {
    expect(normalizeFolder()).toBe("/");
    expect(normalizeFolder("docs//work/")).toBe("/docs/work");
  });

  it("uses the version, 32-byte nonce, and Base64 blob envelope", async () => {
    const plaintext = new TextEncoder().encode("NIP-FS chunk");
    const nonce = Uint8Array.from({ length: 32 }, (_, index) => index);
    const encrypted = await encryptNipFsChunk(plaintext, PRIVATE_KEY, nonce);
    const envelope = base64ToUint8Array(new TextDecoder().decode(encrypted));

    expect(envelope[0]).toBe(2);
    expect(envelope.slice(1, 33)).toEqual(nonce);
    await expect(decryptNipFsChunk(encrypted, PRIVATE_KEY)).resolves.toEqual(plaintext);
  });

  it("creates one Base64URL Blossom auth event containing all hashes", async () => {
    const signer: DriveSigner = {
      getPublicKey: async () => PUBKEY,
      signEvent: async (event) => ({ ...event, id: "event", sig: "signature" }),
    };
    const header = await createBlossomAuthHeader(
      signer,
      PUBKEY,
      "upload",
      ["one", "two"],
      "upload files",
    );
    const encoded = header.slice("Nostr ".length);
    expect(encoded).not.toMatch(/[+/=]/u);

    const padded = encoded.replaceAll("-", "+").replaceAll("_", "/").padEnd(
      Math.ceil(encoded.length / 4) * 4,
      "=",
    );
    const event = JSON.parse(new TextDecoder().decode(base64ToUint8Array(padded))) as NostrEvent;
    expect(event.kind).toBe(24242);
    expect(event.tags.filter((tag) => tag[0] === "x")).toEqual([
      ["x", "one"],
      ["x", "two"],
    ]);
  });

  it("addresses file deletion by kind, author, and stable d tag", () => {
    const event = buildFileDeletionEvent(PUBKEY, "aB19zX20", 123);
    expect(event.kind).toBe(5);
    expect(event.tags).toContainEqual(["a", `34578:${PUBKEY}:aB19zX20`]);
    expect(event.tags).toContainEqual(["k", "34578"]);
  });
});
