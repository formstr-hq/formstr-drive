import {
  getTransfers,
  getTransfer,
  updateTransfer,
  removeTransfer,
  addTransfer,
} from "./transferStore";
import { downloadFileStreaming } from "../services/downloadFile";
import { downloadFileToDownloads, ensureNotificationPermission } from "../native/driveManifest";
import { isAndroidPlatform } from "../utils/platform";
import { isAbortError } from "../utils/abortError";
import type { FileMetadata } from "../types/metadata";
import { uploadDriver } from "./uploadDriver";

// Upload MUST stay at 1: each upload calls the Nostr signer (NIP-07 extension /
// Amber), which cannot service concurrent approval prompts — two parallel
// uploads would race two prompts and one would be silently dropped. Do not
// raise this. Download 2 matches PREFETCH_CONCURRENCY so peak memory stays
// bounded at ~4 chunks.
const CONCURRENCY = {
  upload: 1,
  download: 2,
} as const;

export type TransferOutcome = "completed" | "failed" | "cancelled";

export interface UploadCallbacks {
  // Fired once, only on a confirmed successful upload. Used by the Android
  // pending-import flow to delete the on-device import ONLY after success.
  onComplete?: (metadata: FileMetadata) => void;
  onSettled?: (outcome: TransferOutcome, error?: unknown) => void;
}

interface DownloadJob {
  kind: "download";
  file: FileMetadata;
}

interface UploadJob {
  kind: "upload";
  file: File;
  server: string;
  targetFolder: string;
  callbacks?: UploadCallbacks;
}

type Job = DownloadJob | UploadJob;

// Runtime-only job data (File objects, callbacks) kept out of the display store.
const jobs = new Map<string, Job>();

// Listeners notified when any upload completes successfully, so the file index
// can insert the new file optimistically instead of waiting on the relay tail.
const uploadCompleteListeners = new Set<(metadata: FileMetadata) => void>();
export function onUploadComplete(fn: (metadata: FileMetadata) => void): () => void {
  uploadCompleteListeners.add(fn);
  return () => uploadCompleteListeners.delete(fn);
}

let processTimer: ReturnType<typeof setTimeout> | null = null;

export function triggerQueueProcessing() {
  if (!processTimer) {
    processTimer = setTimeout(() => {
      processTimer = null;
      processQueue();
    }, 100);
  }
}

function processQueue() {
  const transfers = getTransfers();
  // Counters are incremented as we start transfers in this pass, so the
  // concurrency limits are actually enforced within a single drain (the old
  // code computed these once and never updated them, so every pending item
  // started at once).
  let runningUploads = transfers.filter((t) => t.type === "upload" && t.status === "running").length;
  let runningDownloads = transfers.filter((t) => t.type === "download" && t.status === "running").length;

  const pending = transfers.filter((t) => t.status === "pending");

  for (const t of pending) {
    if (t.type === "upload" && runningUploads < CONCURRENCY.upload) {
      runningUploads++;
      void startTransfer(t.id);
    } else if (t.type === "download" && runningDownloads < CONCURRENCY.download) {
      runningDownloads++;
      void startTransfer(t.id);
    }
  }
}

async function startTransfer(id: string) {
  const job = jobs.get(id);
  if (!job) return;

  updateTransfer(id, { status: "running" });

  try {
    if (job.kind === "download") {
      await runDownload(id, job);
      updateTransfer(id, { status: "completed", stage: "Completed", progress: 100 });
    } else {
      const metadata = await runUpload(id, job);
      updateTransfer(id, { status: "completed", stage: "Completed", progress: 100 });
      job.callbacks?.onComplete?.(metadata);
      job.callbacks?.onSettled?.("completed");
      uploadCompleteListeners.forEach((fn) => fn(metadata));
    }

    // Auto-clear completed rows after a short delay; failed/cancelled rows stay
    // visible until the user dismisses or retries them.
    scheduleRemoval(id, 8000);
  } catch (e) {
    if (isAbortError(e)) {
      updateTransfer(id, { status: "cancelled", stage: "Cancelled" });
      if (job.kind === "upload") job.callbacks?.onSettled?.("cancelled", e);
    } else {
      const message = e instanceof Error ? e.message : String(e);
      updateTransfer(id, { status: "failed", stage: "Failed", error: message });
      if (job.kind === "upload") job.callbacks?.onSettled?.("failed", e);
    }
  } finally {
    triggerQueueProcessing();
  }
}

const removalTimers = new Map<string, ReturnType<typeof setTimeout>>();
function scheduleRemoval(id: string, delayMs: number) {
  const existing = removalTimers.get(id);
  if (existing) clearTimeout(existing);
  removalTimers.set(
    id,
    setTimeout(() => {
      removalTimers.delete(id);
      jobs.delete(id);
      removeTransfer(id);
    }, delayMs),
  );
}

