import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FormstrDriveSDK,
  decryptFileMetadata,
  deriveConversationKeyFromHex,
  encryptFileWithExistingKey,
  parseDriveKeyPayload,
  sha256Hex,
  type DriveBlobClient,
  type DriveRelayAdapter,
  type DriveRelayFilter,
  type DriveSigner,
  type NipFsFileMetadata,
  type NostrEvent,
} from "../src";

const PUBKEY = "ab".repeat(32);
const SERVER = "https://blossom.example.com";

afterEach(() => {
  vi.restoreAllMocks();
});

class MemoryRelay implements DriveRelayAdapter {
  readonly events: NostrEvent[] = [];
  readonly operations: string[];

  constructor(operations: string[]) {
    this.operations = operations;
  }

  async query(_relays: readonly string[], filter: DriveRelayFilter): Promise<NostrEvent[]> {
    return this.events.filter((event) => {
      if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
      if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
      const dValues = filter["#d"];
      if (
        dValues &&
        !Array.from(dValues, String).includes(
          event.tags.find((tag) => tag[0] === "d")?.[1] ?? "",
        )
      ) {
        return false;
      }
      return true;
    });
  }

  async publish(_relays: readonly string[], event: NostrEvent): Promise<void> {
    this.events.push(event);
    const d = event.tags.find((tag) => tag[0] === "d")?.[1] ?? "";
    this.operations.push(`relay:${event.kind}:${d}`);
  }
}

class MemoryBlobClient implements DriveBlobClient {
  readonly blobs = new Map<string, Uint8Array>();
  readonly authHeaders: string[] = [];
  readonly operations: string[];

  constructor(operations: string[]) {
    this.operations = operations;
  }

  async upload(
    blob: Uint8Array,
    authHeader: string,
    onProgress?: (percent: number) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    const hash = await sha256Hex(blob);
    this.blobs.set(hash, blob.slice());
    this.authHeaders.push(authHeader);
    this.operations.push(`blob:upload:${hash}`);
    onProgress?.(100);
    return hash;
  }

  async download(hash: string): Promise<Uint8Array> {
    const value = this.blobs.get(hash);
    if (!value) throw new Error(`Missing blob ${hash}`);
    return value.slice();
  }

  async delete(hash: string, authHeader: string): Promise<boolean> {
    this.authHeaders.push(authHeader);
    this.operations.push(`blob:delete:${hash}`);
    this.blobs.delete(hash);
    return true;
  }
}

class FailsOnceBlobClient extends MemoryBlobClient {
  private failed = false;
  private readonly beforeFailure: () => void;

  constructor(operations: string[], beforeFailure: () => void = () => undefined) {
    super(operations);
    this.beforeFailure = beforeFailure;
  }

  override async upload(
    blob: Uint8Array,
    authHeader: string,
    onProgress?: (percent: number) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    if (!this.failed) {
      this.failed = true;
      this.beforeFailure();
      throw new Error("temporary upload failure");
    }
    return super.upload(blob, authHeader, onProgress, signal);
  }
}

class BlocksSecondBlobClient extends MemoryBlobClient {
  private uploads = 0;

  override async upload(
    blob: Uint8Array,
    authHeader: string,
    onProgress?: (percent: number) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    this.uploads += 1;
    if (this.uploads === 1) return super.upload(blob, authHeader, onProgress, signal);
    onProgress?.(1);
    return new Promise((_resolve, reject) => {
      signal?.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true },
      );
    });
  }
}

class FailsSecondUploadAndAllDeletesBlobClient extends MemoryBlobClient {
  private uploads = 0;
  deleteAttempts = 0;

  override async upload(
    blob: Uint8Array,
    authHeader: string,
    onProgress?: (percent: number) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    this.uploads += 1;
    if (this.uploads === 2) throw new Error("second chunk failed");
    return super.upload(blob, authHeader, onProgress, signal);
  }

  override async delete(hash: string, authHeader: string): Promise<boolean> {
    this.deleteAttempts += 1;
    this.authHeaders.push(authHeader);
    this.operations.push(`blob:delete:${hash}`);
    throw new Error("delete server unavailable");
  }
}

