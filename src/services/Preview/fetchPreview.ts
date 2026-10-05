import type { FileMetadata } from "../../types/metadata";
import { decryptFileWithKey } from "../../crypto";
import { BlossomClient } from "../../blossom";
import { detectMimeTypeFromMagicBytes } from "../../utils/fileTypeHelpers";
import { canvasToBlobWithFallback } from "../../utils/canvas";

export interface PreviewData {
  url: string;
  type: string;
  /** A static (non-animated) frame, only set for image/gif previews — shown
   *  by default so the animation only plays on hover, not continuously in
   *  a file list. Absent (falls back to `url`) if extraction failed. */
  staticUrl?: string;
}

// Session-level preview cache, shared by every caller (FileCard, SharedView):
// avoids re-fetching (and re-decrypting) the same thumbnail twice. Keyed by
// previewHash → PreviewData.
const previewCache = new Map<string, PreviewData>();
const inFlightRequests = new Map<string, Promise<PreviewData | null>>();

export const MAX_CONCURRENT_PREVIEWS = 4;
let activePreviewRequests = 0;
const previewQueue: Array<() => void> = [];

async function acquirePreviewSlot(): Promise<void> {
  if (activePreviewRequests < MAX_CONCURRENT_PREVIEWS) {
    activePreviewRequests++;
    return;
  }
  return new Promise<void>((resolve) => {
    previewQueue.push(() => {
      activePreviewRequests++;
      resolve();
    });
  });
}

function releasePreviewSlot(): void {
  activePreviewRequests--;
  const next = previewQueue.shift();
  if (next) {
    next();
  }
}

/** Synchronous cache peek, so a caller can render an already-fetched preview
 *  immediately in the same tick instead of waiting a microtask on
 *  `fetchFilePreview`'s promise (avoids a one-frame flicker back to the
 *  loading state when navigating between folders / re-mounting a card). */
export function getCachedPreview(previewHash: string): PreviewData | undefined {
  return previewCache.get(previewHash);
}

/** Returns the current state of the preview concurrency pool (for tests/monitoring). */
export function getPreviewQueueStatus(): { active: number; queued: number; maxConcurrent: number } {
  return {
    active: activePreviewRequests,
    queued: previewQueue.length,
    maxConcurrent: MAX_CONCURRENT_PREVIEWS,
  };
}

/** Clears the preview cache and in-flight requests (useful for tests and logout). */
export function clearPreviewCache(): void {
  previewCache.clear();
  inFlightRequests.clear();
}

/** Draws `blobUrl`'s current (first) frame to a canvas and re-exports it as a
 *  static webp — used to derive a non-animated poster frame from a GIF. */
async function extractStaticFrame(blobUrl: string): Promise<string> {
  const img = new Image();
  img.src = blobUrl;
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Failed to load image for static frame extraction"));
  });

  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Failed to get canvas 2D context");
  ctx.drawImage(img, 0, 0);

  const blob = await canvasToBlobWithFallback(canvas, 0.8);
  return URL.createObjectURL(blob);
}

/**
 * Fetches and decrypts a file's small thumbnail (`previewHash`), independent
 * of the file's own size — this is the same lightweight preview blob FileCard
 * shows in the drive list, capped at 300px at generation time, so it's cheap
 * to fetch even for a multi-GB file. Unrelated to MAX_PREVIEW_SIZE, which
 * only gates opening a *full-size* inline preview of the actual file.
 *
 * Works without a signer or signed-in identity: `BlossomClient.download` is
 * an unauthenticated GET, and decryption only needs the file's own
 * `encryptionKey` (already present in `file` once its metadata is decrypted)
 * — safe to call from the public SharedView as well as the signed-in drive.
 */
export async function fetchFilePreview(file: FileMetadata): Promise<PreviewData | null> {
  if (!file.previewHash) return null;

  const cached = previewCache.get(file.previewHash);
  if (cached) return cached;

  const inFlight = inFlightRequests.get(file.previewHash);
  if (inFlight) return inFlight;

  const previewHash = file.previewHash;
  const taskPromise = (async (): Promise<PreviewData | null> => {
    await acquirePreviewSlot();
    try {
      // Re-check cache in case it was resolved while waiting in queue
      const cachedAfterWait = previewCache.get(previewHash);
      if (cachedAfterWait) return cachedAfterWait;

      const client = new BlossomClient(file.server);
      const uint8arr = await client.download(previewHash);
      const ciphertext = new TextDecoder().decode(uint8arr as Uint8Array<ArrayBuffer>);
      const decrypted = await decryptFileWithKey(ciphertext, file.encryptionKey);

      const arr = new Uint8Array(decrypted);
      const mimeType = detectMimeTypeFromMagicBytes(arr) || "image/webp";

      const blob = new Blob([decrypted as BlobPart], { type: mimeType });
      const imageUrl = URL.createObjectURL(blob);

      let staticUrl: string | undefined;
      if (mimeType === "image/gif") {
        try {
          staticUrl = await extractStaticFrame(imageUrl);
        } catch (e) {
          console.warn("Failed to extract a static frame for GIF preview; it will always animate", e);
        }
      }

      const data: PreviewData = { url: imageUrl, type: mimeType, staticUrl };

      previewCache.set(previewHash, data);
      return data;
    } finally {
      releasePreviewSlot();
    }
  })().finally(() => {
    inFlightRequests.delete(previewHash);
  });

  inFlightRequests.set(previewHash, taskPromise);
  return taskPromise;
}
