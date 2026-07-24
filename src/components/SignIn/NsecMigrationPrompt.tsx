import { useState } from "react";
import { useProfileContext } from "../../hooks/useProfileContext";

export function NsecMigrationPrompt() {
  const { completeNsecMigration } = useProfileContext();
  const [passphrase, setPassphrase] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSecure = async () => {
    if (!passphrase) {
      setError("Choose a passphrase to secure your key");
      return;
    }

    setError(null);
    setLoading(true);

    try {
      await completeNsecMigration(passphrase);
    } catch (migrationError) {
      setError(
        migrationError instanceof Error
          ? migrationError.message
          : "Failed to secure your key",
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="sign-in-container">
      <div className="sign-in-card">
        <h1>Secure your key</h1>
        <p className="sign-in-subtitle">One-time update to your login</p>

        <div className="sign-in-method-section sign-in-secondary-section">
          <p className="sign-in-section-hint">
            Your key used to be stored on this device without a passphrase.
            Choose a passphrase now to encrypt it — you'll need it to sign in
            going forward.
          </p>
          <div className="sign-in-input-column">
            <input
              className="sign-in-text-input"
              type="password"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              placeholder="Choose a passphrase"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              disabled={loading}
              autoFocus
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  void handleSecure();
                }
              }}
            />
            <button
              type="button"
              className="sign-in-btn sign-in-btn-block"
              onClick={() => void handleSecure()}
              disabled={loading || !passphrase}
            >
              {loading ? "Securing..." : "Secure my key"}
            </button>
          </div>
        </div>

        {error && <p className="sign-in-error">{error}</p>}
      </div>
    </div>
  );
}
