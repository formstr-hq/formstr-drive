import type { ShareResult, ShareSource } from "./types";

export function sourceEquals(a: ShareSource | null, b: ShareSource): boolean {
  if (!a || a.type !== b.type) return false;
  if (a.type === "file" && b.type === "file") return a.id === b.id;
  if (a.type === "folder" && b.type === "folder") return a.path === b.path;
  return false;
}

function shareRequestKey(source: ShareSource): string {
  return source.type === "file" ? `file:${source.id}` : `folder:${source.path}`;
}

const inFlightShareRequests = new Map<string, Promise<ShareResult>>();

/**
 * Runs `request` at most once at a time per source. Every caller that shows
 * up while one is already running (React StrictMode's double effect
 * invocation, a double click, two FileCard instances for the same file)
 * awaits the same in-flight promise instead of each independently seeing
 * "not shared yet" and publishing its own copy — see signerManager.init in
 * src/signer/manager.ts for the same pattern. The check-and-set below has no
 * `await` between them, so it's atomic against JS's single-threaded
 * interleaving regardless of which caller's async work resolves first.
 */
export function dedupeShareRequest(
  source: ShareSource,
  request: () => Promise<ShareResult>,
): Promise<ShareResult> {
  const key = shareRequestKey(source);
  const inFlight = inFlightShareRequests.get(key);
  if (inFlight) return inFlight;

  const attempt = request();
  inFlightShareRequests.set(key, attempt);
  void attempt.finally(() => {
    if (inFlightShareRequests.get(key) === attempt) inFlightShareRequests.delete(key);
  });
  return attempt;
}
