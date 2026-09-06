import { useEffect } from "react";
import { isAndroidPlatform } from "../utils/platform";
import { adoptActiveNativeDownloads, startNativeEventBridge } from "../transfers/nativeAdoption";

/**
 * Android only: re-adopts native downloads that outlived the JS context (app
 * killed/relaunched mid-download) so they reappear as cancellable rows, and
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

    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void adoptActiveNativeDownloads();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      teardown?.();
    };
  }, []);
}
