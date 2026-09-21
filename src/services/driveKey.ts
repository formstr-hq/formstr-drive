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
    cachedStatus = null;
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
/**
 * `fetchDriveKeyEvents`'s result, plus whether the network itself was ever
 * actually given a chance to answer (see `networkConsulted` below) — needed
 * by `resolveEmptyKeyring`'s retry trigger, which today only fires on a
 * fully empty keyring and therefore never runs for "found 1 key when 2
 * exist" (the local cache answered, the network never got asked).
 */
interface DriveKeyFetchResult {
  events: NostrEvent[];
  networkConsulted: boolean;
}

async function fetchDriveKeyEvents(pubkey: string): Promise<DriveKeyFetchResult> {
  return new Promise((resolve) => {
    let settled = false;
    let localEoseAt: number | null = null;
    let networkConsulted = false;
    const found = new Map<string, NostrEvent>();

    const finish = () => {
      if (settled) return;
      settled = true;
      handle.unobserve();
      resolve({ events: sortNewestFirst([...found.values()]), networkConsulted });
    };

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
          // Anything arriving after the local-cache EOSE (below) came from
          // the network, not the replay — that's the only signal available
          // that the network was actually consulted, since observe()'s EOSE
          // fires on local-cache replay only and upstream relay EOSE is
          // never propagated to the main thread (see the doc comment above
          // this function).
          if (localEoseAt !== null) networkConsulted = true;
        },
        onEose: () => {
          // This EOSE is the local-cache replay finishing, NOT proof the
          // network has answered — resolving here (as this used to) lets a
          // stale cached copy of the one replaceable Drive Key event win the
          // race and tears the interest down (unobserve) before a relay can
          // deliver the newer version. Instead, hold the interest open for a
          // settle window so the network gets an actual chance.
          if (localEoseAt === null) localEoseAt = Date.now();
        },
      },
    );

    // The network-settle window: after the local replay's EOSE, give
    // upstream relays a few seconds to answer before accepting whatever the
    // cache had as final. Nothing blocks the UI on this any more (the read
    // path never awaits this synchronously from a user-visible spinner), so
    // it can afford to be patient rather than snapshotting the first answer.
    const NETWORK_SETTLE_MS = 3000;
    const checkSettle = setInterval(() => {
      if (localEoseAt !== null && Date.now() - localEoseAt >= NETWORK_SETTLE_MS) {
        clearInterval(checkSettle);
        finish();
      }
    }, 250);

    // Safety timeout — flaky mobile relays get a generous window even if the
    // local EOSE itself never fires (e.g. a completely cold worker).
    setTimeout(() => {
      clearInterval(checkSettle);
      finish();
    }, 20000);
  });
}

function sortNewestFirst<T extends { created_at: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => b.created_at - a.created_at);
}

/**
 * Resolve the full Drive Key keyring for the current user — read-only, never
 * creates anything.
 *
 * Order of operations, and why:
 *   1. Load the cached ENCRYPTED payloads and decrypt every one with the
 *      signer. This lets a returning user open their drive without waiting on
 *      relays, as long as the signer (e.g. the local nsec) is available.
 *   2. Reconcile with relays. If we already had cached keys this runs in the
 *      background so it never blocks startup; otherwise we await it.
 *   3. If the keyring is still empty after that, classify WHY (see
 *      classifyEmptyKeyring) rather than throwing or prompting: "proven
 *      empty" (safe for ensureDriveKeyMinted to later act on) is kept
 *      strictly separate from "genuinely don't know" (unreachable network,
 *      or a found-but-unusable event this build can't read) — the latter
 *      must never be treated as permission to create anything.
 */
// -----------------------------------------------------------------------------
// Reading a keyring must never be able to CREATE one. Every read consumer
// (getDriveConversationKeys, getActiveDriveKey, getDriveKeyPubkeys,
// getDriveKeyByPubkey) funnels through getDriveKeyring() below, which used to
// mint on a cold cache — meaning simply opening the drive could create and
// publish a key. DriveKeyStatus separates "what did we find" from "is it safe
// to create one", and only ensureDriveKeyMinted() (below, near
// initializeDriveKey) is ever allowed to act on that safety verdict.
// -----------------------------------------------------------------------------
export type DriveKeyStatus =
  | { kind: "ready"; keyring: DriveKeyEntry[] }
  // No key exists anywhere reachable, and that absence is PROVEN (see
  // identityHistory.ts's proveRelayCoverage) — safe for ensureDriveKeyMinted
  // to act on. Never entered on a guess or a timeout.
  | { kind: "empty-confirmed" }
  // Genuinely don't know: unreachable network, a found-but-unusable event, or
  // an identity with history but no locatable key. Must NEVER be treated as
  // "safe to create a key" — that was the entire mint hazard.
  | { kind: "unresolved"; reason: string };

