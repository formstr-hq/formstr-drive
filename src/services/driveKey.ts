/**
 * The Drive Key: the per-identity secret(s) that encrypt and author every
 * file entry. Stored as ONE replaceable kind-34578 event per identity
 * (d = "0:<pubkey>"), NIP-44-encrypted to the identity itself, carrying the
 * active key plus every earlier one: `{ encryptionKey, previousKeys }`.
 *
 * Because the event is replaceable, every relay — and the local store — keeps
 * only its NEWEST version, and different relays can hold different versions:
 * a relay that was down missed a publish, two devices created a key at the
 * same time, an older build wrote a narrower event. Publishing a version that
 * leaves out a key erases that key from every relay that accepts it, and every
 * file under it becomes unreadable. Everything in this module follows from
 * that, as four rules:
 *
 *  1. The keyring is the UNION of every secret in every version seen
 *     anywhere — this device's payload cache, the local store, and each relay
 *     read directly. It only ever grows while signed in.
 *  2. Read before write, per relay. A Drive Key event is only ever written to
 *     a relay whose current version was read moments earlier and is fully
 *     contained in what's being written, or that answered "none". A relay
 *     that didn't answer, or whose version couldn't be decrypted, is never
 *     written to: it might hold a key we don't know. For the same reason no
 *     Drive Key write goes through the data layer, whose outbox delivers
 *     later to relays nobody read (see relayProbe.ts).
 *  3. Converge. Whenever the union holds a key some relay's version lacks,
 *     write the union there. So divergence of any origin heals the next time
 *     any device that can see both sides syncs — e.g. a key created while an
 *     older one sat on a relay that was down merges as soon as that relay is
 *     back, or as soon as a device that still has the old key cached opens.
 *  4. Create only on proof. A first key is created only when no version is
 *     found anywhere reachable, this device has never held one, and enough of
 *     the relays every Drive Key has always gone to genuinely answered
 *     "none" — and it is written only to the relays that answered.
 */
import { nip44, generateSecretKey, getPublicKey, type Event, type Filter, type VerifiedEvent } from "nostr-tools";
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
import { APP_RELAYS, defaultRelays, mergeRelayLists, normalizeRelayUrl } from "../utils/common";
import { publishToRelays, readRelays, type AuthSigner, type RelayReading } from "./relayProbe";

const METADATA_KIND = 34578;
const RELAY_LIST_KIND = 10002;
const HEX_64 = /^[0-9a-fA-F]{64}$/;
const CACHE_IO_TIMEOUT_MS = 3000;
const RELAY_IO_TIMEOUT_MS = 8000;

// The creation quorum. Every Drive Key ever published went to APP_RELAYS: they
// were the only publish target before the local relay, and they're part of
// the configured set it publishes to now. An existing key therefore sits on at
// least one of these, so at least this many of them must genuinely answer
// "no Drive Key here" before a first one is created.
const CREATE_QUORUM_RELAYS = APP_RELAYS.map(normalizeRelayUrl);
// A write relay from the identity's own NIP-65 list that stayed silent gets one
// longer second chance before a first key is created (nothing is ever written
// to a relay that didn't answer, so a relay that stays silent can't be
// overwritten — it just doesn't block creation forever, which a dead relay in
// someone's list otherwise would).
const WRITE_RELAY_RECHECK_MS = 12_000;
const MIN_EMPTY_QUORUM_ANSWERS = 2;

// Background sync cadence. A sync runs once per sign-in, again when the app
// regains focus (at most this often), and on a backoff for as long as some
// relay hasn't answered — that relay might be holding a key we don't have,
// and the moment it answers is the moment it can be merged.
const SYNC_MIN_INTERVAL_MS = 60_000;
const SYNC_RETRY_DELAYS_MS = [2, 5, 15, 30].map((minutes) => minutes * 60_000);
const SYNC_AFTER_CREATE_MS = 30_000;

// "empty-confirmed" is a proof about a moment ("these relays answered just
// now and none carried a key"), not about the identity — a relay that was
// briefly unreachable can make it stale. Reads may reuse it only this long;
// creation never reuses it at all (it re-resolves right before deciding).
const EMPTY_CONFIRMED_TTL_MS = 30_000;

// A single decrypted Drive Key: the secp256k1 secret plus its derived pubkey
// and conversation key (used directly by NIP-44 v2). Keeping the secret hex
// lets us re-encrypt with it, and sign with it, when saving file metadata.
export interface DriveKeyEntry {
  secretKeyHex: string;
  publicKey: string;
  conversationKey: Uint8Array;
}

/** Why no keyring is available — lets the UI say something specific and
 *  offer the one action that makes sense for each case. */
export type DriveKeyIssue =
  // Resolution hasn't produced an answer yet.
  | "checking"
  // Too few relays answered to decide whether a key exists.
  | "not-enough-relays"
  // A Drive Key version exists but couldn't be decrypted (signer refused or
  // failed, or a format this build doesn't know). Never create over it.
  | "unreadable"
  // This device held a key for this identity before (created one, cached its
  // pubkey or payload), but no relay that answered has it now. Not created
  // automatically; the user may choose to start a new one (startNewDriveKey).
  | "seen-on-device"
  // Creating a first key was attempted and failed (see FileIndexProvider).
  | "create-failed";

export type DriveKeyStatus =
  | { kind: "ready"; keyring: DriveKeyEntry[] }
  // No version found anywhere reachable, and that absence is PROVEN: at least
  // MIN_EMPTY_QUORUM_ANSWERS of the quorum relays sent a real EOSE with no
  // Drive Key. `emptyRelays` is every relay that answered that way — the only
  // relays a first key may be written to (rule 2). Holds equally for a
  // brand-new keypair and for an existing Nostr identity that has never used
  // Drive. Never entered on a guess or a timeout.
  | { kind: "empty-confirmed"; emptyRelays: string[] }
  // Genuinely don't know, or can't proceed. Must NEVER be treated as "safe to
  // create a key".
  | { kind: "unresolved"; reason: string; issue: DriveKeyIssue };

type EmptyKeyringVerdict = Exclude<DriveKeyStatus, { kind: "ready" }>;

