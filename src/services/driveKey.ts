import { nip44, generateSecretKey, getPublicKey, type Event } from "nostr-tools";
import { bytesToHex, hexToBytes } from "nostr-tools/utils";
import { dataLayer } from "@formstr/local-relay";
import { signerManager } from "../signer/manager";
import {
  getStoredItem,
  setStoredItem,
  removeStoredItem,
  STORAGE_KEYS,
} from "../utils/persistence";
import type { NostrEvent } from "../types/metadata";
import { establishIdentityHistory } from "./identityHistory";

const METADATA_KIND = 34578;
const HEX_64 = /^[0-9a-fA-F]{64}$/;
const CACHE_IO_TIMEOUT_MS = 3000;

// A single decrypted Drive Key: the secp256k1 secret plus its derived pubkey
// and conversation key (used directly by NIP-44 v2). Keeping the secret hex
// lets us re-encrypt with it, and now sign with it, when saving file metadata.
export interface DriveKeyEntry {
  secretKeyHex: string;
  publicKey: string;
  conversationKey: Uint8Array;
}

// Cached ENCRYPTED payload (never decrypted key material) plus its timestamp,
// so we can restore newest-first without re-fetching from relays.
interface CachedPayload {
  content: string;
  created_at: number;
}

// In-memory cache — the decrypted keys ONLY live here, never in persistent
// storage. Persistent storage keeps the still-encrypted payloads only, so the
// signer must decrypt them again on every cold start.
let cachedKeyring: DriveKeyEntry[] | null = null;
let cachedPubkey: string | null = null;

// The hex of the active Drive Key secret — used when encrypting new file
// metadata so all new uploads share a single, consistent (newest) key.
let activeSecretKeyHex: string | null = null;

// Clear every cache when the user logs out.
signerManager.onChange((pubkey) => {
  if (!pubkey) {
    cachedKeyring = null;
    cachedPubkey = null;
    activeSecretKeyHex = null;
    void removeStoredItem(STORAGE_KEYS.DRIVE_KEY_CACHE);
    void removeStoredItem(STORAGE_KEYS.DRIVE_PUBKEY_CACHE);
  }
});

// -----------------------------------------------------------------------------
// "The drive pubkey set changed" signal — same shape as relayRefresh.ts's
// notify/subscribe pair, reused deliberately: that module exists for exactly
// this "re-declare your interest" pattern.
//
// Why this exists: getDriveKeyring() on a warm cache returns the cached key(s)
// immediately and reconciles with relays in the BACKGROUND (see
// `hadCachedKeys` below). If that reconciliation discovers an additional or
// different drive pubkey — e.g. this device cached a stale key from an earlier
// outage — nothing previously re-ran the file-index author filter, so files
// under the real key were silently never requested. Callers that declare a
// standing interest keyed by drive pubkey (fileIndex.ts's observeFileIndex)
// must re-declare it when this fires.
// -----------------------------------------------------------------------------
const driveKeysChangedListeners = new Set<() => void>();

export function onDriveKeysChanged(fn: () => void): () => void {
  driveKeysChangedListeners.add(fn);
  return () => driveKeysChangedListeners.delete(fn);
}

function notifyDriveKeysChanged(): void {
  driveKeysChangedListeners.forEach((l) => l());
}

function getDriveKeyDTag(pubkey: string): string {
  return `0:${pubkey}`;
}

function deriveKeyMaterial(secretKeyHex: string): { publicKey: string; conversationKey: Uint8Array } {
  const secretKey = hexToBytes(secretKeyHex);
  const publicKey = getPublicKey(secretKey);
  const conversationKey = nip44.v2.utils.getConversationKey(secretKey, publicKey);
  return { publicKey, conversationKey };
}

/** Resolve `fallback` if `promise` hasn't settled within `ms`. Never rejects. */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise.catch(() => fallback),
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

// -----------------------------------------------------------------------------
// Encrypted-payload disk cache, namespaced to the pubkey it belongs to so an
// account switch on the same device can never surface another user's keys.
// This cache is ONLY ever an optimization: reads are time-boxed and writes are
// fire-and-forget, so slow/broken storage can never block or break the core
// "fetch keys, then fetch files" flow.
// -----------------------------------------------------------------------------

async function loadPayloadCache(pubkey: string): Promise<CachedPayload[]> {
  const stored = await withTimeout(
    getStoredItem<unknown>(STORAGE_KEYS.DRIVE_KEY_CACHE, null),
    CACHE_IO_TIMEOUT_MS,
    null,
  );

  if (
    stored &&
    typeof stored === "object" &&
    !Array.isArray(stored) &&
    (stored as { pubkey?: string }).pubkey === pubkey &&
    Array.isArray((stored as { payloads?: unknown }).payloads)
  ) {
    return (stored as { payloads: unknown[] }).payloads
      .map((item) =>
        typeof item === "string"
          ? { content: item, created_at: 0 }
          : (item as CachedPayload),
      )
      .filter((p) => p && typeof p.content === "string");
  }

  return [];
}

