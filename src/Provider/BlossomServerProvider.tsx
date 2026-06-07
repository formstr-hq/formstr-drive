import {
  createContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import { SimplePool } from "nostr-tools";
import {
  getStoredItem,
  setStoredItem,
  STORAGE_KEYS,
} from "../utils/persistence";
import { APP_RELAYS } from "../utils/common";

const PUBLIC_RELAYS = APP_RELAYS;

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
    const pool = new SimplePool();
    let cancelled = false;

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

        if (!cancelled) {
          setServers([
            ...DEFAULT_SERVERS.map((url) => ({
              url,
              source: "default" as const,
            })),
            ...ensuredCustomServers,
          ]);
          setSelectedServer(storedSelectedServer);
          setSettingsLoaded(true);
        }

        const events = await pool.querySync(PUBLIC_RELAYS, {
          kinds: [36363],
          limit: 50,
        });

        const relayServers: ServerInfo[] = [];
        const seenUrls = new Set([
          ...DEFAULT_SERVERS,
          ...ensuredCustomServers.map((server) => server.url),
        ]);

        for (const event of events) {
          const dTag = event.tags.find((t) => t[0] === "d");
          if (dTag && dTag[1]) {
            let url = dTag[1];
            // Normalize URL
            if (!url.startsWith("http://") && !url.startsWith("https://")) {
              url = "https://" + url;
            }
            // Remove trailing slash
            url = url.replace(/\/$/, "");

            if (!seenUrls.has(url)) {
              seenUrls.add(url);
              relayServers.push({ url, source: "relay" });
            }
          }
        }

        if (!cancelled) {
          setServers((prev) => [
            ...prev.filter((s) => s.source !== "relay"),
            ...relayServers,
          ]);
        }
      } catch (e) {
        console.error("Failed to query relay servers:", e);
        if (!cancelled) {
          setError("Failed to fetch servers from relays");
          setSettingsLoaded(true);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
        pool.close(PUBLIC_RELAYS);
      }
    };

    void queryServers();
    return () => {
      cancelled = true;
      pool.close(PUBLIC_RELAYS);
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
