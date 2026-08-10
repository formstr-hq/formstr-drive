import type { FileMetadata } from "../../types/metadata";
import { aesGcmDecrypt, deriveConversationKeyFromHex } from "../../crypto";
import { parseCoordinate } from "./link";
import { fetchEventByCoordinate } from "./relay";
import { isRevoked, type ResolvedShare, type ShareLinkPayload } from "./types";

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

  const container = parsed as { name: string; files: [string, string, string?][] };
  const files: FileMetadata[] = [];
  let partial = false;

  const fetchPromises = container.files.map(async ([, coordinate]) => {
    const { kind: fKind, pubkey: fPubkey, d: fD } = parseCoordinate(coordinate);
    const fileEvent = await fetchEventByCoordinate(fKind, fPubkey, fD);
    if (!fileEvent) {
      throw new Error("File event not found");
    }
    if (fileEvent.tags.some((t) => t[0] === "revoked" && t[1] === "1")) {
      throw new Error("File was revoked");
    }
    const fileJson = await aesGcmDecrypt(fileEvent.content, conversationKey);
    const parsedFile = JSON.parse(fileJson);
    if (isRevoked(parsedFile)) {
      throw new Error("File was revoked");
    }
    return parsedFile as FileMetadata;
  });

  const results = await Promise.allSettled(fetchPromises);
  for (const result of results) {
    if (result.status === "fulfilled") {
      files.push(result.value);
    } else {
      partial = true;
    }
  }

  return { kind: "folder", result: { name: container.name, files, partial } };
}
