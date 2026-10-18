import type { DecodeResponse } from "./decodeWorker";

/** The worker engine cannot decode this file; the caller should try the <video> engine. */
export class DecodeUnavailable extends Error {}

/** True when this context can run the WebCodecs worker engine at all. */
export function decodeEngineAvailable(): boolean {
  return (
    typeof Worker !== "undefined" && typeof VideoDecoder !== "undefined" && typeof OffscreenCanvas !== "undefined"
  );
}

/** Runs the WebCodecs worker for one file. Aborting terminates the worker, which stops all reads and decodes. */
export function decodeVideoThumbnail(file: File, signal: AbortSignal): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const worker = new Worker(new URL("./decodeWorker.ts", import.meta.url), { type: "module" });

    const settle = (fn: () => void) => {
      signal.removeEventListener("abort", onAbort);
      worker.terminate();
      fn();
    };
    const onAbort = () => settle(() => reject(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });

    worker.onmessage = (event: MessageEvent<DecodeResponse>) => {
      const message = event.data;
      if (message.type === "done") settle(() => resolve(new Uint8Array(message.bytes)));
      else if (message.type === "unsupported") settle(() => reject(new DecodeUnavailable(message.message)));
      else settle(() => reject(new Error(message.message)));
    };
    worker.onerror = (event) => settle(() => reject(new Error(event.message || "Video worker crashed")));
    worker.postMessage({ file });
  });
}