class FailsFirstDeleteBlobClient extends MemoryBlobClient {
  deleteAttempts = 0;

  override async delete(hash: string, authHeader: string): Promise<boolean> {
    this.deleteAttempts += 1;
    this.authHeaders.push(authHeader);
    this.operations.push(`blob:delete:${hash}`);
    if (this.deleteAttempts === 1) throw new Error("temporary delete failure");
    this.blobs.delete(hash);
    return true;
  }
}

class SlowQueryRelay extends MemoryRelay {
  override async query(
    relays: readonly string[],
    filter: DriveRelayFilter,
  ): Promise<NostrEvent[]> {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    return super.query(relays, filter);
  }
}

function createSigner(): DriveSigner {
  let eventNumber = 0;
  return {
    getPublicKey: async () => PUBKEY,
    signEvent: async (event) => ({
      ...event,
      id: `event-${++eventNumber}`,
      sig: `signature-${eventNumber}`,
    }),
    nip44Encrypt: async (_pubkey, plaintext) => `identity:${plaintext}`,
    nip44Decrypt: async (_pubkey, ciphertext) => {
      if (!ciphertext.startsWith("identity:")) throw new Error("Not identity encrypted");
      return ciphertext.slice("identity:".length);
    },
  };
}

function makeSdk(relay: MemoryRelay, blobs: MemoryBlobClient, signer = createSigner()) {
  return new FormstrDriveSDK({
    signer,
    relays: ["wss://relay.example.com"],
    blossomServers: [SERVER],
    relayAdapter: relay,
    blobClientFactory: () => blobs,
  });
}

