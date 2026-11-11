import type { FileMetadata } from "../types/metadata";

export function isOfficeDoc(file: { type?: string; name?: string }): boolean {
  const normalizedType = (file.type || "").toLowerCase();
  const lowerName = (file.name || "").toLowerCase();

  return (
    normalizedType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    normalizedType === "application/msword" ||
    normalizedType === "application/vnd.oasis.opendocument.text" ||
    lowerName.endsWith(".docx") ||
    lowerName.endsWith(".doc") ||
    lowerName.endsWith(".odt")
  );
}

export function isTextDoc(file: { type?: string; name?: string }): boolean {
  const normalizedType = (file.type || "").toLowerCase();
  const lowerName = (file.name || "").toLowerCase();

  return (
    normalizedType === "text/markdown" ||
    normalizedType === "text/plain" ||
    lowerName.endsWith(".md") ||
    lowerName.endsWith(".markdown") ||
    lowerName.endsWith(".txt")
  );
}

export function canOpenInPages(file: { type?: string; name?: string; chunks?: unknown[]; blobHash?: string }): boolean {
  return isOfficeDoc(file) || isTextDoc(file);
}

export function canOpenInNostrDocs(file: { type?: string; name?: string; chunks?: unknown[]; blobHash?: string }): boolean {
  return isOfficeDoc(file);
}

// The Android app's WebView is itself served from "localhost", so the hostname
// can't tell dev from production. Only a dev build talks to the local Pages server.
function pagesBaseUrl(): string {
  return import.meta.env.DEV ? "http://localhost:5174" : "https://pages.formstr.app";
}

export function openInNostrDocs(file: {
  server: string;
  blobHash?: string;
  chunks?: Array<{ hash: string; size?: number; server?: string }>;
  encryptionKey: string;
  type: string;
  name: string;
  cipher?: string;
  size?: number;
}) {
  const hash = file.blobHash ?? file.chunks?.[0]?.hash ?? "";
  const payload = {
    server: file.server,
    hash,
    chunks: file.chunks,
    cipher: file.cipher,
    size: file.size,
    encryptionKey: file.encryptionKey,
    type: file.type,
    name: file.name,
  };
  const jsonString = JSON.stringify(payload);
  const utf8Bytes = new TextEncoder().encode(jsonString);
  let binary = "";
  for (let i = 0; i < utf8Bytes.length; i++) {
    binary += String.fromCharCode(utf8Bytes[i]);
  }
  const encodedPayload = btoa(binary);
  const base = pagesBaseUrl();
  // Hash routing instead of query params to avoid exposing the secret key to the server logs
  const url = `${base}/#payload=${encodeURIComponent(encodedPayload)}`;
  window.open(url, "_blank", "noopener,noreferrer");
}

export function openInFormstrPages(_textContent?: string, setPagesHint?: (hint: string) => void) {
  if (setPagesHint) {
    setPagesHint("Opening Formstr Pages...");
  }
  const base = pagesBaseUrl();
  window.open(base, "_blank", "noopener,noreferrer");
}

export function openFileInPages(
  file: FileMetadata,
  options?: {
    textContent?: string | null;
    notify?: (hint: string) => void;
  }
): void {
  const notify = options?.notify ?? (() => {});

  const hash = file.blobHash ?? file.chunks?.[0]?.hash;
  if (file.server && hash && file.encryptionKey) {
    openInNostrDocs(file);
    notify("Opening document in Formstr Pages...");
    return;
  }

  // Fallback if missing blob metadata: open Formstr Pages
  notify("Opening Formstr Pages...");
  window.open("https://pages.formstr.app/", "_blank", "noopener,noreferrer");
}
