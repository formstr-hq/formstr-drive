import { useEffect, useRef, useState } from "react";
import { QRCodeCanvas } from "qrcode.react";
import { useProfileContext } from "../../hooks/useProfileContext";
import { isNativePlatform } from "../../utils/platform";
import { BunkerLinkIcon } from "../icons/Icons";

import { NIP46_RELAYS } from "../../utils/constants";

type RemoteTab = "uri" | "qr";
type SignInMethod = "external" | "bunker" | "import" | "create";

function getUserFriendlyNsecError(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Invalid nsec";
  }

  const message = error.message.toLowerCase();

  if (
    message.includes("nsec") ||
    message.includes("bech32") ||
    message.includes("prefix") ||
    message.includes("letter") ||
    message.includes("invalid")
  ) {
    return "Invalid nsec";
  }

  return "Failed to sign in with nsec";
}

// @formstr/signer's loginWithExtension() throws raw, developer-facing
// messages (e.g. "@formstr\signer: NIP-07 extension not found
// (globalThis.nostr is undefined)" — the library even has a bug where
// `\signer` isn't a valid escape, so it renders as the broken-looking
// "@formstrsigner: ..."). Translate the ones we know into plain language
// instead of surfacing library internals to the user.
function getUserFriendlyExtensionError(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Failed to connect to NIP-07 extension";
  }

  const message = error.message;

  if (/nip-07 extension not found|globalThis\.nostr is undefined/i.test(message)) {
    return "No Nostr browser extension found. Install a NIP-07 signer extension (e.g. Alby, nos2x) and try again.";
  }

  if (/does not expose nip(04|44)/i.test(message)) {
    return "Your Nostr extension doesn't support the encryption Drive needs. Try a different extension.";
  }

  if (/reject|denied|cancel/i.test(message)) {
    return "Connection request was rejected in your extension.";
  }

  return message;
}

interface SignInProps {
  /** Rendered inside AddAccountModal rather than as the full-page sign-in
   * screen — swaps the copy, everything else (every login method) is
   * identical, since adding an account IS signing in, just to a second
   * identity instead of the first. */
  embedded?: boolean;
}

