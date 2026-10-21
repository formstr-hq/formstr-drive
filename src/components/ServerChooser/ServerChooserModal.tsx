import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useBlossomServer } from "../../hooks/useBlossomServer";
import {
  formatLimit,
  getServerLimitsSnapshot,
  lookupLimit,
  subscribeServerLimits,
} from "../../services/serverLimits";
import "./ServerChooserModal.css";

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Asks the user which server to upload to. Nothing is selected for them: the
 * server sees the encrypted files, the account's public key and upload timing,
 * so the choice is theirs. Opens shortly after sign-in when none is chosen yet,
 * and whenever they try to upload without one.
 */
export function ServerChooserModal() {
  const { servers, selectedServer, setSelectedServer, addCustomServer, chooserOpen, closeServerChooser } =
    useBlossomServer();
  const limits = useSyncExternalStore(subscribeServerLimits, getServerLimitsSnapshot);
  // The user's pick in this dialog; null means "nothing changed yet" (show the
  // current selection, if any).
  const [picked, setPicked] = useState<string | null>(null);
  const [custom, setCustom] = useState("");
  const [error, setError] = useState<string | null>(null);
  const selectRef = useRef<HTMLSelectElement>(null);

  const choice = picked ?? selectedServer ?? "";

  const close = () => {
    setPicked(null);
    setCustom("");
    setError(null);
    closeServerChooser();
  };

  useEffect(() => {
    if (!chooserOpen) return;
    selectRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPicked(null);
        closeServerChooser();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [chooserOpen, closeServerChooser]);

  if (!chooserOpen) return null;

  const addOwn = () => {
    if (!custom.trim()) return;
    try {
      addCustomServer(custom);
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That isn't a valid server URL");
    }
  };

  return createPortal(
    <div className="server-chooser-root">
      <div className="server-chooser-scrim" onClick={close} />
      <div
        className="server-chooser"
        role="dialog"
        aria-modal="true"
        aria-labelledby="server-chooser-title"
        aria-describedby="server-chooser-text"
      >
        <h2 id="server-chooser-title" className="server-chooser-title">
          Choose where to upload
        </h2>
        <p id="server-chooser-text" className="server-chooser-text">
          Pick the Blossom server your files are stored on. They're encrypted before they leave your
          device, but the server still sees the encrypted data, your public key and when you upload.
          Uploads go to this server only.
        </p>

        <label className="server-chooser-label" htmlFor="server-chooser-select">
          Server
        </label>
        <select
          id="server-chooser-select"
          ref={selectRef}
          value={choice}
          onChange={(e) => setPicked(e.target.value)}
        >
          <option value="" disabled>
            Choose a server…
          </option>
          {servers.map((s) => {
            const limit = lookupLimit(limits, s.url);
            return (
              <option key={s.url} value={s.url}>
                {hostOf(s.url)}
                {limit ? ` · max ${formatLimit(limit)}` : ""}
              </option>
            );
          })}
        </select>

        <label className="server-chooser-label" htmlFor="server-chooser-custom">
          Or use your own
        </label>
        <div className="server-chooser-row">
          <input
            id="server-chooser-custom"
            type="text"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            value={custom}
            onChange={(e) => {
              setCustom(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => e.key === "Enter" && addOwn()}
            placeholder="https://your-blossom-server.com"
          />
          <button type="button" onClick={addOwn} disabled={!custom.trim()}>
            Use
          </button>
        </div>
        {error && (
          <p className="server-chooser-error" role="alert">
            {error}
          </p>
        )}

        <div className="server-chooser-actions">
          <button type="button" className="server-chooser-secondary" onClick={close}>
            Not now
          </button>
          <button
            type="button"
            className="server-chooser-primary"
            disabled={!choice}
            onClick={() => {
              setSelectedServer(choice);
              close();
            }}
          >
            Use this server
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