// Last resolved status, alongside the same cachedKeyring/cachedPubkey the rest
// of this module already reads directly (self-heal, refreshDriveKeyring). Kept
// in sync with cachedKeyring/cachedPubkey at every write site below.
let cachedStatus: DriveKeyStatus | null = null;

// In-flight keyring resolution, so concurrent callers on a cold in-memory
// cache share one resolution instead of each running its own full decrypt.
// Without this, a single launch's getDriveConversationKeys/getDriveKeyPubkeys/
// getActiveDriveKey calls (fileIndex.ts's observeFileIndex fires the first two
// back-to-back) each miss the fast path and independently decrypt the same
// cached payloads — with a remote signer (Amber) each decrypt is its own
// inter-app round trip, so this turns N round trips into 1.
//
// Keyed by the pubkey the resolution started for: an account switch mid-flight
// must not hand the new account the previous one's in-flight promise.
let inFlightResolve: { pubkey: string | undefined; promise: Promise<DriveKeyStatus> } | null = null;

async function resolveDriveKeyStatusCached(): Promise<DriveKeyStatus> {
  // Fast path: in-memory cache, but only for the SAME user still signed in,
  // and only for a STABLE conclusion. "ready" and "empty-confirmed" are both
  // proven and don't need re-checking. "unresolved" must NOT be cached here —
  // it's a statement about right-now connectivity, not about the identity
  // (identityHistory.ts's own "never cache unknown" rule, which this mirrors)
  // — caching it would mean a relay that was unreachable at the first call
  // stays "unresolved" forever for the rest of the page's life, even after it
  // recovers, since nothing would ever re-run the actual check again.
  if (
    cachedStatus &&
    cachedStatus.kind !== "unresolved" &&
    cachedPubkey &&
    cachedPubkey === signerManager.getPubkey()
  ) {
    return cachedStatus;
  }

  const currentPubkey = signerManager.getPubkey();
  if (inFlightResolve && inFlightResolve.pubkey === currentPubkey) {
    return inFlightResolve.promise;
  }

  const promise = resolveDriveKeyStatus();
  inFlightResolve = { pubkey: currentPubkey, promise };
  try {
    return await promise;
  } finally {
    if (inFlightResolve?.promise === promise) {
      inFlightResolve = null;
    }
  }
}

/** Read-only: resolves the keyring if one exists. NEVER creates one — see
 *  {@link ensureDriveKeyMinted} for the one place that's allowed to. */
export async function getDriveKeyring(): Promise<DriveKeyEntry[]> {
  const status = await resolveDriveKeyStatusCached();
  return status.kind === "ready" ? status.keyring : [];
}

/** Same resolution as {@link getDriveKeyring}, but exposes the full verdict —
 *  UI callers need to tell "empty-confirmed" (proven, safe) apart from
 *  "unresolved" (unknown, must not be presented as empty). */
export async function getDriveKeyStatus(): Promise<DriveKeyStatus> {
  return resolveDriveKeyStatusCached();
}

/** The pieces of resolveDriveKeyStatus's in-progress state classifyEmptyKeyring
 *  needs — passed explicitly (rather than closing over resolveDriveKeyStatus's
 *  locals) so this stays a normal, independently readable top-level function
 *  instead of more nested closure state. */
interface EmptyKeyringDeps {
  getKeyringLength: () => number;
  ingestDriveKeyEvents: (events: NostrEvent[]) => Promise<void>;
  persistCache: () => void;
}

/**
 * Runs only when the first Drive Key fetch left the keyring empty: classifies
 * why — "genuinely new, proven" vs "don't actually know" — WITHOUT ever
 * creating anything. This function cannot mint; see {@link ensureDriveKeyMinted}
 * for the one place that's allowed to, and only ever on this function's
 * "empty-confirmed" verdict.
 *
 * Returns `null` when the retry below actually found the key — the caller
 * re-checks `getKeyringLength()` itself and treats that case as "found",
 * never reading a verdict for it.
 */
