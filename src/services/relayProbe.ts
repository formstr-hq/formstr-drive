import { Relay } from "nostr-tools/relay";
import type { Event, EventTemplate, Filter, VerifiedEvent } from "nostr-tools";

/**
 * Direct, per-relay reads and writes for the Drive Key — the one place the
 * app needs to know what each relay ACTUALLY holds, which the local relay
 * can't tell it:
 *  - `observe()`'s EOSE is the local-cache replay, never per-relay; `seenOn`
 *    is a relay hint, not an inventory. "Nobody sent a Drive Key" through
 *    that layer is indistinguishable from "nobody was asked".
 *  - The local store keeps only the NEWEST version of a replaceable event, so
 *    an older version a relay still holds (e.g. one that was down when a
 *    newer key was published) is dropped on arrival and never reaches any
 *    subscriber. Reading the relay directly is the only way to see it.
 *  - `dataLayer.publishEvent` routes to every configured relay and its
 *    persisted outbox re-delivers later to relays that were down — i.e. to
 *    relays whose current version nobody read. For a replaceable event that
 *    can silently erase a key; Drive Key writes go through
 *    {@link publishToRelays} instead, to an explicit, read-verified list.
 */

export type AuthSigner = (template: EventTemplate) => Promise<VerifiedEvent>;

/** One relay's answer to a read. `answered` means a genuine EOSE arrived (or
 *  matching events did): the relay's current content is known to be exactly
 *  `events`. Otherwise it couldn't be reached, refused, or ran out of time,
 *  and its content is unknown. */
export interface RelayReading {
  relay: string;
  answered: boolean;
  events: Event[];
}

export interface RelayWriteResult {
  accepted: string[];
  /** The relay answered and refused the event (OK false) — not worth
   *  retrying soon. */
  rejected: string[];
  /** Couldn't connect, or no OK before the deadline — transient. */
  failed: string[];
}

// nostr-tools fakes EOSE when its own `eoseTimeout` (default 4.4 s) elapses, so
// a relay that never answered would look exactly like one that answered
// "nothing here". Push that timer well past our own deadline so `oneose` only
// ever means a real EOSE; the deadline below is what bounds the wait.
const FAKE_EOSE_DISABLED_MS = 10 * 60_000;

async function readRelay(
  url: string,
  filter: Filter,
  timeoutMs: number,
  onauth: AuthSigner | undefined,
): Promise<RelayReading> {
  const relay = new Relay(url);
  relay.onauth = onauth;
  const events: Event[] = [];
  const reading = (answered: boolean): RelayReading => ({ relay: url, answered, events });
  let sub: ReturnType<Relay["subscribe"]> | undefined;

  const answer = new Promise<RelayReading>((resolve) => {
    const open = (retriedAfterAuth: boolean) => {
      sub = relay.subscribe([filter], {
        eoseTimeout: FAKE_EOSE_DISABLED_MS,
        onevent: (event) => events.push(event),
        oneose: () => resolve(reading(true)),
        onclose: (reason) => {
          // NIP-42 relays may refuse the REQ until we authenticate. nostr-tools
          // answers the AUTH challenge itself (onauth); retry the REQ once.
          if (!retriedAfterAuth && onauth && reason.startsWith("auth-required")) {
            relay.auth(onauth).then(
              () => open(true),
              () => resolve(reading(events.length > 0)),
            );
            return;
          }
          // Events that did arrive are real content, even without an EOSE.
          resolve(reading(events.length > 0));
        },
      });
    };

    relay.connect({ timeout: timeoutMs }).then(
      () => open(false),
      () => resolve(reading(false)),
    );
  });

  let deadline: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<RelayReading>((resolve) => {
    deadline = setTimeout(() => resolve(reading(events.length > 0)), timeoutMs);
  });

  try {
    return await Promise.race([answer, timedOut]);
  } finally {
    clearTimeout(deadline);
    // nostr-tools queues every send behind a promise, so the CLOSE that
    // relay.close() would send for a still-open subscription goes out after
    // the socket has started closing. Close the subscription first and let
    // its CLOSE go out while the socket is still open.
    if (sub && !sub.closed) {
      sub.close();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    relay.close();
  }
}

/** Reads `filter` from every relay in `relays` in parallel, reporting each
 *  relay's answer separately. Never rejects. */
export async function readRelays(
  filter: Filter,
  relays: string[],
  options: { timeoutMs: number; onauth?: AuthSigner },
): Promise<RelayReading[]> {
  return Promise.all(
    relays.map((url) => readRelay(url, filter, options.timeoutMs, options.onauth)),
  );
}

type WriteOutcome = "accepted" | "rejected" | "failed";

async function publishToRelay(
  url: string,
  event: Event,
  timeoutMs: number,
  onauth: AuthSigner | undefined,
): Promise<WriteOutcome> {
  const relay = new Relay(url);
  relay.onauth = onauth;
  relay.publishTimeout = timeoutMs;
  try {
    await relay.connect({ timeout: timeoutMs });
  } catch {
    relay.close();
    return "failed";
  }

  const publishOnce = async (): Promise<WriteOutcome> => {
    try {
      await relay.publish(event);
      return "accepted";
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      if (reason.startsWith("auth-required")) return "rejected";
      // nostr-tools rejects with these when no OK arrived — transient, not a refusal.
      if (/timed out|closed|connection/i.test(reason)) return "failed";
      return "rejected";
    }
  };

  try {
    const first = await publishOnce();
    if (first === "rejected" && onauth) {
      try {
        await relay.auth(onauth);
        return await publishOnce();
      } catch {
        return first;
      }
    }
    return first;
  } finally {
    relay.close();
  }
}

/** Publishes `event` to exactly `relays` — nowhere else, and with no retry
 *  queue behind it. Never rejects. */
export async function publishToRelays(
  event: Event,
  relays: string[],
  options: { timeoutMs: number; onauth?: AuthSigner },
): Promise<RelayWriteResult> {
  const outcomes = await Promise.all(
    relays.map((url) => publishToRelay(url, event, options.timeoutMs, options.onauth)),
  );
  const result: RelayWriteResult = { accepted: [], rejected: [], failed: [] };
  outcomes.forEach((outcome, index) => result[outcome].push(relays[index]!));
  return result;
}
