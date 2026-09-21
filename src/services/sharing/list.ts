import { aesGcmDecrypt } from "../../crypto";
import { getDriveKeyPubkeys, getDriveConversationKeys } from "../driveKey";
import { METADATA_KIND, buildCoordinate } from "./link";
import { buildShareUrl } from "./link";
import { fetchEvents } from "./relay";
import { sourceEquals } from "./dedupe";
import type { ShareMember, ShareSource, SharedByMeEntry } from "./types";

/**
 * Loads all "Shared by me" entries by fetching the user's `share-info`
 * events and decrypting them with the Drive Key. Revoked shares stay in the
 * list (their `revokedAt` is set) — a vanished entry would be indistinguishable
 * from a relay read failure, and this is the handle a caller needs to retry a
 * partially-failed revoke.
 */
export async function loadSharedByMe(): Promise<SharedByMeEntry[]> {
  const drivePubkeys = await getDriveKeyPubkeys();
  const conversationKeys = await getDriveConversationKeys();
  if (drivePubkeys.length === 0) return [];

  const events = await fetchEvents([{ kinds: [METADATA_KIND], authors: drivePubkeys, "#t": ["share-info"] }]);

  const entries: SharedByMeEntry[] = [];

  for (const event of events) {
    let json: string | null = null;
    for (const key of conversationKeys) {
      try {
        json = await aesGcmDecrypt(event.content, key);
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
      if (!name) continue;

      if (parsed.v === 2) {
        const coordinate = parsed.coordinate;
        const encryptionKey = parsed.encryptionKey;
        if (typeof coordinate !== "string" || typeof encryptionKey !== "string") continue;

        entries.push({
          kind,
          name,
          source: (parsed.source as ShareSource | undefined) ?? null,
          sharedAtSeconds: event.created_at,
          url: buildShareUrl({ v: 1, kind, a: coordinate, k: encryptionKey }),
          infoD,
          infoCoordinate,
          coordinate,
          encryptionKey,
          members: kind === "folder" ? ((parsed.members as ShareMember[] | undefined) ?? []) : [],
          revokedAt: typeof parsed.revokedAt === "number" ? parsed.revokedAt : undefined,
        });
      } else {
        // v1 record: no `v`, `source`, or `members` — `container` is an
        // ["a", coordinate, hint] triple.
        const container = parsed.container as [string, string, string?] | undefined;
        const encryptionKey = parsed.encryptionKey;
        if (!container || typeof encryptionKey !== "string") continue;
        const coordinate = container[1];

        entries.push({
          kind,
          name,
          source: null,
          sharedAtSeconds: event.created_at,
          url: buildShareUrl({ v: 1, kind, a: coordinate, k: encryptionKey }),
          infoD,
          infoCoordinate,
          coordinate,
          encryptionKey,
          members: null,
        });
      }
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
