import type { TransferItem } from "./transferStore";

/**
 * Whether an in-flight transfer keeps going if the app is closed. Android
 * downloads always run in a foreground service; an upload only earns that once
 * it hands off to the upload service (`survivesAppClose`) — before that it is
 * still encrypting in the WebView. On web nothing survives a close.
 *
 * Shared by the close warning and the transfer tray so they never disagree.
 */
export function transferSurvivesAppClose(t: TransferItem, isAndroid: boolean): boolean {
  return isAndroid && (t.type === "download" || t.survivesAppClose === true);
}

export interface UploadFooter {
  /** "info": safe to close. "warning": closing now would lose the upload. */
  tone: "info" | "warning";
  message: string;
}

/** Copy for the Android upload tray footer; null when no upload is active. */
export function getAndroidUploadFooter(active: TransferItem[]): UploadFooter | null {
  const uploads = active.filter((t) => t.type === "upload");
  if (uploads.length === 0) return null;

  const waiting = uploads.filter((t) => !t.survivesAppClose);
  if (waiting.length === 0) {
    return {
      tone: "info",
      message: "You can close the app — uploads continue in the background and you'll be notified.",
    };
  }
  return {
    tone: "warning",
    message: "Keep the app open until the upload moves to the background.",
  };
}
