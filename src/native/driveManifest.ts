import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { resolveChunks, type ChunkRef, type FileMetadata } from "../types/metadata";
import { isAndroidPlatform } from "../utils/platform";

export interface NativeDownloadStartedEvent {
  id: string;
  /** Echoed back verbatim from the `downloadToDownloads` call that started
   *  this download — see the correlation note above pendingDownloadsById. */
  correlationId: string;
}

export interface NativeDownloadEvent {
  id: string;
  type: "progress" | "complete" | "error" | "cancelled";
  percent?: number;
  uri?: string;
  message?: string;
}

export interface NativeUploadEvent {
  id: string;
  type: "progress" | "complete" | "error" | "cancelled";
  percent?: number;
  message?: string;
  /** On `complete`: the Blossom server the blobs actually landed on, which may
   *  be a fallback candidate rather than the primary. */
  server?: string;
  /** On `error`: the server's HTTP status, when the failure was an actual
   *  rejection rather than a network-level or relay-publish failure. Lets
   *  callers run the failure through the same classifyUploadFailure() the web
   *  driver uses (src/services/uploadErrors.ts) instead of guessing from
   *  message text — see DriveUploadWorker.Listener.onError on the native side. */
  status?: number;
}

export interface NativeActiveDownload {
  id: string;
  fileName: string;
  percent: number;
}

export interface NativeActiveUpload {
  id: string;
  fileName: string;
  percent: number;
  /** True while JS is still encrypting/staging — such an upload cannot survive
   *  the app being killed, so it is adopted as failed rather than running. */
  preparing: boolean;
}

export interface NativeUploadBlob {
  path: string;
  hash: string;
  contentType?: string;
  /** Best-effort blob (the preview): a failure skips it instead of failing the
   *  upload or forcing a fallback to another server. */
  optional?: boolean;
}

/**
 * One pre-signed kind-34578 metadata event, paired with the Blossom server its
 * `server` field names. The worker publishes exactly the event matching the
 * server the blobs actually landed on — that's what lets a background upload
 * fall back to another server without needing a signer to re-sign metadata.
 */
export interface NativeUploadMetadataEvent {
  server: string;
  eventJson: string;
}

