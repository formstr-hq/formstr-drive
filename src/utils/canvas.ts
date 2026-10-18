/**
 * Canvas to a Blob, WebP first and JPEG as the fallback. WebP decode is
 * essentially universal, but WebP encode is not: some WebView builds return a
 * null blob, and others quietly hand back a PNG when WebP was requested. So a
 * result only counts when its type is what was asked for. Readers never assume a
 * format (detectMimeTypeFromMagicBytes sniffs the bytes), so the substitution is
 * safe end to end.
 */
export async function canvasToBlobWithFallback(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  quality: number,
): Promise<Blob> {
  const toBlob = (type: string): Promise<Blob | null> =>
    "convertToBlob" in canvas
      ? canvas.convertToBlob({ type, quality }).catch(() => null)
      : new Promise((resolve) => canvas.toBlob(resolve, type, quality));

  for (const type of ["image/webp", "image/jpeg"]) {
    const blob = await toBlob(type);
    if (blob && blob.type === type) return blob;
  }
  throw new Error("Canvas export failed for both image/webp and image/jpeg");
}