async function savePayloadCache(
  pubkey: string,
  payloads: CachedPayload[],
): Promise<void> {
  if (payloads.length === 0) return;
  try {
    await withTimeout(
      setStoredItem(STORAGE_KEYS.DRIVE_KEY_CACHE, { pubkey, payloads }),
      CACHE_IO_TIMEOUT_MS,
      undefined,
    );
  } catch (e) {
    console.warn("[DriveKey] Failed to write local key cache", e);
  }
}

// -----------------------------------------------------------------------------
// Drive pubkey cache. Pubkeys are public the moment we publish anything under
// them, so — unlike the encrypted-payload cache above — this is not sensitive
// and exists purely so the file-index author filter can be declared instantly
// on a warm start, without waiting on the signer.
// -----------------------------------------------------------------------------

/**
 * Merges `drivePubkeys` into whatever this device has EVER recorded for
 * `identityPubkey` — deliberately a union, never an overwrite. An overwrite
 * here would erase the one piece of evidence that a drive-key-mint hazard
 * (see restoreDriveKey's doc comment) occurred at the exact moment it
 * happens: the current keyring's pubkey set shrinking to no longer include
 * one this device previously saw is precisely what {@link
 * findOrphanedDrivePubkeys} looks for, and it can only look for it if this
 * cache remembers pubkeys the current keyring has since stopped resolving.
 */
async function saveCachedDrivePubkeys(identityPubkey: string, drivePubkeys: string[]): Promise<void> {
  try {
    const everSeen = await getCachedDrivePubkeys(identityPubkey);
    const union = Array.from(new Set([...everSeen, ...drivePubkeys]));
    await withTimeout(
      setStoredItem(STORAGE_KEYS.DRIVE_PUBKEY_CACHE, { pubkey: identityPubkey, drivePubkeys: union }),
      CACHE_IO_TIMEOUT_MS,
      undefined,
    );
  } catch (e) {
    console.warn("[DriveKey] Failed to write drive pubkey cache", e);
  }
}

/** Cached drive pubkeys for `identityPubkey`, or [] if none cached yet (e.g.
 *  first run on this device). Never throws, never touches the signer. */
export async function getCachedDrivePubkeys(identityPubkey: string): Promise<string[]> {
  const stored = await withTimeout(
    getStoredItem<unknown>(STORAGE_KEYS.DRIVE_PUBKEY_CACHE, null),
    CACHE_IO_TIMEOUT_MS,
    null,
  );

  if (
    stored &&
    typeof stored === "object" &&
    !Array.isArray(stored) &&
    (stored as { pubkey?: string }).pubkey === identityPubkey &&
    Array.isArray((stored as { drivePubkeys?: unknown }).drivePubkeys)
  ) {
    return (stored as { drivePubkeys: unknown[] }).drivePubkeys.filter(
      (p): p is string => typeof p === "string",
    );
  }

  return [];
}

/**
 * Decrypt a Drive Key payload into every secret it carries: the active key
 * (`encryptionKey`, required) plus any `previousKeys` the payload also names.
 * Returns null if the payload is malformed (bad JSON, or `encryptionKey`
 * missing/invalid); throws if the signer itself fails. Individual malformed
 * entries within `previousKeys` are skipped rather than invalidating the
 * whole payload.
 *
 * The array is ordered active-first — callers that want "the" secret (e.g.
 * legacy single-key payloads) can safely take element 0.
 */
async function decryptDriveKeyPayload(
  encryptedContent: string,
  signer: Awaited<ReturnType<typeof signerManager.getSigner>>,
  pubkey: string,
): Promise<string[] | null> {
  if (!signer.nip44Decrypt) {
    throw new Error("Signer does not support NIP-44 decryption");
  }

  const json = await signer.nip44Decrypt(pubkey, encryptedContent);

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  // Legacy (pre-multi-key) payload shape: an array-of-tags,
  // `[["encryptionKey", hex]]` — this is what every Drive Key on production
  // was minted as before this keyring rework, and it is STILL the only
  // format an existing user's key event will ever be in. Reading it here,
  // rather than treating it as unparseable, is what stops the first-time-user
  // path below from ever running for a returning user: a `null` return here
  // is indistinguishable downstream from "no key was ever created", and this
  // module's own guard against minting a second key runs on that signal.
  // There is no `previousKeys` concept in this shape — it predates it.
  if (Array.isArray(parsed)) {
    const encKeyTag = parsed.find(
      (t): t is string[] => Array.isArray(t) && t.length >= 2 && t[0] === "encryptionKey",
    );
    const legacySecretHex = encKeyTag?.[1];
    if (typeof legacySecretHex !== "string" || !HEX_64.test(legacySecretHex)) return null;
    return [legacySecretHex];
  }

  if (!parsed || typeof parsed !== "object") return null;

  const secretKeyHex = (parsed as { encryptionKey?: unknown }).encryptionKey;
  if (typeof secretKeyHex !== "string" || !HEX_64.test(secretKeyHex)) return null;

  const previousKeysRaw = (parsed as { previousKeys?: unknown }).previousKeys;
  const previousKeys = Array.isArray(previousKeysRaw)
    ? previousKeysRaw.filter((k): k is string => typeof k === "string" && HEX_64.test(k))
    : [];

  return [secretKeyHex, ...previousKeys];
}

