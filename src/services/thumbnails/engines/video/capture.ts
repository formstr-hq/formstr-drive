// Shared by both video engines (the WebCodecs worker and the <video> element):
// which moments to sample, how to pace them, and how to assemble the GIF.
// No DOM access here, so it runs inside a worker too.

import { GIFEncoder, applyPalette, quantize } from "gifenc";

const FRAME_COUNT = 7;
const SAMPLE_SECONDS = 2.5;
/** Frame 0 is black or undecoded on some codecs, so sampling starts a little in. */
const FIRST_FRAME_OFFSET = 0.1;
const GIF_COLORS = 64;
const MIN_GIF_BYTES = 50;

export type FramePlan = { timestamps: number[]; delayMs: number };

/** Moments to sample across the first couple of seconds, and the delay between GIF frames. */
export function planFrames(durationSeconds: number): FramePlan {
  const end = Math.min(durationSeconds, SAMPLE_SECONDS);
  const start = Math.min(FIRST_FRAME_OFFSET, end / 2);
  if (!(end > start)) return { timestamps: [start], delayMs: 200 };

  const timestamps = Array.from({ length: FRAME_COUNT }, (_, i) => start + ((end - start) * i) / (FRAME_COUNT - 1));
  const delayMs = Math.min(500, Math.max(80, Math.round(((end - start) * 1000) / timestamps.length)));
  return { timestamps, delayMs };
}

/** Collects RGBA frames into an animated GIF. */
export class GifBuilder {
  private readonly gif = GIFEncoder();
  frames = 0;
  private readonly delayMs: number;

  constructor(delayMs: number) {
    this.delayMs = delayMs;
  }

  addFrame(rgba: Uint8ClampedArray, width: number, height: number): void {
    const palette = quantize(rgba, GIF_COLORS);
    this.gif.writeFrame(applyPalette(rgba, palette), width, height, {
      palette,
      delay: this.delayMs,
      repeat: 0,
    });
    this.frames += 1;
  }

  /** The GIF, or null when fewer than two frames were captured (a still is better then). */
  finish(): Uint8Array | null {
    this.gif.finish();
    const bytes = this.gif.bytes();
    return this.frames > 1 && bytes.length >= MIN_GIF_BYTES ? bytes : null;
  }
}
