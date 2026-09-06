import { nip44, finalizeEvent, type Event } from "nostr-tools";
import { hexToBytes } from "nostr-tools/utils";
import { dataLayer, type PublishResult } from "@formstr/local-relay";
import { isLegacyFile, type FileMetadata } from "../types/metadata";
import {
  getActiveDriveKey,
  getDriveConversationKeys,
  getDriveKeyPubkeys,
  getCachedDrivePubkeys,
  onDriveKeysChanged,
} from "./driveKey";
import { enqueueMetadataEvent, publishAndDequeue } from "./metadataOutbox";
import { publishDeletionRequest } from "./deletionRequest";

const METADATA_KIND = 34578;
const CLIENT_TAG = "formstr-drive";

/**
 * The single, monotonic source of truth for the decrypted file list, and the
 * one place legacy files are excluded — `emit()` drops them (see isLegacyFile),
 * so nothing downstream ever sees a file it can't act on. Note they are still
 * *written* to `entries`: their `created_at` has to keep participating in the
 * monotonicity guard below, or a stale decryptable event could resurrect one.
 *
 * Every
 * writer — the live relay subscription (`observeFileIndex`) and any
 * optimistic local edit (`saveFileMetadata`) — goes through `write()`, which
 * only accepts a strictly newer `created_at` per file id. That one invariant
 * is what actually prevents a move/rename/delete from flickering: once a
 * write lands at a given `created_at`, nothing older can ever displace it,
 * no matter which of several things that can trigger a re-render — an
 * incoming relay event, an EOSE replay, an optimistic edit, or a fresh
 * `observeFileIndex` instance after a relayRefresh-triggered resubscribe —
 * happens to run next.
 *
 * Living at module scope (not per-`observeFileIndex`-call) is the important
 * part: there is exactly one `entries` map for the app's lifetime, so a
 * subscription rebuild has nothing to "lose" — the previous state is still
 * sitting right here, and the new subscriber sees it immediately on
 * `subscribe()` rather than waiting for its own replay to catch back up.
 */
const fileIndexStore = (() => {
  const entries = new Map<string, { created_at: number; metadata: FileMetadata | null }>();
  let onFiles: ((files: FileMetadata[]) => void) | null = null;

  function emit(): void {
    if (!onFiles) return;
    const files = Array.from(entries.values())
      .filter(
        (e): e is { created_at: number; metadata: FileMetadata } =>
          e.metadata !== null && !e.metadata.deleted && !isLegacyFile(e.metadata),
      )
      .sort((a, b) => b.created_at - a.created_at)
      .map((e) => e.metadata);
    onFiles(files);
  }

  return {
    /** Registers the current handler and immediately replays whatever's
     *  already known. Returns an unregister function. */
    subscribe(handler: (files: FileMetadata[]) => void): () => void {
      onFiles = handler;
      if (entries.size > 0) emit();
      return () => {
        if (onFiles === handler) onFiles = null;
      };
    },
    /** The one guarded write: applied only if strictly newer than what's
     *  already held for this id (ties are treated as "already have it" —
     *  the same rule the committed code always used for relay events). */
    write(id: string, createdAt: number, metadata: FileMetadata | null): void {
      const existing = entries.get(id);
      if (existing && existing.created_at >= createdAt) return;
      entries.set(id, { created_at: createdAt, metadata });
      if (metadata) emit();
    },
    /** Re-emits the current state unconditionally — used after a replay
     *  (EOSE) completes even if every replayed event turned out to be one
     *  `write()` already rejected as not-newer. */
    refresh(): void {
      emit();
    },
    /** Drops everything and emits the resulting empty list — call on
     *  logout/account switch so a new identity never briefly shows the
     *  previous one's files. */
    clear(): void {
      entries.clear();
      emit();
    },
  };
})();

/** Clears the shared file-index store — call when the signed-in identity
 *  changes so a new account never briefly shows the previous one's files. */
export function clearFileIndexStore(): void {
  fileIndexStore.clear();
}

/**
 * Reflects a metadata event that was published by something other than
 * {@link saveFileMetadata} — specifically the Android background upload
 * service, which publishes the event itself from a native context. Without
 * this the file wouldn't appear until its own event round-tripped back through
 * the relay subscription.
 *
 * `createdAt` must be the published event's own timestamp, so the store's
 * monotonicity guard treats the eventual echo as a no-op rather than a race.
 */
