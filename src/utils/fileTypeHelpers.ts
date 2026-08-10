export type PreviewMode = "image" | "video" | "pdf" | "text" | "unsupported";

export const MAX_PREVIEW_SIZE = 5 * 1024 * 1024; // 5 MB

export function resolvePreviewMode(fileType: string): PreviewMode {
  const normalizedType = fileType.toLowerCase();

  if (normalizedType.startsWith("image/")) return "image";
  if (normalizedType.startsWith("video/")) return "video";
  if (normalizedType === "application/pdf") return "pdf";

  if (
    normalizedType.startsWith("text/") ||
    normalizedType === "application/json" ||
    normalizedType === "application/xml" ||
    normalizedType === "application/javascript" ||
    normalizedType === "application/x-javascript" ||
    normalizedType === "application/yaml" ||
    normalizedType === "application/x-yaml" ||
    normalizedType === "text/markdown"
  ) {
    return "text";
  }

  return "unsupported";
}

/**
 * Checks magic bytes of an array to detect specific file types that might not be
 * accurately determined by extension or basic mime type alone.
 */
export function detectMimeTypeFromMagicBytes(arr: Uint8Array): string {
  let mimeType = "image/webp";
  if (arr.length > 8) {
    // 47 49 46 38 ("GIF8") is the header shared by GIF87a and GIF89a.
    if (arr[0] === 0x47 && arr[1] === 0x49 && arr[2] === 0x46 && arr[3] === 0x38) {
      mimeType = "image/gif";
    }
    // 1A 45 DF A3 is the EBML header for WebM and Matroska video formats.
    else if (arr[0] === 0x1A && arr[1] === 0x45 && arr[2] === 0xDF && arr[3] === 0xA3) {
      mimeType = "video/webm";
    }
    // 66 74 79 70 ("ftyp") starting at byte 4 is the ISO base media file format signature for MP4.
    else if (arr[4] === 0x66 && arr[5] === 0x74 && arr[6] === 0x79 && arr[7] === 0x70) {
      mimeType = "video/mp4";
    }
  }
  return mimeType;
}

export function getFileIcon(type: string): string {
  if (type.startsWith("image/")) return "img";
  if (type.startsWith("video/")) return "vid";
  if (type.startsWith("audio/")) return "aud";
  if (type === "application/pdf") return "pdf";
  if (type.includes("zip") || type.includes("archive")) return "zip";
  if (type.includes("text") || type.includes("json")) return "txt";
  return "file";
}
