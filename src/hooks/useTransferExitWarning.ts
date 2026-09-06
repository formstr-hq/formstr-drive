import { useEffect } from "react";
import { getTransfers } from "../transfers/transferStore";
import { isAndroidPlatform } from "../utils/platform";

/**
 * Warns before the tab/window closes while transfers are still in flight and
 * would be lost.
 *
 * On Android a download always runs in a foreground service and survives; an
 * upload survives only once it has handed off to the upload service
 * (`survivesAppClose`) — before that it's still encrypting in the WebView and
 * dies with it. On web nothing survives a close, so any active transfer warns.
 */
export function useTransferExitWarning(): void {
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      const active = getTransfers().filter(
        (t) => t.status === "running" || t.status === "pending",
      );
      if (active.length === 0) return;
      const allSurvive = active.every(
        (t) =>
          isAndroidPlatform && (t.type === "download" || t.survivesAppClose === true),
      );
      if (allSurvive) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, []);
}
