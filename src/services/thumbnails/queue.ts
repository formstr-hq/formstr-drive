// Thumbnails are generated one at a time. Several uploads queued together would
// otherwise run several video decodes or document layouts at once, on top of the
// encryption each upload is already doing.

let tail: Promise<unknown> = Promise.resolve();

/** Runs task after every earlier task has finished. Skipped if signal aborted while waiting. */
export function enqueue<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const run = async () => {
    signal?.throwIfAborted();
    return task();
  };
  const result = tail.then(run, run);
  tail = result.catch(() => {});
  return result;
}