const REASONS: Record<Exclude<DriveKeyIssue, "create-failed">, string> = {
  checking: "Still checking for your Drive Key…",
  "not-enough-relays": "Can't reach enough relays to check whether this account already has a Drive Key.",
  unreadable:
    "Found a Drive Key for this account, but couldn't unlock it — the signer failed to decrypt it, " +
    "or it's in a format this version of the app doesn't recognize.",
  "seen-on-device":
    "This device has used a Drive Key for this account before, but it can't be found on any relay that answered.",
};

function unresolved(issue: Exclude<DriveKeyIssue, "create-failed">): EmptyKeyringVerdict {
  return { kind: "unresolved", reason: REASONS[issue], issue };
}

// Cached ENCRYPTED payload (never decrypted key material) plus its timestamp.
interface CachedPayload {
  content: string;
  created_at: number;
}

type Signer = Awaited<ReturnType<typeof signerManager.getSigner>>;

// -----------------------------------------------------------------------------
// Session state — everything known about the signed-in identity's keys. The
// decrypted keys ONLY live here, never in persistent storage, which keeps the
// still-encrypted payloads only.
// -----------------------------------------------------------------------------

interface Session {
  pubkey: string;
  /** The union keyring, active key first. */
  entries: DriveKeyEntry[];
  activeSecret: string | null;
  /** created_at of the version that named `activeSecret` — the newest
   *  version's choice of active key wins, so every device agrees on it. */
  activeAt: number;
  /** Newest signed, decryptable version seen anywhere — re-broadcast as-is
   *  when it already carries every key (no signer prompt needed). */
  newestEvent: Event | null;
  maxSeenCreatedAt: number;
  sawUnreadableVersion: boolean;
  /** The identity's own write relays (NIP-65), as last read from the relays. */
  writeRelays: string[];
  /** Every encrypted version seen this session (content → created_at). */
  payloads: Map<string, number>;
  status: DriveKeyStatus | null;
  statusAt: number;
  /** Relays that refused a Drive Key write this session — not retried. */
  rejectedBy: Set<string>;
  sync: {
    inFlight: Promise<void> | null;
    lastAt: number;
    timer: ReturnType<typeof setTimeout> | null;
    attempt: number;
  };
}

let session: Session | null = null;

// Decrypted secrets per encrypted payload, so each distinct version costs one
// signer round trip per session (with a remote signer each decrypt is an
// inter-app/network request). `null` = permanently unreadable (malformed);
// signer failures are deliberately NOT memoized — they may succeed later.
const decryptMemo = new Map<string, string[] | null>();
const memoKey = (pubkey: string, content: string) => `${pubkey}:${content}`;

function newSession(pubkey: string): Session {
  return {
    pubkey,
    entries: [],
    activeSecret: null,
    activeAt: -1,
    newestEvent: null,
    maxSeenCreatedAt: 0,
    sawUnreadableVersion: false,
    writeRelays: [],
    payloads: new Map(),
    status: null,
    statusAt: 0,
    rejectedBy: new Set(),
    sync: { inFlight: null, lastAt: 0, timer: null, attempt: 0 },
  };
}

function getSession(pubkey: string): Session {
  if (!session || session.pubkey !== pubkey) {
    if (session?.sync.timer) clearTimeout(session.sync.timer);
    session = newSession(pubkey);
  }
  return session;
}

function currentSession(): Session | null {
  const pubkey = signerManager.getPubkey();
  return session && pubkey && session.pubkey === pubkey ? session : null;
}

// Drop the session on sign-out or account switch; clear the on-device caches
// on sign-out.
signerManager.onChange((pubkey) => {
  if (session && session.pubkey !== pubkey) {
    if (session.sync.timer) clearTimeout(session.sync.timer);
    session = null;
    inFlightResolve = null;
  }
  if (!pubkey) {
    decryptMemo.clear();
    void removeStoredItem(STORAGE_KEYS.DRIVE_KEY_CACHE);
    void removeStoredItem(STORAGE_KEYS.DRIVE_PUBKEY_CACHE);
  }
});

// -----------------------------------------------------------------------------
// "The drive pubkey set changed" signal. Callers that declare a standing
// interest keyed by drive pubkey (fileIndex.ts's observeFileIndex) must
// re-declare it when this fires — e.g. a sync merged in a key that had been
// sitting on a relay that was down, and its files now need to be requested.
// -----------------------------------------------------------------------------
const driveKeysChangedListeners = new Set<() => void>();

export function onDriveKeysChanged(fn: () => void): () => void {
  driveKeysChangedListeners.add(fn);
  return () => driveKeysChangedListeners.delete(fn);
}

function notifyDriveKeysChanged(): void {
  driveKeysChangedListeners.forEach((l) => l());
}

function keyringSignature(s: Session): string {
  return s.entries
    .map((k) => k.publicKey)
    .sort()
    .join(",");
}

function announceIfChanged(s: Session, before: string): void {
  if (keyringSignature(s) !== before) notifyDriveKeysChanged();
}

function getDriveKeyDTag(pubkey: string): string {
  return `0:${pubkey}`;
}

function driveKeyFilter(pubkey: string): Filter {
  return { kinds: [METADATA_KIND], authors: [pubkey], "#d": [getDriveKeyDTag(pubkey)] };
}

function isDriveKeyEvent(event: NostrEvent, pubkey: string): boolean {
  const dTag = getDriveKeyDTag(pubkey);
  return (
    event.pubkey === pubkey &&
    event.kind === METADATA_KIND &&
    event.tags.some((t) => t[0] === "d" && t[1] === dTag)
  );
}

function deriveKeyMaterial(secretKeyHex: string): { publicKey: string; conversationKey: Uint8Array } {
  const secretKey = hexToBytes(secretKeyHex);
  const publicKey = getPublicKey(secretKey);
  const conversationKey = nip44.v2.utils.getConversationKey(secretKey, publicKey);
  return { publicKey, conversationKey };
}

function authSigner(signer: Signer): AuthSigner {
  return (template) => signer.signEvent(template) as Promise<VerifiedEvent>;
}