export function recordPublishedMetadata(metadata: FileMetadata, createdAt: number): void {
  fileIndexStore.write(metadata.id, createdAt, metadata);
}

/**
 * Decrypt metadata by trying every Drive Key in the keyring until one
 * validates the NIP-44 MAC. This recovers files encrypted under an older
 * (forked) key that isn't the active one.
 */
function decryptMetadataWithDriveKey(
  ciphertext: string,
  conversationKeys: Uint8Array[],
): FileMetadata {
  let lastError: unknown = null;

  for (const conversationKey of conversationKeys) {
    try {
      const json = nip44.v2.decrypt(ciphertext, conversationKey);
      return JSON.parse(json);
    } catch (e) {
      // invalid MAC — wrong key, try the next one in the keyring.
      lastError = e;
    }
  }

  throw lastError ?? new Error("No Drive Key available to decrypt metadata");
}

export interface FileIndexStreamHandlers {
  /** Full current file list — called every time a decrypted event changes it. */
  onFiles: (files: FileMetadata[]) => void;
  /**
   * Local-cache replay is done (EOSE). On a warm cache this fires almost
   * instantly with every previously-seen file already delivered; freshly
   * synced and live events keep arriving via `onFiles` afterwards.
   */
  onReady?: () => void;
  /**
   * Fires once the Drive Key keyring attempt settles — success or failure,
   * we're no longer blocked on it — reporting whether it actually produced
   * at least one usable key. `hasKeys: false` covers BOTH a genuine failure
   * and a keyring that resolved successfully but empty; either way there is
   * no key to decrypt with, so a subsequently-empty `onFiles` result must
   * NOT be read as "confirmed empty" — see identityHistory.ts for how a
   * caller should tell a genuinely new identity apart from one whose key
   * just couldn't be resolved this time. (Previously this fired unconditionally
   * once the promise settled either way, with no way to tell which case
   * happened — the keyring's own `.catch` silently turned a failure into an
   * empty array, so "resolved to nothing" and "resolved with real keys" were
   * indistinguishable to every caller.)
   */
  onKeyStatus?: (hasKeys: boolean) => void;
  /**
   * Fires (at most once per EOSE) when at least one event under the
   * currently-subscribed authors failed to decrypt. An empty file list
   * alongside this is a strong signal the WRONG drive key is subscribed —
   * files exist but are unreadable — as opposed to the drive being
   * genuinely empty.
   */
  onDecryptFailures?: (count: number) => void;
}

/**
 * Declare a standing interest in the user's kind-34578 file index. File-entry
 * events are authored by the Drive Key, not the identity key — `identityPubkey`
 * is used only to look up which drive pubkeys belong to this user (via a local
 * cache, then authoritatively via the keyring), never as an event author
 * itself. Events are decrypted as they stream (cache replay first, then
 * network sync + live tail) and the deduped, tombstone-filtered file list is
 * pushed through `onFiles`.
 *
 * Returns an unobserve function.
 */
