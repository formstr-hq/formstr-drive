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

// How long to keep collecting after the last event arrived, once something
// has. Gives a slower relay a chance to deliver a NEWER version of the same
// addressable coordinate (a republished container, a revoke) before we settle
// on the first one that happened to arrive.
const SETTLE_QUIET_MS = 1200;

// How often to re-declare the interest while the store has nothing yet. See
// the "re-poll" comment below for why this is needed at all.
const REPOLL_INTERVAL_MS = 400;

/**
 * Collects every event matching `filters`, resolving once the results look
 * settled or `timeoutMs` elapses.
 *
 * Two local-relay quirks make this trickier than a plain EOSE wait:
 *
 * 1. EOSE means "cache replay finished", NOT "the network answered" — the
 *    worker serves `observe` from its own store first and streams upstream
 *    events afterwards on the live tail (see the identical note on
 *    `fetchDriveKeyEvents` in src/services/driveKey.ts). Settling on EOSE
 *    unconditionally would return an empty result within milliseconds on a
 *    cold cache — exactly the recipient's situation: the OWNER's device
 *    always has the event locally (publishEvent stores before it sends), so
 *    a share link resolved fine there while failing for everyone it was
 *    actually sent to.
 *
 * 2. The worker loads its store from IndexedDB asynchronously on boot, and
 *    that load SUPPRESSES change notifications for the whole batch (a
 *    deliberate choice upstream, to avoid a live-sub storm on every cold
 *    start) — callers are expected to be told once it's done and re-declare.
 *    That notification (`bootstrap.ts`'s "hydrated" handler) never actually
 *    arrives on the installed local-relay version, so an interest declared
 *    before hydration finishes — which `SharedView` reliably does, since it
 *    fires on mount with no sign-in gate ahead of it — sees an empty store at
 *    EOSE and is NEVER told the store filled in moments later. It's stuck
 *    relying on a live relay delivery for an event that was sitting in this
 *    exact browser's own cache the whole time. This is why a share link
 *    fails to resolve reliably on a fresh tab or a reload, even once (1) is
 *    fixed, while working every time from the tab that just created it (which
 *    reuses the already-warm worker from that publish).
 *
 * So EOSE is treated as a checkpoint, not a terminator, and an empty result at
 * EOSE triggers periodic re-declares of the same interest — cheap, local-only
 * re-queries — until the store actually has something or `timeoutMs` elapses.
 * That works around (2) without depending on any hydration signal ever
 * arriving, and a re-declare that lands after hydration finishes gets exactly
 * the fresh, populated query (1) already needed anyway.
 *
 * Never rejects — a relay that never responds is a normal, user-facing outcome
 * ("relays unreachable"), not an exceptional one, so callers get back whatever
 * arrived rather than an error.
 */
function observeCollecting(filters: Filter[], timeoutMs: number): Promise<Event[]> {
  return new Promise((resolve) => {
    let settled = false;
    let quietTimer: ReturnType<typeof setTimeout> | null = null;
    let repollTimer: ReturnType<typeof setTimeout> | null = null;
    const found = new Map<string, Event>();

    const settle = () => {
      if (settled) return;
      settled = true;
      if (quietTimer) clearTimeout(quietTimer);
      if (repollTimer) clearTimeout(repollTimer);
      clearTimeout(deadline);
      handle.unobserve();
      resolve(Array.from(found.values()));
    };

    // Restarted by each new event, so a burst from several relays (or a
    // repoll finally landing) is collected as one batch rather than settling
    // on whichever arrived first.
    const bumpQuietTimer = () => {
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(settle, SETTLE_QUIET_MS);
    };

    // Re-sends the exact same REQ. Each cycle re-queries the worker's store
    // fresh — a plain local read, no network — so it succeeds the moment
    // hydration actually finishes, with no dependency on being told so.
    // Self-perpetuating: only stops once something is found (bumpQuietTimer
    // takes over from there) or the whole call settles.
    const scheduleRepoll = () => {
      repollTimer = setTimeout(() => {
        if (settled || found.size > 0) return;
        handle.update(filters);
        scheduleRepoll();
      }, REPOLL_INTERVAL_MS);
    };

    const handle = dataLayer.observe(filters, {
      onEvent: (event: Event) => {
        const isNew = !found.has(event.id);
        found.set(event.id, event);
        if (isNew) bumpQuietTimer();
      },
      onEose: () => {
        if (found.size > 0) {
          // Cache hit (initial or via a repoll that just landed): nothing
          // left to wait for.
          settle();
        } else if (!repollTimer) {
          scheduleRepoll();
        }
      },
    });

    const deadline = setTimeout(settle, timeoutMs);
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
  const events = await observeCollecting([{ kinds: [kind], authors: [pubkey], "#d": [d] }], timeoutMs);
  return events.reduce<Event | null>(
    (latest, event) => (!latest || event.created_at > latest.created_at ? event : latest),
    null,
  );
}

/** Fetches every event matching `filters`, e.g. every `share-info` event
 *  authored by the user's Drive Keys. */
export function fetchEvents(filters: Filter[], timeoutMs = 8000): Promise<Event[]> {
  return observeCollecting(filters, timeoutMs);
}
