import { abortable } from "./abort";
import { fileKind, type FileKind } from "./kinds";
import { TIMEOUT_MS } from "./limits";
import { enqueue } from "./queue";

type Engine = (file: File, signal: AbortSignal) => Promise<Uint8Array>;

// Engines load on demand, so mediabunny, pdf.js and docx-preview stay out of the
// main upload bundle until a file of that kind is actually thumbnailed.
const ENGINES: Partial<Record<FileKind, { timeoutMs: number; load: () => Promise<Engine> }>> = {
  image: { timeoutMs: TIMEOUT_MS.image, load: async () => (await import("./engines/image")).imageThumbnail },
  video: { timeoutMs: TIMEOUT_MS.video, load: async () => (await import("./engines/video")).videoThumbnail },
  pdf: { timeoutMs: TIMEOUT_MS.pdf, load: async () => (await import("./engines/pdf")).pdfThumbnail },
  text: { timeoutMs: TIMEOUT_MS.text, load: async () => (await import("./engines/text")).textThumbnail },
  html: { timeoutMs: TIMEOUT_MS.html, load: async () => (await import("./engines/html")).htmlThumbnail },
  docx: { timeoutMs: TIMEOUT_MS.docx, load: async () => (await import("./engines/office")).officeThumbnail },
  office: { timeoutMs: TIMEOUT_MS.office, load: async () => (await import("./engines/office")).officeThumbnail },
  audio: { timeoutMs: TIMEOUT_MS.audio, load: async () => (await import("./engines/audio")).audioThumbnail },
};

/** Thumbnail bytes for a file, or null when its kind has none. Throws when the engine finds nothing to show. */
export async function generateThumbnail(file: File, signal?: AbortSignal): Promise<Uint8Array | null> {
  const kind = fileKind(file);
  const entry = ENGINES[kind];
  if (!entry) return null;

  const started = performance.now();
  try {
    const bytes = await enqueue(
      async () => {
        const engine = await entry.load();
        return abortable((s) => engine(file, s), { signal, timeoutMs: entry.timeoutMs });
      },
      signal,
    );
    console.info(`[thumb] ${kind} ok in ${Math.round(performance.now() - started)}ms, ${bytes.length} bytes`);
    return bytes;
  } catch (e) {
    const why = signal?.aborted ? "cancelled" : e instanceof Error ? e.message : String(e);
    console.info(`[thumb] ${kind} no thumbnail after ${Math.round(performance.now() - started)}ms: ${why}`);
    throw e;
  }
}

/** A thumbnail in flight: the upload waits on promise (bounded) and calls cancel if it overruns. */
export type PendingThumbnail = { promise: Promise<Uint8Array | null>; cancel: () => void };

/**
 * Starts a thumbnail that dies with its parent (the upload's abort signal) and
 * can be cancelled on its own. The promise resolves to null on any failure: a
 * missing thumbnail never fails an upload.
 */
export function startThumbnail(file: File, parentSignal?: AbortSignal): PendingThumbnail {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(parentSignal!.reason);
  if (parentSignal?.aborted) controller.abort(parentSignal.reason);
  else parentSignal?.addEventListener("abort", onParentAbort, { once: true });

  const promise = generateThumbnail(file, controller.signal)
    .catch(() => null)
    .finally(() => parentSignal?.removeEventListener("abort", onParentAbort));
  return { promise, cancel: () => controller.abort() };
}