export function observeFileIndex(
  identityPubkey: string,
  handlers: FileIndexStreamHandlers,
): () => void {
  const driveKeysPromise: Promise<Uint8Array[]> = getDriveConversationKeys().catch(
    (e) => {
      console.warn("[FileIndex] Could not obtain Drive Key keyring", e);
      return [];
    },
  );
  // Report the moment the keyring settles — success or failure, we're no
  // longer blocked on it — but unlike before, report WHETHER it actually
  // resolved to usable keys rather than firing unconditionally. Not gated on
  // `stopped`: callers may want to know the key resolved even if the
  // component unmounted a moment later, and firing this has no side effect
  // beyond the callback itself.
  void driveKeysPromise.then((keys) => handlers.onKeyStatus?.(keys.length > 0));

  let stopped = false;

  // Register with the shared store — it replays whatever's already known
  // immediately (see fileIndexStore.subscribe), so a relayRefresh-triggered
  // resubscribe shows the correct current state right away instead of
  // waiting for this instance's own cache/network replay to catch back up.
  const unsubscribeStore = fileIndexStore.subscribe(handlers.onFiles);

  // A drive that's empty because every event failed to decrypt looks
  // identical, from the UI, to a drive that's genuinely empty — the per-event
  // line below is debug-only and Chrome hides it by default. Track a count so
  // there's at least one visible signal something is wrong, without spamming
  // a warning per event on a large drive with a few legitimately stale ones.
  let skippedCount = 0;
  let lastWarnedSkippedCount = 0;

  const processEvent = async (event: Event) => {
    const dTag = event.tags.find((t: string[]) => t[0] === "d");
    const id = dTag?.[1];
    if (!id) return;

    // The Drive Key event and shared-file/container events (services/sharing.ts)
    // are also kind-34578, same author, but carry a `t` tag other than "files"
    // — encrypted under a different key entirely, so they'd never decrypt here
    // and would otherwise inflate skippedCount into a false "wrong Drive Key"
    // warning below. A MISSING `t` tag is left alone: some legacy events
    // predate the tag and must still reach the decrypt attempt below.
    const tTag = event.tags.find((t: string[]) => t[0] === "t")?.[1];
    if (tTag && tTag !== "files") return;

    const driveConversationKeys = await driveKeysPromise;

    let metadata: FileMetadata | null = null;
    try {
      metadata = decryptMetadataWithDriveKey(event.content, driveConversationKeys);
    } catch (e) {
      skippedCount++;
      console.debug("[FileIndex] Skipping undecryptable event:", event.id, e);
    }

    // Record even failed decrypts so an older, decryptable version of the
    // same id can't resurrect a file the newest event superseded — the store
    // itself enforces the created_at monotonicity, regardless of `stopped`.
    fileIndexStore.write(id, event.created_at, metadata);
  };

  // Serialize event processing: decryption awaits the keyring, so a simple
  // promise chain keeps ordering deterministic.
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (work: () => Promise<void>) => {
    queue = queue.then(work).catch((e) => {
      console.error("[FileIndex] Event processing failed", e);
    });
  };

  // Additive subscriptions, never re-subscribe: tearing down and re-declaring
  // a dataLayer.observe would re-EOSE (risking a dropped live event in the gap
  // and a duplicate onReady fire). Instead each new batch of drive pubkeys
  // gets its own observe; the shared store's created_at guard already dedups
  // replay across all of them.
  const handles: Array<{ unobserve: () => void }> = [];
  const subscribedAuthors = new Set<string>();
  let readyFired = false;

  const subscribeAuthors = (authors: string[]) => {
    if (stopped) return;
    const fresh = authors.filter((a) => a && !subscribedAuthors.has(a));
    if (fresh.length === 0) return;
    fresh.forEach((a) => subscribedAuthors.add(a));

    handles.push(
      dataLayer.observe(
        // Deliberately NOT filtered by `#t` here — some legacy events predate
        // the `t` tag entirely (see isLegacyFile in types/metadata.ts) and
        // must still reach processEvent below, which is
        // where non-file events (Drive Key, shared-file/container — see
        // services/sharing.ts) are actually excluded, by their own `t` tag.
        [{ kinds: [METADATA_KIND], authors: fresh }],
        {
          onEvent: (event: Event) => {
            if (stopped) return;
            enqueue(() => processEvent(event));
          },
          onEose: () => {
            if (stopped) return;
            enqueue(async () => {
              fileIndexStore.refresh();
              // The success path was previously silent — the only console
              // signal was a warning on decrypt failure, so "did the relay
              // sync actually run" was indistinguishable from "the drive is
              // just empty" without opening the network tab. This fires once
              // per author batch's first EOSE (readyFired below still guards
              // onReady from firing more than once for the whole subscription).
              console.log(
                `[FileIndex] Relay sync complete for [${Array.from(subscribedAuthors).join(", ")}].`,
              );
              if (!readyFired) {
                readyFired = true;
                handlers.onReady?.();
              }
              if (skippedCount > lastWarnedSkippedCount) {
                lastWarnedSkippedCount = skippedCount;
                console.warn(
                  `[FileIndex] ${skippedCount} file-index event(s) could not be decrypted under ` +
                    `[${Array.from(subscribedAuthors).join(", ")}] — an empty or incomplete drive ` +
                    `may mean the wrong Drive Key is subscribed, not that the drive is actually empty.`,
                );
                handlers.onDecryptFailures?.(skippedCount);
              }
            });
          },
        },
      ),
    );
  };

  // 1. Cached drive pubkeys — localStorage only, no signer, resolves in ms.
  void getCachedDrivePubkeys(identityPubkey).then(subscribeAuthors).catch(() => {});

  // 2. Authoritative keyring — may block on a signer nip44Decrypt on a cold
  //    start with no cache. Adds anything the cache missed (first run, or a
  //    key rotated on another device since the cache was last written).
  void getDriveKeyPubkeys().then(subscribeAuthors).catch((e) => {
    console.warn("[FileIndex] Could not resolve Drive Key pubkeys", e);
  });

  // 3. A warm-cache getDriveKeyRing() returns immediately and reconciles with
  //    relays in the background — if that reconciliation finds a pubkey #2's
  //    lookup above missed (this device cached a stale/incomplete key set),
  //    nothing else re-declares the author filter. Without this, files under
  //    the real key are silently never requested — the subscription EOSEs
  //    clean and just never asked about the right author. subscribeAuthors is
  //    additive and self-dedupes, so calling it again here is always safe.
  const unsubscribeDriveKeysChanged = onDriveKeysChanged(() => {
    void getDriveKeyPubkeys().then(subscribeAuthors).catch((e) => {
      console.warn("[FileIndex] Could not resolve updated Drive Key pubkeys", e);
    });
  });

  return () => {
    stopped = true;
    handles.forEach((h) => h.unobserve());
    unsubscribeStore();
    unsubscribeDriveKeysChanged();
  };
}

