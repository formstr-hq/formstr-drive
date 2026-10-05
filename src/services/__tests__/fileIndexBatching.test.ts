import { describe, it, expect, beforeEach, vi } from "vitest";
import { fileIndexStore } from "../fileIndex";
import type { FileMetadata } from "../../types/metadata";

function createMockMetadata(id: string, name: string, folder = "/", extra: Partial<FileMetadata> = {}): FileMetadata {
  return {
    id,
    name,
    size: 1024,
    type: "text/plain",
    folder,
    uploadedAt: 1700000000,
    server: "https://blossom.example.com",
    encryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    encryptionAlgorithm: "aes-256-gcm",
    ...extra,
  };
}

describe("fileIndexStore Microtask Batching & Operations", () => {
  beforeEach(() => {
    fileIndexStore.clear();
  });

  it("batches rapid successive writes into a single microtask emission", async () => {
    const subscriber = vi.fn();
    const unsubscribe = fileIndexStore.subscribe(subscriber);

    // Initial subscribe should not emit if empty
    expect(subscriber).not.toHaveBeenCalled();

    // Rapidly write 50 items in the same synchronous turn
    const COUNT = 50;
    for (let i = 0; i < COUNT; i++) {
      const file = createMockMetadata(`file-${i}`, `document-${i}.txt`);
      fileIndexStore.write(file.id, 1000 + i, file);
    }

    // Synchronously before microtasks run, subscriber should NOT have been called 50 times
    expect(subscriber).toHaveBeenCalledTimes(0);

    // Wait for the microtask to flush
    await Promise.resolve();

    // Now subscriber should have been invoked exactly once with all 50 items
    expect(subscriber).toHaveBeenCalledTimes(1);
    const emittedFiles = subscriber.mock.calls[0][0] as FileMetadata[];
    expect(emittedFiles).toHaveLength(COUNT);

    // Should be sorted by created_at descending (newest first: file-49 down to file-0)
    expect(emittedFiles[0].id).toBe("file-49");
    expect(emittedFiles[COUNT - 1].id).toBe("file-0");

    unsubscribe();
  });

  it("filters out deleted files and legacy files without id", async () => {
    const subscriber = vi.fn();
    const unsubscribe = fileIndexStore.subscribe(subscriber);

    const validFile = createMockMetadata("valid-1", "valid.txt");
    const deletedFile = createMockMetadata("del-1", "deleted.txt", "/", { deleted: true });
    // Legacy file has empty/missing id
    const legacyFile = createMockMetadata("", "legacy.txt");

    fileIndexStore.write("valid-1", 100, validFile);
    fileIndexStore.write("del-1", 200, deletedFile);
    fileIndexStore.write("legacy-id", 300, legacyFile);

    await Promise.resolve();

    expect(subscriber).toHaveBeenCalledTimes(1);
    const files = subscriber.mock.calls[0][0] as FileMetadata[];
    expect(files).toHaveLength(1);
    expect(files[0].id).toBe("valid-1");

    unsubscribe();
  });

  it("enforces timestamp monotonicity so older events cannot displace newer ones", async () => {
    const subscriber = vi.fn();
    const unsubscribe = fileIndexStore.subscribe(subscriber);

    const initial = createMockMetadata("file-a", "v2-newer.txt");
    const stale = createMockMetadata("file-a", "v1-older.txt");

    // Write newer version at timestamp 2000
    fileIndexStore.write("file-a", 2000, initial);
    // Write stale replayed version at timestamp 1000
    fileIndexStore.write("file-a", 1000, stale);

    await Promise.resolve();

    expect(subscriber).toHaveBeenCalledTimes(1);
    const files = subscriber.mock.calls[0][0] as FileMetadata[];
    expect(files[0].name).toBe("v2-newer.txt");

    unsubscribe();
  });

  it("upgrades a failed (null) event when an equal-timestamp event arrives with valid metadata", async () => {
    const subscriber = vi.fn();
    const unsubscribe = fileIndexStore.subscribe(subscriber);

    // Initial failed decryption writes null
    fileIndexStore.write("file-x", 1500, null);
    await Promise.resolve();
    // No valid files emitted
    expect(subscriber).not.toHaveBeenCalled();

    // Later, retry with the same timestamp arrives with decrypted metadata
    const decrypted = createMockMetadata("file-x", "recovered.txt");
    fileIndexStore.write("file-x", 1500, decrypted);

    await Promise.resolve();
    expect(subscriber).toHaveBeenCalledTimes(1);
    const files = subscriber.mock.calls[0][0] as FileMetadata[];
    expect(files[0].name).toBe("recovered.txt");

    unsubscribe();
  });

  it("synchronously emits on refresh() and cancels pending scheduled microtask", async () => {
    const subscriber = vi.fn();
    const unsubscribe = fileIndexStore.subscribe(subscriber);

    const file = createMockMetadata("file-refresh", "refresh.txt");
    fileIndexStore.write(file.id, 100, file);

    // Before microtask runs, call refresh() synchronously
    fileIndexStore.refresh();

    // refresh() should emit immediately synchronously
    expect(subscriber).toHaveBeenCalledTimes(1);

    // Wait for microtask tick — should NOT double-emit because refresh cancelled emitScheduled
    await Promise.resolve();
    expect(subscriber).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it("flush() synchronously flushes any pending scheduled emit", async () => {
    const subscriber = vi.fn();
    const unsubscribe = fileIndexStore.subscribe(subscriber);

    const file = createMockMetadata("file-flush", "flush.txt");
    fileIndexStore.write(file.id, 100, file);

    expect(subscriber).toHaveBeenCalledTimes(0);
    fileIndexStore.flush();
    expect(subscriber).toHaveBeenCalledTimes(1);

    // Additional microtask does not emit again
    await Promise.resolve();
    expect(subscriber).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it("clears all state and emits an empty list on clear()", async () => {
    const file = createMockMetadata("file-1", "doc.txt");
    fileIndexStore.write(file.id, 100, file);
    await Promise.resolve();

    const subscriber = vi.fn();
    const unsubscribe = fileIndexStore.subscribe(subscriber);
    expect(subscriber).toHaveBeenCalledTimes(1);
    expect(subscriber.mock.calls[0][0]).toHaveLength(1);

    fileIndexStore.clear();
    expect(subscriber).toHaveBeenCalledTimes(2);
    expect(subscriber.mock.calls[1][0]).toEqual([]);

    unsubscribe();
  });

  it("synchronously emits empty list on clear() and cancels pending scheduled microtask", async () => {
    const subscriber = vi.fn();
    const unsubscribe = fileIndexStore.subscribe(subscriber);

    const file = createMockMetadata("file-clear-pending", "clear.txt");
    fileIndexStore.write(file.id, 100, file);

    // Call clear() synchronously before microtask fires
    fileIndexStore.clear();
    expect(subscriber).toHaveBeenCalledTimes(1);
    expect(subscriber.mock.calls[0][0]).toEqual([]);

    // Microtask should not fire second emission
    await Promise.resolve();
    expect(subscriber).toHaveBeenCalledTimes(1);

    unsubscribe();
  });
});
