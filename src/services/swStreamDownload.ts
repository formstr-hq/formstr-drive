import { BlossomClient } from "../blossom";
import type { FileMetadata } from "../types/metadata";
import { decryptFileWithKey } from "../crypto";
import type { DownloadProgressInfo } from "./downloadFile";
import { withTimeout, TransferFailure } from "../transfers/withTimeout";
import { decryptFileChunk, fileChunkRefs } from "./fileCrypto";

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Download aborted", "AbortError");
  }
}

export function hasServiceWorkerSupport(): boolean {
  return typeof navigator !== "undefined" && "serviceWorker" in navigator && window.isSecureContext;
}

/**
 * Streams a decrypted file to disk via the self-hosted /sw.js service worker,
 * so Firefox/Safari/mobile-web (which lack the File System Access API) can
 * still download large files without buffering the whole thing in memory.
 * Bytes never leave the browser except back to the browser's own download
 * manager — the service worker only relays what we've already decrypted.
 */
export async function downloadViaServiceWorker(
  file: FileMetadata,
  onProgress?: (info: DownloadProgressInfo) => void,
  signal?: AbortSignal,
): Promise<{ uri: null }> {
  try {
    return await attemptDownloadViaServiceWorker(file, onProgress, signal);
  } catch (e) {
    if (e instanceof Error && e.message === "sw-attach-timeout") {
      console.warn("SW attach timed out, retrying once...");
      return await attemptDownloadViaServiceWorker(file, onProgress, signal);
    }
    throw e;
  }
}

