import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FileMetadata } from "../../types/metadata";

// Mock dependencies before importing fetchPreview
vi.mock("../../blossom", () => {
  return {
    BlossomClient: vi.fn(),
  };
});

vi.mock("../../crypto", () => {
  return {
    decryptFileWithKey: vi.fn(),
  };
});

vi.mock("../../utils/fileTypeHelpers", () => {
  return {
    detectMimeTypeFromMagicBytes: vi.fn(() => "image/png"),
  };
});

import { BlossomClient } from "../../blossom";
import { decryptFileWithKey } from "../../crypto";
import {
  fetchFilePreview,
  getCachedPreview,
  getPreviewQueueStatus,
  clearPreviewCache,
  MAX_CONCURRENT_PREVIEWS,
} from "../Preview/fetchPreview";

function createMockFile(id: string, previewHash?: string): FileMetadata {
  return {
    id,
    name: `${id}.png`,
    size: 4096,
    type: "image/png",
    folder: "/",
    uploadedAt: 1700000000,
    server: "https://blossom.example.com",
    encryptionKey: "mock-key",
    encryptionAlgorithm: "aes-256-gcm",
    previewHash,
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("fetchPreview Concurrency Limiter & Deduplication (R3)", () => {
  let mockDownload: ReturnType<typeof vi.fn>;
  let originalCreateObjectURL: typeof URL.createObjectURL;

  beforeEach(() => {
    clearPreviewCache();
    vi.clearAllMocks();

    originalCreateObjectURL = URL.createObjectURL;
    URL.createObjectURL = vi.fn(() => "blob:http://localhost/mock-preview-url");

    mockDownload = vi.fn();
    (BlossomClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      download: mockDownload,
    }));

    (decryptFileWithKey as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer
    );
  });

  afterEach(() => {
    URL.createObjectURL = originalCreateObjectURL;
    clearPreviewCache();
  });

  it("exports MAX_CONCURRENT_PREVIEWS equal to 4", () => {
    expect(MAX_CONCURRENT_PREVIEWS).toBe(4);
  });

  it("returns null immediately without acquiring slot if file has no previewHash", async () => {
    const file = createMockFile("no-preview", undefined);
    const result = await fetchFilePreview(file);

    expect(result).toBeNull();
    const status = getPreviewQueueStatus();
    expect(status.active).toBe(0);
    expect(status.queued).toBe(0);
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it("bounds concurrent active requests to MAX_CONCURRENT_PREVIEWS (4) and queues excess requests", async () => {
    const deferredMap = new Map<string, Deferred<Uint8Array>>();

    mockDownload.mockImplementation((hash: string) => {
      const def = createDeferred<Uint8Array>();
      deferredMap.set(hash, def);
      return def.promise;
    });

    // Launch 6 concurrent preview requests with distinct preview hashes
    const promises = [
      fetchFilePreview(createMockFile("f-1", "hash-1")),
      fetchFilePreview(createMockFile("f-2", "hash-2")),
      fetchFilePreview(createMockFile("f-3", "hash-3")),
      fetchFilePreview(createMockFile("f-4", "hash-4")),
      fetchFilePreview(createMockFile("f-5", "hash-5")),
      fetchFilePreview(createMockFile("f-6", "hash-6")),
    ];

    // Give microtasks a tick to enter acquirePreviewSlot
    await Promise.resolve();

    // Verify queue status: exactly 4 active slots, 2 queued
    const statusBefore = getPreviewQueueStatus();
    expect(statusBefore.active).toBe(4);
    expect(statusBefore.queued).toBe(2);
    expect(statusBefore.maxConcurrent).toBe(4);

    // Verify downloads were only started for the first 4 hashes
    expect(mockDownload).toHaveBeenCalledTimes(4);
    expect(deferredMap.has("hash-1")).toBe(true);
    expect(deferredMap.has("hash-2")).toBe(true);
    expect(deferredMap.has("hash-3")).toBe(true);
    expect(deferredMap.has("hash-4")).toBe(true);
    expect(deferredMap.has("hash-5")).toBe(false);
    expect(deferredMap.has("hash-6")).toBe(false);

    // Resolve one active download (hash-1)
    deferredMap.get("hash-1")!.resolve(new Uint8Array([1, 2, 3]));
    await promises[0];

    // Microtask turn allows queued item (hash-5) to acquire the released slot
    await Promise.resolve();

    const statusAfterOne = getPreviewQueueStatus();
    expect(statusAfterOne.active).toBe(4);
    expect(statusAfterOne.queued).toBe(1);
    expect(mockDownload).toHaveBeenCalledTimes(5);
    expect(deferredMap.has("hash-5")).toBe(true);

    // Resolve remaining downloads
    deferredMap.get("hash-2")!.resolve(new Uint8Array([2]));
    deferredMap.get("hash-3")!.resolve(new Uint8Array([3]));
    deferredMap.get("hash-4")!.resolve(new Uint8Array([4]));
    deferredMap.get("hash-5")!.resolve(new Uint8Array([5]));

    await Promise.all([promises[1], promises[2], promises[3], promises[4]]);
    await Promise.resolve();

    // The 6th request should now be active
    expect(mockDownload).toHaveBeenCalledTimes(6);
    expect(deferredMap.has("hash-6")).toBe(true);

    deferredMap.get("hash-6")!.resolve(new Uint8Array([6]));
    await promises[5];

    // All finished -> 0 active, 0 queued
    const statusFinal = getPreviewQueueStatus();
    expect(statusFinal.active).toBe(0);
    expect(statusFinal.queued).toBe(0);
  });

  it("deduplicates concurrent in-flight requests for identical previewHash", async () => {
    const def = createDeferred<Uint8Array>();
    mockDownload.mockReturnValue(def.promise);

    const fileA = createMockFile("f-a", "shared-hash-xyz");
    const fileB = createMockFile("f-b", "shared-hash-xyz");

    // Both requested concurrently before first completes
    const promiseA = fetchFilePreview(fileA);
    const promiseB = fetchFilePreview(fileB);

    // Both should receive the exact same in-flight task promise
    expect(promiseA).toBe(promiseB);

    // Only 1 slot should be acquired, only 1 download called
    const status = getPreviewQueueStatus();
    expect(status.active).toBe(1);
    expect(status.queued).toBe(0);
    expect(mockDownload).toHaveBeenCalledTimes(1);
    expect(mockDownload).toHaveBeenCalledWith("shared-hash-xyz");

    // Resolve download
    def.resolve(new Uint8Array([10, 20]));

    const [resA, resB] = await Promise.all([promiseA, promiseB]);
    expect(resA).toBe(resB);
    expect(resA?.type).toBe("image/png");

    // Slot released cleanly
    expect(getPreviewQueueStatus().active).toBe(0);
  });

  it("releases active slot in try...finally when download fails", async () => {
    mockDownload.mockRejectedValue(new Error("Network download failed (502)"));

    const file = createMockFile("f-err", "hash-fail-download");

    await expect(fetchFilePreview(file)).rejects.toThrow("Network download failed (502)");

    // Slot must be released back to 0
    const status = getPreviewQueueStatus();
    expect(status.active).toBe(0);
    expect(status.queued).toBe(0);

    // Subsequent request should not be blocked and succeed
    mockDownload.mockResolvedValue(new Uint8Array([1, 2, 3]));
    const nextFile = createMockFile("f-ok", "hash-next-ok");
    const result = await fetchFilePreview(nextFile);

    expect(result).not.toBeNull();
    expect(getPreviewQueueStatus().active).toBe(0);
  });

  it("releases active slot in try...finally when decryption fails", async () => {
    mockDownload.mockResolvedValue(new Uint8Array([99]));
    (decryptFileWithKey as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Invalid AES authentication tag")
    );

    const file = createMockFile("f-decrypt-fail", "hash-bad-decrypt");

    await expect(fetchFilePreview(file)).rejects.toThrow("Invalid AES authentication tag");

    // Slot must be released back to 0
    const status = getPreviewQueueStatus();
    expect(status.active).toBe(0);
    expect(status.queued).toBe(0);
  });

  it("serves cached previews immediately without acquiring a slot", async () => {
    mockDownload.mockResolvedValue(new Uint8Array([1, 2, 3]));

    const file = createMockFile("f-cache", "hash-cached-1");

    // First fetch acquires slot and stores in cache
    const firstResult = await fetchFilePreview(file);
    expect(firstResult).not.toBeNull();
    expect(mockDownload).toHaveBeenCalledTimes(1);
    expect(getPreviewQueueStatus().active).toBe(0);

    // Synchronous peek
    const synchronousCache = getCachedPreview("hash-cached-1");
    expect(synchronousCache).toBe(firstResult);

    // Second fetch should return cached item without calling download or acquiring slot
    const secondResult = await fetchFilePreview(file);
    expect(secondResult).toBe(firstResult);
    expect(mockDownload).toHaveBeenCalledTimes(1); // Not called again
    expect(getPreviewQueueStatus().active).toBe(0); // 0 slots consumed
  });

  it("clearPreviewCache clears cache and permits new download fetch", async () => {
    mockDownload.mockResolvedValue(new Uint8Array([1, 2, 3]));

    const file = createMockFile("f-clear", "hash-to-clear");
    await fetchFilePreview(file);
    expect(mockDownload).toHaveBeenCalledTimes(1);
    expect(getCachedPreview("hash-to-clear")).toBeDefined();

    clearPreviewCache();
    expect(getCachedPreview("hash-to-clear")).toBeUndefined();

    // After clearing, fetch triggers download again
    await fetchFilePreview(file);
    expect(mockDownload).toHaveBeenCalledTimes(2);
  });
});