/** Resolve `fallback` if `promise` hasn't settled within `ms`. Never rejects. */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise.catch(() => fallback),
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

/**
 * Serializes every Drive Key WRITE (create, merge, restore) for one identity
 * across all tabs on this device, so each write's read-before-write happens
 * with no other local writer in between — e.g. two tabs opened together by a
 * first-time user can't each create a different key. Falls back to no lock
 * where the Web Locks API is missing; in-tab guards still apply, and two
 * devices racing are handled by convergence (rule 3) instead.
 */
async function withDriveKeyWriteLock<T>(pubkey: string, fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!locks?.request) return fn();
  return locks.request(`formstr-drive:drive-key-write:${pubkey}`, fn);
}

// -----------------------------------------------------------------------------
// Encrypted-payload disk cache, namespaced to the pubkey it belongs to so an
// account switch on the same device can never surface another user's keys.
// Reads are time-boxed and writes are fire-and-forget, so slow/broken storage
// can never block or break the "fetch keys, then fetch files" flow.
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

/**
 * Persists the smallest set of encrypted versions that still covers every
 * known secret — newest first, keeping a version only if it adds a secret not
 * already covered — plus every version whose contents are unknown (not yet
 * decrypted, or unreadable), since those may hold anything. Unions with what's
 * already stored, so another tab's versions are never dropped.
 */
async function persistPayloads(s: Session): Promise<void> {
  try {
    const all = new Map(s.payloads);
    for (const p of await loadPayloadCache(s.pubkey)) {
      all.set(p.content, Math.max(all.get(p.content) ?? 0, p.created_at));
    }

    const covered = new Set<string>();
    const keep: CachedPayload[] = [];
    for (const [content, created_at] of [...all.entries()].sort((a, b) => b[1] - a[1])) {
      const secrets = decryptMemo.get(memoKey(s.pubkey, content));
      if (!secrets) {
        keep.push({ content, created_at });
        continue;
      }
      const fresh = secrets.filter((secret) => !covered.has(secret));
      if (fresh.length === 0) continue;
      fresh.forEach((secret) => covered.add(secret));
      keep.push({ content, created_at });
    }

    if (keep.length === 0) return;
    await withTimeout(
      setStoredItem(STORAGE_KEYS.DRIVE_KEY_CACHE, { pubkey: s.pubkey, payloads: keep }),
      CACHE_IO_TIMEOUT_MS,
      undefined,
    );
  } catch (e) {
    console.warn("[DriveKey] Failed to write local key cache", e);
  }
}

// -----------------------------------------------------------------------------
// Drive pubkey cache. Pubkeys are public the moment we publish anything under
// them, so this is not sensitive and exists so the file-index author filter
// can be declared instantly on a warm start, without waiting on the signer.
// -----------------------------------------------------------------------------

/**
 * Merges `drivePubkeys` into whatever this device has EVER recorded for
 * `identityPubkey` — deliberately a union, never an overwrite: a pubkey this
 * device saw before that the current keyring no longer resolves is exactly
 * what {@link findOrphanedDrivePubkeys} looks for, and the evidence that this
 * device has used Drive for the identity at all.
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

function persist(s: Session): void {
  void persistPayloads(s);
  if (s.entries.length > 0) {
    void saveCachedDrivePubkeys(s.pubkey, s.entries.map((k) => k.publicKey));
  }
}

// Per-identity "this device has created a Drive Key" marker. Survives sign-out
// (unlike the caches above), so it stays evidence this device has used Drive.
async function hasCreatedBefore(pubkey: string): Promise<boolean> {
  const marker = await getStoredItem<Record<string, boolean>>(STORAGE_KEYS.DRIVE_KEY_MINTED_MARKER, {});
  return marker[pubkey] === true;
}

async function recordCreated(pubkey: string): Promise<void> {
  const marker = await getStoredItem<Record<string, boolean>>(STORAGE_KEYS.DRIVE_KEY_MINTED_MARKER, {});
  marker[pubkey] = true;
  await setStoredItem(STORAGE_KEYS.DRIVE_KEY_MINTED_MARKER, marker);
}

/** Whether THIS device has ever held a Drive Key for `pubkey` — created one,
 *  resolved one, or cached a version it can't currently decrypt. Any of these
 *  means a key exists somewhere, whatever the relays that answered say. */
async function hasUsedDriveOnThisDevice(pubkey: string): Promise<boolean> {
  if (await hasCreatedBefore(pubkey)) return true;
  if ((await getCachedDrivePubkeys(pubkey)).length > 0) return true;
  return (await loadPayloadCache(pubkey)).length > 0;
}

// -----------------------------------------------------------------------------
// Decrypting versions into the union keyring (rule 1).
// -----------------------------------------------------------------------------

/**
 * Decrypt a Drive Key payload into every secret it carries: the active key
 * (`encryptionKey`, required) plus any `previousKeys` the payload also names.
 * Returns null if the payload is malformed (bad JSON, or `encryptionKey`
 * missing/invalid); throws if the signer itself fails. Individual malformed
 * entries within `previousKeys` are skipped rather than invalidating the
 * whole payload. Ordered active-first.
 */
async function decryptDriveKeyPayload(
  encryptedContent: string,
  signer: Signer,
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
  // `[["encryptionKey", hex]]` — what every Drive Key on production was
  // created as before the keyring rework, and still what an existing user's
  // event may be. Reading it, rather than treating it as unparseable, is what
  // keeps a returning user from looking like a first-time one.
  if (Array.isArray(parsed)) {
    const encKeyTag = parsed.find(
      (t): t is string[] => Array.isArray(t) && t.length >= 2 && t[0] === "encryptionKey",
    );
    const legacySecretHex = encKeyTag?.[1];
    if (typeof legacySecretHex !== "string" || !HEX_64.test(legacySecretHex)) return null;
    return [legacySecretHex.toLowerCase()];
  }

  if (!parsed || typeof parsed !== "object") return null;

  const secretKeyHex = (parsed as { encryptionKey?: unknown }).encryptionKey;
  if (typeof secretKeyHex !== "string" || !HEX_64.test(secretKeyHex)) return null;

  const previousKeysRaw = (parsed as { previousKeys?: unknown }).previousKeys;
  const previousKeys = Array.isArray(previousKeysRaw)
    ? previousKeysRaw.filter((k): k is string => typeof k === "string" && HEX_64.test(k))
    : [];

  return [secretKeyHex, ...previousKeys].map((k) => k.toLowerCase());
}

