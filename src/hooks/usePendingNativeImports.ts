import { useCallback, useEffect, useRef } from "react";
import {
  listPendingNativeImports,
  readPendingNativeImport,
  removePendingNativeImport,
} from "../native/driveManifest";
import { queueUpload } from "../transfers/transferQueue";
import { getStoredItem, setStoredItem, STORAGE_KEYS } from "../utils/persistence";

interface PendingNativeImportsOptions {
  isSignedIn: boolean;
  pubkey: string | undefined;
  restoring: boolean;
  settingsLoaded: boolean;
  /** True only once the file index is fully trustworthy (driveStatus ===
   *  "ready" in FileIndexProvider). */
  indexReady: boolean;
  /** The chosen upload server; null until the user chooses one (imports wait). */
  selectedServer: string | null;
  onError: (message: string) => void;
}

/**
 * Picks up files handed to the app by the Android Files provider while it
 * wasn't running, and uploads them into the drive.
 *
 * At-least-once: the on-device pending import is deleted ONLY after its upload
 * confirms success. If the upload fails, is cancelled, or the app is killed
 * first, the import is retained and retried on the next launch. A still-running
 * upload with the same id dedupes, so re-scanning is always safe.
 */
export function usePendingNativeImports({
  isSignedIn,
  pubkey,
  restoring,
  settingsLoaded,
  indexReady,
  selectedServer,
  onError,
}: PendingNativeImportsOptions): void {
  const processingRef = useRef(false);

  const processPendingImports = useCallback(async () => {
    if (!isSignedIn || !pubkey || !indexReady || !selectedServer) {
      return;
    }

    if (processingRef.current) {
      return;
    }

    processingRef.current = true;
    try {
      const pendingImports = await listPendingNativeImports();

      // An import belongs to the account that first saw it. The native side
      // doesn't say who shared a file, so the account that's active when it is
      // first seen is the best answer - but from then on it is only ever
      // uploaded for THAT account, never into whichever one is active after a
      // switch. Entries for imports that are gone are pruned.
      const stored = await getStoredItem<unknown>(STORAGE_KEYS.PENDING_IMPORT_OWNERS, null);
      const owners: Record<string, string> =
        stored && typeof stored === "object" && !Array.isArray(stored)
          ? { ...(stored as Record<string, string>) }
          : {};
      const pendingIds = new Set(pendingImports.map((p) => p.id));
      let ownersChanged = false;
      for (const id of Object.keys(owners)) {
        if (!pendingIds.has(id)) {
          delete owners[id];
          ownersChanged = true;
        }
      }
      for (const { id } of pendingImports) {
        if (!owners[id]) {
          owners[id] = pubkey;
          ownersChanged = true;
        }
      }
      if (ownersChanged) await setStoredItem(STORAGE_KEYS.PENDING_IMPORT_OWNERS, owners);

      if (pendingImports.length === 0) {
        return;
      }

      for (const pendingImport of pendingImports) {
        if (owners[pendingImport.id] !== pubkey) continue; // someone else's import
        const importPayload = await readPendingNativeImport(pendingImport.id);
        if (!importPayload) {
          continue;
        }

        try {
          const importedFileBuffer = importPayload.bytes.buffer.slice(
            importPayload.bytes.byteOffset,
            importPayload.bytes.byteOffset + importPayload.bytes.byteLength,
          ) as ArrayBuffer;

          const importedFile = new File([importedFileBuffer], importPayload.name, {
            type: importPayload.mimeType || "application/octet-stream",
          });

          queueUpload(
            importedFile,
            selectedServer,
            importPayload.folderPath,
            [selectedServer],
            {
              onComplete: () => {
                void removePendingNativeImport(importPayload.id);
              },
            },
          );
        } catch (pendingError) {
          console.error("Failed to process pending Android Files import", pendingError);
          onError(
            pendingError instanceof Error
              ? pendingError.message
              : "Failed to import file saved from Android Files",
          );
          continue;
        }
      }
    } finally {
      processingRef.current = false;
    }
  }, [indexReady, isSignedIn, onError, pubkey, selectedServer]);

  useEffect(() => {
    if (
      restoring ||
      !settingsLoaded ||
      !isSignedIn ||
      !pubkey ||
      !indexReady
    ) {
      return;
    }

    void processPendingImports();
  }, [
    indexReady,
    isSignedIn,
    processPendingImports,
    pubkey,
    restoring,
    settingsLoaded,
  ]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (
        document.visibilityState === "visible" &&
        isSignedIn &&
        !restoring &&
        indexReady
      ) {
        void processPendingImports();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [indexReady, isSignedIn, processPendingImports, restoring]);
}
