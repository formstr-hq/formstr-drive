export function canOpenInNostrDocs(file: { type: string; name: string; chunks?: string[] }): boolean {
  if (file.chunks && file.chunks.length > 0) {
    return false; // chunked payloads are not supported by the current Nostr Docs app
  }

  const normalizedType = file.type.toLowerCase();
  const lowerName = file.name.toLowerCase();

  if (
    normalizedType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    normalizedType === "application/msword" ||
    normalizedType === "application/vnd.oasis.opendocument.text"
  ) {
    return true;
  }

  return lowerName.endsWith(".docx") || lowerName.endsWith(".doc") || lowerName.endsWith(".odt");
}

export function openInNostrDocs(file: { server: string; hash: string; encryptionKey: string; type: string; name: string }) {
  const payload = {
    server: file.server,
    hash: file.hash,
    encryptionKey: file.encryptionKey,
    type: file.type,
    name: file.name,
  };
  const encodedPayload = btoa(JSON.stringify(payload));
  // Hash routing instead of query params to avoid exposing the secret key to the server logs
  const url = `https://pages.formstr.app/#payload=${encodeURIComponent(encodedPayload)}`;
  window.open(url, "_blank", "noopener,noreferrer");
}

export async function openInFormstrPages(textContent: string, setPagesHint: (hint: string) => void) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(textContent);
      setPagesHint("Document copied. Paste into Formstr Pages.");
    } else {
      setPagesHint("Opened Formstr Pages. Copy/paste is not available in this browser.");
    }
  } catch {
    setPagesHint("Opened Formstr Pages. Clipboard permission was not granted.");
  } finally {
    window.open("https://pages.formstr.app/", "_blank", "noopener,noreferrer");
  }
}
