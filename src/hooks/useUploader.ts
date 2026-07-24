import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { FileMetadata } from "../types/metadata";
import { saveFileMetadata, buildSignedMetadataEvent } from "../services/fileIndex";
import { createAuthEvent, BACKGROUND_UPLOAD_AUTH_EXPIRATION_SECONDS } from "../auth";
import { generateSecretKey } from "nostr-tools";
import { bytesToHex } from "nostr-tools/utils";
import { uploadFile as chunkedUploadFile, prepareUpload } from "../services/uploadFile";
import { previewFile } from "../services/Preview/previewManager";
import {
  cancelNativeUpload,
  clearUploadNotification,
  ensureNotificationPermission,
  finishUploadNotification,
  showUploadNotification,
  stageNativeUploadChunk,
  startNativeUpload,
  startNativeUploadService,
  subscribeNativeUploadEvents,
} from "../native/driveManifest";
import { isAndroidPlatform } from "../utils/platform";
import { useToast } from "./useToast";
import { isAbortError } from "../utils/abortError";
import { APP_RELAYS } from "../utils/common";
import type { DriveTransferProgress, DriveTransferTask } from "@formstr/drive-sdk";
import { driveFileToMetadata, getDriveSdk } from "../services/driveSdk";

// Background (native) upload is temporarily DISABLED. Staging 50 MB chunks to
// native storage means shipping each as a ~67 MB base64 string across the
// Capacitor bridge, which OOMs/crashes the app on large files. Until this is
// reworked to avoid the base64 bridge (native file access + native encryption),
// Android uploads use the same bounded one-chunk SDK path as web (no bridge,
// no crash) — foreground-only, no background completion. All the native upload
// plumbing is left intact behind this flag so it can be re-enabled later.
const ENABLE_NATIVE_BACKGROUND_UPLOAD = false;

export interface UploadProgress {
  fileName: string;
  stage: string;
  progress?: number;
  currentChunk?: number;
  totalChunks?: number;
}

interface UseUploaderOptions {
  setFiles: Dispatch<SetStateAction<FileMetadata[]>>;
  setError: Dispatch<SetStateAction<string | null>>;
}

/**
 * Owns the SDK upload flow, the (currently disabled) native background
 * handoff, and the in-app progress state.
 * Extracted from FileIndexProvider to keep that provider focused on
 * index/state management. `uploadPreparedFile` is exposed so callers (e.g. the
 * pending-imports processor) can upload into an explicit folder.
 */
