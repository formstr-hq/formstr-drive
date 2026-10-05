import { deriveConversationKeyFromHex } from "../crypto";
import { readPlaintextRange } from "./rangeRead";
import type { FileMetadata } from "../types/metadata";
import { waitForServiceWorkerController } from "./swController";

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
 * Uses the same controller-readiness wait as swStreamDownload.ts's
 * attemptDownloadViaServiceWorker (see swController.ts), but without that
 * function's iframe/pull machinery — media fetches are ordinary
 * request/response, not a long-lived backpressured stream.
 */
export async function openMediaSession(
  file: FileMetadata & { blobHash: string; chunkSize: number },
): Promise<MediaSession> {
  const controller = await waitForServiceWorkerController(
    "Preview service worker is unavailable.",
    "Preview service worker is not active yet. Please reload the page and try again.",
  );

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

  // Read-ahead. A media element reads forward in sequential slices (the SW caps
  // each at READ_AHEAD_BYTES), and each slice used to start its network fetch
  // only after the previous one finished, so playback and index scans ran at one
  // round trip per slice. Starting the next slice while the current one is
  // being consumed overlaps those trips; a seek elsewhere just replaces it.
  const READ_AHEAD_BYTES = 4 * 1024 * 1024; // matches MAX_MEDIA_RANGE_BYTES in public/sw.js
  let ahead: { start: number; end: number; promise: Promise<Uint8Array> } | null = null;
  // Where the last served range ended; a request starting right after it is
  // sequential playback, anything else is a seek or an index probe.
  let lastServedEnd = -1;
  const readBytes = async (start: number, end: number) =>
    (await readPlaintextRange(file, blobKey, start, end)).bytes;
  const prefetchFrom = (start: number) => {
    if (released || start >= file.size) {
      ahead = null;
      return;
    }
    const end = Math.min(start + READ_AHEAD_BYTES - 1, file.size - 1);
    const promise = readBytes(start, end);
    const entry = { start, end, promise };
    ahead = entry;
    promise.catch(() => {
      if (ahead === entry) ahead = null;
    });
  };

  // Set before controller.postMessage below so no "range" request sent
  // immediately after "media-ready" can arrive before a handler exists.
  port.onmessage = (event) => {
    const msg = event.data;
    if (!msg || msg.type !== "range") return;

    (async () => {
      const startedAt = performance.now();
      try {
        let bytes: Uint8Array;
        const hit = ahead && ahead.start === msg.start && ahead.end >= msg.end ? ahead : null;
        if (hit) {
          try {
            bytes = (await hit.promise).subarray(0, msg.end - msg.start + 1);
          } catch {
            bytes = await readBytes(msg.start, msg.end);
          }
        } else {
          bytes = await readBytes(msg.start, msg.end);
        }
        // Only read ahead for sequential reads. A seek (or a container index
        // scan jumping around the file) would just throw the prefetch away and
        // double the bandwidth.
        const sequential = msg.start === lastServedEnd + 1;
        lastServedEnd = msg.end;
        if (sequential) prefetchFrom(msg.end + 1);
        else ahead = null;
        const elapsed = performance.now() - startedAt;
        if (elapsed > 5000) {
          console.warn(
            `[media] slow range read: bytes ${msg.start}-${msg.end} from ${file.server} took ${Math.round(elapsed)}ms`,
          );
        }
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        port.postMessage({ type: "range-data", reqId: msg.reqId, buffer }, [buffer]);
      } catch (e) {
        console.error(
          `[media] range read failed: bytes ${msg.start}-${msg.end} from ${file.server} after ${Math.round(performance.now() - startedAt)}ms`,
          e,
        );
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
    controller.postMessage(
      { type: "media-start", id, size: file.size, mimeType: file.type || "application/octet-stream" },
      [channel.port2],
    );
  });

  return { url: `/__stream_media__/${encodeURIComponent(id)}`, release };
}