async function classifyEmptyKeyring(
  pubkey: string,
  firstAttemptEvents: NostrEvent[],
  deps: EmptyKeyringDeps,
): Promise<{ kind: "empty-confirmed" } | { kind: "unresolved"; reason: string } | null> {
  const { getKeyringLength, ingestDriveKeyEvents, persistCache } = deps;

  // A Drive Key event existing at all — regardless of WHY we couldn't turn
  // it into a usable key (signer failure, or a payload shape this build
  // doesn't recognize) — means a key already exists. Minting a replacement
  // would publish over it: the Drive Key event is replaceable (one per
  // identity), so a second mint doesn't coexist with the first, it destroys
  // it on every relay that accepts the publish, with no way back (see
  // restoreDriveKey's doc comment for the incident this guards against).
  // "Can't read it" must therefore never be treated the same as "doesn't
  // exist" — the two used to be conflated here (gated on
  // `sawGenuineDecryptError`, which a recognized-but-unsupported payload
  // shape never sets), which is exactly the gap a format change walked
  // through undetected.
  if (firstAttemptEvents.length > 0) {
    return {
      kind: "unresolved",
      reason:
        "Found a Drive Key on this account, but this app couldn't read it (an unrecognized format " +
        "or a decrypt failure). Retrying, or opening the drive on a device that already has it, " +
        "may resolve this automatically.",
    };
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
    const retry = await fetchDriveKeyEvents(pubkey);
    await ingestDriveKeyEvents(retry.events);
    persistCache();
  }

  if (getKeyringLength() > 0) {
    // The retry above found it. Not empty any more — caller re-checks length
    // and takes the "found" path; nothing further to classify.
    return null;
  }

  if (identityHistory === "new") {
    // Proven — see proveRelayCoverage: every configured relay answered a
    // control query just now, and none of them carries an event for this
    // pubkey under any kind. Safe for ensureDriveKeyMinted to act on later;
    // this function itself still creates nothing.
    return { kind: "empty-confirmed" };
  }

  return {
    kind: "unresolved",
    reason:
      identityHistory === "existing"
        ? "This account has used Nostr before, but no Drive Key could be found for it yet, even " +
            "after checking its own relay list. This should resolve automatically once the network " +
            "is reachable — nothing will be created in the meantime."
        : "Couldn't reach enough of the network to tell whether this account already has a Drive " +
            "Key. Retrying automatically; nothing will be created until that's confirmed one way " +
            "or the other.",
  };
}

/** Resolves the keyring for the current signed-in user. Read-only: on an
 *  empty result this reports a verdict (see {@link DriveKeyStatus}) but never
 *  creates anything itself — {@link ensureDriveKeyMinted} is the only path
 *  that may act on an "empty-confirmed" verdict. */
