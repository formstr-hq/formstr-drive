import { generateSecretKey } from "nostr-tools";
import { bytesToHex } from "nostr-tools/utils";
import { generateFileId, type FileMetadata } from "../types/metadata";
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
  servers: string[],
  targetFolder: string,
  signal: AbortSignal,
  onProgress: (info: any) => void
): Promise<FileMetadata> {
  // The primary/display server — what shows up as `metadata.server`. The rest
  // of `servers` are fallback candidates only used if a chunk's PUT fails on
  // this one after retries (see uploadFile.ts's uploadChunkWithRetry).
  const server = servers[0];
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

    // Only the very first tick before uploadFile()'s own stage reporting takes
    // over ("Encrypting...", "Uploading...", "Connecting...", "Retrying...",
    // etc. — see src/services/uploadFile.ts). A single merged label here used
    // to be the *only* label shown for the network phase, which is why a
    // stalled connection (CORS block, dropped socket) looked identical to
    // ongoing encryption for the whole retry cascade.
    onProgress({ stage: "Encrypting...", progress: 0 });
    const privateKeyHex = bytesToHex(generateSecretKey());

    const { hashes, previewHash, chunkServers, unencryptedFileHash } = await chunkedUploadFile(
      file,
      servers,
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
      id: generateFileId(),
      unencryptedFileHash,
      size: file.size,
      type: file.type || "application/octet-stream",
      folder: targetFolder,
      uploadedAt: Date.now(),
      server,
      ...(previewHash ? { previewHash } : {}),
      // A fallback server is recorded per chunk only when that chunk actually
      // landed somewhere other than the primary — the common case keeps the
      // original `{ hash }`-only shape.
      chunks: hashes.map((h: string, i: number) =>
        chunkServers?.[i] ? { hash: h, server: chunkServers[i] } : { hash: h },
      ),
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