export function SignIn({ embedded = false }: SignInProps) {
  const {
    requestPubkey,
    loginWithBunkerUri,
    loginWithNostrConnect,
    generatePendingAccount,
    confirmPendingAccount,
    importNsec,
    nativeSignerApps,
    loadingNativeSignerApps,
    restoring,
  } = useProfileContext();
  const nativeShellMode = isNativePlatform;
  const [error, setError] = useState<string | null>(null);
  const [loadingPackage, setLoadingPackage] = useState<string | null>(null);
  const [bunkerUri, setBunkerUri] = useState("");
  const [qrUri, setQrUri] = useState<string | null>(null);
  const [loadingBunker, setLoadingBunker] = useState(false);
  const [loadingQr, setLoadingQr] = useState(false);
  const [nsec, setNsec] = useState("");
  const [importPassphrase, setImportPassphrase] = useState("");
  const [loadingImport, setLoadingImport] = useState(false);
  const [remoteTab, setRemoteTab] = useState<RemoteTab>("qr");
  const [selectedMethod, setSelectedMethod] = useState<SignInMethod | null>(
    null,
  );
  const [createPassphrase, setCreatePassphrase] = useState("");
  const [pendingAccount, setPendingAccount] = useState<{
    npub: string;
    ncryptsec: string;
  } | null>(null);
  const [copiedNewKey, setCopiedNewKey] = useState(false);
  const [loadingCreateKey, setLoadingCreateKey] = useState(false);
  const [loadingExtension, setLoadingExtension] = useState(false);
  const qrAbortRef = useRef<AbortController | null>(null);
  const title = embedded
    ? "Add another account"
    : nativeShellMode
      ? "Sign in to Drive by Form*"
      : "Drive by Form*";
  const subtitle = embedded
    ? "Choose a sign-in method"
    : nativeShellMode
      ? "Choose your preferred login method"
      : "Encrypted file storage on Nostr";

  const busy =
    loadingPackage !== null ||
    loadingBunker ||
    loadingQr ||
    loadingImport ||
    loadingCreateKey ||
    loadingExtension;
  const importBusy = loadingImport;

  useEffect(() => {
    return () => {
      qrAbortRef.current?.abort();
    };
  }, []);

  const handleExtensionLogin = async () => {
    setError(null);
    setLoadingExtension(true);

    try {
      await requestPubkey();
    } catch (loginError) {
      setError(getUserFriendlyExtensionError(loginError));
    } finally {
      setLoadingExtension(false);
    }
  };

  const handleNativeLogin = async (packageName: string) => {
    setError(null);
    setLoadingPackage(packageName);

    try {
      await requestPubkey(packageName);
    } catch (loginError) {
      setError(
        loginError instanceof Error
          ? loginError.message === "Activity Cancelled"
            ? "Login was cancelled in the signer app"
            : loginError.message
          : "Failed to connect to Android signer",
      );
    } finally {
      setLoadingPackage(null);
    }
  };

  const stopQrWaiting = () => {
    qrAbortRef.current?.abort();
    qrAbortRef.current = null;
    setLoadingQr(false);
  };

  const handleBunkerLogin = async (uri: string) => {
    setError(null);

    if (!uri.trim()) {
      setError("Enter a bunker URL to continue");
      return;
    }

    setLoadingBunker(true);

    try {
      await loginWithBunkerUri(uri.trim());
    } catch (loginError) {
      setError(
        loginError instanceof Error
          ? loginError.message
          : "Failed to connect with bunker signer",
      );
    } finally {
      setLoadingBunker(false);
    }
  };

  const handleGenerateQr = async () => {
    setError(null);
    stopQrWaiting();
    setQrUri(null);

    const controller = new AbortController();
    qrAbortRef.current = controller;
    setLoadingQr(true);

    try {
      await loginWithNostrConnect({
        relays: NIP46_RELAYS,
        onUri: (uri) => setQrUri(uri),
        signal: controller.signal,
      });
    } catch (qrError) {
      if (controller.signal.aborted) {
        return;
      }

      setError(
        qrError instanceof Error
          ? qrError.message
          : "Failed to generate QR code",
      );
    } finally {
      setLoadingQr(false);
      qrAbortRef.current = null;
    }
  };

  const handleImportNsec = async () => {
    setError(null);

    if (!nsec.trim()) {
      setError("Enter your nsec to continue");
      return;
    }

    if (!importPassphrase) {
      setError("Choose a passphrase to secure your key");
      return;
    }

    setLoadingImport(true);

    try {
      await importNsec(nsec.trim(), importPassphrase);
    } catch (loginError) {
      setError(getUserFriendlyNsecError(loginError));
    } finally {
      setLoadingImport(false);
    }
  };

  const copyQrUri = async () => {
    if (!qrUri || !navigator.clipboard) {
      return;
    }

    try {
      await navigator.clipboard.writeText(qrUri);
    } catch {
      setError("Failed to copy the QR connection URL");
    }
  };

  const generateKey = () => {
    setError(null);
    setCopiedNewKey(false);

    if (!createPassphrase) {
      setError("Choose a passphrase to secure your new key");
      return;
    }

    setPendingAccount(generatePendingAccount(createPassphrase));
  };

  const copyGeneratedKey = async () => {
    if (!pendingAccount || !navigator.clipboard) {
      return;
    }

    try {
      await navigator.clipboard.writeText(pendingAccount.ncryptsec);
      setCopiedNewKey(true);
    } catch {
      setError("Failed to copy the generated key backup");
    }
  };

  const handleContinueWithGeneratedKey = async () => {
    if (!pendingAccount) {
      setError("Create a key first");
      return;
    }

    setError(null);
    setLoadingCreateKey(true);

    try {
      await confirmPendingAccount(pendingAccount.ncryptsec, createPassphrase);
    } catch (loginError) {
      setError(
        loginError instanceof Error
          ? loginError.message
          : "Failed to continue with generated key",
      );
    } finally {
      setLoadingCreateKey(false);
    }
  };

  const switchRemoteTab = (nextTab: RemoteTab) => {
    setRemoteTab(nextTab);

    if (nextTab === "uri") {
      stopQrWaiting();
    }

    if (nextTab === "qr" && !qrUri && !loadingQr) {
      void handleGenerateQr();
    }
  };

  const openMethod = (method: SignInMethod) => {
    setError(null);
    setSelectedMethod(method);

    if (method !== "bunker") {
      stopQrWaiting();
    }

    if (method === "bunker") {
      switchRemoteTab("qr");
    }

    if (method !== "create") {
      setCopiedNewKey(false);
    }
  };

  const goBackToMethods = () => {
    setError(null);
    stopQrWaiting();
    setRemoteTab("qr");
    setSelectedMethod(null);
  };

  return (
    <div className={`sign-in-container${embedded ? " sign-in-container--embedded" : ""}`}>
      <div className="sign-in-card">
        <h1>{title}</h1>
        <p className="sign-in-subtitle">{subtitle}</p>

        {restoring ? (
          <p className="sign-in-hint">Restoring session...</p>
        ) : (
          <>
            {selectedMethod === null ? (
              <div className="sign-in-choice-list">
                {nativeShellMode ? (
                  <button
                    type="button"
                    className="sign-in-choice-btn sign-in-choice-btn-primary"
                    onClick={() => openMethod("external")}
                  >
                    Continue with external app
                  </button>
                ) : (
                  <button
                    type="button"
                    className="sign-in-choice-btn sign-in-choice-btn-primary"
                    onClick={() => void handleExtensionLogin()}
                    disabled={busy}
                  >
                    {loadingExtension ? "Connecting..." : "Continue with NIP-07 signer"}
                  </button>
                )}

                <button
                  type="button"
                  className="sign-in-choice-btn"
                  onClick={() => openMethod("bunker")}
                >
                  Connect with bunker or QR
                </button>

                <button
                  type="button"
                  className="sign-in-choice-btn"
                  onClick={() => openMethod("import")}
                >
                  Import existing key
                </button>

                <button
                  type="button"
                  className="sign-in-choice-btn"
                  onClick={() => openMethod("create")}
                >
                  Create new key
                </button>
              </div>
            ) : (
              <>
                <button
                  type="button"
                  className="sign-in-back-btn"
                  onClick={goBackToMethods}
                >
                  Back to login methods
                </button>

                {selectedMethod === "external" && nativeShellMode && (
                  <div className="native-signer-list sign-in-primary-actions">
                    {loadingNativeSignerApps ? (
                      <p className="sign-in-hint">
                        Loading Android signer apps...
                      </p>
                    ) : nativeSignerApps.length > 0 ? (
                      nativeSignerApps.map((app) => (
                        <button
                          key={app.packageName}
                          className="native-signer-btn"
                          onClick={() => handleNativeLogin(app.packageName)}
                          disabled={loadingPackage !== null}
                        >
                          {app.iconUrl ? (
                            <img
                              src={app.iconUrl}
                              alt={app.name}
                              className="native-signer-icon"
                            />
                          ) : (
                            <span className="native-signer-fallback">
                              {app.name.charAt(0).toUpperCase()}
                            </span>
                          )}
                          <span>
                            {loadingPackage === app.packageName
                              ? "Connecting..."
                              : nativeSignerApps.length === 1
                                ? `Log in with ${app.name}`
                                : app.name}
                          </span>
                        </button>
                      ))
                    ) : (
                      <p className="sign-in-hint">
                        No Android signer app found. Install Amber or another
                        compatible signer.
                      </p>
                    )}
                  </div>
                )}

                {selectedMethod === "bunker" && (
                  <div className="sign-in-method-section">
                    <div className="sign-in-remote-header">
                      <div className="sign-in-remote-icon" aria-hidden="true">
                        <BunkerLinkIcon />
                      </div>
                      <div className="sign-in-remote-copy">
                        <h2>Connect with remote signer</h2>
                        <p>Scan a QR code, or paste a bunker:// URI</p>
                      </div>
                    </div>

                    <div
                      className="sign-in-tab-row"
                      role="tablist"
                      aria-label="Remote signer methods"
                    >
                      <button
                        type="button"
                        role="tab"
                        aria-selected={remoteTab === "qr"}
                        className={`sign-in-tab-btn${remoteTab === "qr" ? " active" : ""}`}
                        onClick={() => switchRemoteTab("qr")}
                      >
                        Scan QR
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={remoteTab === "uri"}
                        className={`sign-in-tab-btn${remoteTab === "uri" ? " active" : ""}`}
                        onClick={() => switchRemoteTab("uri")}
                      >
                        Paste URI instead
                      </button>
                    </div>

                    {remoteTab === "uri" ? (
                      <div className="sign-in-tab-panel">
                        <input
                          className="sign-in-text-input"
                          type="text"
                          value={bunkerUri}
                          onChange={(event) => setBunkerUri(event.target.value)}
                          placeholder="Enter bunker URI"
                          autoCapitalize="none"
                          autoCorrect="off"
                          spellCheck={false}
                          disabled={loadingBunker}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              void handleBunkerLogin(bunkerUri);
                            }
                          }}
                        />
                        <button
                          type="button"
                          className="sign-in-btn sign-in-btn-block"
                          onClick={() => void handleBunkerLogin(bunkerUri)}
                          disabled={loadingBunker || !bunkerUri.trim()}
                        >
                          {loadingBunker ? "Connecting..." : "Connect"}
                        </button>
                      </div>
                    ) : (
                      <div className="sign-in-qr-panel">
                        {qrUri ? (
                          <QRCodeCanvas value={qrUri} size={176} />
                        ) : (
                          <div className="sign-in-qr-placeholder">
                            {loadingQr
                              ? "Generating QR..."
                              : "QR will appear here"}
                          </div>
                        )}
                        <div className="sign-in-qr-actions">
                          {qrUri ? (
                            <>
                              <button
                                type="button"
                                className="sign-in-link-btn"
                                onClick={() => void copyQrUri()}
                                disabled={!qrUri}
                              >
                                Copy URL
                              </button>
                              <span>
                                {loadingQr
                                  ? "Scan and approve in your bunker signer"
                                  : "Scan this in your signer"}
                              </span>
                            </>
                          ) : (
                            <span>Preparing connection...</span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {selectedMethod === "import" && (
                  <div className="sign-in-method-section sign-in-secondary-section">
                    <div className="sign-in-method-header">
                      <h2>Import existing key</h2>
                    </div>
                    <p className="sign-in-section-hint">
                      Your nsec is encrypted with the passphrase below and
                      never leaves this device unencrypted.
                    </p>
                    <div className="sign-in-input-column">
                      <input
                        className="sign-in-text-input"
                        type="password"
                        value={nsec}
                        onChange={(event) => setNsec(event.target.value)}
                        placeholder="nsec1..."
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        disabled={importBusy}
                      />
                      <input
                        className="sign-in-text-input"
                        type="password"
                        value={importPassphrase}
                        onChange={(event) =>
                          setImportPassphrase(event.target.value)
                        }
                        placeholder="Choose a passphrase"
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        disabled={importBusy}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            void handleImportNsec();
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="sign-in-btn sign-in-btn-block"
                        onClick={() => void handleImportNsec()}
                        disabled={
                          importBusy || !nsec.trim() || !importPassphrase
                        }
                      >
                        {loadingImport ? "Connecting..." : "Import key"}
                      </button>
                    </div>
                  </div>
                )}

                {selectedMethod === "create" && (
                  <div className="sign-in-method-section sign-in-secondary-section">
                    <div className="sign-in-method-header">
                      <h2>Create new key</h2>
                    </div>
                    <p className="sign-in-section-hint">
                      Generate a brand-new Nostr key for this app, protected
                      by a passphrase you choose. Save the encrypted backup
                      before you continue.
                    </p>

                    {!pendingAccount ? (
                      <div className="sign-in-input-column">
                        <input
                          className="sign-in-text-input"
                          type="password"
                          value={createPassphrase}
                          onChange={(event) =>
                            setCreatePassphrase(event.target.value)
                          }
                          placeholder="Choose a passphrase"
                          autoCapitalize="none"
                          autoCorrect="off"
                          spellCheck={false}
                        />
                        <button
                          type="button"
                          className="sign-in-btn sign-in-btn-block"
                          onClick={generateKey}
                          disabled={!createPassphrase}
                        >
                          Generate key
                        </button>
                      </div>
                    ) : (
                      <div className="sign-in-input-column">
                        <div className="sign-in-warning-box">
                          Save this encrypted backup (<code>ncryptsec</code>)
                          and remember your passphrase. If you lose either,
                          you may lose access to your drive.
                        </div>
                        <textarea
                          className="sign-in-secret-output"
                          value={pendingAccount.ncryptsec}
                          readOnly
                          rows={3}
                        />
                        <div className="sign-in-generated-actions">
                          <button
                            type="button"
                            className="sign-in-choice-btn"
                            onClick={() => void copyGeneratedKey()}
                          >
                            {copiedNewKey ? "Copied" : "Copy backup"}
                          </button>
                          <button
                            type="button"
                            className="sign-in-choice-btn"
                            onClick={generateKey}
                          >
                            Regenerate
                          </button>
                        </div>
                        <button
                          type="button"
                          className="sign-in-btn sign-in-btn-block"
                          onClick={() => void handleContinueWithGeneratedKey()}
                          disabled={loadingCreateKey}
                        >
                          {loadingCreateKey
                            ? "Connecting..."
                            : "I have saved it, continue"}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}

            <p className="sign-in-hint">
              {nativeShellMode
                ? "Your keys never leave your control."
                : "Use a NIP-07 signer like Alby, or connect with a bunker signer."}
            </p>
            {error && <p className="sign-in-error">{error}</p>}
          </>
        )}
      </div>
    </div>
  );
}
