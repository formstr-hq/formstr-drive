import { useCallback, useEffect, useRef } from "react";
import { drainMetadataOutbox } from "../services/metadataOutbox";

interface OutboxDrainOptions {
  isSignedIn: boolean;
  pubkey: string | undefined;
  restoring: boolean;
  /** Bumps when the relay worker can newly serve data it couldn't a moment ago
   *  — a good moment to retry a publish that may have failed on a dead relay. */
  relayRefresh: number;
}

/**
 * Drains metadata events that were signed (with the Drive Key — free, no signer
 * prompt) but never confirmed published: the app may have been killed between
 * chunkedUploadFile resolving and saveFileMetadata's publish call, or every
 * relay may have rate-limited the attempt.
 *
 * Retrying costs zero prompts, so this runs freely on mount, on reconnect, and
 * whenever the tab becomes visible again.
 */
export function useMetadataOutboxDrain({
  isSignedIn,
  pubkey,
  restoring,
  relayRefresh,
}: OutboxDrainOptions): void {
  const drainingRef = useRef(false);

  const drainOutbox = useCallback(async () => {
    if (drainingRef.current) return;
    drainingRef.current = true;
    try {
      const { published } = await drainMetadataOutbox();
      if (published > 0) {
        console.log(`[FileIndex] Drained ${published} queued metadata event(s)`);
      }
    } catch (e) {
      console.warn("[FileIndex] Metadata outbox drain failed", e);
    } finally {
      drainingRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (restoring || !isSignedIn || !pubkey) return;
    void drainOutbox();
  }, [isSignedIn, pubkey, restoring, relayRefresh, drainOutbox]);

  useEffect(() => {
    const handleVisible = () => {
      if (document.visibilityState === "visible" && isSignedIn && !restoring) {
        void drainOutbox();
      }
    };
    document.addEventListener("visibilitychange", handleVisible);
    return () => document.removeEventListener("visibilitychange", handleVisible);
  }, [isSignedIn, restoring, drainOutbox]);
}
