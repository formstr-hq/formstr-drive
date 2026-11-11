/** Every size and time budget the thumbnail pipeline uses, in one place. */

export const THUMB_MAX = 300;

/** Plain-text sample read from the head of text and code files. */
export const TEXT_SAMPLE_BYTES = 16 * 1024;
/** HTML read for rendering. Markup beyond this cannot affect the top of the page. */
export const HTML_MAX_BYTES = 1024 * 1024;
/** Largest docx laid out for a first-page render (layout cannot be cancelled). */
export const DOCX_RENDER_MAX_BYTES = 5 * 1024 * 1024;
/** Cap on a decompressed zip entry, so a tiny archive cannot inflate into memory. */
export const ZIP_ENTRY_MAX_BYTES = 8 * 1024 * 1024;

/** Whole-engine time budgets. The video element also has its own stall watchdog. */
export const TIMEOUT_MS = {
  image: 30_000,
  video: 60_000,
  pdf: 60_000,
  text: 10_000,
  html: 15_000,
  docx: 30_000,
  office: 15_000,
  audio: 15_000,
} as const;
