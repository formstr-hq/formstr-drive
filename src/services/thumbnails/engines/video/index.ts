import { decodeEngineAvailable, decodeVideoThumbnail, DecodeUnavailable } from "./decode";
import { videoElementThumbnail } from "./element";

/**
 * WebCodecs in a worker first (reads only the byte ranges it needs, so cost does
 * not scale with file size), then the <video> element for anything the worker
 * cannot do. Both stop when the signal aborts.
 */
export async function videoThumbnail(file: File, signal: AbortSignal): Promise<Uint8Array> {
  if (decodeEngineAvailable()) {
    try {
      return await decodeVideoThumbnail(file, signal);
    } catch (e) {
      if (signal.aborted) throw e;
      const why = e instanceof DecodeUnavailable ? "unsupported" : "failed";
      console.info(`[thumb] video worker ${why}, falling back to <video>:`, e instanceof Error ? e.message : e);
    }
  }
  return videoElementThumbnail(file, signal);
}
