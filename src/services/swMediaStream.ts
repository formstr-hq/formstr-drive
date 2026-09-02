import { deriveConversationKeyFromHex } from "../crypto";
import { readPlaintextRange } from "./rangeRead";
import type { FileMetadata } from "../types/metadata";
import { withTimeout } from "../transfers/withTimeout";

export interface MediaSession {
  /** Feed this straight into a <video src> or <iframe src> — every Range
   *  request the element issues against it is answered by decrypting just
   *  that slice of the file, on demand. */
  url: string;
  /** Tears down the session: tells the SW to drop it and closes the port.
   *  Call on preview close/unmount so a lingering session doesn't keep
   *  answering range requests for a file the user navigated away from. */
  release: () => void;
}

/**
 * Opens a seekable-preview session for a NIP-FS single-blob file via the
 * self-hosted /sw.js service worker (see its header comment for the
 * message protocol). The service worker never receives `encryptionKey` —
 * it only relays "give me plaintext bytes [start, end]" requests, which
 * this module answers locally via {@link readPlaintextRange}.
 *
 * Mirrors the controller-readiness handshake in swStreamDownload.ts's
 * attemptDownloadViaServiceWorker, but without that function's iframe/pull
 * machinery — media fetches are ordinary request/response, not a long-lived
 * backpressured stream.
 */
export async function openMediaSession(
  file: FileMetadata & { blobHash: string; chunkSize: number },
): Promise<MediaSession> {
  await withTimeout(
    navigator.serviceWorker.ready,
    3000,
    "sw-unavailable",
    "Preview service worker is unavailable.",
  );

  let controller = navigator.serviceWorker.controller;
  if (!controller) {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Preview service worker is not active yet. Please reload the page and try again.")),
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
  const blobKey = deriveConversationKeyFromHex(file.encryptionKey);

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      port.postMessage({ type: "media-end" });
    } catch {
      // Port may already be unusable if the SW was terminated; nothing to do.
    }
    port.onmessage = null;
    port.close();
  };

  // Set before controller.postMessage below so no "range" request sent
  // immediately after "media-ready" can arrive before a handler exists.
  port.onmessage = (event) => {
    const msg = event.data;
    if (!msg || msg.type !== "range") return;

    (async () => {
      try {
        const { bytes } = await readPlaintextRange(file, blobKey, msg.start, msg.end);
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        port.postMessage({ type: "range-data", reqId: msg.reqId, buffer }, [buffer]);
      } catch (e) {
        port.postMessage({
          type: "range-error",
          reqId: msg.reqId,
          message: e instanceof Error ? e.message : "Failed to decrypt range",
        });
      }
    })();
  };

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out starting the preview service worker")), 10000);
    const onReady = (event: MessageEvent) => {
      if (event.data?.type === "media-ready") {
        clearTimeout(timeout);
        port.removeEventListener("message", onReady);
        resolve();
      }
    };
    port.addEventListener("message", onReady);
    port.start();
    controller!.postMessage(
      { type: "media-start", id, size: file.size, mimeType: file.type || "application/octet-stream" },
      [channel.port2],
    );
  });

  return { url: `/__stream_media__/${encodeURIComponent(id)}`, release };
}
