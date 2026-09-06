// gifenc (https://github.com/mattdesl/gifenc) ships no TypeScript types.
// Declared here to match the exact API verified against v1.0.3's source
// (src/index.js, src/palettize.js, src/pnnquant2.js) and README.
declare module "gifenc" {
  export type RGB = [number, number, number];
  export type RGBA = [number, number, number, number];
  export type Palette = ReadonlyArray<RGB | RGBA>;

  export interface QuantizeOptions {
    format?: "rgb565" | "rgb444" | "rgba4444";
    oneBitAlpha?: boolean | number;
    clearAlpha?: boolean;
    clearAlphaThreshold?: number;
    clearAlphaColor?: number;
  }

  /** rgba: flat Uint8Array/Uint8ClampedArray of per-pixel RGBA bytes. */
  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    options?: QuantizeOptions,
  ): Palette;

  /** Returns a Uint8Array of length rgba.length / 4 — one palette index per pixel. */
  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: Palette,
    format?: "rgb565" | "rgb444" | "rgba4444",
  ): Uint8Array;

  export interface WriteFrameOptions {
    /** Required on the first frame written (auto mode). */
    palette?: Palette;
    /** Frame delay in milliseconds. */
    delay?: number;
    /** 0 = loop forever, -1 = once, >0 = play N extra times. Only meaningful on frame 1. */
    repeat?: number;
    transparent?: boolean;
    transparentIndex?: number;
    colorDepth?: number;
    dispose?: number;
  }

  export interface GIFEncoderInstance {
    reset(): void;
    finish(): void;
    bytes(): Uint8Array;
    bytesView(): Uint8Array;
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      options?: WriteFrameOptions,
    ): void;
  }

  export function GIFEncoder(options?: { initialCapacity?: number; auto?: boolean }): GIFEncoderInstance;
  export default GIFEncoder;
}