// Decrypts in progress, so two reads that receive the same version at the
// same time (the local store and a relay, on a cold start) share one signer
// request instead of each asking.
const decryptInFlight = new Map<string, Promise<string[] | null>>();

async function decryptVersion(s: Session, content: string, signer: Signer): Promise<string[] | null> {
  const key = memoKey(s.pubkey, content);
  if (decryptMemo.has(key)) return decryptMemo.get(key) ?? null;
  const pending = decryptInFlight.get(key);
  if (pending) return pending;

  const attempt = (async () => {
    try {
      const secrets = await decryptDriveKeyPayload(content, signer, s.pubkey);
      decryptMemo.set(key, secrets);
      return secrets;
    } catch (e) {
      console.warn("[DriveKey] Failed to decrypt a Drive Key version", e);
      return null;
    } finally {
      decryptInFlight.delete(key);
    }
  })();
  decryptInFlight.set(key, attempt);
  return attempt;
}

/** Adds `secrets` (active-first, as one version names them) to the union.
 *  The newest version's active key becomes the session's active key. */
function addSecrets(s: Session, secrets: string[], createdAt: number): void {
  for (const secretKeyHex of secrets) {
    if (s.entries.some((k) => k.secretKeyHex === secretKeyHex)) continue;
    s.entries.push({ secretKeyHex, ...deriveKeyMaterial(secretKeyHex) });
  }
  const named = secrets[0];
  if (named && createdAt > s.activeAt) {
    s.activeSecret = named;
    s.activeAt = createdAt;
  }
  s.entries.sort((a, b) => Number(b.secretKeyHex === s.activeSecret) - Number(a.secretKeyHex === s.activeSecret));
}

async function ingestPayload(
  s: Session,
  content: string,
  createdAt: number,
  signer: Signer,
): Promise<string[] | null> {
  s.payloads.set(content, Math.max(s.payloads.get(content) ?? 0, createdAt));
  const secrets = await decryptVersion(s, content, signer);
  if (secrets) addSecrets(s, secrets, createdAt);
  return secrets;
}

/** Ingests one Drive Key event. Returns its secrets, or null if it isn't a
 *  Drive Key event for this identity or couldn't be decrypted. */
async function ingestEvent(s: Session, event: NostrEvent, signer: Signer): Promise<string[] | null> {
  if (!isDriveKeyEvent(event, s.pubkey)) return null;
  s.maxSeenCreatedAt = Math.max(s.maxSeenCreatedAt, event.created_at);
  const secrets = await ingestPayload(s, event.content, event.created_at, signer);
  if (!secrets) {
    s.sawUnreadableVersion = true;
    return null;
  }
  if (event.id && event.sig && (!s.newestEvent || event.created_at > s.newestEvent.created_at)) {
    s.newestEvent = event as Event;
  }
  return secrets;
}

// -----------------------------------------------------------------------------
// Reading versions.
// -----------------------------------------------------------------------------

/**
 * Fast path: the newest version the local relay has (its store keeps only
 * one), waiting a few seconds for its worker to sync from relays on a cold
 * store. Never judges absence — "nothing here" from this layer can just mean
 * "nobody was asked"; only {@link readRelayStates} can answer that.
 */
async function fetchLocalDriveKeyEvents(pubkey: string): Promise<NostrEvent[]> {
  return new Promise((resolve) => {
    let settled = false;
    let localEoseAt: number | null = null;
    const found = new Map<string, NostrEvent>();

    const finish = () => {
      if (settled) return;
      settled = true;
      clearInterval(checkSettle);
      clearTimeout(safety);
      handle.unobserve();
      resolve([...found.values()]);
    };

    const handle = dataLayer.observe([driveKeyFilter(pubkey)], {
      onEvent: (event: Event) => {
        found.set(event.id, event as unknown as NostrEvent);
      },
      onEose: () => {
        // This EOSE is the local-cache replay finishing, not the network —
        // give upstream relays a settle window before accepting the result.
        if (localEoseAt === null) localEoseAt = Date.now();
      },
    });

    const NETWORK_SETTLE_MS = 3000;
    const checkSettle = setInterval(() => {
      if (localEoseAt !== null && Date.now() - localEoseAt >= NETWORK_SETTLE_MS) finish();
    }, 250);
    // Safety timeout in case the local EOSE itself never fires (cold worker).
    const safety = setTimeout(finish, 20000);
  });
}

/** The `write` relays named in a kind-10002 relay list. */
function writeRelaysOf(event: { tags: string[][] } | null | undefined): string[] {
  return (event?.tags ?? [])
    .filter((t) => t[0] === "r" && typeof t[1] === "string" && (t[2] === undefined || t[2] === "write"))
    .map((t) => t[1]!)
    .filter((url) => url.startsWith("wss://") || url.startsWith("ws://"));
}

/** Every relay this identity's Drive Key could be on, as far as is known
 *  without asking: everything this app publishes to, plus the identity's
 *  write relays if its relay list is already in the local store (cache-only).
 *  readRelayStates then reads the relay list from the relays themselves, so a
 *  fresh device doesn't depend on that cache. */
async function driveKeyRelays(pubkey: string): Promise<string[]> {
  const relayList = await withTimeout(
    dataLayer.fetchReplaceable(RELAY_LIST_KIND, pubkey),
    CACHE_IO_TIMEOUT_MS,
    null,
  );
  return mergeRelayLists(APP_RELAYS, defaultRelays, writeRelaysOf(relayList));
}

/** What one relay holds right now, as far as a write decision is concerned. */
interface RelayState {
  relay: string;
  /** The relay genuinely answered, so its content is known. */
  answered: boolean;
  /** Every version it returned decrypted (vacuously true if it had none). */
  readable: boolean;
  hasVersions: boolean;
  secrets: Set<string>;
}

