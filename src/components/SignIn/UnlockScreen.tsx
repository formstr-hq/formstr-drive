import { useState } from "react";
import { nip19 } from "nostr-tools";
import { useProfileContext } from "../../hooks/useProfileContext";

export function UnlockScreen() {
  const { pubkey, unlockWithPassphrase, logout } = useProfileContext();
  const [passphrase, setPassphrase] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const npub = pubkey ? nip19.npubEncode(pubkey) : "";
  const shortNpub = npub ? `${npub.slice(0, 12)}…${npub.slice(-6)}` : "";

  const handleUnlock = async () => {
    if (!passphrase) {
      setError("Enter your passphrase");
      return;
    }

    setError(null);
    setLoading(true);

    try {
      await unlockWithPassphrase(passphrase);
    } catch (unlockError) {
      setError(
        unlockError instanceof Error
          ? unlockError.message
          : "Incorrect passphrase",
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="sign-in-container">
      <div className="sign-in-card">
        <h1>Unlock your key</h1>
        <p className="sign-in-subtitle">Signed in as {shortNpub}</p>

        <div className="sign-in-method-section sign-in-secondary-section">
          <div className="sign-in-input-column">
            <input
              className="sign-in-text-input"
              type="password"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              placeholder="Passphrase"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              disabled={loading}
              autoFocus
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  void handleUnlock();
                }
              }}
            />
            <button
              type="button"
              className="sign-in-btn sign-in-btn-block"
              onClick={() => void handleUnlock()}
              disabled={loading || !passphrase}
            >
              {loading ? "Unlocking..." : "Unlock"}
            </button>
          </div>
        </div>

        <button
          type="button"
          className="sign-in-link-btn"
          onClick={() => void logout()}
        >
          Log out and use another account
        </button>

        {error && <p className="sign-in-error">{error}</p>}
      </div>
    </div>
  );
}
