import { nip19 } from "nostr-tools";
import type { FileMetadata } from "../../types/metadata";
import { decryptSharePayload } from "./crypto";
import { deriveConversationKeyFromHex } from "../../crypto";
import { fetchEventByCoordinate } from "./relay";
import { isRevoked, type ResolvedShare, type ShareLinkPayload } from "./types";
import { resolveFolderShare } from "./folder/resolve";

/** Resolves a decoded share payload back into file metadata — no signer or
 *  signed-in identity required, matching NIP-FS's "no signer or identity is
 *  required to view or download a shared file". */
export async function resolveSharedLink(payload: ShareLinkPayload): Promise<ResolvedShare> {
  const conversationKey = deriveConversationKeyFromHex(payload.k);

  // decodeShareLink (link.ts) already validated this naddr and its kind
  // before ever handing back a ShareLinkPayload, so the type check below
  // can't actually fail on anything reaching this function through the
  // normal link-parsing path — it's here so this function has no unchecked
  // cast of its own if it's ever called with a payload from somewhere else.
  const decoded = nip19.decode(payload.naddr);
  if (decoded.type !== "naddr") {
    throw new Error("This share link couldn't be found. It may be invalid, or the relays are unreachable.");
  }
  const { kind, pubkey, identifier, relays } = decoded.data;
  const event = await fetchEventByCoordinate(kind, pubkey, identifier, undefined, relays);
  if (!event) {
    throw new Error("This share link couldn't be found. It may be invalid, or the relays are unreachable.");
  }

  // Which subtype this is — file or folder — is read off the event's OWN
  // `t` tag, not asserted by the link. The link only ever needed to say
  // WHERE the event is; what it IS is the event's own business, and there's
  // no second place for that claim to drift out of sync with reality.
  const subtype = event.tags.find((t) => t[0] === "t")?.[1];
  const target: "file" | "folder" = subtype === "container" ? "folder" : "file";

  // Short-circuit on the plaintext tag before decrypting, so a revoked link
  // renders correctly even if the re-encrypted payload is somehow malformed.
  if (event.tags.some((t) => t[0] === "revoked" && t[1] === "1")) {
    return { kind: "revoked", target, at: event.created_at };
  }

  const json = decryptSharePayload(event.content, conversationKey);
  const parsed = JSON.parse(json);

  if (isRevoked(parsed)) {
    return { kind: "revoked", target: parsed.kind, at: parsed.at };
  }

  if (target === "file") {
    return { kind: "file", file: parsed as FileMetadata };
  }

  // Folder sharing is set aside from the UI (see ./folder/create.ts), but an
  // already-existing folder share link still resolves — only CREATING new
  // ones is unwired.
  const container = parsed as { name: string; metadata: [string, string, string?][] };
  return resolveFolderShare(container, conversationKey);
}
