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

async function saveCachedDrivePubkeys(identityPubkey: string, drivePubkeys: string[]): Promise<void> {
  try {
    await withTimeout(
      setStoredItem(STORAGE_KEYS.DRIVE_PUBKEY_CACHE, { pubkey: identityPubkey, drivePubkeys }),
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

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

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
 * empty cache we hold the interest open for a network window; when it closes
 * with nothing found we consult `relayHealth()` to tell "relays reachable, no
 * key exists" apart from "offline" — the local relay's EOSE only covers the
 * cache, not the upstream sync — so we never prompt an existing user to
 * overwrite their key just because they're offline.
 */
async function fetchDriveKeyEvents(pubkey: string): Promise<NostrEvent[]> {
  return new Promise((resolve, reject) => {
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
      void (async () => {
        if (settled) return;
        settled = true;
        handle.unobserve();

        if (found.size > 0) {
          resolve(sortNewestFirst([...found.values()]));
          return;
        }

        try {
          const health = await dataLayer.relayHealth();
          // A single connected relay isn't enough evidence: the Drive Key
          // event lives on whichever relays happened to accept it, and if
          // that's a relay we're NOT currently connected to, one healthy
          // connection elsewhere would look identical to "no key exists" —
          // which is exactly the failure mode that leads to a second key
          // being minted on top of a perfectly good one. Because the Drive Key
          // event is a replaceable kind (one per identity, per relay),
          // publishing that second key erases the first everywhere it lands —
          // so require the network to look real before treating an empty
          // result as trustworthy.
          const connectedCount = health.filter((r) => r.connected).length;
          if (connectedCount >= 2) {
            // Reachable across multiple relays, still nothing published: a
            // genuine first-time user.
            resolve([]);
            return;
          }
        } catch {
          // Health probe failed — treat as offline below.
        }

        reject(
          new Error(
            "Network timeout: could not reach relays to fetch your Drive Key. Please check your connection.",
          ),
        );
      })();
    }, 8000);
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

  // Set only when the signer itself fails (auth/extension problem) — as
  // opposed to decryptDriveKeyPayload returning null for a payload that
  // decrypted fine but doesn't match our expected shape (e.g. an event
  // published in an unsupported/legacy format). Only the former should ever
  // block first-time-user handling below; the latter must be treated the
  // same as "no usable key found" so a stale/incompatible event can't
  // permanently strand the app.
  let sawGenuineDecryptError = false;

  const tryDecrypt = async (content: string): Promise<string[] | null> => {
    try {
      return await decryptDriveKeyPayload(content, signer, pubkey);
    } catch (e) {
      console.warn("[DriveKey] Failed to decrypt a Drive Key payload", e);
      sawGenuineDecryptError = true;
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

  // --- 2. Reconcile with relays -------------------------------------------
  const syncWithRelays = async () => {
    const events = await fetchDriveKeyEvents(pubkey); // rejects if offline

    for (const event of events) {
      rememberPayload(event.content, event.created_at);
      const secrets = await tryDecrypt(event.content);
      secrets?.forEach((secret) => addSecret(secret, event.created_at));
    }

    // Persist whatever we now hold so the next cold start doesn't need relays.
    persistCache();

    // --- 3. First-time-user handling ---
    if (keyring.length === 0) {
      if (events.length > 0 && sawGenuineDecryptError) {
        // Key events exist and the signer itself failed on at least one —
        // a signer/auth problem, NOT a missing key. Never offer to overwrite it.
        throw new Error(
          "Found your Drive Key but couldn't decrypt it. Please reopen the app and try again.",
        );
      }

      // Either no events exist, or every event we found decrypted fine but was
      // in a format we no longer support — treat both the same as a genuine
      // first-time user rather than hard-blocking on a stale/incompatible key.
      const confirmMessage =
        "Drive key not found in relays. Do you want to create a new key?\n\n" +
        "WARNING: If you've used Drive before on another device, any files under that " +
        "device's key will only stay visible if THIS device still has that key too. " +
        "Creating a new one here does not carry those files forward automatically.";
      if (!window.confirm(confirmMessage)) {
        throw new Error("User cancelled drive key creation.");
      }

      const created = await initializeDriveKey(signer, pubkey);
      addSecret(created.entry.secretKeyHex, created.created_at);
      rememberPayload(created.encryptedContent, created.created_at);
      persistCache();
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
    // Cold cache: we must wait for relays to give us the key, tell us there is
    // none (first-time user), or fail (offline -> throws, no prompt).
    await syncWithRelays();
  }

  cachedKeyring = keyring;
  cachedPubkey = pubkey;

  console.log(`[DriveKey] Keyring ready with ${keyring.length} key(s)`);
  return keyring;
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

