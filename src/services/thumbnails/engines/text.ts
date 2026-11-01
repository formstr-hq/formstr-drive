import { TEXT_SAMPLE_BYTES } from "../limits";
import { drawTextPage } from "../render/textPage";

const MAX_LINES = 20;
const PROSE = /\.(txt|md|markdown|tex)$/i;

/** True when the sample looks binary: NUL bytes, or a high share of control characters. */
function looksBinary(bytes: Uint8Array): boolean {
  let control = 0;
  for (const b of bytes) {
    if (b === 0) return true;
    if (b < 9 || (b > 13 && b < 32)) control += 1;
  }
  return bytes.length > 0 && control / bytes.length > 0.1;
}

/** First lines of a text or code file on a page. Reads only the head of the file. */
export async function textThumbnail(file: File, signal: AbortSignal): Promise<Uint8Array> {
  const sample = new Uint8Array(await file.slice(0, TEXT_SAMPLE_BYTES).arrayBuffer());
  signal.throwIfAborted();
  if (sample.length === 0) throw new Error("File is empty");
  if (looksBinary(sample)) throw new Error("File is not text");

  const lines = new TextDecoder("utf-8", { fatal: false })
    .decode(sample)
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd());
  while (lines.length && lines[0].trim() === "") lines.shift();
  return drawTextPage(lines.slice(0, MAX_LINES), { monospace: !PROSE.test(file.name) });
}