async function attemptDownloadViaServiceWorker(
  file: FileMetadata,
  onProgress?: (info: DownloadProgressInfo) => void,
  signal?: AbortSignal,
): Promise<{ uri: null }> {
  // `serviceWorker.ready` never resolves AND never rejects when no registration
  // exists (e.g. /sw.js failed to load in production). Without a timeout the
  // whole download hangs at 0% forever and the FSA/blob fallbacks in
  // downloadFileStreaming are never reached. Reject instead so it falls through.
  await withTimeout(
    navigator.serviceWorker.ready,
    3000,
    "sw-unavailable",
    "Download service worker is unavailable.",
  );
  let controller = navigator.serviceWorker.controller;
  if (!controller) {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Download service worker is not active yet. Please reload the page and try again.")),
        5000,
      );
      const onControllerChange = () => {
        controller = navigator.serviceWorker.controller;
        if (controller) {
          clearTimeout(timeout);
          navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
          resolve();
        }
      };
      navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    });
  }

  const id = crypto.randomUUID();
  const channel = new MessageChannel();
  const port = channel.port1;

  const iframe = document.createElement("iframe");
  iframe.style.display = "none";

  const cleanup = () => {
    port.onmessage = null;
    port.close();
    iframe.remove();
  };

  try {
    let pullCredits = 0;
    interface PullWaiter {
      resolve: () => void;
      reject: (e: unknown) => void;
    }
    let pullWaiters: PullWaiter[] = [];
    let readyResolver: (() => void) | null = null;
    let fetchAttachedResolver: (() => void) | null = null;
    let completeResolver: (() => void) | null = null;
    let cancelledBySw = false;

    port.onmessage = (event) => {
      const msg = event.data;
      if (msg?.type === "ready") {
        readyResolver?.();
      } else if (msg?.type === "fetch-attached") {
        fetchAttachedResolver?.();
      } else if (msg?.type === "complete") {
        completeResolver?.();
      } else if (msg?.type === "pull") {
        // Hand the credit straight to a blocked waiter if there is one; only
        // bank it when nobody is waiting. Incrementing unconditionally (the old
        // bug) left credits > 0 forever, so takePull() stopped ever blocking and
        // all backpressure was lost.
        const waiter = pullWaiters.shift();
        if (waiter) waiter.resolve();
        else pullCredits++;
      } else if (msg?.type === "cancelled") {
        cancelledBySw = true;
        const waiters = pullWaiters;
        pullWaiters = [];
        waiters.forEach((w) => w.resolve()); // let the producer loop observe cancelledBySw and stop
      }
    };
    port.start();

    const takePull = () =>
      new Promise<void>((resolve, reject) => {
        if (cancelledBySw) return resolve();
        if (signal?.aborted) return reject(new DOMException("Download aborted", "AbortError"));
        if (pullCredits > 0) {
          pullCredits--;
          return resolve();
        }

        let settled = false;
        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          pullWaiters = pullWaiters.filter((x) => x !== waiter);
          fn();
        };
        const onAbort = () => finish(() => reject(new DOMException("Download aborted", "AbortError")));
        const timer = setTimeout(
          () =>
            finish(() =>
              reject(new TransferFailure("sw-pull-timeout", "Timed out waiting for the browser to accept download data.")),
            ),
          30000,
        );
        const waiter: PullWaiter = {
          resolve: () => finish(resolve),
          reject: (e) => finish(() => reject(e)),
        };

        signal?.addEventListener("abort", onAbort, { once: true });
        pullWaiters.push(waiter);
      });

    await new Promise<void>((resolve, reject) => {
      readyResolver = resolve;
      controller!.postMessage(
        {
          type: "start",
          id,
          fileName: file.name,
          size: file.size,
          mimeType: file.type || "application/octet-stream",
        },
        [channel.port2],
      );
      setTimeout(() => reject(new Error("Timed out starting the download service worker")), 10000);
    });

    throwIfAborted(signal);
    document.body.appendChild(iframe);
    iframe.src = `/__stream_download__/${encodeURIComponent(id)}`;

    await new Promise<void>((resolve, reject) => {
      fetchAttachedResolver = resolve;
      setTimeout(() => reject(new Error("sw-attach-timeout")), 5000);
    });

    const clients = new Map<string, BlossomClient>();
    const clientFor = (server: string) => {
      let client = clients.get(server);
      if (!client) {
        client = new BlossomClient(server);
        clients.set(server, client);
      }
      return client;
    };

    await new Promise<void>((resolve, reject) => {
      (async () => {
        try {
          const chunks = fileChunkRefs(file);
          let bytesSent = 0;

          if (chunks.length > 0) {
            const totalChunks = chunks.length;

            for (let i = 0; i < totalChunks; i++) {
              throwIfAborted(signal);
              if (cancelledBySw) break;

              await takePull();
              throwIfAborted(signal);
              if (cancelledBySw) break;

              const chunk = chunks[i];
              const encBytes = await clientFor(chunk.server ?? file.server).download(
                chunk.hash,
                undefined,
                undefined,
                signal,
              );
              const decBytes = await decryptFileChunk(file, encBytes, i);
              let buffer = decBytes.buffer.slice(
                decBytes.byteOffset,
                decBytes.byteOffset + decBytes.byteLength,
              ) as ArrayBuffer;

              if (bytesSent + buffer.byteLength > file.size) {
                buffer = buffer.slice(0, file.size - bytesSent);
              }
              bytesSent += buffer.byteLength;
              port.postMessage({ type: "chunk", buffer }, [buffer]);

              onProgress?.({
                stage: "Downloading...",
                progress: Math.round(((i + 1) / totalChunks) * 100),
                currentChunk: i + 1,
                totalChunks,
              });
            }
          } else {
            await takePull();
            throwIfAborted(signal);

            if (!cancelledBySw) {
              onProgress?.({ stage: "Downloading...", progress: 0 });
              const encBytes = await clientFor(file.server).download(file.hash, undefined, (loaded, total) => {
                if (total > 0) {
                  onProgress?.({ stage: "Downloading...", progress: Math.round((loaded / total) * 100) });
                }
              }, signal);
              throwIfAborted(signal);
              const ciphertext = new TextDecoder().decode(encBytes);
              const decrypted = await decryptFileWithKey(ciphertext, file.encryptionKey);
              let buffer = decrypted.buffer.slice(
                decrypted.byteOffset,
                decrypted.byteOffset + decrypted.byteLength,
              ) as ArrayBuffer;

              if (bytesSent + buffer.byteLength > file.size) {
                buffer = buffer.slice(0, file.size - bytesSent);
              }
              bytesSent += buffer.byteLength;

              onProgress?.({ stage: "Saving file...", progress: 100 });
              port.postMessage({ type: "chunk", buffer }, [buffer]);
            }
          }

          if (cancelledBySw) {
            reject(new DOMException("Download aborted", "AbortError"));
            return;
          }

          if (bytesSent !== file.size) {
            throw new Error(`size-mismatch: expected ${file.size} bytes, got ${bytesSent} bytes`);
          }

          port.postMessage({ type: "end" });

          // Wait for the SW to confirm it closed the stream before tearing down
          // the iframe, so we don't cancel an in-progress write. Capped at 5s as
          // a safety net — backpressure means all bytes were already consumed.
          await new Promise<void>((res) => {
            completeResolver = res;
            setTimeout(res, 5000);
          });

          resolve();
        } catch (error) {
          port.postMessage({
            type: "abort",
            message: error instanceof Error ? error.message : "Download failed",
          });
          reject(error);
        }
      })();
    });
  } finally {
    cleanup();
  }

  return { uri: null };
}
