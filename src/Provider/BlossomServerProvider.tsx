import { probeServerLimit } from "../services/serverLimits";
import {
  createContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
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

/**
 * Drive has no built-in storage servers. Where an account's files are stored is
 * the user's own choice: the first time there is none, Drive asks. Files are
 * encrypted before upload, but the server still sees the encrypted blobs, the
 * account's public key and request timing — not something to decide silently.
 *
 * Nothing here falls back to another server: an upload goes to the selected
 * one, and if that fails it fails (with the server's reason) so the user can
 * fix or change it.
 */

/** The servers earlier versions shipped as defaults. Used only to recognise an
 *  old stored selection that the user never actually made. */
const LEGACY_DEFAULT_SERVERS = [
  "https://nostr.download",
  "https://blossom.data.haus",
  "https://blossom.primal.net",
  "https://blossom.oxtr.dev",
];

const MAX_SUGGESTIONS = 6;

export interface ServerInfo {
  url: string;
}

export interface BlossomServerContextType {
  /** This account's own storage servers. Empty until the user adds one. */
  servers: ServerInfo[];
  /** Where uploads go, or null when none is configured yet. */
  selectedServer: string | null;
  setSelectedServer: (url: string) => void;
  /** Adds a server and makes it the selected one. Throws on an invalid URL. */
  addServer: (url: string) => void;
  removeServer: (url: string) => void;
  /** Servers announced on relays (kind 36363). Offered as suggestions only —
   *  never selected or used without the user adding them. */
  suggestions: string[];
  /** This account's server settings have loaded. */
  settingsLoaded: boolean;
  /** Signed in, settings loaded, and no server configured. */
  needsServerSetup: boolean;
  setupOpen: boolean;
  openServerSetup: () => void;
  closeServerSetup: () => void;
  loading: boolean;
  error: string | null;
}

export const BlossomServerContext =
  createContext<BlossomServerContextType | null>(null);

export function normalizeServerUrl(url: string) {
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
  const [servers, setServers] = useState<ServerInfo[]>([]);
  const [selectedServer, setSelectedServerState] = useState<string | null>(null);
  const [discovered, setDiscovered] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  // Whose servers and selection `servers` / `selectedServer` currently hold.
  // They belong to one account: a server added or synced for one identity must
  // never show up under — or, worse, be published in the server list of —
  // another identity on the same device.
  const [settingsOwner, setSettingsOwner] = useState<string | null>(null);
  // Accounts the prompt has already been shown for this session, so closing it
  // with "Not now" isn't followed by it popping straight back up.
  const [promptedFor, setPromptedFor] = useState<Set<string>>(() => new Set());

  // Public Blossom server announcements (kind 36363): suggestions only.
  useEffect(() => {
    let cancelled = false;
    const handle = dataLayer.observe([{ kinds: [36363], limit: 50 }], {
      onEvent: (event: Event) => {
        if (cancelled) return;
        const dTag = event.tags.find((t) => t[0] === "d");
        if (!dTag?.[1]) return;
        const url = normalizeServerUrl(dTag[1]);
        setDiscovered((prev) => (prev.includes(url) ? prev : [...prev, url]));
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

  // This account's own servers and selection. Stored per identity
  // ({ [pubkey]: … }); the first release kept one device-wide value, which
  // belongs to whichever account is active the first time it's read.
  useEffect(() => {
    if (restoring) return;
    if (!pubkey) {
      setSettingsOwner(null);
      setServers([]);
      setSelectedServerState(null);
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
        const urls = (pick<string[]>(storedCustom, Array.isArray) ?? [])
          .filter((u) => typeof u === "string")
          .map(normalizeServerUrl);
        const storedUrl = pick<string>(storedSelected, (v) => typeof v === "string");
        let selected = storedUrl ? normalizeServerUrl(storedUrl) : undefined;
        // An old selection that is one of the servers earlier versions shipped
        // as defaults, and that the user never added themselves, was never a
        // choice — it was the default. Treat it as not configured.
        if (selected && LEGACY_DEFAULT_SERVERS.includes(selected) && !urls.includes(selected)) {
          selected = undefined;
        }
        // A server the user did pick but that isn't in their list yet joins it.
        if (selected && !urls.includes(selected)) urls.push(selected);
        if (!selected && urls.length > 0) selected = urls[0];
        if (cancelled) return;

        setServers(urls.map((url) => ({ url })));
        setSelectedServerState(selected ?? null);
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
  // device shows up on all of them. Gated on `pubkey` (not read once at mount):
  // the signer may not have finished restoring yet, and it must re-subscribe
  // under a switched account's own list.
  useEffect(() => {
    if (restoring || !pubkey || settingsOwner !== pubkey) return;

    const unobserveServerList = observeServerList(pubkey, (syncedUrls) => {
      setServers((prev) => {
        const known = new Set(prev.map((s) => s.url));
        const additions = syncedUrls
          .map(normalizeServerUrl)
          .filter((url) => !known.has(url))
          .map((url) => ({ url }));
        return additions.length > 0 ? [...prev, ...additions] : prev;
      });
    });

    return unobserveServerList;
  }, [pubkey, restoring, settingsOwner]);

  // A synced server arriving on a device with nothing selected becomes the
  // selection: the user chose it on another device.
  useEffect(() => {
    if (settingsOwner !== pubkey || selectedServer || servers.length === 0) return;
    setSelectedServerState(servers[0]!.url);
  }, [servers, selectedServer, settingsOwner, pubkey]);

  // Servers whose probe was inconclusive (offline when added, a timeout) get
  // another try. probeServerLimit no-ops for any server with a known limit or
  // a conclusive earlier probe, so this costs nothing in the steady state.
  useEffect(() => {
    for (const server of servers) void probeServerLimit(server.url);
  }, [servers]);

  const publish = useCallback((urls: string[]) => {
    // Publish the updated list so other devices pick it up. Deliberately not
    // awaited and never rethrown: the change is already in effect locally, and
    // a relay hiccup must not make it appear to fail.
    void publishServerList(urls).catch((e) => {
      console.warn("[BlossomServers] Could not sync server list to relays", e);
    });
  }, []);

  const addServer = useCallback(
    (url: string) => {
      const normalizedUrl = normalizeServerUrl(url);

      try {
        const parsed = new URL(normalizedUrl);
        if (!parsed.hostname.includes(".") && parsed.hostname !== "localhost") {
          throw new Error("invalid host");
        }
      } catch {
        throw new Error(`"${url.trim()}" is not a valid server URL`);
      }

      const next = servers.some((s) => s.url === normalizedUrl)
        ? servers
        : [...servers, { url: normalizedUrl }];
      setServers(next);
      setSelectedServerState(normalizedUrl);

      // One-time, cached, signer-free probe so the picker can show its cap.
      void probeServerLimit(normalizedUrl);
      publish(next.map((s) => s.url));
    },
    [servers, publish],
  );

  const removeServer = useCallback(
    (url: string) => {
      const next = servers.filter((s) => s.url !== url);
      setServers(next);
      setSelectedServerState((current) => (current === url ? (next[0]?.url ?? null) : current));
      publish(next.map((s) => s.url));
    },
    [servers, publish],
  );

  const setSelectedServer = useCallback(
    (url: string) => {
      if (servers.some((s) => s.url === url)) setSelectedServerState(url);
    },
    [servers],
  );

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
    if (!pubkey || settingsOwner !== pubkey) return;
    void saveForAccount(STORAGE_KEYS.SELECTED_SERVER, selectedServer);
  }, [selectedServer, settingsOwner, pubkey, saveForAccount]);

  useEffect(() => {
    if (!pubkey || settingsOwner !== pubkey) return;
    void saveForAccount(STORAGE_KEYS.CUSTOM_SERVERS, servers.map((s) => s.url));
  }, [servers, settingsOwner, pubkey, saveForAccount]);

  const settingsLoaded = !!pubkey && settingsOwner === pubkey;
  const needsServerSetup = settingsLoaded && !selectedServer;

  // Ask once per account per session, shortly after the drive has had a moment
  // to come up, instead of over the top of the sign-in.
  useEffect(() => {
    if (!needsServerSetup || !pubkey || promptedFor.has(pubkey)) return;
    const timer = setTimeout(() => {
      setPromptedFor((prev) => new Set(prev).add(pubkey));
      setSetupOpen(true);
    }, 1200);
    return () => clearTimeout(timer);
  }, [needsServerSetup, pubkey, promptedFor]);

  const suggestions = useMemo(
    () =>
      discovered
        .filter((url) => !servers.some((s) => s.url === url))
        .slice(0, MAX_SUGGESTIONS),
    [discovered, servers],
  );

  const openServerSetup = useCallback(() => setSetupOpen(true), []);
  const closeServerSetup = useCallback(() => setSetupOpen(false), []);

  return (
    <BlossomServerContext.Provider
      value={{
        servers,
        selectedServer,
        setSelectedServer,
        addServer,
        removeServer,
        suggestions,
        settingsLoaded,
        needsServerSetup,
        setupOpen,
        openServerSetup,
        closeServerSetup,
        loading,
        error,
      }}
    >
      {children}
    </BlossomServerContext.Provider>
  );
}