/**
 * Reads every relay directly and folds every version into the union.
 *
 * One subscription per relay asks for the Drive Key AND the identity's
 * relay list (kind 10002), so the relay list comes from the network instead of
 * a cache a fresh device doesn't have, at no extra round trip. Any write relay
 * that list names and that wasn't already asked is read too, and — only when
 * no key has turned up, i.e. when the answer matters for creating one — a
 * write relay that stayed silent gets one longer second chance.
 */
async function readRelayStates(s: Session, signer: Signer): Promise<RelayState[]> {
  const onauth = authSigner(signer);
  const baseRelays = await driveKeyRelays(s.pubkey);
  const relayListFilter: Filter = { kinds: [RELAY_LIST_KIND], authors: [s.pubkey] };

  const readings = new Map<string, RelayReading>();
  const keep = (list: RelayReading[]) => list.forEach((r) => readings.set(normalizeRelayUrl(r.relay), r));
  keep(await readRelays([driveKeyFilter(s.pubkey), relayListFilter], baseRelays, { timeoutMs: RELAY_IO_TIMEOUT_MS, onauth }));

  // The identity's own relay list: newest version any relay returned.
  const lists = [...readings.values()]
    .flatMap((r) => r.events)
    .filter((e) => e.kind === RELAY_LIST_KIND && e.pubkey === s.pubkey)
    .sort((a, b) => b.created_at - a.created_at);
  if (lists[0]) {
    s.writeRelays = writeRelaysOf(lists[0]);
    // So a later cache-only read (and the next cold start) already knows them.
    dataLayer.addEvent(lists[0]);
  }
  const writeSet = new Set(s.writeRelays.map(normalizeRelayUrl));

  const unread = s.writeRelays.filter((url) => !readings.has(normalizeRelayUrl(url)));
  if (unread.length > 0) {
    keep(await readRelays(driveKeyFilter(s.pubkey), unread, { timeoutMs: RELAY_IO_TIMEOUT_MS, onauth }));
  }

  const keyFound = [...readings.values()].some((r) => r.events.some((e) => isDriveKeyEvent(e, s.pubkey)));
  if (!keyFound) {
    const silentWrite = [...readings.values()].filter((r) => !r.answered && writeSet.has(normalizeRelayUrl(r.relay)));
    if (silentWrite.length > 0) {
      keep(
        await readRelays(
          driveKeyFilter(s.pubkey),
          silentWrite.map((r) => r.relay),
          { timeoutMs: WRITE_RELAY_RECHECK_MS, onauth },
        ),
      );
    }
  }

  const states: RelayState[] = [];
  for (const reading of readings.values()) {
    const events = reading.events.filter((e) => isDriveKeyEvent(e, s.pubkey));
    const state: RelayState = {
      relay: reading.relay,
      answered: reading.answered,
      readable: true,
      hasVersions: events.length > 0,
      secrets: new Set(),
    };
    for (const event of events) {
      const secrets = await ingestEvent(s, event, signer);
      if (secrets) secrets.forEach((secret) => state.secrets.add(secret));
      else state.readable = false;
    }
    states.push(state);
  }

  const empty = states.filter((r) => r.answered && !r.hasVersions).map((r) => r.relay);
  const withKey = states.filter((r) => r.hasVersions).map((r) => r.relay);
  const silent = states.filter((r) => !r.answered).map((r) => r.relay);
  console.log(
    `[DriveKey] Relay read: key on ${withKey.length} [${withKey.join(", ")}]; none on ${empty.length} ` +
      `[${empty.join(", ")}]; no answer from ${silent.length} [${silent.join(", ")}]` +
      (s.writeRelays.length ? `; your write relays: [${s.writeRelays.join(", ")}]` : ""),
  );
  return states;
}

// -----------------------------------------------------------------------------
// Resolving the keyring (read-only — never writes anything).
// -----------------------------------------------------------------------------

/**
 * Runs only when every read left the keyring empty: decides "this identity
 * has no Drive Key" (proven) vs "don't know / can't proceed". Creates nothing.
 *
 * Deliberately does NOT ask whether the identity has used Nostr before — that
 * answers the wrong question (an existing Nostr identity that never used
 * Drive would be blocked forever). The only question that matters is "is
 * there a Drive Key on a relay we'd overwrite?", and only the relays
 * themselves can answer it.
 */
async function classifyEmptyKeyring(
  s: Session,
  states: RelayState[],
  options: { ignoreDeviceHistory: boolean },
): Promise<EmptyKeyringVerdict> {
  // A version exists but couldn't be read — a key exists; never create over it.
  if (s.sawUnreadableVersion) return unresolved("unreadable");

  if (!options.ignoreDeviceHistory && (await hasUsedDriveOnThisDevice(s.pubkey))) {
    return unresolved("seen-on-device");
  }

  const emptyRelays = states.filter((r) => r.answered && !r.hasVersions).map((r) => r.relay);
  const emptyQuorumAnswers = emptyRelays.filter((url) => CREATE_QUORUM_RELAYS.includes(normalizeRelayUrl(url)));
  if (emptyQuorumAnswers.length >= MIN_EMPTY_QUORUM_ANSWERS) {
    return { kind: "empty-confirmed", emptyRelays };
  }
  return unresolved("not-enough-relays");
}

/**
 * Resolves the keyring for the current signed-in user: payload cache, then
 * the local store, then every relay directly. Read-only; on an empty result
 * it reports a verdict (see {@link DriveKeyStatus}) but never creates
 * anything. A resolved keyring starts a background sync (rule 3).
 */