/**
 * Collect every Drive Key event for the user via the local relay.
 *
 * A warm local cache resolves instantly at EOSE (cache replay done). On an
 * empty cache we hold the interest open for a network window and then give
 * up with whatever was found — including nothing. This function makes NO
 * claim about whether "nothing found" means "confirmed absent" or "couldn't
 * reach it": that used to be guessed here from relay-connection counts,
 * which is exactly the kind of inference that caused the mint hazard this
 * module now guards against (see restoreDriveKey's doc comment). The
 * authoritative answer to "does a key actually exist for this identity" now
 * comes from {@link establishIdentityHistory} at the one call site
 * (buildDriveKeyring) that needs to make a mint-or-not decision — this
 * function's only job is fetching, not judging.
 */
async function fetchDriveKeyEvents(pubkey: string): Promise<NostrEvent[]> {
  return new Promise((resolve) => {
    let settled = false;
    const found = new Map<string, NostrEvent>();

    const handle = dataLayer.observe(
      [
        {
          kinds: [METADATA_KIND],
          authors: [pubkey],
          "#d": [getDriveKeyDTag(pubkey)],
        },
      ],
      {
        onEvent: (event: Event) => {
          found.set(event.id, event as unknown as NostrEvent);
        },
        onEose: () => {
          // Cache hit: resolve immediately — this is the instant-startup path.
          // Empty cache: keep the interest open for the network window below.
          if (!settled && found.size > 0) {
            settled = true;
            handle.unobserve();
            resolve(sortNewestFirst([...found.values()]));
          }
        },
      },
    );

    // Safety timeout — flaky mobile relays get a generous window.
    setTimeout(() => {
      if (settled) return;
      settled = true;
      handle.unobserve();
      resolve(sortNewestFirst([...found.values()]));
    }, 20000);
  });
}

function sortNewestFirst<T extends { created_at: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => b.created_at - a.created_at);
}

/**
 * Build the full Drive Key keyring for the current user.
 *
 * Order of operations, and why:
 *   1. Load the cached ENCRYPTED payloads and decrypt every one with the
 *      signer. This lets a returning user open their drive without waiting on
 *      relays, as long as the signer (e.g. the local nsec) is available.
 *   2. Reconcile with relays. If we already had cached keys this runs in the
 *      background so it never blocks startup; otherwise we await it.
 *   3. We treat this as a first-time user (and offer to create a key) both
 *      when relays report nothing, and when every event we found was in an
 *      unsupported/legacy format — anything that decrypted but didn't match
 *      our expected shape. We only hard-block WITHOUT offering to overwrite
 *      when the signer itself genuinely failed to decrypt something (an
 *      auth/extension problem), since that's the one case where a key might
 *      actually still be there and recoverable.
 */
// In-flight keyring build, so concurrent callers on a cold in-memory cache
// share one build instead of each running its own full decrypt. Without this,
// a single launch's getDriveConversationKeys/getDriveKeyPubkeys/
// getActiveDriveKey calls (fileIndex.ts's observeFileIndex fires the first two
// back-to-back) each miss the fast path and independently decrypt the same
// cached payloads — with a remote signer (Amber) each decrypt is its own
// inter-app round trip, so this turns N round trips into 1.
//
// Keyed by the pubkey the build started for: an account switch mid-flight
// must not hand the new account the previous one's in-flight promise.
let inFlightBuild: { pubkey: string | undefined; promise: Promise<DriveKeyEntry[]> } | null = null;

export async function getDriveKeyring(): Promise<DriveKeyEntry[]> {
  // Fast path: in-memory cache, but only for the SAME user still signed in.
  if (
    cachedKeyring &&
    cachedPubkey &&
    cachedPubkey === signerManager.getPubkey()
  ) {
    return cachedKeyring;
  }

  const currentPubkey = signerManager.getPubkey();
  if (inFlightBuild && inFlightBuild.pubkey === currentPubkey) {
    return inFlightBuild.promise;
  }

  const promise = buildDriveKeyring();
  inFlightBuild = { pubkey: currentPubkey, promise };
  try {
    return await promise;
  } finally {
    if (inFlightBuild?.promise === promise) {
      inFlightBuild = null;
    }
  }
}

