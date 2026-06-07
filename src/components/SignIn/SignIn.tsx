import { useEffect, useRef, useState } from "react";
import { QRCodeCanvas } from "qrcode.react";
import { useProfileContext } from "../../hooks/useProfileContext";
import { createNewNsec } from "../../signer/LocalSigner";
import { isNativePlatform } from "../../utils/platform";

type RemoteTab = "uri" | "qr";
type SignInMethod = "external" | "bunker" | "nsec" | "create";

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

export function SignIn() {
  const {
    requestPubkey,
    loginWithNip46,
    loginWithNsec,
    createNip46ConnectUri,
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
  const [loadingNsec, setLoadingNsec] = useState(false);
  const [remoteTab, setRemoteTab] = useState<RemoteTab>("uri");
  const [selectedMethod, setSelectedMethod] = useState<SignInMethod | null>(
    null,
  );
  const [generatedNsec, setGeneratedNsec] = useState("");
  const [copiedNewKey, setCopiedNewKey] = useState(false);
  const [loadingCreateKey, setLoadingCreateKey] = useState(false);
  const qrAbortRef = useRef<AbortController | null>(null);
  const title = nativeShellMode ? "Sign in to Formstr Drive" : "Formstr Drive";
  const subtitle = nativeShellMode
    ? "Choose your preferred login method"
    : "Encrypted file storage on Nostr";

  const busy =
    loadingPackage !== null ||
    loadingBunker ||
    loadingQr ||
    loadingNsec ||
    loadingCreateKey;
  const nsecBusy = loadingNsec;

  useEffect(() => {
    return () => {
      qrAbortRef.current?.abort();
    };
  }, []);

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

  const handleBunkerLogin = async (
    uri: string,
    loadingMode: "manual" | "qr",
    abortSignal?: AbortSignal,
  ) => {
    setError(null);

    if (!uri.trim()) {
      setError("Enter a bunker URL to continue");
      return;
    }

    if (loadingMode === "manual") {
      setLoadingBunker(true);
    } else {
      setLoadingQr(true);
    }

    try {
      await loginWithNip46(
        uri.trim(),
        abortSignal ? { abortSignal } : undefined,
      );
    } catch (loginError) {
      if (
        abortSignal?.aborted ||
        (loginError instanceof Error &&
          (loginError.name === "AbortError" ||
            loginError.message.toLowerCase().includes("abort")))
      ) {
        return;
      }

      setError(
        loginError instanceof Error
          ? loginError.message
          : "Failed to connect with bunker signer",
      );
    } finally {
      if (loadingMode === "manual") {
        setLoadingBunker(false);
      } else {
        setLoadingQr(false);
      }
    }
  };

  const handleGenerateQr = async () => {
    setError(null);
    stopQrWaiting();

    try {
      const uri = await createNip46ConnectUri();
      setQrUri(uri);
      const controller = new AbortController();
      qrAbortRef.current = controller;
      await handleBunkerLogin(uri, "qr", controller.signal);
    } catch (qrError) {
      setError(
        qrError instanceof Error
          ? qrError.message
          : "Failed to generate QR code",
      );
      setLoadingQr(false);
    } finally {
      qrAbortRef.current = null;
    }
  };

  const handleNsecLogin = async () => {
    setError(null);

    if (!nsec.trim()) {
      setError("Enter your nsec to continue");
      return;
    }

    setLoadingNsec(true);

    try {
      await loginWithNsec(nsec.trim());
    } catch (loginError) {
      setError(getUserFriendlyNsecError(loginError));
    } finally {
      setLoadingNsec(false);
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
    setGeneratedNsec(createNewNsec());
  };

  const copyGeneratedKey = async () => {
    if (!generatedNsec || !navigator.clipboard) {
      return;
    }

    try {
      await navigator.clipboard.writeText(generatedNsec);
      setCopiedNewKey(true);
    } catch {
      setError("Failed to copy the generated nsec");
    }
  };

  const handleContinueWithGeneratedKey = async () => {
    if (!generatedNsec) {
      setError("Create a key first");
      return;
    }

    setError(null);
    setLoadingCreateKey(true);

    try {
      await loginWithNsec(generatedNsec);
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
      setRemoteTab("uri");
    }

    if (method !== "create") {
      setCopiedNewKey(false);
    }
  };

  const goBackToMethods = () => {
    setError(null);
    stopQrWaiting();
    setRemoteTab("uri");
    setSelectedMethod(null);
  };

  return (
    <div className="sign-in-container">
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
                    onClick={() => void requestPubkey()}
                    disabled={busy}
                  >
                    Continue with NIP-07 signer
                  </button>
                )}

                <button
                  type="button"
                  className="sign-in-choice-btn"
                  onClick={() => openMethod("bunker")}
                >
                  Continue with bunker URL
                </button>

                {nativeShellMode && (
                  <button
                    type="button"
                    className="sign-in-choice-btn"
                    onClick={() => openMethod("nsec")}
                  >
                    Continue with nsec
                  </button>
                )}

                {nativeShellMode && (
                  <button
                    type="button"
                    className="sign-in-choice-btn"
                    onClick={() => openMethod("create")}
                  >
                    Create new key
                  </button>
                )}
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
                        <svg viewBox="0 0 24 24" fill="none">
                          <path
                            d="M10.25 13.75 13.75 10.25M8 15.5H6.5a3 3 0 1 1 0-6H8m8 6h1.5a3 3 0 1 0 0-6H16"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </div>
                      <div className="sign-in-remote-copy">
                        <h2>Connect with remote signer</h2>
                        <p>(NIP-46)</p>
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
                        aria-selected={remoteTab === "uri"}
                        className={`sign-in-tab-btn${remoteTab === "uri" ? " active" : ""}`}
                        onClick={() => switchRemoteTab("uri")}
                      >
                        Paste URI
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={remoteTab === "qr"}
                        className={`sign-in-tab-btn${remoteTab === "qr" ? " active" : ""}`}
                        onClick={() => switchRemoteTab("qr")}
                      >
                        QR Code
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
                              void handleBunkerLogin(bunkerUri, "manual");
                            }
                          }}
                        />
                        <button
                          type="button"
                          className="sign-in-btn sign-in-btn-block"
                          onClick={() =>
                            void handleBunkerLogin(bunkerUri, "manual")
                          }
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

                {selectedMethod === "nsec" && nativeShellMode && (
                  <div className="sign-in-method-section sign-in-secondary-section">
                    <div className="sign-in-method-header">
                      <h2>Continue with nsec</h2>
                    </div>
                    <p className="sign-in-section-hint">
                      Your nsec stays on this device and is stored in Android
                      secure storage.
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
                        disabled={nsecBusy}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            void handleNsecLogin();
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="sign-in-btn sign-in-btn-block"
                        onClick={() => void handleNsecLogin()}
                        disabled={nsecBusy || !nsec.trim()}
                      >
                        {loadingNsec ? "Connecting..." : "Continue with nsec"}
                      </button>
                    </div>
                  </div>
                )}

                {selectedMethod === "create" && nativeShellMode && (
                  <div className="sign-in-method-section sign-in-secondary-section">
                    <div className="sign-in-method-header">
                      <h2>Create new key</h2>
                    </div>
                    <p className="sign-in-section-hint">
                      Generate a brand-new Nostr key for this app. Save it
                      before you continue.
                    </p>

                    {!generatedNsec ? (
                      <button
                        type="button"
                        className="sign-in-btn sign-in-btn-block"
                        onClick={generateKey}
                      >
                        Generate key
                      </button>
                    ) : (
                      <div className="sign-in-input-column">
                        <div className="sign-in-warning-box">
                          Save this <code>nsec</code> now. If you lose it, you
                          may lose access to your drive.
                        </div>
                        <textarea
                          className="sign-in-secret-output"
                          value={generatedNsec}
                          readOnly
                          rows={3}
                        />
                        <div className="sign-in-generated-actions">
                          <button
                            type="button"
                            className="sign-in-choice-btn"
                            onClick={() => void copyGeneratedKey()}
                          >
                            {copiedNewKey ? "Copied" : "Copy key"}
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
