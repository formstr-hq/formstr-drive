import type { PluginListenerHandle } from "@capacitor/core";
import { isAndroidPlatform } from "../utils/platform";
import {
  getActiveDownloads,
  getActiveUploads,
  subscribeNativeDownloadEvents,
  subscribeNativeUploadEvents,
  cancelNativeDownload,
  cancelNativeUpload,
  isNativeDownloadTracked,
  isNativeUploadTracked,
} from "../native/driveManifest";
import { addTransfer, getTransfer, updateTransfer } from "./transferStore";
import { dismissTransfer } from "./transferQueue";
import { PREPARE_PROGRESS_SHARE } from "./nativeUploadDriver";

/** Rescales a raw 0-100 network-phase percent (what the native service
 *  reports) onto the combined 0-100 bar a live session upload shows —
 *  same formula nativeUploadDriver.ts applies for its own progress events,
 *  kept in sync here so an adopted row doesn't jump to a different number
 *  than a live one would show at the same underlying progress. */
function toOverallPercent(rawNetworkPercent: number): number {
  return PREPARE_PROGRESS_SHARE + Math.round((rawNetworkPercent / 100) * (100 - PREPARE_PROGRESS_SHARE));
}

// Adopted native transfers (those started in a previous JS context that outlived
// it) are keyed under these prefixes so they never collide with session
// transfers, which are keyed by file hash / name+size+folder.
const ADOPTED_PREFIX = "native:";
const ADOPTED_UPLOAD_PREFIX = "native-upload:";
const adoptedId = (nativeId: string) => `${ADOPTED_PREFIX}${nativeId}`;
const adoptedUploadId = (nativeId: string) => `${ADOPTED_UPLOAD_PREFIX}${nativeId}`;

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

/**
 * Re-adopts native uploads still tracked by the foreground service but with no
 * in-app row — the upload counterpart of {@link adoptActiveNativeDownloads}.
 *
 * An upload in its PREPARING phase is a special case: staging runs in the
 * WebView, so if we're adopting it, the JS context that was doing that work is
 * gone and it can never finish. Those are adopted as failed (matching the
 * "Upload interrupted" notification the service posts) rather than shown as a
 * progress bar that will never move.
 */
export async function adoptActiveNativeUploads(): Promise<void> {
  if (!isAndroidPlatform) return;

  let active;
  try {
    active = await getActiveUploads();
  } catch {
    return;
  }

  for (const u of active) {
    if (isNativeUploadTracked(u.id)) continue; // driven by this session's queue
    if (getTransfer(adoptedUploadId(u.id))) continue; // already adopted

    const controller = new AbortController();
    controller.signal.addEventListener("abort", () => void cancelNativeUpload(u.id), {
      once: true,
    });

    addTransfer({
      id: adoptedUploadId(u.id),
      type: "upload",
      status: u.preparing ? "failed" : "running",
      progress: u.preparing ? 0 : toOverallPercent(u.percent),
      stage: u.preparing ? "Failed" : "Uploading...",
      // An adopted, non-preparing upload is already owned by the foreground
      // service — same reasoning as nativeUploadDriver.ts's post-handoff flag,
      // so the beforeunload guard doesn't warn about closing a tab that can't
      // actually lose this upload.
      ...(u.preparing
        ? { error: "Upload was interrupted before it finished preparing — please try again" }
        : { survivesAppClose: true }),
      fileDetails: { name: u.fileName, size: 0, hash: "" },
      abortController: controller,
    });
  }
}

let bridgeHandle: PluginListenerHandle | null = null;
let uploadBridgeHandle: PluginListenerHandle | null = null;

/**
 * Installs app-lifetime listeners that route native transfer events to adopted
 * rows (progress/complete/error/cancelled). Session transfers are driven by the
 * queue instead, so their events target differently-keyed rows and are no-ops
 * here (updateTransfer ignores unknown ids). Returns a teardown function.
 */
export async function startNativeEventBridge(): Promise<() => void> {
  if (!isAndroidPlatform || bridgeHandle) return () => {};

  uploadBridgeHandle = await subscribeNativeUploadEvents(undefined, (event) => {
    const id = adoptedUploadId(event.id);
    if (!getTransfer(id)) return; // not an adopted upload

    if (event.type === "progress" && typeof event.percent === "number") {
      updateTransfer(id, { progress: toOverallPercent(event.percent), stage: "Uploading..." });
    } else if (event.type === "complete") {
      updateTransfer(id, { status: "completed", progress: 100, stage: "Completed" });
      setTimeout(() => dismissTransfer(id), 8000);
    } else if (event.type === "error") {
      updateTransfer(id, { status: "failed", stage: "Failed", error: event.message });
    } else if (event.type === "cancelled") {
      updateTransfer(id, { status: "cancelled", stage: "Cancelled" });
    }
  });

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
    void uploadBridgeHandle?.remove();
    uploadBridgeHandle = null;
  };
}
