import { useCallback, useSyncExternalStore } from "react";
import { dataLayer, type Event, type Filter, type ObserveHandle } from "@formstr/local-relay";
import { getStoredItem, setStoredItem, STORAGE_KEYS } from "../utils/persistence";

// Mirrors nostr-polls' kind-0 field precedence (display_name is the "nice"
// user-set name, name is the technical/username field — clients show
// display_name first, falling back to name).
export interface NostrProfile {
  name?: string;
  display_name?: string;
  picture?: string;
}

interface PersistedProfileEntry {
  profile: NostrProfile;
  created_at: number;
}

// In-memory profile cache, keyed by pubkey. Session-scoped; seeded from the
// persisted cache below on first use so it survives reloads too.
const profileCache = new Map<string, NostrProfile>();
// Newest created_at we've applied per pubkey — a stale/older kind-0 (e.g. a
// cache replay after a live update already landed) must never overwrite it.
const newestByPubkey = new Map<string, number>();
const subscribersByKey = new Map<string, Set<() => void>>();

function notify(pubkey: string) {
  subscribersByKey.get(pubkey)?.forEach((fn) => fn());
}

// ---------------------------------------------------------------------------
// Persisted cache (mirrors nostr-polls' `pollerama:profile_cache`): profiles
// seen once render instantly on the next cold load, without waiting on the
// worker/IndexedDB hydration race or a fresh relay round-trip.
// ---------------------------------------------------------------------------

let persistedCacheLoaded = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const payload: Record<string, PersistedProfileEntry> = {};
    profileCache.forEach((profile, pubkey) => {
      payload[pubkey] = { profile, created_at: newestByPubkey.get(pubkey) ?? 0 };
    });
    void setStoredItem(STORAGE_KEYS.PROFILE_CACHE, payload);
  }, 500);
}

async function loadPersistedCacheOnce() {
  if (persistedCacheLoaded) return;
  persistedCacheLoaded = true;

  const stored = await getStoredItem<Record<string, PersistedProfileEntry>>(
    STORAGE_KEYS.PROFILE_CACHE,
    {}
  );

  for (const [pubkey, entry] of Object.entries(stored)) {
    if (profileCache.has(pubkey)) continue; // a live event already beat the disk read
    profileCache.set(pubkey, entry.profile);
    newestByPubkey.set(pubkey, entry.created_at);
    notify(pubkey);
  }
}

function applyProfileEvent(event: Event) {
  const existing = newestByPubkey.get(event.pubkey) ?? 0;
  if (event.created_at <= existing) return;

  try {
    const parsed = JSON.parse(event.content) as NostrProfile;
    profileCache.set(event.pubkey, parsed);
    newestByPubkey.set(event.pubkey, event.created_at);
    notify(event.pubkey);
    schedulePersist();
  } catch {
    // Ignore malformed profile content
  }
}

// ---------------------------------------------------------------------------
// One growing, debounced, batched relay interest for every watched pubkey —
// mirrors nostr-polls' addToInterest: a single `authors: [...]` filter widened
// via handle.update() as more pubkeys are watched, instead of a separate
// relay subscription per pubkey (which is what this hook did before, and what
// meant loading N accounts/avatars opened N subscriptions instead of one).
// ---------------------------------------------------------------------------

const watchedPubkeys = new Set<string>();
let interestHandle: ObserveHandle | null = null;
let interestTimer: ReturnType<typeof setTimeout> | null = null;

function ensureWatching(pubkey: string) {
  if (watchedPubkeys.has(pubkey)) return;
  watchedPubkeys.add(pubkey);

  if (interestTimer) clearTimeout(interestTimer);
  interestTimer = setTimeout(() => {
    interestTimer = null;
    const filters: Filter[] = [{ kinds: [0], authors: Array.from(watchedPubkeys) }];
    if (interestHandle) {
      interestHandle.update(filters);
    } else {
      interestHandle = dataLayer.observe(filters, { onEvent: applyProfileEvent });
    }
  }, 300);
}

function subscribe(pubkey: string | undefined, onStoreChange: () => void): () => void {
  if (!pubkey) return () => {};

  void loadPersistedCacheOnce();

  let listeners = subscribersByKey.get(pubkey);
  if (!listeners) {
    listeners = new Set();
    subscribersByKey.set(pubkey, listeners);
  }
  listeners.add(onStoreChange);
  ensureWatching(pubkey);

  return () => {
    const set = subscribersByKey.get(pubkey);
    set?.delete(onStoreChange);
    if (set && set.size === 0) subscribersByKey.delete(pubkey);
    // Deliberately do NOT drop `pubkey` from watchedPubkeys / tear down the
    // relay interest — it's allowed to grow and stay warm for the session
    // (same tradeoff nostr-polls makes), so switching back to a previously
    // -viewed account is already live instead of re-subscribing from scratch.
  };
}

export function useNostrProfile(pubkey?: string): NostrProfile | undefined {
  // Both callbacks are memoized on [pubkey] so useSyncExternalStore only
  // re-subscribes when the watched key actually changes — never on every
  // render.
  const subscribeToPubkey = useCallback(
    (onStoreChange: () => void) => subscribe(pubkey, onStoreChange),
    [pubkey]
  );
  const getSnapshot = useCallback(
    () => (pubkey ? profileCache.get(pubkey) : undefined),
    [pubkey]
  );

  return useSyncExternalStore(subscribeToPubkey, getSnapshot);
}

/** display_name first (the user-facing "nice" name), falling back to the
 * technical `name` field — the precedence nostr-polls uses everywhere. */
export function getProfileDisplayName(profile: NostrProfile | undefined): string | undefined {
  return profile?.display_name || profile?.name;
}
