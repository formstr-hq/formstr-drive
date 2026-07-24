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

const DEFAULT_SERVERS = [
  "https://nostr.download",
  "https://blossom.primal.net",
  "https://blossom.oxtr.dev",
];

interface ServerInfo {
  url: string;
  source: "default" | "relay" | "custom";
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
        unobserve = () => handle.unobserve();
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

  const addCustomServer = useCallback((url: string) => {
    const normalizedUrl = normalizeServerUrl(url);

    try {
      new URL(normalizedUrl);
    } catch {
      throw new Error(`"${url}" is not a valid server URL`);
    }

    setServers((prev) => {
      if (prev.some((s) => s.url === normalizedUrl)) {
        return prev;
      }
      return [...prev, { url: normalizedUrl, source: "custom" }];
    });
    setSelectedServer(normalizedUrl);
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
