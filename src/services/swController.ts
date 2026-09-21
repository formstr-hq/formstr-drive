import { withTimeout } from "../transfers/withTimeout";

/**
 * Waits for the self-hosted /sw.js service worker to be ready AND actively
 * controlling this page, resolving with the controller. Shared by both
 * streaming paths that talk to it — swStreamDownload.ts's full-file download
 * session and swMediaStream.ts's seekable-preview session — since both need
 * exactly this same two-stage wait before they can `postMessage` a session
 * start.
 *
 * `serviceWorker.ready` never resolves AND never rejects when no
 * registration exists (e.g. /sw.js failed to load in production) — the
 * outer timeout turns that into a rejection instead of a permanent hang.
 */
export async function waitForServiceWorkerController(
  unavailableMessage: string,
  notActiveMessage: string,
): Promise<ServiceWorker> {
  await withTimeout(navigator.serviceWorker.ready, 3000, "sw-unavailable", unavailableMessage);

  const existing = navigator.serviceWorker.controller;
  if (existing) return existing;

  return new Promise<ServiceWorker>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(notActiveMessage)), 5000);
    const onControllerChange = () => {
      const controller = navigator.serviceWorker.controller;
      if (controller) {
        clearTimeout(timeout);
        navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
        resolve(controller);
      }
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
  });
}
