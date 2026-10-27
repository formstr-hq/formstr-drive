import { useCallback, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useProfileContext } from "./useProfileContext";
import { useToast } from "./useToast";
import { AccountLockPrompt } from "../components/SignIn/AccountLockPrompt";
import type { LockInfo, LockReason } from "../signer/types";
import "../components/SignIn/SignIn.css";

interface Pending extends Partial<LockInfo> {
  pubkey: string;
  reason: LockReason;
}

/**
 * Switches accounts all or nothing. Most switches just happen. When the account
 * you picked needs something first (its passphrase, the extension on the right
 * key, a reachable signer) a full-screen prompt asks for it on an opaque
 * backdrop — nothing of the current drive shows behind it — and Cancel leaves
 * you on the account you were on.
 */
export function useAccountSwitcher(): { switchTo: (pubkey: string) => Promise<void>; dialog: ReactNode } {
  const { switchAccount, unlockAndSwitch } = useProfileContext();
  const toast = useToast();
  const [pending, setPending] = useState<Pending | null>(null);

  const switchTo = useCallback(
    async (pubkey: string) => {
      try {
        const result = await switchAccount(pubkey);
        if (!result.ok) {
          setPending({ pubkey, reason: result.need, extensionPubkey: result.extensionPubkey });
        }
      } catch (e) {
        toast.error(e instanceof Error && e.message ? e.message : "Couldn't switch account");
      }
    },
    [switchAccount, toast],
  );

  const dialog = pending
    ? createPortal(
        <div className="switch-account-overlay">
          <div className="sign-in-container">
            <AccountLockPrompt
              key={pending.reason}
              pubkey={pending.pubkey}
              reason={pending.reason}
              extensionPubkey={pending.extensionPubkey}
              onPassphrase={async (passphrase) => {
                await unlockAndSwitch(pending.pubkey, passphrase);
                setPending(null);
              }}
              onRetry={async () => {
                const result = await switchAccount(pending.pubkey);
                if (result.ok) setPending(null);
                else setPending({ pubkey: pending.pubkey, reason: result.need, extensionPubkey: result.extensionPubkey });
              }}
            >
              <button type="button" className="sign-in-link-btn" onClick={() => setPending(null)}>
                Cancel
              </button>
            </AccountLockPrompt>
          </div>
        </div>,
        document.body,
      )
    : null;

  return { switchTo, dialog };
}
