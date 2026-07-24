import type { PluginListenerHandle } from "@capacitor/core";
import { isAndroidPlatform } from "../utils/platform";
import {
  getActiveDownloads,
  subscribeNativeDownloadEvents,
  cancelNativeDownload,
  isNativeDownloadTracked,
} from "../native/driveManifest";
import { addTransfer, getTransfer, updateTransfer } from "./transferStore";
import { dismissTransfer } from "./transferQueue";

// Adopted native downloads (those started in a previous JS context that outlived
// it) are keyed under this prefix so they never collide with session downloads,
// which are keyed by file hash.
const ADOPTED_PREFIX = "native:";
const adoptedId = (nativeId: string) => `${ADOPTED_PREFIX}${nativeId}`;

/**
 * Re-adopts native downloads that are still running in the foreground service
 * but have no in-app row — e.g. the app was killed and relaunched mid-download.
 * Idempotent: a download already tracked by this session's queue, or already
 * adopted, is skipped. Without this, such a download is invisible and
 * uncancellable until it finishes.
 */
export async function adoptActiveNativeDownloads(): Promise<void> {
  if (!isAndroidPlatform) return;

  let active;
  try {
    active = await getActiveDownloads();
  } catch {
    return;
  }

  for (const d of active) {
    if (isNativeDownloadTracked(d.id)) continue; // driven by this session's queue
    if (getTransfer(adoptedId(d.id))) continue; // already adopted

    const controller = new AbortController();
    controller.signal.addEventListener(
      "abort",
      () => void cancelNativeDownload(d.id),
      { once: true },
    );

    addTransfer({
      id: adoptedId(d.id),
      type: "download",
      status: "running",
      progress: d.percent ?? 0,
      stage: "Downloading...",
      fileDetails: { name: d.fileName, size: 0, hash: "" },
      abortController: controller,
    });
  }
}

let bridgeHandle: PluginListenerHandle | null = null;

/**
 * Installs a single app-lifetime listener that routes native download events to
 * adopted rows (progress/complete/error/cancelled). Session downloads are driven
 * by the queue instead, so their events target rows keyed by hash and are no-ops
 * here (updateTransfer ignores unknown ids). Returns a teardown function.
 */
export async function startNativeEventBridge(): Promise<() => void> {
  if (!isAndroidPlatform || bridgeHandle) return () => {};

  bridgeHandle = await subscribeNativeDownloadEvents((event) => {
    const id = adoptedId(event.id);
    if (!getTransfer(id)) return; // not an adopted download

    if (event.type === "progress" && typeof event.percent === "number") {
      updateTransfer(id, { progress: event.percent, stage: "Downloading..." });
    } else if (event.type === "complete") {
      updateTransfer(id, {
        status: "completed",
        progress: 100,
        stage: "Completed",
        ...(event.uri ? { resultUri: event.uri } : {}),
      });
      setTimeout(() => dismissTransfer(id), 8000);
    } else if (event.type === "error") {
      updateTransfer(id, { status: "failed", stage: "Failed", error: event.message });
    } else if (event.type === "cancelled") {
      updateTransfer(id, { status: "cancelled", stage: "Cancelled" });
    }
  });

  return () => {
    void bridgeHandle?.remove();
    bridgeHandle = null;
  };
}