async function resolveDriveKeyStatus(
  options: { ignoreDeviceHistory?: boolean } = {},
): Promise<DriveKeyStatus> {
  const signer = await signerManager.getSigner();
  const pubkey = await signer.getPublicKey();
  const s = getSession(pubkey);
  const before = keyringSignature(s);
  // Evidence about what's out there right now, not about the identity.
  s.sawUnreadableVersion = false;

  for (const { content, created_at } of await loadPayloadCache(pubkey)) {
    await ingestPayload(s, content, created_at, signer);
  }

  // Cold start (nothing usable cached on this device): ask the local store and
  // every relay at the same time instead of one after the other. Both only
  // fold versions into the union, so the order they land in can't change
  // the outcome — only how long it takes.
  let relayRead: Promise<RelayState[]> | null = null;
  if (s.entries.length === 0) {
    relayRead = readRelayStates(s, signer);
    for (const event of await fetchLocalDriveKeyEvents(pubkey)) await ingestEvent(s, event, signer);
  }

  let status: DriveKeyStatus;
  if (s.entries.length > 0) {
    status = { kind: "ready", keyring: [...s.entries] };
  } else {
    const states = await relayRead!;
    status =
      s.entries.length > 0
        ? { kind: "ready", keyring: [...s.entries] }
        : await classifyEmptyKeyring(s, states, { ignoreDeviceHistory: options.ignoreDeviceHistory ?? false });
    relayRead = null;
  }

  if (session !== s) return status; // signed out / switched mid-resolve

  persist(s);
  announceIfChanged(s, before);
  if (!options.ignoreDeviceHistory) {
    s.status = status;
    s.statusAt = Date.now();
  }
  console.log(`[DriveKey] Keyring ready with ${s.entries.length} key(s)`);

  if (relayRead) {
    // The local store answered first. Let the relay read finish in the
    // background — it can only add keys — then sync from there, rather than
    // starting a second relay read alongside it.
    const afterRead = keyringSignature(s);
    void relayRead.then(
      () => {
        if (session !== s) return;
        persist(s);
        announceIfChanged(s, afterRead);
        if (!s.sync.inFlight && !s.sync.timer) scheduleSync(s, 0);
      },
      () => {},
    );
  } else if (status.kind === "ready" && !s.sync.inFlight && !s.sync.timer) {
    scheduleSync(s, 0);
  }
  return status;
}

// In-flight resolution, so concurrent callers on a cold session share one
// resolution — with a remote signer each decrypt is its own round trip.
// Keyed by pubkey: an account switch mid-flight must not hand the new account
// the previous one's promise.
let inFlightResolve: { pubkey: string | undefined; promise: Promise<DriveKeyStatus> } | null = null;

async function resolveDriveKeyStatusCached(): Promise<DriveKeyStatus> {
  // A keyring, once resolved, only ever grows — always current, no re-check.
  // "empty-confirmed" is reusable only briefly (see EMPTY_CONFIRMED_TTL_MS).
  // "unresolved" is never reused: it's a statement about right-now
  // connectivity, and the next call deserves a fresh answer.
  const s = currentSession();
  if (s && s.entries.length > 0) return { kind: "ready", keyring: [...s.entries] };
  if (s?.status?.kind === "empty-confirmed" && Date.now() - s.statusAt < EMPTY_CONFIRMED_TTL_MS) {
    return s.status;
  }

  const pubkey = signerManager.getPubkey();
  if (inFlightResolve && inFlightResolve.pubkey === pubkey) return inFlightResolve.promise;

  const promise = resolveDriveKeyStatus();
  inFlightResolve = { pubkey, promise };
  try {
    return await promise;
  } finally {
    if (inFlightResolve?.promise === promise) inFlightResolve = null;
  }
}

/** Read-only: resolves the keyring if one exists. NEVER creates one. */
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

// -----------------------------------------------------------------------------
// Writing versions (rule 2) and converging (rule 3).
// -----------------------------------------------------------------------------

/** Never older than any version seen — a replaceable event older than what
 *  a relay holds is simply ignored by it (clocks on other devices can be
 *  ahead of this one). */
function nextCreatedAt(s: Session): number {
  return Math.max(Math.floor(Date.now() / 1000), s.maxSeenCreatedAt + 1);
}

/** Encrypts and signs ONE Drive Key event naming `activeSecretHex` as active
 *  and carrying `previousKeys` alongside it. Publishing is the caller's job. */
async function buildDriveKeyEvent(
  signer: Signer,
  pubkey: string,
  activeSecretHex: string,
  previousKeys: string[],
  createdAt: number,
): Promise<Event> {
  if (!signer.nip44Encrypt) {
    throw new Error("Your signer doesn't support NIP-44 encryption, which Drive needs for your Drive Key.");
  }

  // Payload format matches the NIP: a JSON object, not array-of-tags.
  const payload: { encryptionKey: string; previousKeys?: string[] } = { encryptionKey: activeSecretHex };
  if (previousKeys.length > 0) payload.previousKeys = previousKeys;

  // Encrypt the payload to the user themselves using their Main Identity Signer.
  const encryptedContent = await signer.nip44Encrypt(pubkey, JSON.stringify(payload));
  // We know what it holds — no need to ask the signer to decrypt our own write.
  decryptMemo.set(memoKey(pubkey, encryptedContent), [activeSecretHex, ...previousKeys]);

  const event: NostrEvent = {
    kind: METADATA_KIND,
    pubkey,
    created_at: createdAt,
    tags: [
      ["d", getDriveKeyDTag(pubkey)],
      ["client", "formstr-drive"],
    ],
    content: encryptedContent,
  };
  return (await signer.signEvent(event)) as unknown as Event;
}

/** Writes `event` to `targets`, records it locally, and folds it into the
 *  session. Returns the relays that accepted it. */
async function writeVersion(s: Session, event: Event, targets: string[], signer: Signer): Promise<string[]> {
  const result = await publishToRelays(event, targets, {
    timeoutMs: RELAY_IO_TIMEOUT_MS,
    onauth: authSigner(signer),
  });
  result.rejected.forEach((relay) => s.rejectedBy.add(relay));
  if (result.accepted.length > 0) {
    // Local store only — no network, so its outbox never re-delivers it.
    dataLayer.addEvent(event);
    await ingestEvent(s, event as unknown as NostrEvent, signer);
    persist(s);
  }
  console.log(
    `[DriveKey] Wrote Drive Key version to ${result.accepted.length}/${targets.length} relays` +
      (result.rejected.length ? `; refused by [${result.rejected.join(", ")}]` : "") +
      (result.failed.length ? `; failed on [${result.failed.join(", ")}]` : ""),
  );
  return result.accepted;
}

