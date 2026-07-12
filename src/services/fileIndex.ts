import { nip44, type Event } from "nostr-tools";
import { dataLayer, type PublishResult } from "@formstr/local-relay";
import type { FileMetadata, NostrEvent } from "../types/metadata";
import { signerManager } from "../signer/manager";
import {
  getDriveConversationKey,
  getDriveConversationKeys,
} from "./driveKey";

const METADATA_KIND = 34578;
const CLIENT_TAG = "formstr-drive";

async function getSigner() {
  return signerManager.getSigner();
}

async function encryptMetadata(metadata: FileMetadata): Promise<string> {
  const conversationKey = await getDriveConversationKey();
  const json = JSON.stringify(metadata);
  return nip44.v2.encrypt(json, conversationKey);
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

/**
 * Legacy fallback: decrypt metadata encrypted directly to the Main Identity Key.
 * Used for events that do NOT carry the ["t", "files"] tag.
 */
async function decryptMetadataLegacy(ciphertext: string): Promise<FileMetadata> {
  const signer = await getSigner();
  if (!signer.nip44Decrypt) {
    throw new Error("Signer does not support NIP-44 decryption");
  }

  const pubkey = await signer.getPublicKey();
  const json = await signer.nip44Decrypt(pubkey, ciphertext);
  return JSON.parse(json);
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
  /** Cumulative list of files still encrypted to the Main Identity Key. */
  onLegacyFilesFound?: (files: FileMetadata[]) => void;
}

/**
 * Declare a standing interest in the user's kind-34578 file index. Events are
 * decrypted as they stream (cache replay first, then network sync + live tail)
 * and the deduped, tombstone-filtered file list is pushed through `onFiles`.
 * Replaces the old fetch-everything-then-wait-10-seconds SimplePool flow.
 *
 * Returns an unobserve function.
 */
export function observeFileIndex(
  pubkey: string,
  handlers: FileIndexStreamHandlers,
): () => void {
  // Resolve the Drive Key keyring in parallel with the event stream — keys are
  // only needed once the first event is processed. Every key the user has ever
  // published may unlock files encrypted under it, so we keep them ALL and try
  // each when decrypting. If this fails (e.g. signer unavailable), we fall
  // back to legacy decryption for every event.
  const driveKeysPromise: Promise<Uint8Array[]> = getDriveConversationKeys().catch(
    (e) => {
      console.warn(
        "[FileIndex] Could not obtain Drive Key keyring, using legacy decryption",
        e,
      );
      return [];
    },
  );

  // Per-hash newest event wins. `metadata: null` records "newest version could
  // not be decrypted (or is a tombstone we keep to block older resurrections)".
  const entries = new Map<
    string,
    { created_at: number; metadata: FileMetadata | null }
  >();
  const legacyFilesToMigrate: FileMetadata[] = [];
  let legacyDirty = false;
  let eosed = false;
  let stopped = false;

  const emitFiles = () => {
    const files = Array.from(entries.values())
      .filter(
        (e): e is { created_at: number; metadata: FileMetadata } =>
          e.metadata !== null && !e.metadata.deleted,
      )
      .sort((a, b) => b.created_at - a.created_at)
      .map((e) => e.metadata);
    handlers.onFiles(files);
  };

  const emitLegacy = () => {
    if (legacyDirty && legacyFilesToMigrate.length > 0) {
      legacyDirty = false;
      handlers.onLegacyFilesFound?.([...legacyFilesToMigrate]);
    }
  };

  const processEvent = async (event: Event) => {
    const dTag = event.tags.find((t: string[]) => t[0] === "d");
    const hash = dTag?.[1];
    if (!hash) return;

    // Skip the Drive Key event itself — it's not a file.
    if (hash.startsWith("0:")) return;

    // Older than what we already hold for this hash — ignore.
    const existing = entries.get(hash);
    if (existing && existing.created_at >= event.created_at) return;

    const driveConversationKeys = await driveKeysPromise;

    let metadata: FileMetadata | null = null;
    let isLegacy = false;
    try {
      const hasFilesTag = event.tags.some(
        (t: string[]) => t[0] === "t" && t[1] === "files",
      );

      if (hasFilesTag && driveConversationKeys.length > 0) {
        // New format: try every Drive Key in the keyring until one decrypts.
        try {
          metadata = decryptMetadataWithDriveKey(
            event.content,
            driveConversationKeys,
          );
        } catch {
          // No Drive Key worked (e.g. the event predates Drive Keys entirely,
          // or was encrypted to the Main Identity Key). Fall back to legacy.
          metadata = await decryptMetadataLegacy(event.content);
          isLegacy = true;
        }
      } else {
        // Legacy format: fall back to the Main Identity Signer.
        metadata = await decryptMetadataLegacy(event.content);
        isLegacy = driveConversationKeys.length > 0;
      }
    } catch (e) {
      console.debug("[FileIndex] Skipping incompatible event:", event.id, e);
    }

    // Record even failed decrypts so an older, decryptable version of the same
    // hash can't resurrect a file the newest event superseded.
    entries.set(hash, { created_at: event.created_at, metadata });

    if (isLegacy && metadata && !metadata.deleted) {
      legacyFilesToMigrate.push(metadata);
      legacyDirty = true;
    }

    if (metadata) {
      emitFiles();
      if (eosed) emitLegacy();
    }
  };

  // Serialize event processing: decryption awaits the keyring and may call an
  // async signer, so a simple promise chain keeps ordering deterministic and
  // avoids concurrent signer prompts.
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (work: () => Promise<void>) => {
    queue = queue.then(work).catch((e) => {
      console.error("[FileIndex] Event processing failed", e);
    });
  };

  const handle = dataLayer.observe(
    [{ kinds: [METADATA_KIND], authors: [pubkey] }],
    {
      onEvent: (event: Event) => {
        if (stopped) return;
        enqueue(() => processEvent(event));
      },
      onEose: () => {
        if (stopped) return;
        enqueue(async () => {
          eosed = true;
          emitFiles();
          emitLegacy();
          handlers.onReady?.();
        });
      },
    },
  );

  return () => {
    stopped = true;
    handle.unobserve();
  };
}

export async function autoMigrateLegacyFiles(files: FileMetadata[]) {
  console.log(`[FileIndex] Auto-migrating ${files.length} legacy files to Drive Key format...`);
  for (const file of files) {
    try {
      // Re-saving encrypts with Drive Key and updates the relay event (replacing the legacy one)
      await saveFileMetadata(file);
      console.log(`[FileIndex] Auto-migrated: ${file.name}`);
    } catch (e) {
      console.error(`[FileIndex] Failed to auto-migrate file: ${file.name}`, e);
    }
  }
}

/**
 * Builds and signs the kind-34578 metadata event, but does NOT publish it.
 * Split out so callers (e.g. an Android foreground handoff) can sign the
 * event while the signer is available and publish it later, possibly from
 * a background context with no signer access.
 */
export async function buildSignedMetadataEvent(metadata: FileMetadata): Promise<Event> {
  const signer = await getSigner();
  const pubkey = await signer.getPublicKey();

  const encrypted = await encryptMetadata(metadata);

  const event: NostrEvent = {
    kind: METADATA_KIND,
    pubkey,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["d", metadata.hash],
      ["t", "files"],
      ["client", CLIENT_TAG],
      ["encrypted", "nip44"],
    ],
    content: encrypted,
  };

  return signer.signEvent(event);
}

