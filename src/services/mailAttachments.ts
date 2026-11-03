import { finalizeEvent, nip19, verifyEvent, type Event } from "nostr-tools";
import { hexToBytes } from "nostr-tools/utils";
import { dataLayer } from "@formstr/local-relay";
import { BlossomClient } from "../blossom";
import { deriveConversationKeyFromHex } from "../crypto";
import { signerManager } from "../signer/manager";
import { getLocalRelayClient } from "../dataLayer/bootstrap";
import { getStoredItem, setStoredItem, STORAGE_KEYS } from "../utils/persistence";
import { buildShareEvent } from "./sharing/event";
import { decodeShareLink, METADATA_KIND } from "./sharing/link";
import { withRelayHints } from "./sharing/hints";
import {
  fetchEventByCoordinate,
  fetchEvents,
  nextCreatedAt,
} from "./sharing/relay";

/** Mailstr's inner mail kind, seal kind, and NIP-59 wrap kind. */
const MAIL_KIND = 1301;
const SEAL_KIND = 13;
const GIFTWRAP_KIND = 1059;

/**
 * One retained mail-attachment capability. Mirrors the mail app's
 * `AttachmentManage`; the drive UI reads it from the sender's own self-copy
 * giftwrap, not from a separate keyring event.
 */
export interface MailAttachmentKey {
  shareUrl: string;
  filename: string;
  createdAt: number;
  /** New attachments are authorized by the user's identity; older ones by a
   *  retained throwaway upload key. */
  uploadAuth?: "identity" | "ephemeral";
  uploadSecretKey?: string;
  shareSecretKey: string;
  blobHash: string;
  server: string;
}

const HEX64 = /^[0-9a-f]{64}$/i;
const HTTP_URL = /^https?:\/\//i;

/** Last DM relay set pushed to the worker. Re-setting it re-opens the kind-1059
 *  stream, so avoid doing that on every live-triggered reload. */
let appliedDmRelays = "";

function applyDmRelays(relays: string[]): void {
  const key = [...relays].sort().join("\n");
  if (key === appliedDmRelays) return;
  const client = getLocalRelayClient();
  if (!client) return;
  client.setDmRelays(relays);
  appliedDmRelays = key;
}

function isManage(value: unknown): value is MailAttachmentKey {
  if (!value || typeof value !== "object") return false;
  const m = value as Record<string, unknown>;
  const hasEphemeralUploadKey =
    typeof m.uploadSecretKey === "string" && HEX64.test(m.uploadSecretKey);
  const hasIdentityUpload = m.uploadAuth === "identity";
  return (
    typeof m.shareUrl === "string" &&
    m.shareUrl.includes("#shared=") &&
    typeof m.filename === "string" &&
    m.filename.length > 0 &&
    typeof m.createdAt === "number" &&
    Number.isFinite(m.createdAt) &&
    (hasIdentityUpload || hasEphemeralUploadKey) &&
    typeof m.shareSecretKey === "string" &&
    HEX64.test(m.shareSecretKey) &&
    typeof m.blobHash === "string" &&
    HEX64.test(m.blobHash) &&
    typeof m.server === "string" &&
    HTTP_URL.test(m.server)
  );
}

async function dmRelayHints(pubkey: string): Promise<string[]> {
  const events = await fetchEvents(
    [{ kinds: [10050], authors: [pubkey], limit: 1 }],
    5000,
  );
  const latest = events.sort((a, b) => b.created_at - a.created_at)[0];
  if (!latest) {
    applyDmRelays([]);
    return [];
  }
  const relays = latest.tags
    .filter((tag) => tag[0] === "relay" && typeof tag[1] === "string" && tag[1])
    .map((tag) => tag[1]);
  // The drive relay was bootstrapped without DM relays (it only reads the
  // drive index). A kind-1059 read is routed through the DM stream, so without
  // this the mail self-copies are never fetched — which is why new attachments
  // did not appear. Setting them also makes a standing observe live-update.
  applyDmRelays(relays);
  return relays;
}

async function loadRemoved(): Promise<Set<string>> {
  const urls = await getStoredItem<string[]>(
    STORAGE_KEYS.REMOVED_MAIL_ATTACHMENTS,
    [],
  );
  return new Set(Array.isArray(urls) ? urls : []);
}

async function markRemoved(shareUrl: string): Promise<void> {
  const urls = await getStoredItem<string[]>(
    STORAGE_KEYS.REMOVED_MAIL_ATTACHMENTS,
    [],
  );
  const next = Array.from(new Set([...(Array.isArray(urls) ? urls : []), shareUrl]));
  await setStoredItem(STORAGE_KEYS.REMOVED_MAIL_ATTACHMENTS, next);
}

/**
 * Unwrap one wrap only when it is OUR OWN self-copy: the outer p-tag is ours,
 * but anyone can send us a wrap, so the seal author must be our identity and
 * the inner rumor must match it. That is what stops a hostile sender from
 * planting fake delete keys in our Drive UI.
 */
async function unwrapSelfCopy(
  wrap: Event,
  signerPubkey: string,
  nip44Decrypt: (peerPubkey: string, ciphertext: string) => Promise<string>,
): Promise<{ kind: number; pubkey: string; tags: string[][]; created_at: number } | null> {
  let seal: Event;
  try {
    seal = JSON.parse(await nip44Decrypt(wrap.pubkey, wrap.content)) as Event;
  } catch {
    return null;
  }
  if (
    seal.kind !== SEAL_KIND ||
    seal.pubkey !== signerPubkey ||
    !verifyEvent(seal)
  ) {
    return null;
  }

  let rumor: { kind: number; pubkey: string; tags: string[][]; created_at: number };
  try {
    rumor = JSON.parse(
      await nip44Decrypt(seal.pubkey, seal.content),
    ) as typeof rumor;
  } catch {
    return null;
  }
  if (rumor.kind !== MAIL_KIND || rumor.pubkey !== signerPubkey) return null;
  return rumor;
}

