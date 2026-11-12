import { useProfileContext } from "../../hooks/useProfileContext";
import { useAccountSwitcher } from "../../hooks/useAccountSwitcher";
import { AccountLockPrompt } from "./AccountLockPrompt";
import { shortNpub } from "../../utils/npub";

/**
 * Shown on a cold start when the account you were last on can't sign yet. It is
 * never shown for a switch (see useAccountSwitcher) - and it always has a way
 * out: pick another account, or remove this one on purpose.
 */
export function UnlockScreen() {
  const { pubkey, lockInfo, unlockWithPassphrase, retryUnlock, accounts } = useProfileContext();
  const { switchTo, signOut, dialog } = useAccountSwitcher();

  if (!pubkey) return null;
  const others = accounts.filter((account) => account.pubkey !== pubkey);

  return (
    <div className="sign-in-container">
      <AccountLockPrompt
        pubkey={pubkey}
        reason={lockInfo?.reason ?? "passphrase"}
        extensionPubkey={lockInfo?.extensionPubkey}
        onPassphrase={async (passphrase) => {
          await unlockWithPassphrase(passphrase);
        }}
        onRetry={retryUnlock}
      >
        {others.length > 0 && (
          <div className="unlock-other-accounts">
            <p className="unlock-other-accounts-label">Use another account</p>
            {others.map((account) => (
              <button
                key={account.pubkey}
                type="button"
                className="sign-in-btn sign-in-btn-block unlock-other-account"
                onClick={() => void switchTo(account.pubkey)}
              >
                {shortNpub(account.pubkey)}
              </button>
            ))}
          </div>
        )}
        <button type="button" className="sign-in-link-btn unlock-remove" onClick={() => void signOut(pubkey)}>
          Remove this account from this device
        </button>
      </AccountLockPrompt>
      {dialog}
    </div>
  );
}
