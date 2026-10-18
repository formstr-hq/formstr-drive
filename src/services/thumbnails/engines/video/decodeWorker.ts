/// <reference lib="webworker" />
// Video thumbnails off the main thread. mediabunny demuxes straight from the
// File through slice() reads (head and tail, so MP4s with the index at the end
// work) and WebCodecs decodes only the frames we sample. Memory and time do not
// depend on file size.

import { ALL_FORMATS, BlobSource, CanvasSink, Input } from "mediabunny";
import { canvasToBlobWithFallback } from "../../../../utils/canvas";
import { fitWithin } from "../../encode";
import { GifBuilder, planFrames } from "./capture";

export type DecodeRequest = { file: File };
export type DecodeResponse =
  | { type: "done"; bytes: ArrayBuffer }
  | { type: "unsupported"; message: string }
  | { type: "error"; message: string };

async function generate(file: File): Promise<DecodeResponse> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) return { type: "unsupported", message: "No video track" };
    if (!(await track.canDecode())) return { type: "unsupported", message: "Codec cannot be decoded here" };

    // Real aspect ratio, never upscaled: the same output the <video> engine gives.
    const size = fitWithin(track.displayWidth, track.displayHeight);
    const sink = new CanvasSink(track, { width: size.width, height: size.height, fit: "fill" });
    const plan = planFrames(await input.computeDuration());
    const gif = new GifBuilder(plan.delayMs);
    let still: OffscreenCanvas | null = null;

    for await (const frame of sink.canvasesAtTimestamps(plan.timestamps)) {
      if (!frame) continue;
      const canvas = frame.canvas as OffscreenCanvas;
      const ctx = canvas.getContext("2d", { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
      if (!still) {
        still = new OffscreenCanvas(canvas.width, canvas.height);
        still.getContext("2d")!.drawImage(canvas, 0, 0);
      }
      gif.addFrame(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
    }
    if (!still) return { type: "error", message: "No frames could be decoded" };

    const bytes = gif.finish();
    if (bytes) return { type: "done", bytes: bytes.slice().buffer };
    return { type: "done", bytes: await (await canvasToBlobWithFallback(still, 0.7)).arrayBuffer() };
  } catch (e) {
    return { type: "error", message: e instanceof Error ? e.message : String(e) };
  } finally {
    input.dispose();
  }
}

self.onmessage = async (event: MessageEvent<DecodeRequest>) => {
  const result = await generate(event.data.file);
  if (result.type === "done") (self as DedicatedWorkerGlobalScope).postMessage(result, [result.bytes]);
  else self.postMessage(result);
};