/**
 * The sender's mail attachment capabilities, extracted from their own Sent
 * giftwraps. No separate keyring event and no settings growth: the self-copy
 * already carries an encrypted `attachment-manage` tag per attachment.
 */
export async function loadMailAttachmentKeys(): Promise<MailAttachmentKey[]> {
  const signer = await signerManager.getSigner();
  if (!signer.nip44Decrypt) {
    throw new Error("This signer cannot decrypt your sent mail.");
  }
  const pubkey = await signer.getPublicKey();
  const dmRelays = await dmRelayHints(pubkey);
  const wraps = await withRelayHints(dmRelays, () =>
    fetchEvents(
      [
        {
          kinds: [GIFTWRAP_KIND],
          "#p": [pubkey],
          "#k": [String(MAIL_KIND)],
          limit: 500,
        },
      ],
      12_000,
    ),
  );

  const removed = await loadRemoved();
  const byUrl = new Map<string, MailAttachmentKey>();
  for (const wrap of wraps) {
    const rumor = await unwrapSelfCopy(wrap, pubkey, signer.nip44Decrypt);
    if (!rumor) continue;
    for (const tag of rumor.tags) {
      if (tag[0] !== "attachment-manage" || !tag[1]) continue;
      try {
        const parsed: unknown = JSON.parse(tag[1]);
        if (!isManage(parsed) || removed.has(parsed.shareUrl)) continue;
        const existing = byUrl.get(parsed.shareUrl);
        if (!existing || parsed.createdAt > existing.createdAt) {
          byUrl.set(parsed.shareUrl, parsed);
        }
      } catch {
        // Malformed tag; ignore.
      }
    }
  }

  return [...byUrl.values()].sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Standing interest in the user's own mail self-copies. With DM relays set by
 * `loadMailAttachmentKeys`, this surfaces a new self-copy (and therefore a new
 * mail attachment) without reopening the view.
 */
export function observeMailAttachmentKeys(
  pubkey: string,
  onChange: () => void,
): () => void {
  const handle = dataLayer.observe(
    [
      {
        kinds: [GIFTWRAP_KIND],
        "#p": [pubkey],
        "#k": [String(MAIL_KIND)],
      },
    ],
    { onEvent: () => onChange() },
  );
  return () => handle.unobserve();
}

/**
 * Revoke the share, delete the encrypted Blob with the retained upload key,
 * and remember locally that this entry is gone (the self-copy still carries the
 * tag, so the list must not resurrect it on reload).
 */
export async function deleteMailAttachmentKey(key: MailAttachmentKey): Promise<void> {
  const link = decodeShareLink(key.shareUrl);
  if (!link) throw new Error("The stored share link is malformed.");
  const decoded = nip19.decode(link.naddr);
  if (decoded.type !== "naddr") throw new Error("The stored share coordinate is malformed.");
  const { pubkey: sharePubkey, identifier: dTag } = decoded.data;
  const relayHints = decoded.data.relays ?? [];

  // Revoke first: this is what stops the link working. A failed blob delete
  // afterwards leaves an orphan, not a live link.
  const original = await fetchEventByCoordinate(
    METADATA_KIND,
    sharePubkey,
    dTag,
    8000,
    relayHints,
  );
  const createdAt = original
    ? Math.max(nextCreatedAt(), original.created_at + 1)
    : nextCreatedAt();
  const at = Math.floor(Date.now() / 1000);
  const identityUpload = key.uploadAuth === "identity" || !key.uploadSecretKey;
  // Resolve the identity signer before revoking: a revoked link whose blob
  // cannot be deleted because the signer is locked is worse than leaving both.
  const identitySigner = identityUpload ? await signerManager.getSigner() : null;
  const revoked = buildShareEvent({
    subtype: "shared-file",
    dTag,
    payload: { v: 1, revoked: true, at, kind: "file" },
    conversationKey: deriveConversationKeyFromHex(link.k),
    signingKey: hexToBytes(key.shareSecretKey),
    createdAt,
    extraTags: [["revoked", "1"]],
  });
  const published = await withRelayHints(relayHints, () =>
    dataLayer.publishEvent(revoked),
  );
  if (!published.relayResults.some((outcome) => outcome.status === "accepted")) {
    throw new Error("Could not revoke the share; the link is still live.");
  }

  const now = Math.floor(Date.now() / 1000);
  const tags: string[][] = [
    ["t", "delete"],
    ["x", key.blobHash],
    ["expiration", String(now + 300)],
  ];
  const authEvent = identitySigner
    ? ((await identitySigner.signEvent({
        kind: 24242,
        created_at: now,
        tags,
        content: "Delete mail attachment",
      })) as Event)
    : finalizeEvent(
        {
          kind: 24242,
          created_at: now,
          tags,
          content: "Delete mail attachment",
        },
        hexToBytes(key.uploadSecretKey!),
      );
  await new BlossomClient(key.server).delete(
    key.blobHash,
    `Nostr ${btoa(JSON.stringify(authEvent))}`,
  );

  await markRemoved(key.shareUrl);
}
