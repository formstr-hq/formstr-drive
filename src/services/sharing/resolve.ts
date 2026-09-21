import type { FileMetadata } from "../../types/metadata";
import { aesGcmDecrypt, deriveConversationKeyFromHex } from "../../crypto";
import { parseCoordinate } from "./link";
import { fetchEventByCoordinate } from "./relay";
import { isRevoked, type ResolvedShare, type ShareLinkPayload } from "./types";
import { resolveFolderShare } from "./folder/resolve";

/** Resolves a decoded share payload back into file metadata — no signer or
 *  signed-in identity required, matching NIP-FS's "no signer or identity is
 *  required to view or download a shared file". */
export async function resolveSharedLink(payload: ShareLinkPayload): Promise<ResolvedShare> {
  const conversationKey = deriveConversationKeyFromHex(payload.k);
  const { kind, pubkey, d } = parseCoordinate(payload.a);
  const event = await fetchEventByCoordinate(kind, pubkey, d);
  if (!event) {
    throw new Error("This share link couldn't be found. It may be invalid, or the relays are unreachable.");
  }

  // Short-circuit on the plaintext tag before decrypting, so a revoked link
  // renders correctly even if the re-encrypted payload is somehow malformed.
  if (event.tags.some((t) => t[0] === "revoked" && t[1] === "1")) {
    return { kind: "revoked", target: payload.kind, at: event.created_at };
  }

  const json = await aesGcmDecrypt(event.content, conversationKey);
  const parsed = JSON.parse(json);

  if (isRevoked(parsed)) {
    return { kind: "revoked", target: parsed.kind, at: parsed.at };
  }

  if (payload.kind === "file") {
    return { kind: "file", file: parsed as FileMetadata };
  }

  // Folder sharing is set aside from the UI (see ./folder/create.ts), but an
  // already-existing folder share link still resolves — only CREATING new
  // ones is unwired.
  const container = parsed as { name: string; files: [string, string, string?][] };
  return resolveFolderShare(container, conversationKey);
}
