import { finalizeEvent } from "nostr-tools";
import { hexToBytes, bytesToHex } from "nostr-tools/utils";
import type { DriveKeyEntry } from "../driveKey";
import { aesGcmEncrypt, deriveConversationKeyFromHex } from "../../crypto";
import { enqueueMetadataEvent, publishAndDequeue } from "../metadataOutbox";
import { METADATA_KIND, CLIENT_TAG, parseCoordinate } from "./link";
import { nextCreatedAt, fetchEventByCoordinate } from "./relay";
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
// share-info bookkeeping event — encrypted to the owner's own Drive Key, so
// only they can enumerate their outstanding shares.
// ---------------------------------------------------------------------------

interface ShareInfoPayload {
  v: 2;
  kind: "file" | "folder";
  name: string;
  /** Null when superseding a v1 entry on revoke — the original share never
   *  recorded a source, and revoke has no way to reconstruct one. */
  source: ShareSource | null;
  /** Container coordinate (folder) or the shared-file coordinate (file). */
  coordinate: string;
  /** Folder members with file-id tracking, for drift detection. [] for a
   *  file share. */
  members: ShareMember[];
  encryptionKey: string;
  revokedAt?: number;
}

/** Publishes (or republishes, at an existing `dTag`) the share-info event.
 *  Callers decide whether a failure here is fatal — creating a fresh share
 *  treats it as best-effort (the share link itself already works), while
 *  drift updates and revokes want to know if it didn't land. */
export async function writeShareInfo(
  driveKey: DriveKeyEntry,
  dTag: string,
  payload: Omit<ShareInfoPayload, "v">,
): Promise<void> {
  const event = finalizeEvent(
    {
      kind: METADATA_KIND,
      created_at: nextCreatedAt(),
      tags: [
        ["d", dTag],
        ["t", "share-info"],
        ["client", CLIENT_TAG],
        ["encrypted", "nip44"],
      ],
      content: await aesGcmEncrypt(
        JSON.stringify({ v: 2, ...payload } satisfies ShareInfoPayload),
        driveKey.conversationKey,
      ),
    },
    hexToBytes(driveKey.secretKeyHex),
  );
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
  tag: "shared-file" | "shared-container",
  conversationKey: Uint8Array,
  payload: RevokedSharePayload,
): Promise<void> {
  const { pubkey, d } = parseCoordinate(coordinate);
  const original = await fetchEventByCoordinate(METADATA_KIND, pubkey, d);
  const createdAt = original ? Math.max(nextCreatedAt(), original.created_at + 1) : nextCreatedAt();

  const event = finalizeEvent(
    {
      kind: METADATA_KIND,
      created_at: createdAt,
      tags: [
        ["d", d],
        ["t", tag],
        ["client", CLIENT_TAG],
        ["encrypted", "nip44"],
        ["revoked", "1"],
      ],
      content: await aesGcmEncrypt(JSON.stringify(payload), conversationKey),
    },
    hexToBytes(key.secretKeyHex),
  );

  await enqueueMetadataEvent(event, `revoke ${d}`);
  await publishAndDequeue(event);
}
