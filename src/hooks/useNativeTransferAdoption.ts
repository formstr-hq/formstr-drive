import { useEffect } from "react";
import { isAndroidPlatform } from "../utils/platform";
import {
  adoptActiveNativeDownloads,
  adoptActiveNativeUploads,
  startNativeEventBridge,
} from "../transfers/nativeAdoption";

/**
 * Android only: re-adopts native transfers that outlived the JS context (app
 * killed/relaunched mid-transfer) so they reappear as cancellable rows, and
 * keeps a single app-lifetime listener routing their progress/completion.
 */
export function useNativeTransferAdoption(): void {
  useEffect(() => {
    if (!isAndroidPlatform) return;

    let teardown: (() => void) | undefined;
    void startNativeEventBridge().then((fn) => {
      teardown = fn;
    });
    void adoptActiveNativeDownloads();
    void adoptActiveNativeUploads();

    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void adoptActiveNativeDownloads();
        void adoptActiveNativeUploads();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      teardown?.();
    };
  }, []);
}
