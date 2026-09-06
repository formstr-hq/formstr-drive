import { useEffect } from "react";
import type { FileMetadata } from "../types/metadata";
import {
  clearNativeDriveManifest,
  syncNativeDriveManifest,
} from "../native/driveManifest";

interface NativeManifestSyncOptions {
  files: FileMetadata[];
  customFolders: string[];
  isSignedIn: boolean;
  pubkey: string | undefined;
  restoring: boolean;
  settingsLoaded: boolean;
  /** True only once the file index is fully trustworthy (driveStatus ===
   *  "ready" in FileIndexProvider) — gating on this, not just the Drive Key
   *  resolving, means publishing a partial or wrongly-empty file list can
   *  never make the Files app briefly show a half-empty (or falsely empty)
   *  drive. */
  indexReady: boolean;
}

/**
 * Keeps the Android Files-app manifest in step with the drive: publishes the
 * current file/folder set once the index has fully hydrated, and clears it on
 * sign-out so a signed-out device doesn't keep exposing the previous account's
 * files through the system file picker.
 */
export function useNativeManifestSync({
  files,
  customFolders,
  isSignedIn,
  pubkey,
  restoring,
  settingsLoaded,
  indexReady,
}: NativeManifestSyncOptions): void {
  useEffect(() => {
    if (restoring) {
      return;
    }

    if (!isSignedIn || !pubkey) {
      void clearNativeDriveManifest().catch((manifestError) => {
        console.error("Failed to clear Android Drive manifest", manifestError);
      });
    }
  }, [isSignedIn, pubkey, restoring]);

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

    void syncNativeDriveManifest(files, customFolders).catch((manifestError) => {
      console.error("Failed to sync Android Drive manifest", manifestError);
    });
  }, [
    customFolders,
    files,
    isSignedIn,
    indexReady,
    pubkey,
    restoring,
    settingsLoaded,
  ]);
}
