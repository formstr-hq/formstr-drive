export const defaultRelays = [
  "wss://relay.damus.io/",
  "wss://relay.primal.net/",
  "wss://nos.lol",
  "wss://relay.nostr.wirednet.jp/",
  "wss://nostr-01.yakihonne.com",
  "wss://relay.snort.social",
  "wss://relay.nostr.band",
  "wss://nostr21.com",
];

// Core relays used for file metadata publishing and Blossom server discovery
export const APP_RELAYS = [
  "wss://relay.damus.io",
  "wss://relay.nostr.band",
  "wss://nos.lol",
];

export const getDefaultRelays = () => {
  return defaultRelays;
};

/**
 * Normalizes a relay URL for dedup/comparison purposes: strips a trailing
 * slash and lowercases the scheme+host. `APP_RELAYS` and `defaultRelays` list
 * the same relay with and without a trailing slash (e.g. `relay.damus.io` vs
 * `relay.damus.io/`) — a plain `new Set([...])` over the raw strings doesn't
 * catch that, so every caller that merges the two lists ends up dialing the
 * same relay twice. This does NOT touch a path/query after the host, so it's
 * safe even though relay URLs don't normally carry one.
 */
export function normalizeRelayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "");
    return `${parsed.protocol}//${parsed.host}${path}${parsed.search}`.toLowerCase();
  } catch {
    // Malformed input — fall back to a best-effort trim rather than throwing;
    // callers merging relay lists shouldn't be able to crash on bad data.
    return url.trim().replace(/\/+$/, "").toLowerCase();
  }
}

/** Merges relay lists into a deduped set, normalizing away scheme/host-case
 *  and trailing-slash differences that a plain `Set` over raw strings misses. */
export function mergeRelayLists(...lists: string[][]): string[] {
  const seen = new Map<string, string>();
  for (const list of lists) {
    for (const url of list) {
      const key = normalizeRelayUrl(url);
      if (!seen.has(key)) seen.set(key, url);
    }
  }
  return Array.from(seen.values());
}