/** The pieces of buildDriveKeyring's in-progress state resolveEmptyKeyring
 *  needs — passed explicitly (rather than resolveEmptyKeyring closing over
 *  buildDriveKeyring's locals) so this stays a normal, independently
 *  readable top-level function instead of more nested closure state. */
interface EmptyKeyringDeps {
  getKeyringLength: () => number;
  addSecret: (secretKeyHex: string, createdAt: number) => boolean;
  rememberPayload: (content: string, createdAt: number) => void;
  ingestDriveKeyEvents: (events: NostrEvent[]) => Promise<void>;
  persistCache: () => void;
}

/**
 * Runs only when the first Drive Key fetch left the keyring empty: decides
 * whether that means "genuinely new" (safe to mint) or something else
 * entirely (found-but-unusable, unreachable network, or findable via a
 * wider relay search) — see the inline comments for why each branch is
 * handled the way it is.
 */
async function resolveEmptyKeyring(
  pubkey: string,
  signer: Awaited<ReturnType<typeof signerManager.getSigner>>,
  firstAttemptEvents: NostrEvent[],
  deps: EmptyKeyringDeps,
): Promise<void> {
  const { getKeyringLength, addSecret, rememberPayload, ingestDriveKeyEvents, persistCache } = deps;

  // A Drive Key event existing at all — regardless of WHY we couldn't turn
  // it into a usable key (signer failure, or a payload shape this build
  // doesn't recognize) — means a key already exists. Minting a replacement
  // here would publish over it: the Drive Key event is replaceable (one per
  // identity), so a second mint doesn't coexist with the first, it destroys
  // it on every relay that accepts the publish, with no way back (see
  // restoreDriveKey's doc comment for the incident this guards against).
  // "Can't read it" must therefore never be treated the same as "doesn't
  // exist" — the two used to be conflated here (gated on
  // `sawGenuineDecryptError`, which a recognized-but-unsupported payload
  // shape never sets), which is exactly the gap a format change walked
  // through undetected.
  if (firstAttemptEvents.length > 0) {
    throw new Error(
      "Found a Drive Key on the relays, but this app couldn't use it (unrecognized format or a " +
        "decrypt failure). Creating a new key here would permanently replace it and orphan every " +
        "file under it. Please update the app, or use Import Drive Key with your existing secret.",
    );
  }

  // No Drive Key event was found at all — but that alone still isn't proof
  // this is a first-time user; it's equally what "the network couldn't
  // answer" looks like, OR what "the key lives on a relay we aren't
  // querying" looks like. Ask the one question that actually has a
  // positive answer: has this IDENTITY (not this specific event kind) ever
  // published anything? A used identity always has SOMETHING (profile,
  // contacts, relay list, or this app's own drive metadata), independent
  // of whether the Drive Key specifically could be found — so this can't
  // be fooled by the same failure mode (a payload/kind this build doesn't
  // recognize) that caused the original incident. See identityHistory.ts
  // for the full reasoning and why "unknown" must never be treated as "new".
  const identityHistory = await establishIdentityHistory(pubkey);

  if (identityHistory === "existing") {
    // identityHistory's own broad-kind query (kinds 0/3/10002/34578) may
    // have just delivered this identity's kind-10002 relay list (NIP-65)
    // into the local relay's store — @formstr/local-relay routes
    // author-scoped queries through an outbox model
    // (partitionAuthorsByRelay / getWriteRelays), but ONLY using whatever
    // kind-10002 it already has locally; the first fetchDriveKeyEvents call
    // had nothing to route with. Retry now that it might: this is what
    // actually finds a Drive Key published to relays outside this app's
    // fixed default set, not just what stops the app from destroying it.
    const retryEvents = await fetchDriveKeyEvents(pubkey);
    await ingestDriveKeyEvents(retryEvents);
    persistCache();
  }

  if (getKeyringLength() === 0 && identityHistory !== "new") {
    throw new Error(
      identityHistory === "existing"
        ? "This account has used Nostr before, but no Drive Key could be found for it, even after " +
            "checking its own relay list. Creating a new one would risk destroying an existing key " +
            "if one exists elsewhere. Please check your connection and try again, or use Import " +
            "Drive Key with your existing secret."
        : "Could not reach enough relays to tell whether this account already has a Drive Key. " +
            "Refusing to create one, since that could permanently destroy an existing key. Please " +
            "check your connection and try again.",
    );
  }

  if (getKeyringLength() === 0) {
    // Only reachable with identityHistory === "new" — the "existing" and
    // "unknown" cases both throw above.
    const confirmMessage =
      "No Drive Key found, and this looks like a new account — create one now?\n\n" +
      "Note: creating a key REPLACES your Drive Key everywhere it's published (one per account, " +
      "replaceable). If you've actually used Drive before and see this by mistake, use Import Drive " +
      "Key with your existing secret instead.";
    if (!window.confirm(confirmMessage)) {
      throw new Error("User cancelled drive key creation.");
    }

    const created = await initializeDriveKey(signer, pubkey);
    addSecret(created.entry.secretKeyHex, created.created_at);
    rememberPayload(created.encryptedContent, created.created_at);
    persistCache();
  }
  // else: the retry above found the key — a returning user whose key lives
  // outside the fixed relay set. Nothing left to do here.
}