describe("FormstrDriveSDK operations", () => {
  it("uploads in protocol order, downloads, edits with one ID, and deletes blobs first", async () => {
    const operations: string[] = [];
    const relay = new MemoryRelay(operations);
    const blobs = new MemoryBlobClient(operations);
    const sdk = makeSdk(relay, blobs);
    await sdk.initialize();

    const source = new TextEncoder().encode("abcdefgh");
    const preview = new TextEncoder().encode("preview");
    const states: string[] = [];
    const task = sdk.upload(source, {
      name: "report.txt",
      folder: "docs/work/",
      type: "text/plain",
      chunkSize: 3,
      preview,
      includeUnencryptedHash: true,
    });
    task.subscribe((progress) => states.push(progress.state));
    task.subscribe((progress) => {
      if (progress.state !== "queued") throw new Error("observer failed");
    });
    const uploaded = await task.result;

    expect(uploaded.id).toMatch(/^[0-9A-Za-z]{8}$/u);
    expect(uploaded.folder).toBe("/docs/work");
    expect(uploaded.format).toBe("nip-fs");
    expect(uploaded.chunks).toHaveLength(3);
    expect(states).toContain("publishing-metadata");
    expect(states).toContain("uploading-preview");
    expect(states).toContain("uploading-chunks");

    const keyEvent = relay.events.find((event) =>
      event.tags.some((tag) => tag[0] === "d" && tag[1] === `0:${PUBKEY}`),
    )!;
    const secret = parseDriveKeyPayload(keyEvent.content.slice("identity:".length))!;
    const fileEvent = relay.events.find((event) =>
      event.tags.some((tag) => tag[0] === "d" && tag[1] === uploaded.id),
    )!;
    const metadata = decryptFileMetadata(
      fileEvent.content,
      deriveConversationKeyFromHex(secret),
    ) as NipFsFileMetadata;

    expect(Object.keys(metadata).sort()).toEqual([
      "chunks",
      "encryptionAlgorithm",
      "encryptionKey",
      "folder",
      "name",
      "previewHash",
      "server",
      "size",
      "type",
      "unencryptedFileHash",
      "uploadedAt",
    ]);
    expect(metadata).not.toHaveProperty("hash");
    expect(fileEvent.tags).toEqual([
      ["d", uploaded.id],
      ["t", "files"],
      ["encrypted", "nip44"],
      ["client", "formstr-drive"],
    ]);

    const metadataPublishIndex = operations.indexOf(`relay:34578:${uploaded.id}`);
    const firstBlobUploadIndex = operations.findIndex((operation) => operation.startsWith("blob:upload:"));
    expect(metadataPublishIndex).toBeLessThan(firstBlobUploadIndex);
    expect(operations[firstBlobUploadIndex]).toBe(`blob:upload:${metadata.previewHash}`);
    expect(new Set(blobs.authHeaders.slice(0, 4)).size).toBe(1);

    await expect(sdk.getPreview(uploaded.id)).resolves.toEqual(preview);
    await expect(sdk.download(uploaded.id).result).resolves.toEqual(source);

    const renamed = await sdk.renameFile(uploaded.id, "renamed.txt");
    const moved = await sdk.moveFile(uploaded.id, "/archive");
    expect(renamed.id).toBe(uploaded.id);
    expect(moved.id).toBe(uploaded.id);
    expect(moved.name).toBe("renamed.txt");
    expect(moved.folder).toBe("/archive");
    await expect(task.retry()).rejects.toThrow("Only a failed transfer can be retried");

    const beforeDelete = operations.length;
    await sdk.deleteFile(uploaded.id);
    const deletionOperations = operations.slice(beforeDelete);
    const metadataDeleteIndex = deletionOperations.findIndex((operation) => operation === "relay:5:");
    expect(metadataDeleteIndex).toBeGreaterThan(0);
    expect(deletionOperations.slice(0, metadataDeleteIndex).every(
      (operation) => operation.startsWith("blob:delete:"),
    )).toBe(true);
    const deletionEvent = relay.events.at(-1)!;
    expect(deletionEvent.tags).toContainEqual(["a", `34578:${PUBKEY}:${uploaded.id}`]);
  });

  it("reads a legacy drive-key tag array and identity-encrypted single blob", async () => {
    const operations: string[] = [];
    const relay = new MemoryRelay(operations);
    const blobs = new MemoryBlobClient(operations);
    const signer = createSigner();
    const sdk = makeSdk(relay, blobs, signer);
    const driveSecret = "23".repeat(32);
    const fileSecret = "34".repeat(32);
    const plaintext = new TextEncoder().encode("legacy file");
    const legacyCiphertext = await encryptFileWithExistingKey(plaintext, fileSecret);
    const blobHash = "legacy-blob-hash";
    blobs.blobs.set(blobHash, new TextEncoder().encode(legacyCiphertext));
    relay.events.push(
      {
        kind: 34578,
        pubkey: PUBKEY,
        created_at: 10,
        tags: [["d", `0:${PUBKEY}`]],
        content: `identity:${JSON.stringify([["encryptionKey", driveSecret]])}`,
      },
      {
        id: "legacy-event",
        kind: 34578,
        pubkey: PUBKEY,
        created_at: 11,
        tags: [["d", blobHash]],
        content: `identity:${JSON.stringify({
          name: "legacy.txt",
          hash: blobHash,
          size: plaintext.length,
          type: "text/plain",
          folder: "/",
          uploadedAt: 1000,
          server: SERVER,
          encryptionKey: fileSecret,
          encryptionAlgorithm: "aes-gcm",
        })}`,
      },
    );

    await sdk.initialize();
    const files = await sdk.listFiles();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ id: blobHash, name: "legacy.txt" });
    await expect(sdk.download(blobHash).result).resolves.toEqual(plaintext);
  });

  it("reuses prepared hashes and metadata when a failed upload is retried", async () => {
    const operations: string[] = [];
    const relay = new MemoryRelay(operations);
    let now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const blobs = new FailsOnceBlobClient(operations, () => {
      now += 60_000;
    });
    const sdk = makeSdk(relay, blobs);
    await sdk.initialize();

    const task = sdk.upload(new TextEncoder().encode("retry"), { name: "retry.txt" });
    await expect(task.result).rejects.toMatchObject({
      code: "TRANSFER_FAILED",
      message: "File upload failed: temporary upload failure",
    });
    expect(operations.at(-1)).toBe("relay:5:");
    await expect(sdk.listFiles()).resolves.toEqual([]);

    const firstMetadata = relay.events.find((event) =>
      event.tags.some((tag) => tag[0] === "d" && tag[1] && !tag[1].startsWith("0:")),
    )!;
    const cleanupDeletion = relay.events.find((event) => event.kind === 5)!;
    expect(cleanupDeletion.created_at).toBeGreaterThan(firstMetadata.created_at);

    const retried = await task.retry();

    const filePublishes = relay.events.filter(
      (event) => event.tags.some((tag) => tag[0] === "d" && tag[1] === retried.id),
    );
    expect(filePublishes).toHaveLength(2);
    expect(filePublishes[1]!.created_at).toBeGreaterThan(cleanupDeletion.created_at);
    await expect(sdk.listFiles()).resolves.toMatchObject([{ id: retried.id }]);
    await expect(sdk.download(retried.id).result).resolves.toEqual(
      new TextEncoder().encode("retry"),
    );
  });

  it("deletes uploaded blobs and the metadata address when an upload is cancelled", async () => {
    const operations: string[] = [];
    const relay = new MemoryRelay(operations);
    const blobs = new BlocksSecondBlobClient(operations);
    const sdk = makeSdk(relay, blobs);
    await sdk.initialize();

    const task = sdk.upload(new TextEncoder().encode("cancel"), {
      name: "cancel.txt",
      chunkSize: 3,
    });
    const result = task.result.catch((error: unknown) => error);
    const secondChunkStarted = new Promise<void>((resolve) => {
      const unsubscribe = task.subscribe((progress) => {
        if (progress.state === "uploading-chunks" && progress.currentChunk === 2) {
          unsubscribe();
          resolve();
        }
      });
    });
    await secondChunkStarted;
    await task.cancel();

    await expect(result).resolves.toMatchObject({ code: "ABORTED" });
    expect(operations.some((operation) => operation.startsWith("blob:delete:"))).toBe(true);
    expect(operations.at(-1)).toBe("relay:5:");
    await expect(task.retry()).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("removes failed-upload metadata even when blob cleanup is unavailable", async () => {
    const operations: string[] = [];
    const relay = new MemoryRelay(operations);
    const blobs = new FailsSecondUploadAndAllDeletesBlobClient(operations);
    const sdk = makeSdk(relay, blobs);
    await sdk.initialize();

    const task = sdk.upload(new TextEncoder().encode("two chunks"), {
      name: "cleanup.txt",
      chunkSize: 5,
    });

    await expect(task.result).rejects.toMatchObject({ code: "TRANSFER_FAILED" });
    expect(blobs.deleteAttempts).toBe(1);
    expect(operations.at(-1)).toBe("relay:5:");
    await expect(sdk.listFiles()).resolves.toEqual([]);
  });

  it("continues deleting remaining blobs and metadata after one blob delete fails", async () => {
    const operations: string[] = [];
    const relay = new MemoryRelay(operations);
    const blobs = new FailsFirstDeleteBlobClient(operations);
    const sdk = makeSdk(relay, blobs);
    await sdk.initialize();

    const uploaded = await sdk.upload(new TextEncoder().encode("two chunks"), {
      name: "delete.txt",
      chunkSize: 5,
    }).result;
    const beforeDelete = operations.length;

    await expect(sdk.deleteFile(uploaded.id)).resolves.toBeUndefined();

    const deletionOperations = operations.slice(beforeDelete);
    expect(blobs.deleteAttempts).toBe(2);
    expect(deletionOperations.at(-1)).toBe("relay:5:");
    await expect(sdk.listFiles()).resolves.toEqual([]);
  });

  it("publishes only one drive key when first uploads start concurrently", async () => {
    const operations: string[] = [];
    const relay = new SlowQueryRelay(operations);
    const blobs = new MemoryBlobClient(operations);
    const sdk = makeSdk(relay, blobs);
    await sdk.initialize();

    const first = sdk.upload(new TextEncoder().encode("first"), { name: "first.txt" });
    const second = sdk.upload(new TextEncoder().encode("second"), { name: "second.txt" });
    await Promise.all([first.result, second.result]);

    const driveKeyEvents = relay.events.filter((event) =>
      event.tags.some((tag) => tag[0] === "d" && tag[1] === `0:${PUBKEY}`),
    );
    expect(driveKeyEvents).toHaveLength(1);
    await expect(sdk.listFiles()).resolves.toHaveLength(2);
  });
});
