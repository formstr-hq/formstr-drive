import { generateSecretKey } from "nostr-tools";
import { bytesToHex } from "nostr-tools/utils";
import { generateFileId, type FileMetadata } from "../types/metadata";
import { uploadFile as chunkedUploadFile, computePlaintextHash } from "../services/uploadFile";
import { previewFile } from "../services/Preview/previewManager";
import { saveFileMetadata, findDuplicateByHash } from "../services/fileIndex";
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
  const uploadNotifId = crypto.randomUUID();
  let lastNotifPercent = -1;

  if (isAndroidPlatform) {
    await ensureNotificationPermission();
  }

  try {
    onProgress({ stage: "Reading file...", progress: 0 });

    // NIP-FS client-level dedup: the encrypted blobHash is unique per upload
    // (fresh ephemeral key + nonces every time), so it can never catch a
    // re-upload of identical content — only the plaintext hash can. Checked
    // before kicking off preview generation so a duplicate never pays for
    // work whose result gets thrown away.
    onProgress({ stage: "Checking for duplicates...", progress: 0 });
    const plaintextHash = await computePlaintextHash(file, signal);
    const duplicate = findDuplicateByHash(plaintextHash);

    if (duplicate) {
      onProgress({ stage: "Saving metadata...", progress: 90 });
      // Reuses every storage field verbatim (blobHash/chunkSize or legacy
      // chunks, server(s), encryptionKey, previewHash) — it's the exact same
      // underlying blob, so nothing needs re-uploading, only a fresh
      // metadata event under this upload's own id/name/folder.
      const metadata: FileMetadata = {
        ...duplicate,
        id: generateFileId(),
        name: file.name,
        folder: targetFolder,
        uploadedAt: Date.now(),
      };

      const publishResult = await saveFileMetadata(metadata);
      if (publishResult.accepted < publishResult.total) {
        console.warn(`[Upload] Metadata saved to ${publishResult.accepted}/${publishResult.total} relays`);
      }

      onProgress({ stage: "Upload complete", progress: 100 });
      if (isAndroidPlatform) {
        void finishUploadNotification(uploadNotifId, file.name, true);
      }
      return metadata;
    }

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

    const { blobHash, chunkSize, previewHash, usedServer, unencryptedFileHash } = await chunkedUploadFile(
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
    // The server the blob actually landed on — the primary (servers[0])
    // unless it failed and a fallback candidate succeeded instead.
    const landedServer = usedServer ?? servers[0];
    const metadata: FileMetadata = {
      name: file.name,
      id: generateFileId(),
      unencryptedFileHash,
      size: file.size,
      type: file.type || "application/octet-stream",
      folder: targetFolder,
      uploadedAt: Date.now(),
      server: landedServer,
      servers: [landedServer],
      ...(previewHash ? { previewHash } : {}),
      blobHash,
      chunkSize,
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
