import { BlossomClient } from "../blossom";
import type { FileMetadata } from "../types/metadata";
import { decryptFileWithKey } from "../crypto";
import type { DownloadProgressInfo } from "./downloadFile";
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
  const registration = await navigator.serviceWorker.ready;
  const controller = navigator.serviceWorker.controller;
  if (!registration.active || !controller) {
    throw new Error("Download service worker is not active yet. Please reload the page and try again.");
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
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(
        () => reject(new Error("Timed out starting the download service worker")),
        10000,
      );
      port.onmessage = (event) => {
        if (event.data?.type === "ready") {
          window.clearTimeout(timeout);
          resolve();
        }
      };
      controller.postMessage(
        {
          type: "start",
          id,
          fileName: file.name,
          size: file.size,
          mimeType: file.type || "application/octet-stream",
        },
        [channel.port2],
      );
    });

    throwIfAborted(signal);

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
      let cancelledBySw = false;

      port.onmessage = (event) => {
        const msg = event.data;
        if (msg?.type === "cancelled") {
          cancelledBySw = true;
        }
      };

      const waitForPull = () =>
        new Promise<void>((pullResolve) => {
          const handler = (event: MessageEvent) => {
            if (event.data?.type === "pull") {
              port.removeEventListener("message", handler);
              pullResolve();
            } else if (event.data?.type === "cancelled") {
              cancelledBySw = true;
              port.removeEventListener("message", handler);
              pullResolve();
            }
          };
          port.addEventListener("message", handler);
        });
      port.start();

      const producer = (async () => {
        try {
          const chunks = fileChunkRefs(file);
          if (chunks.length > 0) {
            const totalChunks = chunks.length;

            for (let i = 0; i < totalChunks; i++) {
              throwIfAborted(signal);
              if (cancelledBySw) break;

              await waitForPull();
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
              const buffer = decBytes.buffer.slice(
                decBytes.byteOffset,
                decBytes.byteOffset + decBytes.byteLength,
              ) as ArrayBuffer;
              port.postMessage({ type: "chunk", buffer }, [buffer]);

              onProgress?.({
                stage: "Downloading...",
                progress: Math.round(((i + 1) / totalChunks) * 100),
                currentChunk: i + 1,
                totalChunks,
              });
            }
          } else {
            await waitForPull();
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
              const buffer = decrypted.buffer.slice(
                decrypted.byteOffset,
                decrypted.byteOffset + decrypted.byteLength,
              ) as ArrayBuffer;
              onProgress?.({ stage: "Saving file...", progress: 100 });
              port.postMessage({ type: "chunk", buffer }, [buffer]);
            }
          }

          if (cancelledBySw) {
            reject(new DOMException("Download aborted", "AbortError"));
            return;
          }

          port.postMessage({ type: "end" });
          resolve();
        } catch (error) {
          port.postMessage({
            type: "abort",
            message: error instanceof Error ? error.message : "Download failed",
          });
          reject(error);
        }
      })();

      // Start the download request only after the producer has synchronously
      // installed its first `pull` listener. Otherwise a fast service worker
      // can send the first pull before waitForPull is listening and stall the
      // download forever.
      document.body.appendChild(iframe);
      iframe.src = `/__stream_download__/${encodeURIComponent(id)}`;
      void producer;
    });
  } finally {
    cleanup();
  }

  return { uri: null };
}
