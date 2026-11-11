// Rasterizes markup (an HTML page, or a docx page laid out by docx-preview) into
// a square thumbnail of the TOP of the page, the way a drive shows documents.
//
// The markup goes into an SVG <foreignObject> that is loaded as an image: the
// browser lays it out and paints it, but an SVG image runs no scripts and
// fetches no external resources, so untrusted HTML is safe to render here.
// External stylesheets, web fonts and remote images simply do not load.

import { encodeCanvas } from "../encode";
import { THUMB_MAX } from "../limits";

const XHTML = "http://www.w3.org/1999/xhtml";
const LOAD_TIMEOUT_MS = 10_000;
const REMOVE = "script, link, iframe, frame, object, embed, base, meta, noscript, audio, video, source";

/**
 * Serializes the parsed page as it is, html and body elements included, so the
 * author's own rules (html, body, :root, custom properties, @media, nesting)
 * apply exactly as written: no selector rewriting, nothing to get wrong. The
 * SVG root is the document's :root, so custom properties defined there inherit
 * down into the page.
 */
function buildSvg(html: string, width: number): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll(REMOVE).forEach((el) => el.remove());
  doc.querySelectorAll("*").forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.startsWith("on") || /^\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
    }
  });
  doc.querySelectorAll("style").forEach((style) => {
    // An @import url can contain ";" (Google Fonts does), so match the url token, not up to the first ";".
    style.textContent = (style.textContent ?? "").replace(
      /@import\s+(?:url\([^)]*\)|"[^"]*"|'[^']*')[^;]*;/gi,
      "",
    );
  });

  // A page whose body is shorter than the frame would otherwise leave the rest unpainted.
  const base = doc.createElement("style");
  base.textContent = "body{min-height:100%}";
  doc.head.prepend(base);

  const page = doc.documentElement;
  page.setAttribute(
    "style",
    `${page.getAttribute("style") ?? ""};display:block;width:${width}px;height:${width}px;overflow:hidden`,
  );
  const markup = new XMLSerializer().serializeToString(page);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${width}">` +
    `<foreignObject width="100%" height="100%">${markup}</foreignObject></svg>`
  );
}

function loadSvg(svg: string, signal: AbortSignal): Promise<HTMLImageElement> {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    signal.throwIfAborted();
    const img = new Image();
    const timer = setTimeout(() => finish(() => reject(new Error("Render timed out"))), LOAD_TIMEOUT_MS);
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      settle();
    };
    const onAbort = () => finish(() => reject(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
    img.onload = () => finish(() => resolve(img));
    img.onerror = () => finish(() => reject(new Error("Markup could not be rendered as an image")));
    // A data: URL, not a blob: URL: Chromium taints canvases that drew a blob-URL foreignObject SVG.
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
}

let probe: Promise<boolean> | null = null;

/**
 * Safari taints a canvas that drew a foreignObject image, so exporting it
 * throws. Probe once with a 1x1 image so unsupported browsers skip the work.
 */
function canRasterizeMarkup(): Promise<boolean> {
  probe ??= (async () => {
    try {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><foreignObject width="2" height="2"><div xmlns="${XHTML}" style="width:2px;height:2px;background:red"></div></foreignObject></svg>`;
      const img = await loadSvg(svg, new AbortController().signal);
      const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(img, 0, 0);
      ctx.getImageData(0, 0, 1, 1);
      return true;
    } catch {
      return false;
    }
  })();
  return probe;
}

/** Renders html at width CSS pixels wide and returns a square thumbnail of its top width x width region. */
export async function renderDocumentThumbnail(html: string, width: number, signal: AbortSignal): Promise<Uint8Array> {
  if (!(await canRasterizeMarkup())) throw new Error("This browser cannot export rendered markup");
  const img = await loadSvg(buildSvg(html, width), signal);

  const canvas = document.createElement("canvas");
  canvas.width = THUMB_MAX;
  canvas.height = THUMB_MAX;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, THUMB_MAX, THUMB_MAX);
  ctx.drawImage(img, 0, 0, THUMB_MAX, THUMB_MAX);
  return encodeCanvas(canvas);
}