export function useUploader({ setFiles, setError }: UseUploaderOptions) {
  const toast = useToast();
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const sdkUploadTaskRef = useRef<DriveTransferTask<unknown> | null>(null);
  const nativeUploadIdRef = useRef<string | null>(null);

  /**
   * Prepares (encrypts + hashes chunks and preview) and stages a file for a
   * native background upload, then hands it off to DriveUploadService via
   * stageNativeUploadChunk/startNativeUpload. Both Nostr signatures (the
   * Blossom auth event and the file-metadata event) are produced here, in
   * the foreground, before any network I/O — the native side only ships
   * bytes and publishes an already-signed event, so it survives the app
   * being swiped away.
   */
  const uploadPreparedFileNative = useCallback(
    async (file: File, server: string, targetFolder: string, controller: AbortController): Promise<FileMetadata> => {
      const signal = controller.signal;
      const throwIfAborted = () => {
        if (signal.aborted) {
          throw new DOMException("Upload aborted", "AbortError");
        }
      };

      setUploadProgress({ fileName: file.name, stage: "Reading file...", progress: 0 });

      const previewPromise = previewFile(file).catch((e) => {
        console.warn("Background preview generation failed", e);
        return null;
      });

      const uploadId = crypto.randomUUID();
      const privateKeyHex = bytesToHex(generateSecretKey());

      // Start the foreground service now (PREPARING phase) so a persistent
      // notification is visible while we encrypt + stage, and register the id
      // before any staging so cancel/cleanup can find it.
      nativeUploadIdRef.current = uploadId;
      await startNativeUploadService(uploadId, file.name);

      // While staging (before startNativeUpload attaches its own listener), a
      // notification "Cancel" tapped mid-staging must also abort this JS loop.
      let prepareCancelListener = await subscribeNativeUploadEvents(uploadId, (event) => {
        if (event.type === "cancelled" || event.type === "error") {
          controller.abort();
        }
      });

      try {
        const preview = await previewPromise;
        throwIfAborted();

        // Encrypt + hash + stage each chunk one at a time; onBlob hands each
        // ciphertext blob straight to native storage and drops it, so peak
        // memory stays ~one chunk regardless of file size.
        const prepared = await prepareUpload(
          file,
          privateKeyHex,
          signal,
          (info) => setUploadProgress({ fileName: file.name, ...info }),
          preview,
          (index, bytes) => stageNativeUploadChunk(uploadId, index, bytes),
        );

        throwIfAborted();
      const combinedHashes = prepared.previewHash
        ? [...prepared.chunkHashes, prepared.previewHash]
        : prepared.chunkHashes;

      setUploadProgress({ fileName: file.name, stage: "Waiting for signature approval...", progress: 45 });
      const authHeader = await createAuthEvent(
        "upload",
        `Upload ${file.name}`,
        combinedHashes,
        BACKGROUND_UPLOAD_AUTH_EXPIRATION_SECONDS,
      );

      const metadata: FileMetadata = {
        name: file.name,
        hash: prepared.chunkHashes[0],
        size: file.size,
        type: file.type || "application/octet-stream",
        folder: targetFolder,
        uploadedAt: Date.now(),
        server,
        ...(prepared.previewHash ? { previewHash: prepared.previewHash } : {}),
        chunks: prepared.chunkHashes.map((hash) => ({ hash })),
        encryptionKey: privateKeyHex,
        encryptionAlgorithm: "aes-gcm",
      };

      const signedMetadataEvent = await buildSignedMetadataEvent(metadata);

      throwIfAborted();

      const chunkRefs = prepared.chunkRefs ?? [];
      const blobs: { path: string; hash: string; contentType: string }[] = chunkRefs.map((path, i) => ({
        path,
        hash: prepared.chunkHashes[i],
        contentType: "application/octet-stream",
      }));
      if (prepared.previewRef && prepared.previewHash) {
        blobs.push({ path: prepared.previewRef, hash: prepared.previewHash, contentType: "application/octet-stream" });
      }

      // Staging done + both events signed. The upload phase owns event
      // handling from here (its own listener + promise), so stop the
      // prepare-phase listener to avoid it aborting the shared controller on
      // a network-phase error (which would break the JS fallback).
      await prepareCancelListener?.remove();
      prepareCancelListener = null;

      setUploadProgress({ fileName: file.name, stage: "Uploading...", progress: 50 });

      await startNativeUpload(
        {
          uploadId,
          server,
          fileName: file.name,
          authHeader,
          metadataEventJson: JSON.stringify(signedMetadataEvent),
          blobs,
          relays: APP_RELAYS,
        },
        (event) => {
          if (event.type === "progress" && typeof event.percent === "number") {
            setUploadProgress({
              fileName: file.name,
              stage: "Uploading...",
              progress: 50 + Math.round(event.percent / 2),
            });
          }
        },
      );

      setUploadProgress({ fileName: file.name, stage: "Upload complete", progress: 100 });
      setFiles((prev) => [metadata, ...prev]);
      return metadata;
      } finally {
        await prepareCancelListener?.remove();
      }
    },
    [setFiles],
  );

  const uploadPreparedFile = useCallback(
    async (file: File, server: string, targetFolder: string): Promise<FileMetadata> => {
      setError(null);

      if (!isAndroidPlatform || !ENABLE_NATIVE_BACKGROUND_UPLOAD) {
        if (isAndroidPlatform) await ensureNotificationPermission();
        const uploadNotificationId = crypto.randomUUID();
        let lastNotificationPercent = -1;
        setUploadProgress({
          fileName: file.name,
          stage: "Generating preview...",
          progress: 0,
        });
        const preview = await previewFile(file).catch((previewError) => {
          console.warn("Preview generation failed", previewError);
          return null;
        });
        const sdk = await getDriveSdk(server);
        const task = sdk.upload(file, {
          folder: targetFolder,
          server,
          ...(preview ? { preview } : {}),
        });
        sdkUploadTaskRef.current = task;
        const unsubscribe = task.subscribe((progress) => {
          setUploadProgress(toUploadProgress(file.name, progress));
          if (isAndroidPlatform) {
            const percent = Math.floor(progress.percent ?? 0);
            if (percent !== lastNotificationPercent) {
              lastNotificationPercent = percent;
              void showUploadNotification(uploadNotificationId, file.name, percent);
            }
          }
        });

        try {
          const uploaded = driveFileToMetadata(await task.result);
          setFiles((previous) => [uploaded, ...previous]);
          if (isAndroidPlatform) {
            void finishUploadNotification(uploadNotificationId, file.name, true);
          }
          return uploaded;
        } catch (uploadError) {
          if (isAbortError(uploadError)) {
            if (isAndroidPlatform) void clearUploadNotification(uploadNotificationId);
            toast.info("Upload cancelled");
            throw uploadError;
          }
          const errorMessage =
            uploadError instanceof Error ? uploadError.message : "Upload failed";
          setError(errorMessage);
          if (isAndroidPlatform) {
            void finishUploadNotification(
              uploadNotificationId,
              file.name,
              false,
              errorMessage,
            );
          }
          toast.error(errorMessage, {
            action: {
              label: "Retry",
              onClick: () => {
                void (async () => {
                  sdkUploadTaskRef.current = task;
                  const unsubscribeRetry = task.subscribe((progress) => {
                    setUploadProgress(toUploadProgress(file.name, progress));
                  });
                  try {
                    const uploaded = driveFileToMetadata(await task.retry());
                    setFiles((previous) => [uploaded, ...previous]);
                    setError(null);
                    if (isAndroidPlatform) {
                      void finishUploadNotification(uploadNotificationId, file.name, true);
                    }
                  } catch (retryError) {
                    const retryMessage =
                      retryError instanceof Error
                        ? retryError.message
                        : "Upload retry failed";
                    setError(retryMessage);
                    if (isAndroidPlatform) {
                      void finishUploadNotification(
                        uploadNotificationId,
                        file.name,
                        false,
                        retryMessage,
                      );
                    }
                    toast.error(retryMessage);
                  } finally {
                    unsubscribeRetry();
                    if (sdkUploadTaskRef.current === task) {
                      sdkUploadTaskRef.current = null;
                    }
                    setUploadProgress(null);
                  }
                })();
              },
            },
          });
          throw uploadError;
        } finally {
          unsubscribe();
          if (sdkUploadTaskRef.current === task) sdkUploadTaskRef.current = null;
          setUploadProgress(null);
        }
      }

      const controller = new AbortController();
      uploadAbortRef.current = controller;
      const { signal } = controller;

      if (isAndroidPlatform && ENABLE_NATIVE_BACKGROUND_UPLOAD) {
        await ensureNotificationPermission();

        try {
          const metadata = await uploadPreparedFileNative(file, server, targetFolder, controller);
          setUploadProgress(null);
          uploadAbortRef.current = null;
          nativeUploadIdRef.current = null;
          return metadata;
        } catch (e) {
          // Tear down the foreground service if it's still in the PREPARING
          // phase (idempotent + a no-op once the worker owns the upload), so a
          // failed/aborted handoff never leaves a stuck "Preparing…" notification.
          const startedId = nativeUploadIdRef.current;
          if (startedId) {
            void cancelNativeUpload(startedId);
          }
          nativeUploadIdRef.current = null;
          if (isAbortError(e)) {
            setUploadProgress(null);
            uploadAbortRef.current = null;
            toast.info("Upload cancelled");
            throw e;
          }
          console.warn("[Upload] Native handoff failed, falling back to JS upload", e);
          // Fall through to the JS path below — uploads must not hard-break
          // just because native staging/start failed.
        }
      }

      // The JS upload path runs no foreground service, so drive a lightweight
      // Android notification directly (best-effort, no-op off Android).
      if (isAndroidPlatform) {
        await ensureNotificationPermission();
      }
      const uploadNotifId = crypto.randomUUID();
      let lastNotifPercent = -1;

      try {
        setUploadProgress({ fileName: file.name, stage: "Reading file...", progress: 0 });

        // Start generating preview immediately in the background
        const previewPromise = previewFile(file).catch((e) => {
          console.warn("Background preview generation failed", e);
          return null;
        });

        setUploadProgress({ fileName: file.name, stage: "Encrypting & Uploading...", progress: 0 });
        const privateKeyHex = bytesToHex(generateSecretKey());
        // The preview is passed into the uploader so it's covered by the same
        // upload auth as the file chunks — one signer prompt instead of two.
        const { hashes, previewHash } = await chunkedUploadFile(
          file,
          server,
          privateKeyHex,
          (info) => {
            setUploadProgress({ fileName: file.name, ...info });
            if (isAndroidPlatform) {
              const pct = Math.floor(info.progress ?? 0);
              if (pct !== lastNotifPercent) {
                lastNotifPercent = pct;
                void showUploadNotification(uploadNotifId, file.name, pct);
              }
            }
          },
          signal,
          previewPromise,
        );
        const hash = hashes[0];

        setUploadProgress({ fileName: file.name, stage: "Saving metadata...", progress: 98 });
        const metadata: FileMetadata = {
          name: file.name,
          hash,
          size: file.size,
          type: file.type || "application/octet-stream",
          folder: targetFolder,
          uploadedAt: Date.now(),
          server,
          ...(previewHash ? { previewHash } : {}),
          // Always record chunk hashes — even for a single chunk — so the download
          // path knows to use the raw-binary aesGcmDecryptBytes format that
          // aesGcmEncryptBytes produces. Files without this field (legacy uploads)
          // fall back to the base64-string decryptFileWithKey path.
          chunks: hashes.map((hash) => ({ hash })),
          encryptionKey: privateKeyHex,
          encryptionAlgorithm: "aes-gcm",
        };

        await saveFileMetadata(metadata);
        setFiles((prev) => [metadata, ...prev]);
        if (isAndroidPlatform) {
          void finishUploadNotification(uploadNotifId, file.name, true);
        }
        return metadata;
      } catch (e) {
        if (isAbortError(e)) {
          if (isAndroidPlatform) {
            void clearUploadNotification(uploadNotifId);
          }
          toast.info("Upload cancelled");
          throw e;
        }
        const errorMsg = e instanceof Error ? e.message : "Upload failed";
        if (isAndroidPlatform) {
          void finishUploadNotification(uploadNotifId, file.name, false, errorMsg);
        }
        setError(errorMsg);
        toast.error(errorMsg, {
          action: { label: "Retry", onClick: () => void uploadPreparedFile(file, server, targetFolder) },
        });
        throw e;
      } finally {
        setUploadProgress(null);
        uploadAbortRef.current = null;
      }
    },
    [toast, uploadPreparedFileNative, setFiles, setError],
  );

  const cancelUpload = useCallback(() => {
    void sdkUploadTaskRef.current?.cancel();
    uploadAbortRef.current?.abort();
    if (nativeUploadIdRef.current) {
      void cancelNativeUpload(nativeUploadIdRef.current);
    }
  }, []);

  return { uploadProgress, uploadPreparedFile, cancelUpload };
}

function toUploadProgress(
  fileName: string,
  progress: DriveTransferProgress,
): UploadProgress {
  const stages: Record<DriveTransferProgress["state"], string> = {
    queued: "Queued...",
    preparing: "Encrypting file...",
    "awaiting-signature": "Waiting for signature approval...",
    "publishing-metadata": "Publishing metadata...",
    "uploading-preview": "Uploading preview...",
    "uploading-chunks": "Uploading file...",
    downloading: "Downloading...",
    completed: "Upload complete",
    failed: "Upload failed",
    cancelled: "Upload cancelled",
  };
  return {
    fileName,
    stage: progress.message ?? stages[progress.state],
    progress: progress.percent,
    currentChunk: progress.currentChunk,
    totalChunks: progress.totalChunks,
  };
}
