// Folder sharing — set aside per NIP-FS ("Folder sharing is TBD") and
// current product direction: not reachable from the UI. See ./create.ts for
// the full explanation. resolveSharedLink (../resolve.ts) still calls this
// when asked to resolve an EXISTING folder share link, so a link created
// before this feature was set aside keeps working even though creating new
// ones is no longer exposed anywhere in the UI.
import type { FileMetadata } from "../../../types/metadata";
import { aesGcmDecrypt } from "../../../crypto";
import { parseCoordinate } from "../link";
import { fetchEventByCoordinate } from "../relay";
import { isRevoked, type ResolvedShare } from "../types";

/** Resolves an already-decrypted shared-container payload into its member
 *  files. `conversationKey` is the container's own ephemeral key — every
 *  member was encrypted under the SAME key, so no per-member key lookup is
 *  needed. */
export async function resolveFolderShare(
  container: { name: string; files: [string, string, string?][] },
  conversationKey: Uint8Array,
): Promise<ResolvedShare> {
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
