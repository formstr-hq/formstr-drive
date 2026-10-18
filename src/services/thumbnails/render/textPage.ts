import { encodeCanvas } from "../encode";
import { THUMB_MAX } from "../limits";

const PAD = 14;
/** Characters considered per line; anything longer is clipped before measuring. */
const MAX_LINE_CHARS = 400;

/** Longest prefix of text that fits maxWidth, found by binary search (log n measureText calls). */
function clipToWidth(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  const line = text.length > MAX_LINE_CHARS ? text.slice(0, MAX_LINE_CHARS) : text;
  if (ctx.measureText(line).width <= maxWidth) return line;
  let lo = 0;
  let hi = line.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(line.slice(0, mid)).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return line.slice(0, lo);
}

/** Paper-coloured square with the given lines of text: the thumbnail for documents and code. */
export async function drawTextPage(lines: string[], options: { monospace: boolean }): Promise<Uint8Array> {
  const { monospace } = options;
  const fontSize = monospace ? 10 : 12;
  const lineHeight = Math.round(fontSize * 1.45);

  const canvas = document.createElement("canvas");
  canvas.width = THUMB_MAX;
  canvas.height = THUMB_MAX;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, THUMB_MAX, THUMB_MAX);
  ctx.fillStyle = "#1f2937";
  ctx.textBaseline = "top";
  ctx.font = `${fontSize}px ${monospace ? "ui-monospace, Menlo, Consolas, monospace" : "system-ui, sans-serif"}`;

  const maxLines = Math.floor((THUMB_MAX - PAD * 2) / lineHeight);
  const maxWidth = THUMB_MAX - PAD * 2;
  lines.slice(0, maxLines).forEach((line, i) => {
    ctx.fillText(clipToWidth(ctx, line.replace(/\t/g, "  "), maxWidth), PAD, PAD + i * lineHeight);
  });
  return encodeCanvas(canvas);
}

export type SlideCard = { title: string; lines: string[]; background: string };

/** Greedy word wrap, at most maxLines lines (the last one ellipsized when text remains). */
function wrapWords(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const out: string[] = [];
  let line = "";
  const words = text.split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const candidate = line ? `${line} ${words[i]}` : words[i];
    if (line && ctx.measureText(candidate).width > maxWidth) {
      out.push(line);
      line = words[i];
      if (out.length === maxLines) return ellipsize(ctx, out, maxWidth);
    } else {
      line = candidate;
    }
  }
  if (line) out.push(line);
  return out.length > maxLines ? ellipsize(ctx, out.slice(0, maxLines), maxWidth) : out;
}

function ellipsize(ctx: CanvasRenderingContext2D, lines: string[], maxWidth: number): string[] {
  const last = lines.length - 1;
  lines[last] = `${clipToWidth(ctx, lines[last], maxWidth - ctx.measureText("...").width)}...`;
  return lines;
}

/** True when white text reads better than dark text on this #rrggbb background. */
function isDark(hex: string): boolean {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.299 * r + 0.587 * g + 0.114 * b < 140;
}

/** A slide-like card (background colour, big title, a few lines): the thumbnail for presentations without a preview image. */
export async function drawSlideCard({ title, lines, background }: SlideCard): Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  canvas.width = THUMB_MAX;
  canvas.height = THUMB_MAX;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, THUMB_MAX, THUMB_MAX);
  const ink = isDark(background) ? "#ffffff" : "#111827";
  const soft = isDark(background) ? "rgba(255,255,255,0.72)" : "rgba(17,24,39,0.7)";
  const maxWidth = THUMB_MAX - PAD * 2;

  ctx.textBaseline = "top";
  let y = PAD + 6;
  if (title) {
    ctx.fillStyle = ink;
    ctx.font = "bold 22px system-ui, sans-serif";
    for (const line of wrapWords(ctx, title, maxWidth, 3)) {
      ctx.fillText(line, PAD, y);
      y += 28;
    }
    y += 8;
  }
  ctx.fillStyle = soft;
  ctx.font = "12px system-ui, sans-serif";
  for (const text of lines) {
    if (y > THUMB_MAX - PAD - 16) break;
    for (const line of wrapWords(ctx, text, maxWidth, 2)) {
      ctx.fillText(line, PAD, y);
      y += 17;
    }
    y += 3;
  }
  return encodeCanvas(canvas);
}
