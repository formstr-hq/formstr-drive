import { generateSecretKey } from "nostr-tools";
import { bytesToHex } from "nostr-tools/utils";
import type { FileMetadata } from "../types/metadata";
import { uploadFile as chunkedUploadFile } from "../services/uploadFile";
import { previewFile } from "../services/Preview/previewManager";
import { saveFileMetadata } from "../services/fileIndex";
import { isAndroidPlatform } from "../utils/platform";
import { isAbortError } from "../utils/abortError";
import {
  showUploadNotification,
  finishUploadNotification,
  clearUploadNotification,
  ensureNotificationPermission,
} from "../native/driveManifest";

export async function uploadDriver(
  file: File,
  server: string,
  targetFolder: string,
  signal: AbortSignal,
  onProgress: (info: any) => void
): Promise<FileMetadata> {
  const uploadNotifId = crypto.randomUUID();
  let lastNotifPercent = -1;

  if (isAndroidPlatform) {
    await ensureNotificationPermission();
  }

  try {
    onProgress({ stage: "Reading file...", progress: 0 });

    const previewPromise = previewFile(file).catch((e: any) => {
      console.warn("Background preview generation failed", e);
      return null;
    });

    onProgress({ stage: "Encrypting & Uploading...", progress: 0 });
    const privateKeyHex = bytesToHex(generateSecretKey());

    const { hashes, previewHash } = await chunkedUploadFile(
      file,
      server,
      privateKeyHex,
      (info: any) => {
        onProgress(info);
        if (isAndroidPlatform) {
          const pct = Math.floor(info.progress ?? 0);
          if (pct !== lastNotifPercent) {
            lastNotifPercent = pct;
            void showUploadNotification(uploadNotifId, file.name, pct);
          }
        }
      },
      signal,
      previewPromise
    );

    onProgress({ stage: "Saving metadata...", progress: 98 });
    const metadata: FileMetadata = {
      name: file.name,
      hash: hashes[0],
      size: file.size,
      type: file.type || "application/octet-stream",
      folder: targetFolder,
      uploadedAt: Date.now(),
      server,
      ...(previewHash ? { previewHash } : {}),
      chunks: hashes.map((h: string) => ({ hash: h })),
      encryptionKey: privateKeyHex,
      encryptionAlgorithm: "aes-gcm",
    };

    const publishResult = await saveFileMetadata(metadata);
    if (publishResult.accepted < publishResult.total) {
      console.warn(`[Upload] Metadata saved to ${publishResult.accepted}/${publishResult.total} relays`);
    }

    if (isAndroidPlatform) {
      void finishUploadNotification(uploadNotifId, file.name, true);
    }

    return metadata;
  } catch (e: any) {
    if (isAndroidPlatform) {
      if (isAbortError(e)) {
        void clearUploadNotification(uploadNotifId);
      } else {
        void finishUploadNotification(uploadNotifId, file.name, false, e.message);
      }
    }
    throw e;
  }
}
