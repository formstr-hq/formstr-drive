import { decryptSharePayload } from "./crypto";
import { getDriveKeyPubkeys, getDriveConversationKeys } from "../driveKey";
import { METADATA_KIND, buildCoordinate, encodeShareLink, parseCoordinate } from "./link";
import { fetchEvents } from "./relay";
import { sourceEquals } from "./dedupe";
import type { ShareMember, ShareSource, SharedByMeEntry } from "./types";

/**
 * Loads all "Shared by me" entries by fetching the user's `shared-container`
 * bookkeeping events (NIP-FS's "Shared container Information subtype" —
 * published for file shares too, despite the name; see shareInfo.ts) and
 * decrypting them with the Drive Key. Revoked shares stay in the list (their
 * `revokedAt` is set) — a vanished entry would be indistinguishable from a
 * relay read failure, and this is the handle a caller needs to retry a
 * partially-failed revoke.
 */
export async function loadSharedByMe(): Promise<SharedByMeEntry[]> {
  const drivePubkeys = await getDriveKeyPubkeys();
  const conversationKeys = await getDriveConversationKeys();
  if (drivePubkeys.length === 0) return [];

  const events = await fetchEvents([
    { kinds: [METADATA_KIND], authors: drivePubkeys, "#t": ["shared-container"] },
  ]);

  const entries: SharedByMeEntry[] = [];

  for (const event of events) {
    let json: string | null = null;
    for (const key of conversationKeys) {
      try {
        json = decryptSharePayload(event.content, key);
        break;
      } catch {
        // Wrong key — try the next one in the keyring.
      }
    }
    if (json === null) continue;

    const infoD = event.tags.find((t) => t[0] === "d")?.[1];
    if (!infoD) continue;
    const infoCoordinate = buildCoordinate(event.pubkey, infoD);

    try {
      const parsed = JSON.parse(json) as Record<string, unknown>;
      const kind: "file" | "folder" = parsed.kind === "folder" ? "folder" : "file";
      const name = typeof parsed.name === "string" ? parsed.name : null;
      const coordinate = typeof parsed.coordinate === "string" ? parsed.coordinate : null;
      const encryptionKey = typeof parsed.encryptionKey === "string" ? parsed.encryptionKey : null;
      const source = parsed.source as ShareSource | undefined;
      if (!name || !coordinate || !encryptionKey || !source) continue;

      const relays = Array.isArray(parsed.relays) ? (parsed.relays as string[]) : [];
      const { d } = parseCoordinate(coordinate);

      entries.push({
        kind,
        name,
        source,
        sharedAtSeconds: event.created_at,
        url: encodeShareLink({ pubkey: event.pubkey, dTag: d, relays, secretKeyHex: encryptionKey }),
        infoD,
        infoCoordinate,
        coordinate,
        relays,
        encryptionKey,
        members: kind === "folder" ? ((parsed.members as ShareMember[] | undefined) ?? []) : [],
        revokedAt: typeof parsed.revokedAt === "number" ? parsed.revokedAt : undefined,
      });
    } catch {
      // Skip malformed entries.
    }
  }

  entries.sort((a, b) => b.sharedAtSeconds - a.sharedAtSeconds);
  return entries;
}

/**
 * The existing live (non-revoked) share for this item, or null. Used to make
 * sharing idempotent — the newest match wins, though under normal operation
 * there should only ever be one live entry per source.
 *
 * `knownEntries`, if given, is searched instead of querying relays — pass
 * the list a `SharesProvider` already has loaded (e.g. from `useShares()`)
 * to turn "does this already have a link" from an ~8s-capped relay round
 * trip into a synchronous lookup. Only skip the network this way once
 * you're sure that cache has actually completed its first load; an empty
 * cache that hasn't loaded yet would look identical to "never shared" and
 * create a duplicate.
 */
export async function findActiveShare(
  source: ShareSource,
  knownEntries?: SharedByMeEntry[],
): Promise<SharedByMeEntry | null> {
  const entries = knownEntries ?? (await loadSharedByMe());
  return entries.find((e) => !e.revokedAt && sourceEquals(e.source, source)) ?? null;
}
