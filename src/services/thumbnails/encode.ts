import { canvasToBlobWithFallback } from "../../utils/canvas";
import { THUMB_MAX } from "./limits";

export type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

/** Fits (w, h) inside max x max, keeping the aspect ratio and never upscaling. */
export function fitWithin(width: number, height: number, max = THUMB_MAX): { width: number; height: number } {
  const scale = Math.min(max / width, max / height, 1);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Encoded bytes of a canvas: WebP where the browser can encode it, otherwise JPEG. */
export async function encodeCanvas(canvas: AnyCanvas, quality = 0.7): Promise<Uint8Array> {
  const blob = await canvasToBlobWithFallback(canvas, quality);
  return new Uint8Array(await blob.arrayBuffer());
}

/** Luminance spread (0-255) below which an image counts as blank. */
const BLANK_SPREAD = 10;

/** True when the canvas is one flat colour (a placeholder image, not a real preview). */
function isBlank(canvas: HTMLCanvasElement): boolean {
  const probe = document.createElement("canvas");
  probe.width = probe.height = 16;
  const ctx = probe.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(canvas, 0, 0, 16, 16);
  const { data } = ctx.getImageData(0, 0, 16, 16);
  let min = 255;
  let max = 0;
  for (let i = 0; i < data.length; i += 4) {
    const luminance = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    min = Math.min(min, luminance);
    max = Math.max(max, luminance);
  }
  return max - min < BLANK_SPREAD;
}

/**
 * Decodes encoded image bytes and scales them to a thumbnail. With rejectBlank,
 * a flat single-colour image throws: authoring apps sometimes embed an empty
 * placeholder as a document preview, and a blank tile is worse than the fallback.
 */
export async function imageBytesToThumbnail(
  bytes: Uint8Array,
  mime: string,
  options: { rejectBlank?: boolean } = {},
): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(new Blob([bytes as unknown as BlobPart], { type: mime }));
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, width, height);
    if (options.rejectBlank && isBlank(canvas)) throw new Error("Embedded preview image is blank");
    return await encodeCanvas(canvas);
  } finally {
    bitmap.close();
  }
}