async function buildDriveKeyring(): Promise<DriveKeyEntry[]> {
  const signer = await signerManager.getSigner();
  const pubkey = await signer.getPublicKey();

  const keyring: DriveKeyEntry[] = [];
  const seenSecrets = new Set<string>();
  const secretTimestamps = new Map<string, number>();
  const collectedPayloads: CachedPayload[] = [];
  const seenPayloadContents = new Set<string>();

  const addSecret = (secretKeyHex: string, createdAt: number): boolean => {
    if (!HEX_64.test(secretKeyHex)) return false;
    if (seenSecrets.has(secretKeyHex)) {
      if (createdAt > (secretTimestamps.get(secretKeyHex) ?? 0)) {
        secretTimestamps.set(secretKeyHex, createdAt);
      }
      return false;
    }
    seenSecrets.add(secretKeyHex);
    secretTimestamps.set(secretKeyHex, createdAt);
    keyring.push({ secretKeyHex, ...deriveKeyMaterial(secretKeyHex) });
    return true;
  };

  const rememberPayload = (content: string, createdAt: number) => {
    if (seenPayloadContents.has(content)) return;
    seenPayloadContents.add(content);
    collectedPayloads.push({ content, created_at: createdAt });
  };

  const tryDecrypt = async (content: string): Promise<string[] | null> => {
    try {
      return await decryptDriveKeyPayload(content, signer, pubkey);
    } catch (e) {
      console.warn("[DriveKey] Failed to decrypt a Drive Key payload", e);
      return null;
    }
  };

  const persistCache = () => {
    // Fire-and-forget: a cache write must NEVER block returning the keyring
    // (and therefore file loading). savePayloadCache swallows its own errors.
    void savePayloadCache(pubkey, collectedPayloads);
  };

  // Tracks the pubkey set finalizeActiveKey last announced, so a second call
  // (the warm-cache path calls it once synchronously, then again after
  // syncWithRelays reconciles) only notifies when the set actually grew or
  // changed — not on every routine call.
  let lastAnnouncedPubkeys: string | null = null;

  const finalizeActiveKey = () => {
    // Newest key first, so new uploads use the most recent key (matching other
    // devices) and callers can default to keyring[0].
    keyring.sort(
      (a, b) =>
        (secretTimestamps.get(b.secretKeyHex) ?? 0) -
        (secretTimestamps.get(a.secretKeyHex) ?? 0),
    );
    activeSecretKeyHex = keyring[0]?.secretKeyHex ?? null;

    // Persist the (public, non-sensitive) drive pubkeys so a cold start can
    // declare the file-index author filter immediately, before the signer has
    // decrypted anything. This runs on every path (unlike persistCache, which
    // the warm-cache path never reaches), so it's the one place a cold-start
    // reader can rely on being kept current.
    if (keyring.length > 0) {
      void saveCachedDrivePubkeys(
        pubkey,
        keyring.map((k) => k.publicKey),
      );
    }

    const currentPubkeys = keyring
      .map((k) => k.publicKey)
      .sort()
      .join(",");
    if (lastAnnouncedPubkeys !== null && currentPubkeys !== lastAnnouncedPubkeys) {
      notifyDriveKeysChanged();
    }
    lastAnnouncedPubkeys = currentPubkeys;
  };

  // --- 1. Local cache ----------------------------------------------------
  for (const { content, created_at } of await loadPayloadCache(pubkey)) {
    rememberPayload(content, created_at);
    const secrets = await tryDecrypt(content);
    secrets?.forEach((secret) => addSecret(secret, created_at));
  }

  if (keyring.length > 0) {
    console.log(`[DriveKey] Restored ${keyring.length} key(s) from local cache`);
  }
  const hadCachedKeys = keyring.length > 0;

  // Decrypts and folds a batch of Drive Key events into the in-progress
  // keyring/payload cache. Factored out so the retry below (after
  // identityHistory potentially discovers where else to look) shares
  // exactly the same ingestion logic as the first attempt, rather than a
  // second near-copy of this loop.
  const ingestDriveKeyEvents = async (events: NostrEvent[]): Promise<void> => {
    for (const event of events) {
      rememberPayload(event.content, event.created_at);
      const secrets = await tryDecrypt(event.content);
      secrets?.forEach((secret) => addSecret(secret, event.created_at));
    }
  };

  // --- 2. Reconcile with relays -------------------------------------------
  const syncWithRelays = async () => {
    const events = await fetchDriveKeyEvents(pubkey); // never rejects — may resolve empty
    await ingestDriveKeyEvents(events);

    // Persist whatever we now hold so the next cold start doesn't need relays.
    persistCache();

    // --- 3. First-time-user handling ---
    if (keyring.length === 0) {
      await resolveEmptyKeyring(pubkey, signer, events, {
        getKeyringLength: () => keyring.length,
        addSecret,
        rememberPayload,
        ingestDriveKeyEvents,
        persistCache,
      });
    }

    finalizeActiveKey();
  };

  if (hadCachedKeys) {
    // Returning user: never block startup, never risk a create-key prompt.
    finalizeActiveKey();
    void syncWithRelays().catch((e) =>
      console.warn("[DriveKey] Background relay sync failed", e),
    );
  } else {
    // Cold cache: we must wait for relays to give us the key, confirm via
    // identityHistory that this is genuinely a first-time user, or throw
    // (unreachable network, or an existing-but-unreadable key — either way,
    // no prompt).
    await syncWithRelays();
  }

  cachedKeyring = keyring;
  cachedPubkey = pubkey;

  console.log(`[DriveKey] Keyring ready with ${keyring.length} key(s)`);
  return keyring;
}