async function runDownload(id: string, job: DownloadJob) {
  const file = job.file;
  const item = getTransfer(id);
  const signal = item?.abortController.signal;

  const onProgress = (info: {
    progress?: number;
    stage?: string;
    currentChunk?: number;
    totalChunks?: number;
  }) => {
    updateTransfer(id, {
      progress: info.progress ?? 0,
      stage: info.stage,
      currentChunk: info.currentChunk,
      totalChunks: info.totalChunks,
    });
  };

  if (isAndroidPlatform) {
    await ensureNotificationPermission();
    updateTransfer(id, { progress: 0, stage: "Downloading..." });
    const result = await downloadFileToDownloads(
      file,
      (percent) => onProgress({ progress: percent, stage: "Downloading..." }),
      (cancelNative) => {
        // Route the transfer's AbortController (the × button) to the native
        // foreground-service cancel. If it was already aborted between enqueue
        // and start, cancel immediately.
        if (signal?.aborted) {
          cancelNative();
          return;
        }
        signal?.addEventListener("abort", cancelNative, { once: true });
      },
    );
    // Keep the content:// uri so the completed row can offer a "View" action.
    if (result?.uri) updateTransfer(id, { resultUri: result.uri });
  } else {
    await downloadFileStreaming(file, onProgress, signal);
  }
}

async function runUpload(id: string, job: UploadJob): Promise<FileMetadata> {
  const item = getTransfer(id);
  const signal = item?.abortController.signal ?? new AbortController().signal;

  const onProgress = (info: {
    progress?: number;
    stage?: string;
    currentChunk?: number;
    totalChunks?: number;
  }) => {
    updateTransfer(id, {
      progress: info.progress ?? 0,
      stage: info.stage,
      currentChunk: info.currentChunk,
      totalChunks: info.totalChunks,
    });
  };

  return uploadDriver(job.file, job.server, job.targetFolder, signal, onProgress);
}

// Removes a terminal (completed/failed/cancelled) entry so its id can be
// re-queued. Active entries are left alone, which is what dedupes an accidental
// double-click or a pending-import re-scan while an upload is still in flight.
function resetIfTerminal(id: string): boolean {
  const existing = getTransfer(id);
  if (!existing) return true;
  if (existing.status === "completed" || existing.status === "failed" || existing.status === "cancelled") {
    const timer = removalTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      removalTimers.delete(id);
    }
    jobs.delete(id);
    removeTransfer(id);
    return true;
  }
  // Still active — caller should not start a duplicate.
  return false;
}

/** Retry a failed or cancelled transfer, reusing its original job (the File /
 *  FileMetadata is still held in the jobs map). */
export function retryTransfer(id: string): boolean {
  const item = getTransfer(id);
  const job = jobs.get(id);
  if (!item || !job) return false;
  if (item.status !== "failed" && item.status !== "cancelled") return false;

  const timer = removalTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    removalTimers.delete(id);
  }

  updateTransfer(id, {
    status: "pending",
    progress: 0,
    stage: undefined,
    error: undefined,
    currentChunk: undefined,
    totalChunks: undefined,
    // Fresh controller: the old one was already aborted/consumed.
    abortController: new AbortController(),
  });
  triggerQueueProcessing();
  return true;
}

/** Remove a terminal transfer's row without retrying (user dismiss / clear). */
export function dismissTransfer(id: string) {
  const timer = removalTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    removalTimers.delete(id);
  }
  jobs.delete(id);
  removeTransfer(id);
}

/** Enqueue a download. Returns true if it was accepted, false if an identical
 *  transfer is already active (deduped). */
export function queueDownload(file: FileMetadata): boolean {
  const id = file.id;
  if (!resetIfTerminal(id)) return false;

  jobs.set(id, { kind: "download", file });
  addTransfer({
    id,
    type: "download",
    status: "pending",
    progress: 0,
    fileDetails: { name: file.name, size: file.size, hash: file.id, server: file.server },
    abortController: new AbortController(),
  });
  triggerQueueProcessing();
  return true;
}

/** Enqueue an upload. Returns true if accepted, false if an identical transfer
 *  is already active (deduped). The id includes the target folder so the same
 *  file can be uploaded to two folders. */
export function queueUpload(
  file: File,
  server: string,
  targetFolder: string,
  callbacks?: UploadCallbacks,
): boolean {
  const id = `${file.name}:${file.size}:${file.lastModified}:${targetFolder}`;
  if (!resetIfTerminal(id)) return false;

  jobs.set(id, { kind: "upload", file, server, targetFolder, callbacks });
  addTransfer({
    id,
    type: "upload",
    status: "pending",
    progress: 0,
    fileDetails: { name: file.name, size: file.size, hash: "", server },
    abortController: new AbortController(),
  });
  triggerQueueProcessing();
  return true;
}
