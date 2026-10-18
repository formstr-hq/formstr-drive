import { abortable } from "../abort";
import { encodeCanvas, fitWithin } from "../encode";

// pdf.js is fed through a range transport for every file, so the whole PDF is
// never read into memory: it asks for the cross-reference table at the end, then
// only the bytes page 1 needs.
const INITIAL_CHUNK_BYTES = 64 * 1024;
const MAX_SCALE = 1.5;
// The print intent makes pdf.js render without requestAnimationFrame, which never fires
// in a background tab, where an upload (and so its thumbnail) may well be running.
const PRINT_INTENT = "print";

export async function pdfThumbnail(file: File, signal: AbortSignal): Promise<Uint8Array> {
  const pdfjs = (await import("./pdfWorker")).default;
  signal.throwIfAborted();

  const initial = new Uint8Array(await file.slice(0, INITIAL_CHUNK_BYTES).arrayBuffer());
  const transport = new pdfjs.PDFDataRangeTransport(file.size, initial);
  // The handler must exist before getDocument: pdf.js can ask for ranges immediately.
  transport.requestDataRange = (begin: number, end: number) => {
    file
      .slice(begin, end)
      .arrayBuffer()
      .then((buffer) => transport.onDataRange(begin, new Uint8Array(buffer)))
      .catch(() => void task.destroy());
  };
  const task = pdfjs.getDocument({ range: transport, disableAutoFetch: true, disableStream: true });
  const stop = () => void task.destroy();
  signal.addEventListener("abort", stop, { once: true });

  try {
    const pdf = await abortable(() => task.promise, { signal });
    if (pdf.numPages < 1) throw new Error("PDF has no pages");

    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const fit = fitWithin(base.width, base.height);
    const viewport = page.getViewport({ scale: Math.min(fit.width / base.width, MAX_SCALE) });

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    await abortable(() => page.render({ canvas, viewport, intent: PRINT_INTENT }).promise, { signal });
    return await encodeCanvas(canvas);
  } finally {
    signal.removeEventListener("abort", stop);
    stop();
  }
}
