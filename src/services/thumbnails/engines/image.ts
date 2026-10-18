import { abortable } from "../abort";
import { encodeCanvas, fitWithin } from "../encode";

const HEIC_TYPES = new Set(["image/heic", "image/heif"]);
const HEIC_EXT = /\.(heic|heif)$/i;

function isHeic(file: File): boolean {
  const type = file.type.toLowerCase();
  return HEIC_TYPES.has(type) || ((type === "" || type === "application/octet-stream") && HEIC_EXT.test(file.name));
}

async function heicToJpeg(file: File, signal: AbortSignal): Promise<Blob> {
  const module = await import("heic2any");
  const heic2any = module.default ?? module;
  const converted = await abortable(
    () => heic2any({ blob: file, toType: "image/jpeg", quality: 0.8 }),
    { signal },
  );
  return Array.isArray(converted) ? converted[0] : converted;
}

/** createImageBitmap cannot decode some formats (SVG in several browsers), so fall back to an img element. */
async function decode(blob: Blob, signal: AbortSignal): Promise<CanvasImageSource & { width: number; height: number; close?: () => void }> {
  try {
    return await createImageBitmap(blob);
  } catch {
    signal.throwIfAborted();
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await abortable(() => img.decode(), { signal });
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function imageThumbnail(file: File, signal: AbortSignal): Promise<Uint8Array> {
  const source = isHeic(file) ? await heicToJpeg(file, signal) : file;
  signal.throwIfAborted();

  const image = await decode(source, signal);
  try {
    const { width, height } = fitWithin(image.width, image.height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d")!.drawImage(image, 0, 0, width, height);
    return await encodeCanvas(canvas);
  } finally {
    image.close?.();
  }
}