/** One sync pass, under the write lock. Returns whether to try again later. */
async function convergeOnce(s: Session): Promise<boolean> {
  const signer = await signerManager.getSigner();
  if ((await signer.getPublicKey()) !== s.pubkey || session !== s) return false;
  const before = keyringSignature(s);

  // Another tab may have written versions to the shared cache since.
  for (const { content, created_at } of await loadPayloadCache(s.pubkey)) {
    await ingestPayload(s, content, created_at, signer);
  }
  const states = await readRelayStates(s, signer);
  if (session !== s) return false;
  persist(s);
  announceIfChanged(s, before);

  const unsettled = states.some((r) => !s.rejectedBy.has(r.relay) && (!r.answered || !r.readable));
  if (s.entries.length === 0) return false; // nothing to spread; creating is createFirstKey's job

  // Rule 2 + 3: every relay whose content is fully known and lacks a key.
  const known = s.entries.map((k) => k.secretKeyHex);
  const targets = states
    .filter((r) => r.answered && r.readable && !s.rejectedBy.has(r.relay))
    .filter((r) => known.some((secret) => !r.secrets.has(secret)))
    .map((r) => r.relay);
  if (targets.length === 0) return unsettled;

  // Re-broadcast the newest version unchanged if it already carries every
  // key (no signer prompt); otherwise sign a merged version that keeps the
  // current active key.
  const newestSecrets = s.newestEvent ? decryptMemo.get(memoKey(s.pubkey, s.newestEvent.content)) : null;
  const event =
    s.newestEvent && newestSecrets && known.every((secret) => newestSecrets.includes(secret))
      ? s.newestEvent
      : await buildDriveKeyEvent(
          signer,
          s.pubkey,
          s.activeSecret ?? known[0]!,
          known.filter((secret) => secret !== (s.activeSecret ?? known[0])),
          nextCreatedAt(s),
        );

  const accepted = await writeVersion(s, event, targets, signer);
  return unsettled || accepted.length < targets.length;
}

function scheduleSync(s: Session, delayMs: number): void {
  if (s.sync.timer) clearTimeout(s.sync.timer);
  s.sync.timer = setTimeout(() => {
    s.sync.timer = null;
    void syncDriveKeys(s);
  }, delayMs);
}

/** Runs one sync pass (single-flight per session), then schedules a retry on
 *  a backoff while anything is still unsettled. */
function syncDriveKeys(s: Session): Promise<void> {
  if (session !== s) return Promise.resolve();
  if (s.sync.inFlight) return s.sync.inFlight;

  s.sync.inFlight = (async () => {
    let retry = false;
    try {
      retry = await withDriveKeyWriteLock(s.pubkey, () => convergeOnce(s));
    } catch (e) {
      console.warn("[DriveKey] Sync failed", e);
      retry = true;
    } finally {
      s.sync.lastAt = Date.now();
      s.sync.inFlight = null;
    }
    if (session !== s) return;
    if (retry) {
      scheduleSync(s, SYNC_RETRY_DELAYS_MS[Math.min(s.sync.attempt, SYNC_RETRY_DELAYS_MS.length - 1)]!);
      s.sync.attempt++;
    } else {
      s.sync.attempt = 0;
    }
  })();
  return s.sync.inFlight;
}

/**
 * Re-reads every relay and converges, for an already-resolved keyring. Fired
 * when the app regains focus or visibility (throttled), and by the degraded
 * state's Retry (`force`). A no-op before a keyring exists — resolution runs
 * on its own then.
 */
export async function refreshDriveKeyring(options: { force?: boolean } = {}): Promise<void> {
  const s = currentSession();
  if (!s || s.entries.length === 0) return;
  if (!options.force && Date.now() - s.sync.lastAt < SYNC_MIN_INTERVAL_MS) return;
  return syncDriveKeys(s);
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refreshDriveKeyring();
  });
  // `visibilitychange` only fires when a tab is actually occluded; two windows
  // tiled side by side never fire it. `focus` covers that case; the throttle
  // makes firing both on one transition harmless.
  window.addEventListener("focus", () => {
    void refreshDriveKeyring();
  });
}

// -----------------------------------------------------------------------------
// Read accessors.
// -----------------------------------------------------------------------------

/** The conversation keys for every Drive Key. Try each one when decrypting
 *  file metadata until the NIP-44 MAC validates. */
export async function getDriveConversationKeys(): Promise<Uint8Array[]> {
  const keyring = await getDriveKeyring();
  return keyring.map((entry) => entry.conversationKey);
}

/** The active Drive Key entry (secret, pubkey, conversation key), resolved
 *  once — so content encrypted under one key is never authored by another. */
export async function getActiveDriveKey(): Promise<DriveKeyEntry> {
  const keyring = await getDriveKeyring();
  if (keyring.length === 0) throw new Error("No Drive Key available");
  const active = currentSession()?.activeSecret;
  return keyring.find((k) => k.secretKeyHex === active) ?? keyring[0]!;
}

/**
 * Looks up a specific Drive Key by its public half, from anywhere in the
 * keyring — needed wherever an operation must sign with the SAME key that
 * authored some earlier event (revoking a share, superseding a file published
 * before a key change). Returns null (never throws) if not held.
 */
export async function getDriveKeyByPubkey(pubkey: string): Promise<DriveKeyEntry | null> {
  const keyring = await getDriveKeyring();
  return keyring.find((entry) => entry.publicKey === pubkey) ?? null;
}

/** The pubkeys of every Drive Key in the keyring — the file index subscribes
 *  to all of them, since older files carry an older key's pubkey as author. */
export async function getDriveKeyPubkeys(): Promise<string[]> {
  const keyring = await getDriveKeyring();
  return keyring.map((entry) => entry.publicKey);
}

/**
 * Drive pubkeys this device has recorded before for `identityPubkey` that the
 * current keyring doesn't resolve — a key whose version isn't on any relay
 * that has answered yet. Usually transient now: the background sync merges it
 * as soon as a relay holding it answers. Returns [] when nothing looks lost.
 */
