/**
 * The one place that decides what kind of file something is. Everything else
 * (preview modal, icons, thumbnails, Pages hand-off) maps from this, so the
 * answers cannot drift apart.
 */

export type FileKind =
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "docx"
  | "office"
  | "html"
  | "text"
  | "archive"
  | "other";

const EXT = {
  image: /\.(jpe?g|png|gif|webp|avif|bmp|heic|heif|svg)$/i,
  video: /\.(mp4|m4v|mov|webm|mkv|avi|mts|m2ts|3gp)$/i,
  audio: /\.(mp3|m4a|aac|flac|ogg|oga|opus|wav)$/i,
  pdf: /\.pdf$/i,
  docx: /\.(docx|doc)$/i,
  office: /\.(xlsx|pptx|odt|ods|odp)$/i,
  html: /\.(html?|xhtml)$/i,
  archive: /\.(zip|tar|gz|tgz|7z|rar|bz2|xz)$/i,
  text:
    /\.(txt|md|markdown|json|jsonc|csv|tsv|log|xml|ya?ml|toml|ini|cfg|conf|env|css|scss|less|js|jsx|mjs|cjs|tsx?|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|ps1|sql|lua|dart|vue|svelte|tex|srt|vtt)$/i,
} as const;

const DOCX_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
]);

const OFFICE_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
]);

const TEXT_APPLICATION_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-javascript",
  "application/x-sh",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
]);

const ARCHIVE_TYPES = /zip|archive|x-tar|gzip|x-7z|x-rar/i;

/** Types that say nothing about the content, so the extension decides. */
const GENERIC_TYPES = new Set(["", "application/octet-stream", "application/zip", "application/x-zip-compressed"]);

/** A .ts file is TypeScript far more often than an MPEG transport stream. */
const TS_SOURCE_MAX_BYTES = 2 * 1024 * 1024;

export function fileKind(file: { type?: string; name?: string; size?: number }): FileKind {
  const type = (file.type ?? "").toLowerCase().split(";")[0].trim();
  const name = file.name ?? "";

  if (/\.ts$/i.test(name) && (file.size ?? 0) < TS_SOURCE_MAX_BYTES && (type === "" || type === "video/mp2t")) {
    return "text";
  }

  if (type === "text/html" || type === "application/xhtml+xml") return "html";
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  if (type === "application/pdf") return "pdf";
  if (DOCX_TYPES.has(type)) return "docx";
  if (OFFICE_TYPES.has(type)) return "office";
  if (type.startsWith("text/") || TEXT_APPLICATION_TYPES.has(type)) return "text";

  if (GENERIC_TYPES.has(type)) {
    if (EXT.image.test(name)) return "image";
    if (EXT.video.test(name)) return "video";
    if (EXT.audio.test(name)) return "audio";
    if (EXT.pdf.test(name)) return "pdf";
    if (EXT.docx.test(name)) return "docx";
    if (EXT.office.test(name)) return "office";
    if (EXT.html.test(name)) return "html";
    if (EXT.text.test(name)) return "text";
  }
  if (ARCHIVE_TYPES.test(type) || EXT.archive.test(name)) return "archive";
  return "other";
}
