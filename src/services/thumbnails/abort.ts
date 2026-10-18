/** Thrown (as the abort reason) when a time budget runs out. Not an AbortError. */
export class ThumbnailTimeout extends Error {
  constructor(ms: number) {
    super(`Timed out after ${ms}ms`);
    this.name = "ThumbnailTimeout";
  }
}

/** Promise that rejects with signal.reason as soon as it aborts, plus its cleanup. */
function rejectOnAbort(signal: AbortSignal): { promise: Promise<never>; dispose: () => void } {
  let dispose = () => {};
  const promise = new Promise<never>((_, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    dispose = () => signal.removeEventListener("abort", onAbort);
  });
  return { promise, dispose };
}

/**
 * The only abort/timeout race in the pipeline. Runs run() with a signal that
 * fires when the parent aborts OR the budget expires, and rejects the moment
 * either happens. The work itself should watch the signal to actually stop.
 */
export async function abortable<T>(
  run: (signal: AbortSignal) => Promise<T>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  const { signal: parent, timeoutMs } = options;
  parent?.throwIfAborted();

  const controller = new AbortController();
  const onParentAbort = () => controller.abort(parent!.reason);
  parent?.addEventListener("abort", onParentAbort, { once: true });
  const timer = timeoutMs ? setTimeout(() => controller.abort(new ThumbnailTimeout(timeoutMs)), timeoutMs) : undefined;
  const race = rejectOnAbort(controller.signal);

  try {
    return await Promise.race([run(controller.signal), race.promise]);
  } finally {
    clearTimeout(timer);
    race.dispose();
    parent?.removeEventListener("abort", onParentAbort);
  }
}