export async function findOrphanedDrivePubkeys(identityPubkey: string): Promise<string[]> {
  const everSeen = await getCachedDrivePubkeys(identityPubkey);
  if (everSeen.length === 0) return [];
  const current = new Set(await getDriveKeyPubkeys());
  return everSeen.filter((p) => !current.has(p));
}

// -----------------------------------------------------------------------------
// Creating a first key (rule 4) and restoring one.
// -----------------------------------------------------------------------------

/** `ok: false` when there's still no key and the caller should show why:
 *  creating failed, or the fresh check inside the lock no longer proves
 *  there's none (e.g. relays stopped answering since the read path looked). */
export type DriveKeyMintResult = { ok: true } | { ok: false; reason: string; issue: DriveKeyIssue };

// In-tab guard against overlapping attempts; the write lock covers other tabs.
const createInFlight = new Set<string>();

async function createFirstKey(options: { userRequested: boolean }): Promise<DriveKeyMintResult> {
  const pubkey = signerManager.getPubkey();
  if (!pubkey || createInFlight.has(pubkey)) return { ok: true };
  createInFlight.add(pubkey);

  try {
    return await withDriveKeyWriteLock(pubkey, async () => {
      const signer = await signerManager.getSigner();
      if ((await signer.getPublicKey()) !== pubkey) return { ok: true }; // switched mid-flight
      const s = getSession(pubkey);

      // Always a fresh resolve, right here inside the lock — never a cached
      // verdict of any age. Another tab may have created a key while this one
      // waited for the lock; this picks it up (shared payload cache, and the
      // relays) instead of creating a second one. Its `emptyRelays` are the
      // write targets.
      const status = await resolveDriveKeyStatus({ ignoreDeviceHistory: options.userRequested });
      if (status.kind === "ready") return { ok: true };
      if (status.kind === "unresolved") return { ok: false, reason: status.reason, issue: status.issue };

      const secretKeyHex = bytesToHex(generateSecretKey());
      console.log("[DriveKey] Creating a new Drive Key");
      const event = await buildDriveKeyEvent(signer, pubkey, secretKeyHex, [], nextCreatedAt(s));
      const before = keyringSignature(s);
      const accepted = await writeVersion(s, event, status.emptyRelays, signer);
      if (accepted.length === 0) {
        throw new Error("Couldn't save your new Drive Key to any relay. Please check your connection.");
      }
      await recordCreated(pubkey);
      s.status = { kind: "ready", keyring: [...s.entries] };
      s.statusAt = Date.now();
      announceIfChanged(s, before);

      // Relays that didn't answer get the key on a later sync — or, if one
      // was holding an older key after all, that key is merged in then.
      scheduleSync(s, SYNC_AFTER_CREATE_MS);
      return { ok: true };
    });
  } catch (e) {
    console.warn("[DriveKey] Failed to create a Drive Key", e);
    return {
      ok: false,
      reason: e instanceof Error ? e.message : "Couldn't create your Drive Key.",
      issue: "create-failed",
    };
  } finally {
    createInFlight.delete(pubkey);
  }
}

/**
 * Creates a first Drive Key, silently, when — and only when — resolution
 * proves there is none (rule 4). Called by FileIndexProvider on an
 * "empty-confirmed" verdict, and safe to call again on every fresh verdict:
 * it re-resolves inside the write lock and does nothing unless the proof
 * still holds.
 */
export async function ensureDriveKeyMinted(): Promise<DriveKeyMintResult> {
  return createFirstKey({ userRequested: false });
}

/**
 * The user's explicit way out of "seen-on-device": this device held a key
 * for this identity, but no relay that answers has it any more. Skips only
 * the device-history check — every other proof still applies (no version
 * anywhere reachable, quorum answered "none"), and the new key is written
 * only to relays that answered. If the old key turns up later, sync merges
 * it, so this can hide old files for a while but never destroys a key.
 */
export async function startNewDriveKey(): Promise<DriveKeyMintResult> {
  return createFirstKey({ userRequested: true });
}

/**
 * Makes `activeSecretHex` the active key, keeping every other known key —
 * `previousSecretsHex` plus the whole current union, which is re-read from
 * every relay first so a restore can never drop a key that's only on a relay.
 * Written (rule 2) to every relay whose content is fully known.
 */
export async function restoreDriveKey(
  activeSecretHex: string,
  previousSecretsHex: string[] = [],
): Promise<void> {
  if (!HEX_64.test(activeSecretHex)) {
    throw new Error("Invalid Drive Key secret: expected 64 hex characters.");
  }
  const active = activeSecretHex.toLowerCase();

  const signer = await signerManager.getSigner();
  const pubkey = await signer.getPublicKey();
  const s = getSession(pubkey);

  await withDriveKeyWriteLock(pubkey, async () => {
    const before = keyringSignature(s);
    for (const { content, created_at } of await loadPayloadCache(pubkey)) {
      await ingestPayload(s, content, created_at, signer);
    }
    const states = await readRelayStates(s, signer);
    const targets = states.filter((r) => r.answered && r.readable && !s.rejectedBy.has(r.relay)).map((r) => r.relay);
    if (targets.length === 0) {
      throw new Error("Couldn't reach a relay to save the Drive Key to. Please check your connection and try again.");
    }

    const others = Array.from(
      new Set([
        ...s.entries.map((k) => k.secretKeyHex),
        ...previousSecretsHex.filter((k) => HEX_64.test(k)).map((k) => k.toLowerCase()),
      ]),
    ).filter((k) => k !== active);
    const event = await buildDriveKeyEvent(signer, pubkey, active, others, nextCreatedAt(s));
    const accepted = await writeVersion(s, event, targets, signer);
    if (accepted.length === 0) {
      throw new Error("Failed to save the Drive Key to any relay. Please check your connection and try again.");
    }
    s.status = { kind: "ready", keyring: [...s.entries] };
    s.statusAt = Date.now();
    announceIfChanged(s, before);
    console.log(`[DriveKey] Restored keyring: ${s.entries.length} key(s)`);
  });

  scheduleSync(s, SYNC_AFTER_CREATE_MS);
}
