import { bytesToHex, hexToBytes } from "nostr-tools/utils";
import type { DriveKeyEntry } from "../driveKey";
import { deriveConversationKeyFromHex } from "../../crypto";
import { enqueueMetadataEvent, publishAndDequeue } from "../metadataOutbox";
import { buildShareEvent } from "./event";
import { METADATA_KIND, parseCoordinate } from "./link";
import { fetchEventByCoordinate, nextCreatedAt } from "./relay";
import type { RevokedSharePayload, ShareMember, ShareSource } from "./types";

/**
 * Ephemeral encryption pair per NIP-FS "File/Folder Sharing": conversationKey
 * is derived from the secret paired with its OWN derived pubkey (self-
 * encryption), exactly like `deriveConversationKeyFromHex` already does for
 * the Drive Key. Anyone later given the secret hex can re-derive the same
 * conversation key without needing to know any real recipient pubkey.
 */
export function generateEphemeralEncryptionKey(): { secretKeyHex: string; conversationKey: Uint8Array } {
  const secretKeyHex = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  const conversationKey = deriveConversationKeyFromHex(secretKeyHex);
  return { secretKeyHex, conversationKey };
}

// ---------------------------------------------------------------------------
// "shared-container" bookkeeping event, encrypted to the owner's own Drive
// Key — NIP-FS's "Shared container Information subtype". Despite the name
// (shared by the spec, not chosen here), it is published for BOTH file and
// folder shares: it's this app's one place to enumerate "shares I've made",
// regardless of what the share points at. Only the owner can decrypt it.
// ---------------------------------------------------------------------------

interface ShareInfoPayload {
  v: 1;
  kind: "file" | "folder";
  name: string;
  source: ShareSource;
  /** Container coordinate (folder) or the shared-file coordinate (file). */
  coordinate: string;
  /** Relays `coordinate`'s event actually landed on at last publish — what
   *  lets `list.ts` rebuild a working link (with hints) from this record
   *  alone, without re-publishing anything. */
  relays: string[];
  /** Folder members with file-id tracking, for drift detection. [] for a
   *  file share. */
  members: ShareMember[];
  encryptionKey: string;
  revokedAt?: number;
}

/** Publishes (or republishes, at an existing `dTag`) the bookkeeping event.
 *  Callers decide whether a failure here is fatal — creating a fresh share
 *  treats it as best-effort (the share link itself already works), while
 *  drift updates and revokes want to know if it didn't land. */
export async function writeShareInfo(
  driveKey: DriveKeyEntry,
  dTag: string,
  payload: Omit<ShareInfoPayload, "v">,
): Promise<void> {
  const event = buildShareEvent({
    subtype: "shared-container",
    dTag,
    payload: { v: 1, ...payload } satisfies ShareInfoPayload,
    conversationKey: driveKey.conversationKey,
    signingKey: hexToBytes(driveKey.secretKeyHex),
  });
  await enqueueMetadataEvent(event, payload.name);
  await publishAndDequeue(event);
}

/**
 * Publishes a superseding event at `coordinate` — same `d`, same `t` tag,
 * re-encrypted under the SAME conversation key the recipient already has
 * (so this discloses nothing new, and is the only way a viewer can render
 * an authenticated "revoked" state rather than a generic decrypt failure).
 * `created_at` is bumped strictly past whatever's currently published there,
 * so a revoke issued in the same second as the original share always wins
 * the relay tie-break.
 */
export async function publishSupersedingEvent(
  key: DriveKeyEntry,
  coordinate: string,
  subtype: "shared-file" | "container",
  conversationKey: Uint8Array,
  payload: RevokedSharePayload,
): Promise<void> {
  const { pubkey, d } = parseCoordinate(coordinate);
  const original = await fetchEventByCoordinate(METADATA_KIND, pubkey, d);
  const createdAt = original ? Math.max(nextCreatedAt(), original.created_at + 1) : nextCreatedAt();

  const event = buildShareEvent({
    subtype,
    dTag: d,
    payload,
    conversationKey,
    signingKey: hexToBytes(key.secretKeyHex),
    createdAt,
    extraTags: [["revoked", "1"]],
  });

  await enqueueMetadataEvent(event, `revoke ${d}`);
  await publishAndDequeue(event);
}
