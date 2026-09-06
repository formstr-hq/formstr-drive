import { finalizeEvent } from "nostr-tools";
import { hexToBytes } from "nostr-tools/utils";
import { dataLayer } from "@formstr/local-relay";
import { getDriveKeyByPubkey } from "./driveKey";

const METADATA_KIND = 34578;

/**
 * Best-effort NIP-09 kind-5 deletion request addressed at one or more
 * addressable coordinates ("34578:<pubkey>:<d>"). Never throws — many relays
 * don't honor kind-5 at all (or don't apply it to addressable events), so
 * this is a courtesy on top of whatever actually supersedes the event (a
 * tombstone republish for files, a "revoked" republish for shares), never
 * the deletion mechanism itself.
 *
 * Coordinates are grouped by author and one kind-5 is published per author
 * (each with all of that author's coordinates as separate `a` tags), rather
 * than one kind-5 per coordinate — a folder revoke can involve a dozen+
 * coordinates, and N separate publishes is exactly the burst pattern that
 * gets rate-limited (see metadataOutbox.ts's ~90%-rejected-at-10/s note).
 * A coordinate whose author this device holds no Drive Key secret for is
 * skipped with a warning: a kind-5 signed by key A cannot delete an event
 * authored by key B, so publishing one would be pure noise.
 */
export async function publishDeletionRequest(
  coordinates: string[],
  reason: string,
): Promise<void> {
  const byAuthor = new Map<string, string[]>();

  for (const coordinate of coordinates) {
    const [, pubkey] = coordinate.split(":");
    if (!pubkey) continue;
    const list = byAuthor.get(pubkey) ?? [];
    list.push(coordinate);
    byAuthor.set(pubkey, list);
  }

  await Promise.all(
    Array.from(byAuthor.entries()).map(async ([pubkey, coords]) => {
      try {
        const key = await getDriveKeyByPubkey(pubkey);
        if (!key) {
          console.warn(
            `[DeletionRequest] Skipping NIP-09 request for ${coords.length} coordinate(s) — ` +
              `this device doesn't hold the Drive Key secret for ${pubkey}`,
          );
          return;
        }

        const deletionEvent = finalizeEvent(
          {
            kind: 5,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
              ...coords.map((c) => ["a", c]),
              ["k", String(METADATA_KIND)],
            ],
            content: reason,
          },
          hexToBytes(key.secretKeyHex),
        );
        await dataLayer.publishEvent(deletionEvent);
      } catch (e) {
        console.warn("[DeletionRequest] NIP-09 deletion request failed (superseding event still applies)", e);
      }
    }),
  );
}