// Guards refreshDriveKeyring against overlapping calls and against firing on
// every rapid visibilitychange toggle — this is a background top-up, not
// something that needs to run more than about once a minute even if the tab
// is switched to and from repeatedly.
let refreshInFlight: Promise<void> | null = null;
let lastRefreshAt = 0;
const MIN_REFRESH_INTERVAL_MS = 60_000;

/**
 * Re-checks relays for Drive Key secrets beyond what's already cached,
 * WITHOUT ever resolving from scratch or risking a mint decision — this only
 * ever ADDS keys to an already-resolved keyring, the same thing
 * buildDriveKeyring's own background sync (the `hadCachedKeys` branch) does
 * once, on the very first resolution of a session.
 *
 * That "once" is the gap this fills: getDriveKeyring()'s fast path returns
 * `cachedKeyring` forever after that, with no mechanism to ever recheck
 * relays again for the rest of the page's life — not when a relay that was
 * unreachable at boot reconnects, and not when a recovery (restoreDriveKey)
 * published from another device/tab lands afterward. A tab that resolved
 * its keyring before either of those happened is otherwise stuck with that
 * answer until a full reload — observed directly: one browser tab correctly
 * holding 2 keys after a recovery, a second tab (resolved earlier, separate
 * storage) still stuck on the pre-recovery 1.
 *
 * Wired to fire when the tab regains visibility (see the listener below) —
 * the same "did something change while we were away" pattern
 * usePendingNativeImports.ts already uses for pending imports, not a blind
 * poll. A no-op if nothing has resolved yet (buildDriveKeyring will run
 * naturally) or the signed-in identity has changed since.
 */
export async function refreshDriveKeyring(): Promise<void> {
  if (!cachedKeyring || !cachedPubkey) return;
  if (cachedPubkey !== signerManager.getPubkey()) return;
  if (refreshInFlight) return refreshInFlight;
  if (Date.now() - lastRefreshAt < MIN_REFRESH_INTERVAL_MS) return;

  const pubkey = cachedPubkey;
  refreshInFlight = (async () => {
    try {
      const signer = await signerManager.getSigner();
      const events = await fetchDriveKeyEvents(pubkey);
      // Re-check after the await: a sign-out/switch or a fresh
      // buildDriveKeyring could have run while this was in flight.
      if (events.length === 0 || !cachedKeyring || cachedPubkey !== pubkey) return;

      const seenSecrets = new Set(cachedKeyring.map((k) => k.secretKeyHex));
      let changed = false;

      for (const event of events) {
        let secrets: string[] | null;
        try {
          secrets = await decryptDriveKeyPayload(event.content, signer, pubkey);
        } catch (e) {
          console.warn("[DriveKey] Refresh: failed to decrypt a payload", e);
          continue;
        }
        secrets?.forEach((secretKeyHex) => {
          if (!HEX_64.test(secretKeyHex) || seenSecrets.has(secretKeyHex)) return;
          seenSecrets.add(secretKeyHex);
          cachedKeyring!.push({ secretKeyHex, ...deriveKeyMaterial(secretKeyHex) });
          changed = true;
        });
      }

      if (changed) {
        console.log(
          `[DriveKey] Background refresh found additional key(s) — keyring now ${cachedKeyring.length}`,
        );
        void saveCachedDrivePubkeys(pubkey, cachedKeyring.map((k) => k.publicKey));
        notifyDriveKeysChanged();
      }
    } catch (e) {
      console.warn("[DriveKey] Background refresh failed", e);
    } finally {
      lastRefreshAt = Date.now();
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      void refreshDriveKeyring();
    }
  });
}

