import { probeServerLimit } from "../services/serverLimits";
import {
  createContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import { dataLayer, type Event } from "@formstr/local-relay";
import {
  getStoredItem,
  setStoredItem,
  STORAGE_KEYS,
} from "../utils/persistence";
import { observeServerList, publishServerList } from "../services/blossomServerList";
import { useProfileContext } from "../hooks/useProfileContext";

const DEFAULT_SERVERS = [
  "https://nostr.download",
  "https://blossom.data.haus",
  "https://blossom.primal.net",
  "https://blossom.oxtr.dev",
];

export interface ServerInfo {
  url: string;
  source: "default" | "relay" | "custom";
}

export interface BlossomServerContextType {
  servers: ServerInfo[];
  /** The user's chosen upload server; null until they choose one. */
  selectedServer: string | null;
  setSelectedServer: (url: string) => void;
  /** Signed in, settings loaded, and no server chosen yet. */
  needsServerChoice: boolean;
  chooserOpen: boolean;
  openServerChooser: () => void;
  closeServerChooser: () => void;
  addCustomServer: (url: string) => void;
  loading: boolean;
  error: string | null;
}

export const BlossomServerContext =
  createContext<BlossomServerContextType | null>(null);

function normalizeServerUrl(url: string) {
  let normalizedUrl = url.trim();
  if (
    !normalizedUrl.startsWith("http://") &&
    !normalizedUrl.startsWith("https://")
  ) {
    normalizedUrl = "https://" + normalizedUrl;
  }

  return normalizedUrl.replace(/\/$/, "");
}

export function BlossomServerProvider({ children }: { children: ReactNode }) {
  const { pubkey, restoring } = useProfileContext();
  const [servers, setServers] = useState<ServerInfo[]>(
    DEFAULT_SERVERS.map((url) => ({ url, source: "default" })),
  );
  const [selectedServer, setSelectedServer] = useState<string | null>(null);
  const [chooserOpen, setChooserOpen] = useState(false);
  // Accounts already asked this session, so "Not now" isn't followed by the
  // prompt popping straight back up.
  const [promptedFor, setPromptedFor] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Whose custom servers and selection `servers` / `selectedServer` currently
  // hold. They belong to one account: a server added or synced for one identity
  // must never show up under — or, worse, be published in the server list of —
  // another identity on the same device.
  const [settingsOwner, setSettingsOwner] = useState<string | null>(null);

  // Public Blossom server lists (kind 36363) — discovery, the same for everyone.
  // Cache replay makes them available instantly on repeat loads and the live
  // tail keeps finding new ones; deduped against whatever is already listed.
  useEffect(() => {
    let cancelled = false;
    const handle = dataLayer.observe([{ kinds: [36363], limit: 50 }], {
      onEvent: (event: Event) => {
        if (cancelled) return;
        const dTag = event.tags.find((t) => t[0] === "d");
        if (!dTag?.[1]) return;
        const url = normalizeServerUrl(dTag[1]);
        setServers((prev) =>
          prev.some((s) => s.url === url) ? prev : [...prev, { url, source: "relay" }],
        );
      },
      onEose: () => {
        if (!cancelled) setLoading(false);
      },
    });
    return () => {
      cancelled = true;
      handle.unobserve();
    };
  }, []);

  // This account's own custom servers and selected server. Stored per identity
  // ({ [pubkey]: … }); the first release kept one device-wide value, which
  // belongs to whichever account is active the first time it's read.
  useEffect(() => {
    if (restoring) return;
    if (!pubkey) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset when the active account changes
      setSettingsOwner(null);
      setServers((prev) => prev.filter((s) => s.source !== "custom"));
      setSelectedServer(null);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const storedCustom = await getStoredItem<unknown>(STORAGE_KEYS.CUSTOM_SERVERS, null);
        const storedSelected = await getStoredItem<unknown>(STORAGE_KEYS.SELECTED_SERVER, null);
        const pick = <T,>(stored: unknown, isLegacy: (v: unknown) => boolean): T | undefined => {
          if (isLegacy(stored)) return stored as T;
          if (stored && typeof stored === "object" && !Array.isArray(stored)) {
            return (stored as Record<string, T>)[pubkey];
          }
          return undefined;
        };
        const customUrls = pick<string[]>(storedCustom, Array.isArray) ?? [];
        // No server is chosen until the user chooses one.
        const storedUrl = pick<string>(storedSelected, (v) => typeof v === "string");
        const selected = typeof storedUrl === "string" ? normalizeServerUrl(storedUrl) : null;
        if (cancelled) return;

        const custom = customUrls.map((url) => ({
          url: normalizeServerUrl(url),
          source: "custom" as const,
        }));
        const ensured =
          !selected || custom.some((c) => c.url === selected) || DEFAULT_SERVERS.includes(selected)
            ? custom
            : [...custom, { url: selected, source: "custom" as const }];

        setServers((prev) => {
          const kept = prev.filter((s) => s.source !== "custom");
          const known = new Set(kept.map((s) => s.url));
          return [...kept, ...ensured.filter((c) => !known.has(c.url))];
        });
        setSelectedServer(selected);
        setSettingsOwner(pubkey);
      } catch (e) {
        console.error("Failed to load server settings:", e);
        if (!cancelled) {
          setError("Failed to load your server settings");
          setSettingsOwner(pubkey);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [pubkey, restoring]);

  // The user's own BUD-03 server list (kind 10063), so a server added on one
  // device shows up on all of them. Kept in its own effect, gated on `pubkey`
  // rather than read once via signerManager.getPubkey() at mount: the effect
  // above runs before the signer has necessarily finished restoring a session
  // (this provider mounts alongside ProfileProvider, not after it settles), so
  // a synchronous read here would silently see `undefined` on most cold
  // starts and never subscribe for the rest of the session. Depending on
  // `pubkey` instead means this activates the moment it's actually known, and
  // correctly re-subscribes under a switched account's own list.
  useEffect(() => {
    if (restoring || !pubkey || settingsOwner !== pubkey) return;

    const unobserveServerList = observeServerList(pubkey, (syncedUrls) => {
      setServers((prev) => {
        const known = new Set(prev.map((s) => s.url));
        // Merged as "custom" because that's what it is — a server this user
        // deliberately chose, not an arbitrary third-party URL discovered
        // from the network — which also makes it eligible for upload
        // fallback (see getUploadCandidateServers).
        const additions = syncedUrls
          .map(normalizeServerUrl)
          .filter((url) => !known.has(url))
          .map((url) => ({ url, source: "custom" as const }));
        return additions.length > 0 ? [...prev, ...additions] : prev;
      });
    });

    return unobserveServerList;
  }, [pubkey, restoring, settingsOwner]);

  // Custom servers whose probe was inconclusive (offline when added, a timeout)
  // get another try. probeServerLimit no-ops for any server with a known limit
  // or a conclusive earlier probe, so this costs nothing in the steady state.
  useEffect(() => {
    for (const server of servers) {
      if (server.source === "custom") void probeServerLimit(server.url);
    }
  }, [servers]);

  const addCustomServer = useCallback((url: string) => {
    const normalizedUrl = normalizeServerUrl(url);

    try {
      new URL(normalizedUrl);
    } catch {
      throw new Error(`"${url}" is not a valid server URL`);
    }

    let nextCustomUrls: string[] = [];
    setServers((prev) => {
      if (prev.some((s) => s.url === normalizedUrl)) {
        nextCustomUrls = prev.filter((s) => s.source === "custom").map((s) => s.url);
        return prev;
      }
      const next: ServerInfo[] = [...prev, { url: normalizedUrl, source: "custom" }];
      nextCustomUrls = next.filter((s) => s.source === "custom").map((s) => s.url);
      return next;
    });
    setSelectedServer(normalizedUrl);

    // One-time, cached, signer-free probe so the picker can show its cap.
    void probeServerLimit(normalizedUrl);

    // Publish the updated list so other devices pick it up. Deliberately not
    // awaited and never rethrown: the server is already usable locally, and a
    // relay hiccup must not make "add server" appear to fail. The warning is
    // the signal that cross-device sync specifically didn't happen.
    void publishServerList([normalizedUrl, ...nextCustomUrls.filter((u) => u !== normalizedUrl)])
      .catch((e) => {
        console.warn("[BlossomServers] Could not sync server list to relays", e);
      });
  }, []);

  const saveForAccount = useCallback(async (key: string, value: unknown) => {
    if (!pubkey) return;
    const stored = await getStoredItem<unknown>(key, null);
    const byAccount: Record<string, unknown> =
      stored && typeof stored === "object" && !Array.isArray(stored)
        ? { ...(stored as Record<string, unknown>) }
        : {};
    byAccount[pubkey] = value;
    await setStoredItem(key, byAccount);
  }, [pubkey]);

  useEffect(() => {
    if (!pubkey || settingsOwner !== pubkey || !selectedServer) return;
    void saveForAccount(STORAGE_KEYS.SELECTED_SERVER, selectedServer);
  }, [selectedServer, settingsOwner, pubkey, saveForAccount]);

  const needsServerChoice = !!pubkey && settingsOwner === pubkey && !selectedServer;

  // Ask once per account per session, a moment after the drive comes up.
  useEffect(() => {
    if (!needsServerChoice || !pubkey || promptedFor.has(pubkey)) return;
    const timer = setTimeout(() => {
      setPromptedFor((prev) => new Set(prev).add(pubkey));
      setChooserOpen(true);
    }, 1200);
    return () => clearTimeout(timer);
  }, [needsServerChoice, pubkey, promptedFor]);

  const openServerChooser = useCallback(() => setChooserOpen(true), []);
  const closeServerChooser = useCallback(() => setChooserOpen(false), []);

  useEffect(() => {
    if (!pubkey || settingsOwner !== pubkey) return;

    const customServerUrls = servers
      .filter((server) => server.source === "custom")
      .map((server) => server.url);

    void saveForAccount(STORAGE_KEYS.CUSTOM_SERVERS, customServerUrls);
  }, [servers, settingsOwner, pubkey, saveForAccount]);

  return (
    <BlossomServerContext.Provider
      value={{
        servers,
        selectedServer,
        setSelectedServer,
        needsServerChoice,
        chooserOpen,
        openServerChooser,
        closeServerChooser,
        addCustomServer,
        loading,
        error,
      }}
    >
      {children}
    </BlossomServerContext.Provider>
  );
}