/**
 * Publish a signed metadata event through the local relay: it lands in the
 * local store immediately (standing observers see it before any relay acks)
 * and the worker fans it out upstream. Throws if NO relay accepted it,
 * matching the old Promise.any semantics; the per-relay outcome is returned
 * for publish feedback in the upload manager.
 */
export async function publishMetadataEvent(signedEvent: Event): Promise<PublishResult> {
  const result = await dataLayer.publishEvent(signedEvent);
  if (!result.ok) {
    const reasons = result.relayResults
      .map((r) => `${r.relay}: ${r.status}${r.message ? ` (${r.message})` : ""}`)
      .join(", ");
    throw new Error(`No relay accepted the metadata event — ${reasons}`);
  }
  return result;
}

export async function saveFileMetadata(metadata: FileMetadata): Promise<PublishResult> {
  const signedEvent = await buildSignedMetadataEvent(metadata);
  return publishMetadataEvent(signedEvent);
}

export async function deleteFileMetadata(_hash: string, currentMetadata: FileMetadata): Promise<void> {
  const deletedMetadata: FileMetadata = {
    ...currentMetadata,
    deleted: true,
  };
  await saveFileMetadata(deletedMetadata);
}

export function extractFolders(files: FileMetadata[]): string[] {
  const folders = new Set<string>();
  folders.add("/");

  for (const file of files) {
    const parts = file.folder.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current += "/" + part;
      folders.add(current);
    }
  }

  return Array.from(folders).sort();
}
