export function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + " GB";
}

export function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString();
}

/** Same as {@link formatDate}, but for a unix-SECONDS timestamp (e.g. a
 *  Nostr event's `created_at`) rather than the millisecond timestamps
 *  `formatDate` expects everywhere else in the app. */
export function formatUnixSeconds(seconds: number): string {
  return formatDate(seconds * 1000);
}

export function getHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
