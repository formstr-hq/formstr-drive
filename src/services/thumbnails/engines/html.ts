import { HTML_MAX_BYTES } from "../limits";
import { renderDocumentThumbnail } from "../render/document";
import { textThumbnail } from "./text";

const PAGE_WIDTH = 1100;

/** A rendered view of the top of an HTML page. Falls back to its source text when rendering is unavailable. */
export async function htmlThumbnail(file: File, signal: AbortSignal): Promise<Uint8Array> {
  try {
    const html = await file.slice(0, HTML_MAX_BYTES).text();
    signal.throwIfAborted();
    return await renderDocumentThumbnail(html, PAGE_WIDTH, signal);
  } catch (e) {
    if (signal.aborted) throw e;
    console.info("[thumb] html render unavailable, using source text:", e instanceof Error ? e.message : e);
    return textThumbnail(file, signal);
  }
}
