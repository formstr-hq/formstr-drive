import { useState, type ReactNode } from "react";
import { nip19 } from "nostr-tools";
import type { LockReason } from "../../signer/types";

function shortNpub(pubkey: string): string {
  const npub = nip19.npubEncode(pubkey);
  return `${npub.slice(0, 12)}…${npub.slice(-6)}`;
}

interface ReasonCopy {
  title: string;
  body: (account: string, other?: string) => string;
  /** Takes a passphrase instead of a plain "Try again". */
  passphrase?: boolean;
}

// One row per reason: a new kind of "can't sign yet" is a new row, not a new screen.
const REASONS: Record<LockReason, ReasonCopy> = {
  passphrase: {
    title: "Unlock your key",
    body: (account) => `Enter the passphrase for ${account}.`,
    passphrase: true,
  },
  "extension-missing": {
    title: "Your Nostr extension isn't available",
    body: (account) => `${account} signs with a browser extension. Enable it, then try again.`,
  },
  "extension-other-account": {
    title: "Your extension is on another account",
    body: (account, other) =>
      `${account} signs with a browser extension, but it is currently on ${other ?? "a different key"}. Switch the extension to ${account}, then try again.`,
  },
  "signer-unreachable": {
    title: "Couldn't reach your signer",
    body: (account) => `${account} signs with a remote signer (a bunker or an Android app). Make sure it is running, then try again.`,
  },
};

interface AccountLockPromptProps {
  pubkey: string;
  reason: LockReason;
  extensionPubkey?: string;
  onPassphrase: (passphrase: string) => Promise<void>;
  onRetry: () => Promise<void>;
  children?: ReactNode;
}

export function AccountLockPrompt({
  pubkey,
  reason,
  extensionPubkey,
  onPassphrase,
  onRetry,
  children,
}: AccountLockPromptProps) {
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copy = REASONS[reason];

  const run = async (action: () => Promise<void>, fallback: string) => {
    setError(null);
    setBusy(true);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : fallback);
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    if (!passphrase) {
      setError("Enter your passphrase");
      return;
    }
    void run(() => onPassphrase(passphrase), "Incorrect passphrase");
  };

  return (
    <div className="sign-in-card">
      <h1>{copy.title}</h1>
      <p className="sign-in-subtitle">
        {copy.body(shortNpub(pubkey), extensionPubkey ? shortNpub(extensionPubkey) : undefined)}
      </p>

      <div className="sign-in-method-section sign-in-secondary-section">
        <div className="sign-in-input-column">
          {copy.passphrase ? (
            <>
              <input
                className="sign-in-text-input"
                type="password"
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
                placeholder="Passphrase"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                disabled={busy}
                autoFocus
                onKeyDown={(event) => {
                  if (event.key === "Enter") submit();
                }}
              />
              <button
                type="button"
                className="sign-in-btn sign-in-btn-block"
                onClick={submit}
                disabled={busy || !passphrase}
              >
                {busy ? "Unlocking..." : "Unlock"}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="sign-in-btn sign-in-btn-block"
              onClick={() => void run(onRetry, "Still can't reach it")}
              disabled={busy}
            >
              {busy ? "Checking..." : "Try again"}
            </button>
          )}
        </div>
      </div>

      {error && <p className="sign-in-error">{error}</p>}
      {children}
    </div>
  );
}
