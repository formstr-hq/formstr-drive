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
  /** An account to remove once this switch has actually happened. */
  removeAfter?: string;
}

/**
 * Switches accounts all or nothing. Most switches just happen. When the account
 * you picked needs something first (its passphrase, the extension on the right
 * key, a reachable signer) a full-screen prompt asks for it on an opaque
 * backdrop — nothing of the current drive shows behind it — and Cancel leaves
 * you on the account you were on.
 *
 * `signOut` removes an account from this device. If it is the one you're on and
 * another account remains, it moves you to that account first - you only reach
 * the login screen when there is nobody left to be.
 */
export function useAccountSwitcher(): {
  switchTo: (pubkey: string, removeAfter?: string) => Promise<void>;
  signOut: (pubkey: string) => Promise<void>;
  dialog: ReactNode;
} {
  const { pubkey: activePubkey, accounts, switchAccount, unlockAndSwitch, removeAccount } = useProfileContext();
  const toast = useToast();
  const [pending, setPending] = useState<Pending | null>(null);

  const switchTo = useCallback(
    async (pubkey: string, removeAfter?: string) => {
      try {
        const result = await switchAccount(pubkey);
        if (result.ok) {
          if (removeAfter) await removeAccount(removeAfter);
        } else {
          setPending({ pubkey, reason: result.need, extensionPubkey: result.extensionPubkey, removeAfter });
        }
      } catch (e) {
        toast.error(e instanceof Error && e.message ? e.message : "Couldn't switch account");
      }
    },
    [switchAccount, removeAccount, toast],
  );

  const signOut = useCallback(
    async (pubkey: string) => {
      const next = pubkey === activePubkey ? accounts.find((account) => account.pubkey !== pubkey) : undefined;
      if (next) {
        await switchTo(next.pubkey, pubkey);
        return;
      }
      try {
        await removeAccount(pubkey);
      } catch (e) {
        toast.error(e instanceof Error && e.message ? e.message : "Couldn't remove account");
      }
    },
    [activePubkey, accounts, switchTo, removeAccount, toast],
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
                if (pending.removeAfter) await removeAccount(pending.removeAfter);
                setPending(null);
              }}
              onRetry={async () => {
                const result = await switchAccount(pending.pubkey);
                if (result.ok) {
                  if (pending.removeAfter) await removeAccount(pending.removeAfter);
                  setPending(null);
                } else {
                  setPending({ ...pending, reason: result.need, extensionPubkey: result.extensionPubkey });
                }
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

  return { switchTo, signOut, dialog };
}
