import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useBlossomServer } from "../../hooks/useBlossomServer";
import {
  formatLimit,
  getServerLimitsSnapshot,
  lookupLimit,
  subscribeServerLimits,
} from "../../services/serverLimits";
import "./ServerSetupModal.css";

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Where an account's files are stored. There is no built-in server: the first
 * time none is configured Drive opens this, and uploading without one opens it
 * again. It is also the place to add, switch and remove servers afterwards.
 */
export function ServerSetupModal() {
  const {
    servers,
    selectedServer,
    setSelectedServer,
    addServer,
    removeServer,
    suggestions,
    needsServerSetup,
    setupOpen,
    closeServerSetup,
  } = useBlossomServer();
  const limits = useSyncExternalStore(subscribeServerLimits, getServerLimitsSnapshot);
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!setupOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeServerSetup();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previous?.focus?.();
    };
  }, [setupOpen, closeServerSetup]);

  if (!setupOpen) return null;

  const submit = (value: string) => {
    if (!value.trim()) return;
    try {
      addServer(value);
      setUrl("");
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That isn't a valid server URL");
    }
  };

  return createPortal(
    <div className="server-setup-root">
      <div className="server-setup-scrim" onClick={closeServerSetup} />
      <div
        ref={dialogRef}
        className="server-setup"
        role="dialog"
        aria-modal="true"
        aria-labelledby="server-setup-title"
        aria-describedby="server-setup-intro"
      >
        <div className="server-setup-header">
          <h2 id="server-setup-title" className="server-setup-title">
            {needsServerSetup ? "Choose where your files are stored" : "Storage servers"}
          </h2>
          <button className="server-setup-close" onClick={closeServerSetup} aria-label="Close">
            ×
          </button>
        </div>

        <div className="server-setup-body">
          <p id="server-setup-intro" className="server-setup-text">
            Drive stores your files on a Blossom server you choose. Files are encrypted on your
            device before they're uploaded, but the server still sees the encrypted data, your
            public key and when you upload. There is no default: pick one you trust, or run your
            own. Files you've already uploaded stay where they are.
          </p>

          <form
            className="server-setup-add"
            onSubmit={(e) => {
              e.preventDefault();
              submit(url);
            }}
          >
            <input
              ref={inputRef}
              type="text"
              inputMode="url"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setError(null);
              }}
              placeholder="https://your-blossom-server.com"
              aria-label="Blossom server URL"
              aria-invalid={error ? true : undefined}
            />
            <button type="submit" disabled={!url.trim()}>
              Add
            </button>
          </form>
          {error && (
            <p className="server-setup-error" role="alert">
              {error}
            </p>
          )}

          {servers.length > 0 && (
            <section className="server-setup-section" aria-label="Your servers">
              <h3 className="server-setup-subtitle">Your servers</h3>
              <ul className="server-setup-list">
                {servers.map((server) => {
                  const limit = lookupLimit(limits, server.url);
                  const active = server.url === selectedServer;
                  return (
                    <li key={server.url} className={active ? "is-active" : undefined}>
                      <label>
                        <input
                          type="radio"
                          name="storage-server"
                          checked={active}
                          onChange={() => setSelectedServer(server.url)}
                        />
                        <span className="server-setup-host">
                          {hostOf(server.url)}
                          {limit && (
                            <span className="server-setup-meta"> · max {formatLimit(limit)}</span>
                          )}
                        </span>
                      </label>
                      <button
                        type="button"
                        className="server-setup-remove"
                        onClick={() => removeServer(server.url)}
                        aria-label={`Remove ${hostOf(server.url)}`}
                      >
                        Remove
                      </button>
                    </li>
                  );
                })}
              </ul>
              <p className="server-setup-note">Uploads go to the selected server only.</p>
            </section>
          )}

          {suggestions.length > 0 && (
            <section className="server-setup-section" aria-label="Servers announced on relays">
              <h3 className="server-setup-subtitle">Announced on relays</h3>
              <p className="server-setup-note">
                Public servers other people have announced. Drive hasn't vetted them and none is
                used unless you add it.
              </p>
              <ul className="server-setup-list">
                {suggestions.map((suggestion) => (
                  <li key={suggestion}>
                    <span className="server-setup-host">{hostOf(suggestion)}</span>
                    <button type="button" className="server-setup-add-suggestion" onClick={() => submit(suggestion)}>
                      Add
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <div className="server-setup-footer">
          <button type="button" className="server-setup-secondary" onClick={closeServerSetup}>
            {needsServerSetup ? "Not now" : "Done"}
          </button>
          {selectedServer && needsServerSetup === false && (
            <span className="server-setup-selected">Uploading to {hostOf(selectedServer)}</span>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
