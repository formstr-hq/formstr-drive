import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "nostr-tools/utils";

export interface StreamHasher {
  /** Feeds bytes in order. Resolves once the hasher has room for more (the
   *  worker-backed one applies backpressure so a slow hash can't queue the
   *  whole file in memory). When `transfer` is true the buffer is handed off
   *  to the hasher and must not be read afterwards. */
  update(bytes: Uint8Array, transfer?: boolean): Promise<void>;
  digest(): Promise<string>;
  /** Releases the worker; safe to call more than once and after digest(). */
  dispose(): void;
}

/** Batches (4MB each) allowed in a worker's queue before update() waits. */
const MAX_IN_FLIGHT = 3;

function inlineHasher(): StreamHasher {
  const h = sha256.create();
  return {
    async update(bytes) {
      h.update(bytes);
    },
    async digest() {
      return bytesToHex(h.digest());
    },
    dispose() {},
  };
}

function workerHasher(worker: Worker): StreamHasher {
  let inFlight = 0;
  let waiters: Array<() => void> = [];
  let failure: unknown;
  let resolveDigest: ((hex: string) => void) | undefined;
  let rejectDigest: ((err: unknown) => void) | undefined;

  const fail = (err: unknown) => {
    failure = err;
    rejectDigest?.(err);
    waiters.forEach((w) => w());
    waiters = [];
  };

  worker.onmessage = (e: MessageEvent<{ type: "ack" } | { type: "digest"; hex: string }>) => {
    if (e.data.type === "ack") {
      inFlight--;
      waiters.shift()?.();
    } else {
      resolveDigest?.(e.data.hex);
    }
  };
  worker.onerror = (e) => fail(e.error ?? new Error(e.message || "Hash worker failed"));

  return {
    async update(bytes, transfer = false) {
      while (inFlight >= MAX_IN_FLIGHT && !failure) {
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
      if (failure) throw failure;
      // A subarray can't be transferred without detaching its whole backing
      // buffer, so anything that isn't the full buffer is copied.
      const owned = transfer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
      const buf = owned ? (bytes.buffer as ArrayBuffer) : (bytes.slice().buffer as ArrayBuffer);
      inFlight++;
      worker.postMessage({ type: "update", buf }, [buf]);
    },
    digest() {
      if (failure) return Promise.reject(failure);
      return new Promise<string>((resolve, reject) => {
        resolveDigest = resolve;
        rejectDigest = reject;
        worker.postMessage({ type: "digest" });
      });
    },
    dispose() {
      worker.terminate();
    },
  };
}

/** SHA-256 over a stream of buffers, hashed on its own thread where Workers
 *  exist (falls back to hashing inline, e.g. in tests or locked-down contexts). */
export function createStreamHasher(): StreamHasher {
  if (typeof Worker === "undefined") return inlineHasher();
  try {
    return workerHasher(new Worker(new URL("../worker/sha256.worker.ts", import.meta.url), { type: "module" }));
  } catch {
    return inlineHasher();
  }
}
