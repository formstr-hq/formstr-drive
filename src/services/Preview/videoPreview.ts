import { GIFEncoder, quantize, applyPalette } from "gifenc";
import { withTimeout } from "../../transfers/withTimeout";
import { canvasToBlobWithFallback } from "../../utils/canvas";

const PREVIEW_MAX_DIMENSION = 300;
const PREVIEW_DURATION_SECONDS = 2.5;
const FRAME_COUNT = 7;
const GIF_MAX_COLORS = 64;
const SEEK_TIMEOUT_MS = 4000;
const METADATA_TIMEOUT_MS = 8000;
const TOTAL_TIMEOUT_MS = 20000;
const STATIC_FRAME_TIMEOUT_MS = 8000;

/** Resolves once `video`'s `seeked` event fires for this specific seek, or
 *  rejects after `timeoutMs` — never a fixed-duration guess about whether a
 *  frame is "ready"; the browser tells us directly. */
function waitForSeek(video: HTMLVideoElement, timestamp: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onSeeked = () => {
      if (settled) return;
      settled = true;
      video.removeEventListener("seeked", onSeeked);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      video.removeEventListener("seeked", onSeeked);
      reject(new Error(`Seek to ${timestamp.toFixed(2)}s timed out`));
    }, timeoutMs);
    video.addEventListener("seeked", onSeeked);
    video.currentTime = timestamp;
  });
}

/**
 * Captures a handful of frames via the browser's own native, streaming video
 * decoder — never ffmpeg/wasm, never a manual read of the file's bytes — and
 * encodes them into a real animated GIF with `gifenc` (pure JS, no CDN/wasm
 * fetch). `preload="metadata"` plus seeking means the browser only needs to
 * parse headers and decode around each seek point; the source file's bytes
 * are never materialized in JS-visible memory, so peak memory here doesn't
 * scale with the source file's size — only with PREVIEW_MAX_DIMENSION and
 * FRAME_COUNT, both fixed. Each frame is fully processed (captured, quantized,
 * palette-applied, written to the GIF stream) before the next seek, so at
 * most one decoded frame's pixel data is ever held at once.
 */
async function generateAnimatedGifPreview(file: File): Promise<Uint8Array> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");

  try {
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.src = url;

    await withTimeout(
      new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = () => resolve();
        video.onerror = () => reject(new Error("Video metadata failed to load"));
      }),
      METADATA_TIMEOUT_MS,
      "gif-metadata-timeout",
      `Timed out loading video metadata for ${file.name}`,
    );

    const sourceWidth = video.videoWidth;
    const sourceHeight = video.videoHeight;
    if (sourceWidth <= 0 || sourceHeight <= 0) {
      throw new Error("Video has no readable dimensions");
    }

    const scale = Math.min(PREVIEW_MAX_DIMENSION / sourceWidth, PREVIEW_MAX_DIMENSION / sourceHeight, 1);
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    // willReadFrequently: we call getImageData once per frame (a handful of
    // times) — this hints the browser to keep a CPU-backed buffer instead of
    // a GPU one, avoiding a slow GPU readback on every call.
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Failed to get canvas 2D context");

    const duration = video.duration || 0;
    // Skip the first ~0.1s — frame 0 is black/undecoded on some codecs.
    const end = Math.min(duration, PREVIEW_DURATION_SECONDS);
    const start = Math.min(0.1, end / 2);
    const timestamps =
      end > start
        ? Array.from({ length: FRAME_COUNT }, (_, i) => start + ((end - start) * i) / (FRAME_COUNT - 1))
        : [start]; // degenerate (near-zero-length) clip: one frame only

    // Pace the loop at roughly the source's own playback speed rather than an
    // arbitrary fixed rate, clamped to a sane range.
    const frameDelayMs = Math.min(500, Math.max(80, Math.round(((end - start) * 1000) / timestamps.length)));

    const gif = GIFEncoder();

    for (const timestamp of timestamps) {
      await waitForSeek(video, timestamp, SEEK_TIMEOUT_MS);
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(video, 0, 0, width, height);
      const { data } = ctx.getImageData(0, 0, width, height);

      const palette = quantize(data, GIF_MAX_COLORS);
      const index = applyPalette(data, palette);
      gif.writeFrame(index, width, height, { palette, delay: frameDelayMs, repeat: 0 });
    }

    gif.finish();
    const bytes = gif.bytes();
    if (bytes.length < 50) {
      throw new Error("GIF encoder produced an empty/near-empty preview");
    }
    return bytes;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Single static frame via the browser's own video decoder — used as the
 * fallback when the animated path fails for any reason (decode error, corrupt
 * file, encode failure). `preload="metadata"` means the browser only needs to
 * parse headers up front and stream-decode around the seek point, never
 * materializing the whole file as a JS buffer, so this stays cheap regardless
 * of source size.
 */
function generateStaticVideoFrame(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    const url = URL.createObjectURL(file);
    let settled = false;

    const cleanup = () => URL.revokeObjectURL(url);
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const timer = setTimeout(() => {
      settle(() => reject(new Error("Video frame extraction timed out")));
    }, STATIC_FRAME_TIMEOUT_MS);

    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.src = url;

    video.onloadedmetadata = () => {
      video.currentTime = Math.min(0.1, video.duration || 0.1);
    };

    video.onseeked = () => {
      clearTimeout(timer);
      (async () => {
        try {
          const width = video.videoWidth || 0;
          const height = video.videoHeight || 0;
          if (width <= 0 || height <= 0) {
            throw new Error("Video has no readable dimensions");
          }
          const scale = Math.min(PREVIEW_MAX_DIMENSION / width, PREVIEW_MAX_DIMENSION / height, 1);

          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(width * scale));
          canvas.height = Math.max(1, Math.round(height * scale));
          const ctx = canvas.getContext("2d");
          if (!ctx) throw new Error("Failed to get canvas 2D context");
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

          const blob = await canvasToBlobWithFallback(canvas, 0.7);
          const bytes = new Uint8Array(await blob.arrayBuffer());
          settle(() => resolve(bytes));
        } catch (e) {
          settle(() => reject(e instanceof Error ? e : new Error(String(e))));
        }
      })();
    };

    video.onerror = () => settle(() => reject(new Error("Video loading failed")));
  });
}

export async function generateVideoThumbnail(file: File): Promise<Uint8Array> {
  try {
    return await withTimeout(
      generateAnimatedGifPreview(file),
      TOTAL_TIMEOUT_MS,
      "gif-preview-timeout",
      `Timed out generating an animated preview for ${file.name}`,
    );
  } catch (e) {
    console.warn("Animated GIF preview generation failed, falling back to a static frame", e);
    return generateStaticVideoFrame(file);
  }
}
