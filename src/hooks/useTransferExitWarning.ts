import { useEffect } from "react";
import { getTransfers } from "../transfers/transferStore";
import { isAndroidPlatform } from "../utils/platform";

/**
 * Warns before the tab/window closes while transfers are still in flight and
 * would be lost.
 *
 * A native download runs in a foreground service and survives, so it needs no
 * warning; a native upload runs in the webview (background upload is
 * disabled) and DOES die — so the rule is: warn unless every active transfer
 * is a native download. On web nothing survives a close, so any active
 * transfer warns.
 */
export function useTransferExitWarning(): void {
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      const active = getTransfers().filter(
        (t) => t.status === "running" || t.status === "pending",
      );
      if (active.length === 0) return;
      const allSurvive = active.every((t) => t.type === "download" && isAndroidPlatform);
      if (allSurvive) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, []);
}
