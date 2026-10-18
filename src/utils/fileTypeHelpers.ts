import { fileKind, type FileKind } from "../services/thumbnails/kinds";

export type PreviewMode = "image" | "video" | "pdf" | "text" | "html" | "docx" | "unsupported";

export const MAX_PREVIEW_SIZE = 5 * 1024 * 1024; // 5 MB
export const PREVIEW_UNAVAILABLE_MESSAGE = "Preview isn't available for this file. Download it to view.";

export function resolvePreviewMode(fileType: string, fileName?: string): PreviewMode {
  const kind = fileKind({ type: fileType, name: fileName });
  switch (kind) {
    case "image":
    case "video":
    case "pdf":
    case "text":
    case "html":
    case "docx":
      return kind as PreviewMode;
    default:
      return "unsupported";
  }
}

// Containers that mainstream browsers don't demux. canPlayType is only trusted
// for these: for other types an empty answer is unreliable (e.g. Firefox says ""
// for video/quicktime though many .mov files play), so those are just tried.
const OFTEN_UNSUPPORTED_VIDEO = /matroska|x-msvideo|x-flv|x-ms-wmv/i;

/**
 * False only when `fileType` is a container browsers commonly can't play AND
 * this browser's `canPlayType` firmly rules it out. Anything else, including
 * no DOM or no type, is "maybe" — a supported container can still fail on its
 * codec, which the player reports itself.
 */
export function browserMayPlayVideo(fileType: string): boolean {
  if (!fileType || typeof document === "undefined") return true;
  if (!OFTEN_UNSUPPORTED_VIDEO.test(fileType)) return true;
  return document.createElement("video").canPlayType(fileType) !== "";
}

/** Short notice for a file type the app has no viewer for, naming the extension when there is one. */
export function unsupportedTypeMessage(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  const ext = dot > 0 && dot < fileName.length - 1 ? fileName.slice(dot).toLowerCase() : "";
  return ext ? `Preview isn't available for ${ext} files.` : "Preview isn't available for this file type.";
}

export function unsupportedVideoMessage(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  const ext = dot > 0 && dot < fileName.length - 1 ? fileName.slice(dot) : "";
  return ext
    ? `This browser can't play ${ext} videos. Download the file to watch it in a media player.`
    : "This browser can't play this video format. Download the file to watch it in a media player.";
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

const ICON_BY_KIND: Record<FileKind, string> = {
  image: "img",
  video: "vid",
  audio: "aud",
  pdf: "pdf",
  html: "html",
  docx: "doc",
  office: "doc",
  archive: "zip",
  text: "txt",
  other: "file",
};

export function getFileIcon(type: string, name?: string): string {
  return ICON_BY_KIND[fileKind({ type, name })];
}