async function resolveDriveKeyStatus(): Promise<DriveKeyStatus> {
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
  // Returns the empty-keyring verdict when the keyring is STILL empty after
  // this run, or null when keys were found (by the first fetch, by
  // classifyEmptyKeyring's own retry, or were already cached). Only the
  // caller of the AWAITED (cold-cache) call below reads this — the
  // backgrounded warm-cache call's verdict, if any, doesn't affect what
  // resolveDriveKeyStatus returns, since a warm cache already has entries.
  const syncWithRelays = async (): Promise<
    { kind: "empty-confirmed" } | { kind: "unresolved"; reason: string } | null
  > => {
    const fetchResult = await fetchDriveKeyEvents(pubkey); // never rejects — may resolve empty
    await ingestDriveKeyEvents(fetchResult.events);

    // Persist whatever we now hold so the next cold start doesn't need relays.
    persistCache();

    // --- 3. First-time-user classification (never creates anything) ---
    let emptyVerdict: { kind: "empty-confirmed" } | { kind: "unresolved"; reason: string } | null = null;
    if (keyring.length === 0) {
      emptyVerdict = await classifyEmptyKeyring(pubkey, fetchResult.events, {
        getKeyringLength: () => keyring.length,
        ingestDriveKeyEvents,
        persistCache,
      });
    }

    finalizeActiveKey();

    // --- 4. Self-heal a relay event narrower than what this device knows ---
    // This device can know MORE than the network currently does: an earlier
    // accidental mint (see restoreDriveKey's doc comment) replaces the real
    // key's event on relays with a narrower one, but a device that already
    // had the real key cached locally keeps decrypting it fine regardless —
    // it just never had a reason to WRITE that knowledge back. Verified
    // directly: one browser resolving 2 keys from its own local cache while
    // relays carry only 1, and no amount of another device re-querying
    // those same relays can ever converge, because there is genuinely
    // nothing wider on the network to fetch. Only refreshDriveKeyring
    // (re-fetching relays) cannot fix this class of gap; only publishing
    // can.
    //
    // Guarded to only ever ADD, never replace under uncertainty:
    //   - the newest relay event must decrypt successfully — if it can't be
    //     read, its contents are unknown, and publishing over an unreadable
    //     event is the same hazard the original mint caused
    //   - what's resolved locally must be a STRICT superset of what that
    //     event carries — never publish a subset, and only publish when
    //     every secret the network currently has is also one we hold
    if (fetchResult.events.length > 0 && keyring.length > 0) {
      const newestEvent = fetchResult.events[0]!; // fetchDriveKeyEvents returns newest-first
      const publishedSecrets = await tryDecrypt(newestEvent.content);
      if (publishedSecrets) {
        const resolvedSecrets = keyring.map((k) => k.secretKeyHex);
        const isStrictSuperset =
          publishedSecrets.length < resolvedSecrets.length &&
          publishedSecrets.every((s) => resolvedSecrets.includes(s));

        if (isStrictSuperset) {
          try {
            const active = activeSecretKeyHex!;
            const previous = resolvedSecrets.filter((s) => s !== active);
            const { encryptedContent, created_at } = await publishDriveKeyPayload(
              signer,
              pubkey,
              active,
              previous,
            );
            rememberPayload(encryptedContent, created_at);
            persistCache();
            console.log(
              `[DriveKey] Self-heal: published a merged key event carrying ${resolvedSecrets.length} ` +
                `key(s) — the relay's previous event only carried ${publishedSecrets.length}.`,
            );
          } catch (e) {
            console.warn("[DriveKey] Self-heal publish failed", e);
          }
        }
      }
    }

    return emptyVerdict;
  };

  let emptyVerdict: { kind: "empty-confirmed" } | { kind: "unresolved"; reason: string } | null = null;

  if (hadCachedKeys) {
    // Returning user: never block startup, never risk creating anything.
    finalizeActiveKey();
    void syncWithRelays().catch((e) =>
      console.warn("[DriveKey] Background relay sync failed", e),
    );
  } else {
    // Cold cache: wait for relays, get a real verdict (found / proven-empty /
    // unresolved) — no throwing, no dialog, whatever the outcome.
    emptyVerdict = await syncWithRelays();
  }

  cachedKeyring = keyring;
  cachedPubkey = pubkey;

  console.log(`[DriveKey] Keyring ready with ${keyring.length} key(s)`);

  const status: DriveKeyStatus =
    keyring.length > 0
      ? { kind: "ready", keyring }
      : emptyVerdict ?? { kind: "unresolved", reason: "Still checking for your Drive Key…" };
  cachedStatus = status;
  return status;
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
 * resolveDriveKeyStatus's own background sync (the `hadCachedKeys` branch)
 * does once, on the very first resolution of a session.
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
 * poll. A no-op if nothing has resolved yet (resolveDriveKeyStatus will run
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
      const { events } = await fetchDriveKeyEvents(pubkey);
      // Re-check after the await: a sign-out/switch or a fresh
      // resolveDriveKeyStatus could have run while this was in flight.
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
        cachedStatus = { kind: "ready", keyring: cachedKeyring };
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
  // `visibilitychange` only fires when a tab is actually occluded (minimized,
  // backgrounded, switched away from within one window) — two windows tiled
  // side by side on screen, neither ever hidden, can click back and forth
  // between them without it ever firing at all. `window.focus` fires on that
  // exact OS-level "this window became active" transition regardless of
  // on-screen visibility, so it's the trigger that actually covers that case.
  // Both listeners are kept — mobile tab-backgrounding needs the first,
  // desktop window-switching needs the second, and refreshDriveKeyring's own
  // throttling makes firing both on the same transition harmless.
  window.addEventListener("focus", () => {
    void refreshDriveKeyring();
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

// Per-pubkey guard against two CONCURRENT calls both trying to mint at once —
// deliberately NOT a "never try again this session" latch: a call that bails
// on status.kind !== "empty-confirmed" (relays not yet fully reachable) must
// be retriable once conditions improve, e.g. the user hitting the degraded
// state's Retry button, or a relay that comes back later in the same page
// load. The persisted marker below (recordMinted/hasMintedBefore) is the
// separate guard against ever SUCCEEDING at minting twice for one identity.
const mintInFlight = new Set<string>();

async function hasMintedBefore(pubkey: string): Promise<boolean> {
  const marker = await getStoredItem<Record<string, boolean>>(STORAGE_KEYS.DRIVE_KEY_MINTED_MARKER, {});
  return marker[pubkey] === true;
}

async function recordMinted(pubkey: string): Promise<void> {
  const marker = await getStoredItem<Record<string, boolean>>(STORAGE_KEYS.DRIVE_KEY_MINTED_MARKER, {});
  marker[pubkey] = true;
  await setStoredItem(STORAGE_KEYS.DRIVE_KEY_MINTED_MARKER, marker);
}

/**
 * The ONE place in this module allowed to create a Drive Key. Intended to be
 * called once per signed-in session (fire-and-forget, non-blocking — see
 * FileIndexProvider.tsx's wiring) as soon as a "empty-confirmed" verdict is
 * available. Silent: no dialog, no confirmation. Mints ONLY on
 * resolveDriveKeyStatus's "empty-confirmed" verdict — proven via
 * identityHistory.ts's proveRelayCoverage, i.e. every configured relay
 * answered a control query just now and none of them carries anything for
 * this pubkey under any kind. Never called from a read path, never on a
 * timeout, never from a UI confirmation click.
 *
 * Doubly guarded against minting twice for one identity: an in-memory
 * concurrency lock (rejects only calls that overlap an attempt already in
 * flight, not later independent calls) plus a persisted per-pubkey marker
 * (survives a reload — a second "empty-confirmed" verdict arriving later in
 * the same identity's life, however unlikely in practice, must still refuse
 * to mint again).
 *
 * Callers should call this again whenever a fresh verdict becomes available
 * (FileIndexProvider.tsx does, from onKeyStatus) rather than assuming one
 * call is the only chance — a bail on "not yet empty-confirmed" is not a
 * permanent no, it's "ask again once you know more".
 */
export async function ensureDriveKeyMinted(): Promise<void> {
  const pubkey = signerManager.getPubkey();
  if (!pubkey) return;
  if (mintInFlight.has(pubkey)) return;
  mintInFlight.add(pubkey);

  try {
    if (await hasMintedBefore(pubkey)) return;

    const status = await getDriveKeyStatus();
    if (status.kind !== "empty-confirmed") return;

    // Re-check right before minting: a concurrent resolution (another read, a
    // background sync, restoreDriveKey from a warning banner) may have found
    // or created a key in the interim, since getDriveKeyStatus() above may
    // itself have taken several seconds.
    if (cachedKeyring && cachedKeyring.length > 0 && cachedPubkey === pubkey) return;

    const signer = await signerManager.getSigner();
    const signerPubkey = await signer.getPublicKey();
    if (signerPubkey !== pubkey) return; // account switched mid-flight

    const created = await initializeDriveKey(signer, pubkey);
    const entry = created.entry;

    cachedKeyring = [entry];
    cachedPubkey = pubkey;
    cachedStatus = { kind: "ready", keyring: cachedKeyring };
    activeSecretKeyHex = entry.secretKeyHex;

    void savePayloadCache(pubkey, [
      { content: created.encryptedContent, created_at: created.created_at },
    ]);
    void saveCachedDrivePubkeys(pubkey, [entry.publicKey]);
    await recordMinted(pubkey);

    console.log("[DriveKey] Minted a new Drive Key (proven first-time user)");
    notifyDriveKeysChanged();
  } catch (e) {
    console.warn("[DriveKey] Failed to mint a new Drive Key", e);
    // Do NOT record the marker on failure — a genuinely new user whose first
    // mint attempt failed (e.g. a network blip) must be allowed to try again.
  } finally {
    mintInFlight.delete(pubkey);
  }
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