type DriveFilesPlugin = {
  updateManifest(options: { manifestJson: string }): Promise<void>;
  clearManifest(): Promise<void>;
  listPendingImports(): Promise<{ imports: NativePendingImportEntry[] }>;
  readPendingImport(options: { id: string }): Promise<{
    id: string;
    name: string;
    mimeType: string;
    size: number;
    folderPath: string;
    base64: string;
  }>;
  removePendingImport(options: { id: string }): Promise<void>;
  saveToDownloads(options: { base64: string; fileName: string; mimeType: string }): Promise<{ uri: string }>;
  downloadToDownloads(options: {
    server: string;
    /** NIP-FS single-blob file: present together, absent on legacy files
     *  (which carry `chunks` instead — see types/metadata.ts's
     *  isLegacyBlobFormat). */
    blobHash?: string;
    chunkSize?: number;
    chunks?: ChunkRef[];
    correlationId: string;
    encryptionKey: string;
    unencryptedFileHash?: string;
    fileName: string;
    mimeType: string;
    size: number;
  }): Promise<{ uri: string }>;
  cancelDownload(options: { id: string }): Promise<void>;
  getActiveDownloads(): Promise<{ downloads: NativeActiveDownload[] }>;
  openFile(options: { uri: string; mimeType: string }): Promise<void>;
  requestNotificationPermission(): Promise<{ granted: boolean }>;
  startUploadService(options: { uploadId: string; fileName: string }): Promise<void>;
  stageUploadChunk(options: {
    uploadId: string;
    index: number;
    base64: string;
    append?: boolean;
  }): Promise<{ path: string }>;
  startNativeUpload(options: {
    uploadId: string;
    servers: string[];
    fileName: string;
    authHeader: string;
    metadataEvents: NativeUploadMetadataEvent[];
    blobs: NativeUploadBlob[];
    relays: string[];
  }): Promise<{ server: string }>;
  getActiveUploads(): Promise<{ uploads: NativeActiveUpload[] }>;
  cancelNativeUpload(options: { uploadId: string }): Promise<void>;
  showUploadNotification(options: { id: string; fileName: string; percent: number }): Promise<void>;
  finishUploadNotification(options: { id: string; fileName: string; ok: boolean; message?: string }): Promise<void>;
  clearUploadNotification(options: { id: string }): Promise<void>;
  addListener(
    eventName: "downloadStarted",
    listenerFunc: (event: NativeDownloadStartedEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "downloadEvent",
    listenerFunc: (event: NativeDownloadEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "uploadEvent",
    listenerFunc: (event: NativeUploadEvent) => void,
  ): Promise<PluginListenerHandle>;
};

export const ROOT_DOCUMENT_ID = "root";
const FOLDER_DOCUMENT_PREFIX = "folder:";
const FILE_DOCUMENT_PREFIX = "file:";

export interface NativeDriveFolderEntry {
  id: string;
  path: string;
  name: string;
  parentId: string;
}

export interface NativeDriveFileEntry {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  folderPath: string;
  parentId: string;
  uploadedAt: number;
  server: string;
  encryptionKey: string;
  previewHash?: string;
  unencryptedFileHash?: string;
  /** NIP-FS single-blob file: present together, absent on legacy files
   *  (which carry `chunks` instead — see types/metadata.ts's
   *  isLegacyBlobFormat). */
  blobHash?: string;
  chunkSize?: number;
  chunks?: ChunkRef[];
}

export interface NativeDriveManifest {
  version: 1;
  syncedAt: number;
  folders: NativeDriveFolderEntry[];
  files: NativeDriveFileEntry[];
}

export interface NativePendingImportEntry {
  id: string;
  documentId: string;
  name: string;
  mimeType: string;
  size: number;
  folderPath: string;
  parentId: string;
  createdAt: number;
}

const driveFilesPlugin = isAndroidPlatform
  ? registerPlugin<DriveFilesPlugin>("DriveFiles")
  : null;

export function normalizeFolderPath(path: string): string {
  // `folder: string` is only a TS-level promise (see FileMetadata's
  // isLegacyFile comment) — a real decrypted event predating this field, or
  // any malformed metadata, can pass `file.folder` through as undefined
  // despite the type. Every caller here goes through this one function, so
  // guarding here (rather than at each `normalizeFolderPath(file.folder)`
  // call site) means the next caller inherits the same safety for free.
  if (!path) return "/";
  const trimmed = path.trim();
  if (!trimmed || trimmed === "/") {
    return "/";
  }

  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const collapsed = withLeadingSlash.replace(/\/+/g, "/");
  return collapsed.length > 1 ? collapsed.replace(/\/$/, "") : collapsed;
}

function getParentFolderPath(path: string): string {
  const normalized = normalizeFolderPath(path);
  if (normalized === "/") {
    return ROOT_DOCUMENT_ID;
  }

  const lastSlashIndex = normalized.lastIndexOf("/");
  if (lastSlashIndex <= 0) {
    return ROOT_DOCUMENT_ID;
  }

  return normalized.slice(0, lastSlashIndex) || "/";
}

function getFolderName(path: string): string {
  const normalized = normalizeFolderPath(path);
  if (normalized === "/") {
    return "My Drive";
  }

  return normalized.split("/").filter(Boolean).at(-1) ?? normalized;
}

function toFolderDocumentId(path: string): string {
  return `${FOLDER_DOCUMENT_PREFIX}${normalizeFolderPath(path)}`;
}

function toFileDocumentId(hash: string): string {
  return `${FILE_DOCUMENT_PREFIX}${hash}`;
}

function deriveFolderPaths(files: FileMetadata[], customFolders: string[]): string[] {
  const folderPaths = new Set<string>();

  for (const folder of customFolders) {
    const normalized = normalizeFolderPath(folder);
    if (normalized === "/") {
      continue;
    }

    const parts = normalized.split("/").filter(Boolean);
    let currentPath = "";

    for (const part of parts) {
      currentPath += `/${part}`;
      folderPaths.add(currentPath);
    }
  }

  for (const file of files) {
    const normalized = normalizeFolderPath(file.folder);
    if (normalized === "/") {
      continue;
    }

    const parts = normalized.split("/").filter(Boolean);
    let currentPath = "";

    for (const part of parts) {
      currentPath += `/${part}`;
      folderPaths.add(currentPath);
    }
  }

  return Array.from(folderPaths).sort((left, right) => {
    const depthDiff =
      left.split("/").filter(Boolean).length - right.split("/").filter(Boolean).length;

    if (depthDiff !== 0) {
      return depthDiff;
    }

    return left.localeCompare(right);
  });
}

export function buildNativeDriveManifest(
  files: FileMetadata[],
  customFolders: string[],
): NativeDriveManifest {
  const folderPaths = deriveFolderPaths(files, customFolders);

  const folders: NativeDriveFolderEntry[] = folderPaths.map((path) => {
    const parentPath = getParentFolderPath(path);

    return {
      id: toFolderDocumentId(path),
      path,
      name: getFolderName(path),
      parentId:
        parentPath === ROOT_DOCUMENT_ID
          ? ROOT_DOCUMENT_ID
          : toFolderDocumentId(parentPath),
    };
  });

  // Chunks are published with their resolved server, so the native side
  // (DriveFilesDocumentsProvider / DriveFileDownloader.java) fetches each one
  // from wherever it actually landed. That's what lets every file — including
  // ones whose chunks fell back to a different server mid-upload — appear in
  // the Files app; they used to be excluded here because native could only
  // address a single server per file.
  const driveFiles: NativeDriveFileEntry[] = files.map((file) => {
    const folderPath = normalizeFolderPath(file.folder);

    return {
      id: toFileDocumentId(file.id),
      name: file.name,
      mimeType: file.type || "application/octet-stream",
      size: file.size,
      folderPath,
      parentId:
        folderPath === "/" ? ROOT_DOCUMENT_ID : toFolderDocumentId(folderPath),
      uploadedAt: file.uploadedAt,
      server: file.server,
      encryptionKey: file.encryptionKey,
      ...(file.previewHash ? { previewHash: file.previewHash } : {}),
      ...(file.unencryptedFileHash ? { unencryptedFileHash: file.unencryptedFileHash } : {}),
      ...(file.blobHash && file.chunkSize
        ? { blobHash: file.blobHash, chunkSize: file.chunkSize }
        : {}),
      ...(file.chunks ? { chunks: resolveChunks(file.chunks, file.server) } : {}),
    };
  });

  return {
    version: 1,
    syncedAt: Date.now(),
    folders,
    files: driveFiles,
  };
}

export async function syncNativeDriveManifest(
  files: FileMetadata[],
  customFolders: string[],
): Promise<void> {
  if (!driveFilesPlugin) {
    return;
  }

  const manifest = buildNativeDriveManifest(files, customFolders);
  await driveFilesPlugin.updateManifest({
    manifestJson: JSON.stringify(manifest),
  });
}

export async function clearNativeDriveManifest(): Promise<void> {
  if (!driveFilesPlugin) {
    return;
  }

  await driveFilesPlugin.clearManifest();
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

export async function listPendingNativeImports(): Promise<NativePendingImportEntry[]> {
  if (!driveFilesPlugin) {
    return [];
  }

  const response = await driveFilesPlugin.listPendingImports();
  return response.imports ?? [];
}

export async function readPendingNativeImport(
  id: string,
): Promise<{
  id: string;
  name: string;
  mimeType: string;
  size: number;
  folderPath: string;
  bytes: Uint8Array;
} | null> {
  if (!driveFilesPlugin) {
    return null;
  }

  const response = await driveFilesPlugin.readPendingImport({ id });
  return {
    id: response.id,
    name: response.name,
    mimeType: response.mimeType,
    size: response.size,
    folderPath: response.folderPath,
    bytes: base64ToUint8Array(response.base64),
  };
}

export async function removePendingNativeImport(id: string): Promise<void> {
  if (!driveFilesPlugin) {
    return;
  }

  await driveFilesPlugin.removePendingImport({ id });
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export async function saveFileToDownloads(
  bytes: Uint8Array,
  fileName: string,
  mimeType: string,
): Promise<{ uri: string } | null> {
  if (isAndroidPlatform && driveFilesPlugin) {
    const base64 = uint8ArrayToBase64(bytes);
    const result = await driveFilesPlugin.saveToDownloads({ base64, fileName, mimeType });
    return result;
  }

  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeType }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
  return null;
}

interface DownloadCallbacks {
  onProgress?: (percent: number) => void;
  onStarted?: (cancel: () => void) => void;
  // The native download id (a random UUID) once `downloadStarted` has arrived.
  // Until then progress/cancel can't be routed, so the entry lives in
  // `pendingDownloadsByCorrelationId` under the token we minted up front.
  nativeId?: string;
}

// The native plugin generates its own random UUID per download and reports
// progress and completion under that id, which the caller can't know at call
// time. So each call mints a correlation token, registers its callbacks under
// it, and the native side echoes the token back on `downloadStarted` alongside
// the id it chose — at which point the entry is re-keyed to that id.
const pendingDownloadsByCorrelationId = new Map<string, DownloadCallbacks>();
const activeDownloadsById = new Map<string, DownloadCallbacks>();
let nativeListenersInitialized = false;

async function ensureNativeListeners() {
  if (nativeListenersInitialized || !driveFilesPlugin) return;
  nativeListenersInitialized = true;

  await driveFilesPlugin.addListener("downloadStarted", (event) => {
    const callbacks = pendingDownloadsByCorrelationId.get(event.correlationId);
    if (!callbacks) return;
    pendingDownloadsByCorrelationId.delete(event.correlationId);
    callbacks.nativeId = event.id;
    activeDownloadsById.set(event.id, callbacks);
    callbacks.onStarted?.(() => {
      void driveFilesPlugin?.cancelDownload({ id: event.id });
    });
  });

  await driveFilesPlugin.addListener("downloadEvent", (event) => {
    const callbacks = activeDownloadsById.get(event.id);
    if (event.type === "progress" && typeof event.percent === "number") {
      callbacks?.onProgress?.(event.percent);
    }
  });
}

export async function downloadFileToDownloads(
  file: {
    server: string;
    /** NIP-FS single-blob file: present together, absent on legacy files. */
    blobHash?: string;
    chunkSize?: number;
    chunks?: ChunkRef[];
    encryptionKey: string;
    unencryptedFileHash?: string;
    name: string;
    type?: string;
    size: number;
  },
  onProgress?: (percent: number) => void,
  onStarted?: (cancel: () => void) => void,
): Promise<{ uri: string }> {
  if (!isAndroidPlatform || !driveFilesPlugin) {
    throw new Error("Native download is only available on Android");
  }
  const plugin = driveFilesPlugin;
  // Correlates this call to the `downloadStarted` event the plugin fires with
  // the id it generated. Per-call rather than per-file, so downloading the
  // same file twice concurrently doesn't collide on one map key.
  const correlationId = crypto.randomUUID();

  await ensureNativeListeners();

  const callbacks: DownloadCallbacks = { onProgress, onStarted };
  pendingDownloadsByCorrelationId.set(correlationId, callbacks);

  try {
    // No timeout here: downloadToDownloads resolves only when the *whole* file
    // finishes, so wrapping it in a fixed timeout would spuriously fail every
    // real download while the native foreground service kept running headless.
    return await plugin.downloadToDownloads({
      server: file.server,
      ...(file.blobHash && file.chunkSize
        ? { blobHash: file.blobHash, chunkSize: file.chunkSize }
        : {
            // Resolved per-chunk servers, so a chunk that fell back during
            // upload is fetched from where it actually lives (mirrors
            // resolveChunks usage in services/downloadFile.ts).
            chunks: resolveChunks(file.chunks, file.server),
          }),
      correlationId,
      encryptionKey: file.encryptionKey,
      ...(file.unencryptedFileHash ? { unencryptedFileHash: file.unencryptedFileHash } : {}),
      fileName: file.name,
      mimeType: file.type || "application/octet-stream",
      size: file.size,
    });
  } catch (e) {
    if ((e as { code?: string })?.code === "ABORT_ERR") {
      throw new DOMException("Download cancelled", "AbortError");
    }
    throw e;
  } finally {
    pendingDownloadsByCorrelationId.delete(correlationId);
    if (callbacks.nativeId) activeDownloadsById.delete(callbacks.nativeId);
  }
}

/**
 * True if a native download with this id is being driven by the current
 * session's queue (via downloadFileToDownloads). Adoption uses this to avoid
 * creating a duplicate row for a download it's already tracking.
 */
export function isNativeDownloadTracked(nativeId: string): boolean {
  return activeDownloadsById.has(nativeId);
}

export async function openDownloadedFile(uri: string, mimeType: string): Promise<void> {
  if (isAndroidPlatform && driveFilesPlugin) {
    await driveFilesPlugin.openFile({ uri, mimeType });
  }
}

/**
 * Prompts for POST_NOTIFICATIONS on the user's first transfer (Android 13+
 * only asks once — subsequent calls resolve instantly from cached state).
 * Callers should proceed with the transfer regardless of the result; a denial
 * just means the ongoing/completion notification won't show.
 */
export async function ensureNotificationPermission(): Promise<boolean> {
  if (!isAndroidPlatform || !driveFilesPlugin) {
    return true;
  }
  const { granted } = await driveFilesPlugin.requestNotificationPermission();
  return granted;
}

/**
 * Starts the upload foreground service in its PREPARING phase, so a persistent
 * notification appears immediately — while JS is still encrypting/staging —
 * rather than only once the network phase begins. No-op off Android.
 */
export async function startNativeUploadService(uploadId: string, fileName: string): Promise<void> {
  if (!isAndroidPlatform || !driveFilesPlugin) {
    return;
  }
  await driveFilesPlugin.startUploadService({ uploadId, fileName });
}

// Bridge messages are JSON strings, so a whole 50MB chunk would cross as a
// ~67MB base64 string — enough to spike (or OOM) a low-end device. Slices are
// sized to stay well under that while keeping the call count small; the slice
// length is a multiple of 3 so each piece encodes to unpadded base64 and the
// concatenation on the native side is byte-exact.
const STAGE_SLICE_BYTES = 3 * 1024 * 1024;

/**
 * Writes one pre-encrypted upload segment to app-private storage so the
 * native upload worker can PUT it without any JS/crypto involvement. Called
 * during the foreground prepare phase, one segment at a time, and streamed
 * in slices so peak memory stays bounded.
 *
 * NIP-FS concatenates every segment into a single blob, so a whole file's
 * worth of segments share one `index` (its destination) — the caller passes
 * `appendToPrevious: true` for every segment after the first at that index,
 * so each one's slices land after the previous segment's rather than
 * truncating it. The preview, which is its own separate blob, uses a
 * different `index` and the default `appendToPrevious: false`.
 */
export async function stageNativeUploadChunk(
  uploadId: string,
  index: number,
  bytes: Uint8Array,
  signal?: AbortSignal,
  appendToPrevious = false,
): Promise<string> {
  if (!isAndroidPlatform || !driveFilesPlugin) {
    throw new Error("Native upload staging is only available on Android");
  }

  let path = "";
  // A zero-length blob still needs one call, to create the (empty) file.
  for (let offset = 0; offset === 0 || offset < bytes.length; offset += STAGE_SLICE_BYTES) {
    if (signal?.aborted) {
      throw new DOMException("Upload aborted", "AbortError");
    }
    const slice = bytes.subarray(offset, Math.min(offset + STAGE_SLICE_BYTES, bytes.length));
    const result = await driveFilesPlugin.stageUploadChunk({
      uploadId,
      index,
      base64: uint8ArrayToBase64(slice),
      // The very first slice of the very first segment at this index
      // truncates, so a retry of the same upload never appends onto a
      // partial file left by a previous attempt. Every other slice —
      // whether continuing this segment or starting a later one at the same
      // index — appends.
      append: appendToPrevious || offset > 0,
    });
    path = result.path;
  }

  return path;
}

/**
 * Hands a fully-prepared upload (staged ciphertext blobs, a pre-signed
 * Blossom auth header, and one pre-signed metadata event per candidate server)
 * off to the native DriveUploadService, which PUTs the blobs and publishes the
 * matching metadata event with no signer/crypto involvement — so it can keep
 * running after the app is swiped away. Resolves when the native side reports
 * completion, rejects on error, and rejects with an AbortError-shaped
 * DOMException on cancel.
 */
export async function startNativeUpload(
  options: {
    uploadId: string;
    servers: string[];
    fileName: string;
    authHeader: string;
    metadataEvents: NativeUploadMetadataEvent[];
    blobs: NativeUploadBlob[];
    relays: string[];
  },
  onEvent?: (event: NativeUploadEvent) => void,
): Promise<{ server: string }> {
  if (!isAndroidPlatform || !driveFilesPlugin) {
    throw new Error("Native upload is only available on Android");
  }
  const plugin = driveFilesPlugin;

  let listener: PluginListenerHandle | null = null;
  trackedUploadIds.add(options.uploadId);
  try {
    if (onEvent) {
      listener = await plugin.addListener("uploadEvent", (event) => {
        if (event.id === options.uploadId) {
          onEvent(event);
        }
      });
    }
    return await plugin.startNativeUpload(options);
  } catch (e) {
    if ((e as { code?: string })?.code === "ABORT_ERR") {
      throw new DOMException("Upload cancelled", "AbortError");
    }
    throw e;
  } finally {
    trackedUploadIds.delete(options.uploadId);
    await listener?.remove();
  }
}

// Uploads whose network phase this JS context is awaiting. Adoption consults
// this so it never creates a duplicate row for an upload the queue already owns.
const trackedUploadIds = new Set<string>();

/**
 * True if a native upload with this id is being driven by the current session's
 * queue (via {@link startNativeUpload}).
 */
export function isNativeUploadTracked(uploadId: string): boolean {
  return trackedUploadIds.has(uploadId);
}

export async function cancelNativeUpload(uploadId: string): Promise<void> {
  if (!isAndroidPlatform || !driveFilesPlugin) {
    return;
  }
  await driveFilesPlugin.cancelNativeUpload({ uploadId });
}

/**
 * Lightweight, JS-driven upload notification for the in-app (OPFS) upload path,
 * which runs no foreground service. Best-effort and a no-op off Android.
 */
export async function showUploadNotification(id: string, fileName: string, percent: number): Promise<void> {
  if (!isAndroidPlatform || !driveFilesPlugin) {
    return;
  }
  await driveFilesPlugin.showUploadNotification({ id, fileName, percent });
}

export async function finishUploadNotification(
  id: string,
  fileName: string,
  ok: boolean,
  message?: string,
): Promise<void> {
  if (!isAndroidPlatform || !driveFilesPlugin) {
    return;
  }
  await driveFilesPlugin.finishUploadNotification({ id, fileName, ok, message });
}

export async function clearUploadNotification(id: string): Promise<void> {
  if (!isAndroidPlatform || !driveFilesPlugin) {
    return;
  }
  await driveFilesPlugin.clearUploadNotification({ id });
}

/**
 * Subscribes to native upload events, scoped to one uploadId or (with
 * `undefined`) to every in-flight upload.
 *
 * The scoped form is used during the PREPARING phase, before startNativeUpload
 * runs, so a notification "Cancel" tapped mid-staging can abort the JS
 * encrypt/stage loop too. The unscoped form backs the adoption bridge. Returns
 * null off Android; the caller must remove the handle.
 */
export async function subscribeNativeUploadEvents(
  uploadId: string | undefined,
  onEvent: (event: NativeUploadEvent) => void,
): Promise<PluginListenerHandle | null> {
  if (!isAndroidPlatform || !driveFilesPlugin) {
    return null;
  }
  return driveFilesPlugin.addListener("uploadEvent", (event) => {
    if (uploadId === undefined || event.id === uploadId) {
      onEvent(event);
    }
  });
}

/**
 * Downloads still running in the native foreground service — used to rehydrate
 * in-app progress after the app is reopened (the JS/React state is gone but the
 * service kept running). Returns an empty list off Android.
 */
export async function getActiveDownloads(): Promise<NativeActiveDownload[]> {
  if (!isAndroidPlatform || !driveFilesPlugin) {
    return [];
  }
  const { downloads } = await driveFilesPlugin.getActiveDownloads();
  return downloads;
}

/**
 * Uploads still tracked by the native foreground service — the upload-side
 * counterpart of {@link getActiveDownloads}, used to rehydrate in-app progress
 * after the app is reopened mid-upload. Returns an empty list off Android.
 */
export async function getActiveUploads(): Promise<NativeActiveUpload[]> {
  if (!isAndroidPlatform || !driveFilesPlugin) {
    return [];
  }
  const { uploads } = await driveFilesPlugin.getActiveUploads();
  return uploads;
}

/**
 * Subscribes to native download events across all in-flight downloads (unlike
 * downloadFileToDownloads, whose listeners are scoped to a single call). Used
 * to keep a rehydrated progress card live until the download finishes. Returns
 * null off Android; caller must remove the handle.
 */
export async function subscribeNativeDownloadEvents(
  onEvent: (event: NativeDownloadEvent) => void,
): Promise<PluginListenerHandle | null> {
  if (!isAndroidPlatform || !driveFilesPlugin) {
    return null;
  }
  return driveFilesPlugin.addListener("downloadEvent", (event) => onEvent(event));
}

export async function cancelNativeDownload(id: string): Promise<void> {
  if (!isAndroidPlatform || !driveFilesPlugin) {
    return;
  }
  await driveFilesPlugin.cancelDownload({ id });
}
