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

/**
 * The candidate list for automatic upload fallback: the selected server
 * first, then the user's other known DEFAULT/custom servers. Deliberately
 * excludes relay-discovered ("relay" source) servers unless one is already
 * the selection — those are arbitrary third-party URLs the user never
 * reviewed, and while file content is end-to-end encrypted before upload, the
 * BUD-02 auth event still exposes the identity pubkey, blob hash, and timing
 * to whatever server receives it. Automatically fanning that out beyond the
 * trusted (default + user-added) set isn't a call this function should make
 * on its own.
 */
export function getUploadCandidateServers(
  selectedServer: string,
  servers: ServerInfo[],
): string[] {
  const rest = servers
    .filter((s) => s.source !== "relay" && s.url !== selectedServer)
    .map((s) => s.url);
  return [selectedServer, ...rest];
}

export interface BlossomServerContextType {
  servers: ServerInfo[];
  selectedServer: string;
  setSelectedServer: (url: string) => void;
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
  const [selectedServer, setSelectedServer] = useState(DEFAULT_SERVERS[0]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let unobserve: (() => void) | null = null;

    const queryServers = async () => {
      try {
        const storedCustomServers = await getStoredItem<string[]>(
          STORAGE_KEYS.CUSTOM_SERVERS,
          [],
        );
        const storedSelectedServer = normalizeServerUrl(
          await getStoredItem<string>(
            STORAGE_KEYS.SELECTED_SERVER,
            DEFAULT_SERVERS[0],
          ),
        );

        const customServers = storedCustomServers.map((url) => ({
          url: normalizeServerUrl(url),
          source: "custom" as const,
        }));
        const ensuredCustomServers = customServers.some(
          (server) => server.url === storedSelectedServer,
        )
          ? customServers
          : DEFAULT_SERVERS.includes(storedSelectedServer)
            ? customServers
            : [
                ...customServers,
                { url: storedSelectedServer, source: "custom" as const },
              ];

        if (cancelled) return;
        setServers([
          ...DEFAULT_SERVERS.map((url) => ({
            url,
            source: "default" as const,
          })),
          ...ensuredCustomServers,
        ]);
        setSelectedServer(storedSelectedServer);
        setSettingsLoaded(true);

        // Standing interest in published Blossom server lists (kind 36363):
        // cache replay makes them available instantly on repeat loads, and the
        // live tail keeps discovering new ones. Dedupe against whatever is
        // already in the list (defaults, customs, earlier discoveries).
        const handle = dataLayer.observe(
          [{ kinds: [36363], limit: 50 }],
          {
            onEvent: (event: Event) => {
              if (cancelled) return;
              const dTag = event.tags.find((t) => t[0] === "d");
              if (!dTag?.[1]) return;
              const url = normalizeServerUrl(dTag[1]);
              setServers((prev) =>
                prev.some((s) => s.url === url)
                  ? prev
                  : [...prev, { url, source: "relay" }],
              );
            },
            onEose: () => {
              if (!cancelled) setLoading(false);
            },
          },
        );
        unobserve = () => {
          handle.unobserve();
        };
      } catch (e) {
        console.error("Failed to query relay servers:", e);
        if (!cancelled) {
          setError("Failed to fetch servers from relays");
          setSettingsLoaded(true);
          setLoading(false);
        }
      }
    };

    void queryServers();
    return () => {
      cancelled = true;
      unobserve?.();
    };
  }, []);

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
    if (restoring || !pubkey) return;

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
  }, [pubkey, restoring]);

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

    // Publish the updated list so other devices pick it up. Deliberately not
    // awaited and never rethrown: the server is already usable locally, and a
    // relay hiccup must not make "add server" appear to fail. The warning is
    // the signal that cross-device sync specifically didn't happen.
    void publishServerList([normalizedUrl, ...nextCustomUrls.filter((u) => u !== normalizedUrl)])
      .catch((e) => {
        console.warn("[BlossomServers] Could not sync server list to relays", e);
      });
  }, []);

  useEffect(() => {
    if (!settingsLoaded) return;
    void setStoredItem(STORAGE_KEYS.SELECTED_SERVER, selectedServer);
  }, [selectedServer, settingsLoaded]);

  useEffect(() => {
    if (!settingsLoaded) return;

    const customServerUrls = servers
      .filter((server) => server.source === "custom")
      .map((server) => server.url);

    void setStoredItem(STORAGE_KEYS.CUSTOM_SERVERS, customServerUrls);
  }, [servers, settingsLoaded]);

  return (
    <BlossomServerContext.Provider
      value={{
        servers,
        selectedServer,
        setSelectedServer,
        addCustomServer,
        loading,
        error,
      }}
    >
      {children}
    </BlossomServerContext.Provider>
  );
}