/**
 * Builds and signs the kind-34578 metadata event, but does NOT publish it.
 * Signed with the Drive Key (not the identity signer) — this costs zero user
 * approval prompts, since the Drive Key is a locally-held secp256k1 keypair.
 * Split out so callers (e.g. an Android foreground handoff) can build+sign
 * synchronously and publish later, possibly from a background context.
 */
export async function buildSignedMetadataEvent(metadata: FileMetadata): Promise<Event> {
  // Resolve the active key ONCE — encrypting and signing with independently
  // resolved "active key" lookups risks a background key-rotation landing
  // between them, encrypting under key A but authoring under key B.
  const key = await getActiveDriveKey();

  return finalizeEvent(
    {
      kind: METADATA_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["d", metadata.id],
        ["t", "files"],
        ["client", CLIENT_TAG],
        ["encrypted", "nip44"],
      ],
      content: nip44.v2.encrypt(JSON.stringify(metadata), key.conversationKey),
    },
    hexToBytes(key.secretKeyHex),
  );
}

export async function saveFileMetadata(metadata: FileMetadata): Promise<PublishResult> {
  // Signed with the Drive Key above — no signer/extension prompt.
  const signedEvent = await buildSignedMetadataEvent(metadata);
  // Reflect it through the shared store immediately, using the exact
  // created_at just signed — before the network publish, not after — so the
  // UI shows the edit right away, and this event's own echo (once it round-
  // trips through the relay) is a no-op against the store's created_at guard
  // rather than a race.
  fileIndexStore.write(metadata.id, signedEvent.created_at, metadata);
  await enqueueMetadataEvent(signedEvent, metadata.name);
  return publishAndDequeue(signedEvent);
}

export async function deleteFileMetadata(_hash: string, currentMetadata: FileMetadata): Promise<void> {
  const deletedMetadata: FileMetadata = {
    ...currentMetadata,
    deleted: true,
  };
  // The tombstone republish is what deletion actually relies on — relays are
  // not obligated to honor NIP-09, so it must land regardless of the request
  // below. The deletion request itself is fire-and-forget on top of it.
  await saveFileMetadata(deletedMetadata);
  const key = await getActiveDriveKey();
  void publishDeletionRequest(
    [`${METADATA_KIND}:${key.publicKey}:${currentMetadata.id}`],
    `Deleted ${currentMetadata.name}`,
  );
}

export function extractFolders(files: FileMetadata[]): string[] {
  const folders = new Set<string>();
  folders.add("/");

  for (const file of files) {
    // `folder: string` is only a TS-level promise — a real decrypted event
    // from before this field existed (or any malformed metadata) can lack
    // it despite having a valid `id` and passing isLegacyFile. Uncaught, this
    // throws inside the render-time useMemo that calls this function
    // (FileIndexProvider's `folders`), which blanks the entire app rather
    // than just this one file's folder — so this file is treated as living
    // at the root instead of crashing the whole list over one bad event.
    if (!file.folder) continue;
    const parts = file.folder.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current += "/" + part;
      folders.add(current);
    }
  }

  return Array.from(folders).sort();
}