/**
 * The conversation keys for every Drive Key. Try each one when decrypting file
 * metadata until the NIP-44 MAC validates.
 */
export async function getDriveConversationKeys(): Promise<Uint8Array[]> {
  const keyring = await getDriveKeyring();
  return keyring.map((entry) => entry.conversationKey);
}

/**
 * The full active Drive Key entry (secret, pubkey, conversation key), resolved
 * exactly once. fileIndex.ts uses this rather than separately resolving the
 * conversation key and the secret, because each independent lookup re-resolves
 * "the active key", and a background syncWithRelays() can reassign the active
 * key between two such calls — producing content encrypted under one key but
 * authored (signed) by another.
 */
export async function getActiveDriveKey(): Promise<DriveKeyEntry> {
  return getActiveEntry();
}

/**
 * Looks up a specific Drive Key by its public half, from anywhere in the
 * keyring — not just the active one. Needed wherever an operation must sign
 * with the SAME key that authored some earlier event (e.g. revoking a share
 * or superseding a file published before a key rotation): the active key at
 * the time of the operation may no longer be the key that authored it, and a
 * kind-5 or a superseding addressable event signed by the wrong key simply
 * can't touch that coordinate. Returns null (never throws) if this device's
 * keyring doesn't hold the secret for `pubkey`.
 */
export async function getDriveKeyByPubkey(pubkey: string): Promise<DriveKeyEntry | null> {
  const keyring = await getDriveKeyring();
  return keyring.find((entry) => entry.publicKey === pubkey) ?? null;
}

/** The pubkeys of every Drive Key the user has ever published — the file index
 *  read filter subscribes to all of them, since older files may still carry an
 *  older (rotated) key's pubkey as their event author. */
export async function getDriveKeyPubkeys(): Promise<string[]> {
  const keyring = await getDriveKeyring();
  return keyring.map((entry) => entry.publicKey);
}

/**
 * Detects the drive-key-mint hazard AFTER the fact: a drive pubkey this
 * device has recorded before for `identityPubkey`, that the CURRENT keyring
 * no longer resolves to a secret for. That gap is exactly what happens when
 * a later mint replaces an earlier key on the relays (see
 * {@link restoreDriveKey}'s doc comment) — the old pubkey's files become
 * unreachable, but this device still remembers having seen that pubkey.
 *
 * Only catchable because {@link saveCachedDrivePubkeys} accumulates a union
 * rather than overwriting — an overwrite would erase this exact evidence at
 * the moment the key is lost. Returns [] when nothing looks lost (including
 * a genuine first-time user, who has never recorded anything here).
 *
 * Intended for a startup check that surfaces a warning banner; does not
 * throw on its own (network/signer failures inside getDriveKeyPubkeys
 * propagate, but a caller driving a banner should treat that the same as
 * "couldn't check right now" rather than "definitely fine").
 */
export async function findOrphanedDrivePubkeys(identityPubkey: string): Promise<string[]> {
  const everSeen = await getCachedDrivePubkeys(identityPubkey);
  if (everSeen.length === 0) return [];
  const current = new Set(await getDriveKeyPubkeys());
  return everSeen.filter((p) => !current.has(p));
}

async function getActiveEntry(): Promise<DriveKeyEntry> {
  const keyring = await getDriveKeyring();
  if (keyring.length === 0) {
    throw new Error("No Drive Key available");
  }

  // Reuse the cached active secret if it's still in the keyring; else newest.
  const active =
    (activeSecretKeyHex &&
      keyring.find((k) => k.secretKeyHex === activeSecretKeyHex)) ||
    keyring[0]!;
  activeSecretKeyHex = active.secretKeyHex;
  return active;
}

/**
 * Encrypts, signs, and publishes ONE Drive Key event carrying `activeSecretHex`
 * as the active key (`encryptionKey`) and `previousKeys` alongside it. Used by
 * {@link initializeDriveKey} to create a first-time user's key. Throws if no
 * relay accepts the publish — this is deliberately loud, since the Drive Key
 * event is a replaceable kind (one per identity, per relay): a silently-failed
 * publish here can leave a device unable to find its own key later, or —
 * if this is ever called with `previousKeys` again — orphan whichever secrets
 * didn't make it into the new event, since publishing one erases the last.
 */
