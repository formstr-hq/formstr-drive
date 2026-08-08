import { type Event, type Filter } from "nostr-tools";
import { dataLayer } from "@formstr/local-relay";

// -----------------------------------------------------------------------------
// A monotonic created_at clock, module-scoped. Relays tie-break equal
// timestamps on an addressable event by lowest event id, which means two
// publishes at the same coordinate within the same second (e.g. sharing a
// folder, then immediately revoking it) are a coin flip on which one "wins".
// Every event this feature signs goes through nextCreatedAt() so that never
// happens — each successive publish this session is guaranteed strictly
// newer than the last, on top of always being >= wall-clock time.
// -----------------------------------------------------------------------------
let lastStamp = 0;
export function nextCreatedAt(): number {
  lastStamp = Math.max(Math.floor(Date.now() / 1000), lastStamp + 1);
  return lastStamp;
}

/** Collects every event matching `filters` until EOSE or `timeoutMs`,
 *  whichever comes first. Never rejects — a relay that never responds is a
 *  normal, user-facing outcome ("relays unreachable"), not an exceptional
 *  one, so callers get back whatever arrived rather than an error. */
function observeUntilEose(filters: Filter[], timeoutMs: number): Promise<Event[]> {
  return new Promise((resolve) => {
    let settled = false;
    const found: Event[] = [];

    const handle = dataLayer.observe(filters, {
      onEvent: (event: Event) => found.push(event),
      onEose: () => {
        if (settled) return;
        settled = true;
        handle.unobserve();
        resolve(found);
      },
    });

    setTimeout(() => {
      if (settled) return;
      settled = true;
      handle.unobserve();
      resolve(found);
    }, timeoutMs);
  });
}

/** Fetches the newest event at a given (kind, author, d) coordinate, or null
 *  if nothing was found within `timeoutMs`. */
export async function fetchEventByCoordinate(
  kind: number,
  pubkey: string,
  d: string,
  timeoutMs = 8000,
): Promise<Event | null> {
  const events = await observeUntilEose([{ kinds: [kind], authors: [pubkey], "#d": [d] }], timeoutMs);
  return events.reduce<Event | null>(
    (latest, event) => (!latest || event.created_at > latest.created_at ? event : latest),
    null,
  );
}

/** Fetches every event matching `filters`, e.g. every `share-info` event
 *  authored by the user's Drive Keys. */
export function fetchEvents(filters: Filter[], timeoutMs = 8000): Promise<Event[]> {
  return observeUntilEose(filters, timeoutMs);
}
