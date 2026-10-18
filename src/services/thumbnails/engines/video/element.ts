import { encodeCanvas, fitWithin } from "../../encode";
import { GifBuilder, planFrames } from "./capture";

// Fallback engine: one hidden <video> on the file blob URL, for anything the
// WebCodecs worker cannot do. It gives up only when the element makes no
// progress for STALL_MS, never on a fixed wall-clock budget, so a huge file
// that keeps advancing gets all the time it needs (the engine budget still caps it).
const STALL_MS = 15_000;

const ACTIVITY = [
  "progress",
  "loadstart",
  "loadedmetadata",
  "loadeddata",
  "canplay",
  "seeking",
  "seeked",
  "timeupdate",
] as const;

/** Resolves on the next `event`; rejects on error, abort, or STALL_MS without any activity. */
function nextEvent(video: HTMLVideoElement, event: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    let timer: ReturnType<typeof setTimeout>;
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      video.removeEventListener(event, onEvent);
      video.removeEventListener("error", onError);
      for (const name of ACTIVITY) video.removeEventListener(name, arm);
      signal.removeEventListener("abort", onAbort);
      settle();
    };
    const onEvent = () => finish(resolve);
    const onError = () => finish(() => reject(new Error("Video element error")));
    const onAbort = () => finish(() => reject(signal.reason));
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(() => reject(new Error(`No video progress for ${STALL_MS / 1000}s`))), STALL_MS);
    };

    video.addEventListener(event, onEvent, { once: true });
    video.addEventListener("error", onError, { once: true });
    for (const name of ACTIVITY) video.addEventListener(name, arm);
    signal.addEventListener("abort", onAbort, { once: true });
    arm();
  });
}

function seek(video: HTMLVideoElement, seconds: number, signal: AbortSignal): Promise<void> {
  const arrived = nextEvent(video, "seeked", signal);
  video.currentTime = seconds;
  return arrived;
}

export async function videoElementThumbnail(file: File, signal: AbortSignal): Promise<Uint8Array> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  try {
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.src = url;

    await nextEvent(video, "loadedmetadata", signal);
    if (video.videoWidth <= 0 || video.videoHeight <= 0) throw new Error("Video has no readable dimensions");

    const { width, height } = fitWithin(video.videoWidth, video.videoHeight);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;

    const plan = planFrames(Number.isFinite(video.duration) ? video.duration : 0);
    const gif = new GifBuilder(plan.delayMs);
    try {
      for (const timestamp of plan.timestamps) {
        await seek(video, timestamp, signal);
        ctx.drawImage(video, 0, 0, width, height);
        gif.addFrame(ctx.getImageData(0, 0, width, height).data, width, height);
      }
      const bytes = gif.finish();
      if (bytes) return bytes;
    } catch (e) {
      if (signal.aborted) throw e;
      console.info("[thumb] animated capture failed, taking a still from the same element", e);
    }

    // Still frame from the SAME element, never a second one opened on the same file.
    if (gif.frames === 0) await seek(video, plan.timestamps[0], signal);
    ctx.drawImage(video, 0, 0, width, height);
    return await encodeCanvas(canvas);
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}