async function publishDriveKeyPayload(
  signer: Awaited<ReturnType<typeof signerManager.getSigner>>,
  pubkey: string,
  activeSecretHex: string,
  previousKeys: string[],
): Promise<{ encryptedContent: string; created_at: number }> {
  if (!signer.nip44Encrypt) {
    throw new Error("Signer does not support NIP-44 encryption");
  }

  // Payload format matches the NIP: a JSON object, not array-of-tags.
  const payload: { encryptionKey: string; previousKeys?: string[] } = {
    encryptionKey: activeSecretHex,
  };
  if (previousKeys.length > 0) {
    payload.previousKeys = previousKeys;
  }

  // Encrypt the payload to the user themselves using their Main Identity Signer.
  const encryptedContent = await signer.nip44Encrypt(pubkey, JSON.stringify(payload));

  const created_at = Math.floor(Date.now() / 1000);
  const event: NostrEvent = {
    kind: METADATA_KIND,
    pubkey,
    created_at,
    tags: [
      ["d", getDriveKeyDTag(pubkey)],
      ["client", "formstr-drive"],
    ],
    content: encryptedContent,
  };

  const signedEvent = await signer.signEvent(event);
  const result = await dataLayer.publishEvent(signedEvent);
  if (!result.ok) {
    throw new Error(
      "Failed to publish your Drive Key to any relay. Please check your connection and try again.",
    );
  }
  console.log(
    `[DriveKey] Published Drive Key event (${result.accepted}/${result.total} relays)`,
  );

  return { encryptedContent, created_at };
}

async function initializeDriveKey(
  signer: Awaited<ReturnType<typeof signerManager.getSigner>>,
  pubkey: string,
): Promise<{ entry: DriveKeyEntry; encryptedContent: string; created_at: number }> {
  console.log("[DriveKey] Generating new Drive Key");

  const secretKey = generateSecretKey();
  const secretKeyHex = bytesToHex(secretKey);

  const { encryptedContent, created_at } = await publishDriveKeyPayload(
    signer,
    pubkey,
    secretKeyHex,
    [],
  );

  return {
    entry: { secretKeyHex, ...deriveKeyMaterial(secretKeyHex) },
    encryptedContent,
    created_at,
  };
}

/**
 * Recovery primitive for the Drive Key mint hazard the guards elsewhere in
 * this module exist to prevent: a second Drive Key minted on top of a
 * working one replaces it (the event is replaceable — one per identity),
 * orphaning every file under the original with no way back, since
 * {@link initializeDriveKey} always published with `previousKeys: []`.
 *
 * Republishes with `activeSecretHex` as the active key and
 * `previousSecretsHex` carried alongside it in one event, so a subsequent
 * fetch finds BOTH: {@link getDriveConversationKeys} returns every key in the
 * keyring for decryption, and `observeFileIndex` (fileIndex.ts) already
 * subscribes to every drive pubkey the keyring resolves to. Nothing under
 * either key stays orphaned once this succeeds.
 *
 * To recover from an orphaning mint: pass the ORIGINAL (files-bearing) key
 * as `activeSecretHex` — new uploads should keep using it — and the
 * replacing key as one of `previousSecretsHex`, so this publish (being
 * newer) wins over the orphaning one by replaceable-event ordering.
 *
 * Requires a reachable relay: {@link publishDriveKeyPayload} throws if no
 * relay accepts the publish, same as a fresh mint.
 */
export async function restoreDriveKey(
  activeSecretHex: string,
  previousSecretsHex: string[] = [],
): Promise<void> {
  if (!HEX_64.test(activeSecretHex)) {
    throw new Error("Invalid Drive Key secret: expected 64 hex characters.");
  }
  const validPrevious = previousSecretsHex.filter(
    (k) => HEX_64.test(k) && k !== activeSecretHex,
  );

  const signer = await signerManager.getSigner();
  const pubkey = await signer.getPublicKey();

  const { encryptedContent, created_at } = await publishDriveKeyPayload(
    signer,
    pubkey,
    activeSecretHex,
    validPrevious,
  );

  // Rebuild the in-memory keyring directly from what was just published
  // rather than waiting for it to round-trip back through a relay
  // subscription — that publish IS now authoritative, and waiting would
  // race the next caller (e.g. a standing observeFileIndex) against relay
  // latency for no reason.
  const keyring: DriveKeyEntry[] = [activeSecretHex, ...validPrevious].map(
    (secretKeyHex) => ({ secretKeyHex, ...deriveKeyMaterial(secretKeyHex) }),
  );

  cachedKeyring = keyring;
  cachedPubkey = pubkey;
  activeSecretKeyHex = activeSecretHex;

  await savePayloadCache(pubkey, [{ content: encryptedContent, created_at }]);
  await saveCachedDrivePubkeys(pubkey, keyring.map((k) => k.publicKey));

  // Callers with a standing file-index subscription (fileIndex.ts) need to
  // re-declare their author filter now that the keyring includes a pubkey
  // (the previously-orphaning key) it may not have been watching before.
  notifyDriveKeysChanged();

  console.log(
    `[DriveKey] Restored keyring: ${keyring.length} key(s), active=${keyring[0]!.publicKey}`,
  );
}

