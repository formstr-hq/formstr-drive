/**
 * `canvas.toBlob()` with a WebP encode, falling back to JPEG if WebP produces
 * nothing. WebP *decode* is essentially universal, but WebP *encode* via
 * `toBlob` is a much newer, less consistently available capability across
 * WebView builds than plain JPEG — some return a `null` blob rather than
 * throwing, which silently drops the image with no error anywhere. JPEG has
 * been supported everywhere basically forever, so it's the safe fallback for
 * a small (≤300px) preview thumbnail where the extra size doesn't matter.
 *
 * Callers that read the result back never assume a specific format — the
 * read side (`detectMimeTypeFromMagicBytes`) sniffs the real bytes — so this
 * silent format substitution is safe end-to-end.
 */
export async function canvasToBlobWithFallback(
  canvas: HTMLCanvasElement,
  quality: number,
): Promise<Blob> {
  const webp = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/webp", quality),
  );
  if (webp) return webp;

  const jpeg = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/jpeg", quality),
  );
  if (jpeg) return jpeg;

  throw new Error("Canvas export failed for both image/webp and image/jpeg");
}
