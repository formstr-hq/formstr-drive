import { dataLayer, type Event, type Filter } from "@formstr/local-relay";
import { APP_RELAYS, defaultRelays, mergeRelayLists, normalizeRelayUrl } from "../utils/common";

/**
 * Whether a Nostr identity has ever published anything, established
 * POSITIVELY rather than inferred from the absence of one specific event —
 * the inversion at the root of the Drive Key mint hazard (see
 * restoreDriveKey's doc comment in driveKey.ts): treating "couldn't find a
 * Drive Key" as "this person is new" is wrong whenever the reason we
 * couldn't find it is a format change, a relay outage, or a cold cache
 * rather than the key never having existed.
 *
 *  - "new": no event of any kind found for this pubkey, and enough of the
 *    network was reachable to trust that absence.
 *  - "existing": at least one event was found. This identity has been used
 *    before, on Nostr generally — independent of whether a Drive Key
 *    specifically could be found.
 *  - "unknown": couldn't reach enough of the network to trust either
 *    conclusion. Must NEVER be treated as "new".
 */
export type IdentityHistory = "new" | "existing" | "unknown";

// A handful of common, cheap-to-find kinds: profile, contacts, relay list,
// and this app's own drive metadata. Any ONE of them existing proves prior
// use — this is an existence check across broad kinds, not a targeted fetch,
// so it stays correct even if this app's own event kinds change shape again
// (the exact failure mode this replaces).
const EXISTENCE_KINDS = [0, 3, 10002, 34578];

// Positive results are permanent for the life of the page — an identity that
// has published before will always have published before. "unknown" is
// deliberately NOT cached, so a later, better-connected call can still
// resolve it.
const cache = new Map<string, IdentityHistory>();

// The relay set fetchDriveKeyEvents' query actually fans out to (bootstrap.ts
// sets exactly this as setUserRelays) — proof must cover THIS set, since
// these are the relays whose silence we're about to treat as "no key exists".
const CONFIGURED_RELAYS = mergeRelayLists(APP_RELAYS, defaultRelays).map(normalizeRelayUrl);

/**
 * Positive, per-relay proof that the configured relay set actually answered a
 * query just now — replaces the old connectedCount>=2 heuristic, which is
 * connection-level (a socket being OPEN) rather than query-level (that relay
 * having actually returned data). A relay stuck mid-handshake (the Android
 * failure this whole mechanism exists to catch: two relays connected fine
 * while the one holding the real Drive Key sat in a dead TCP connect) passes
 * the old check and fails this one.
 *
 * Deliberately NOT scoped to this identity's pubkey — a genuinely new user has
 * no events under any kind, so an author-scoped control query would always
 * come back empty and prove nothing about whether relays are even listening.
 * `limit` is small since this only needs SOME event per relay, not a
 * meaningful result.
 *
 * `seenOn` is what makes this possible: it is the only way to learn which
 * relays actually delivered a given event — `observe()` itself never
 * surfaces per-relay EOSE to the main thread (upstream EOSE tracking exists
 * inside RelayPool but is private/unwired).
 *
 * Threshold is deliberately full coverage, not a quorum: two relays
 * answering "we have nothing" does not prove the THIRD, non-answering relay
 * (the one that might actually hold the key) has nothing — that is exactly
 * the failure this replaces. A relay unaccounted for means the verdict stays
 * "uncertain", never "proven empty".
 */
async function proveRelayCoverage(): Promise<{ fullyCovered: boolean; answeredBy: Set<string> }> {
  const answeredBy = new Set<string>();

  try {
    const controlEvents = await new Promise<Event[]>((resolve) => {
      const found: Event[] = [];
      const handle = dataLayer.observe(
        [{ kinds: [1, 0, 3, 10002], limit: 5 }],
        {
          onEvent: (event: Event) => found.push(event),
          onEose: () => resolve(found),
        },
      );
      setTimeout(() => {
        handle.unobserve();
        resolve(found);
      }, 5000);
    });

    for (const event of controlEvents) {
      const relays = await dataLayer.seenOn(event.id).catch(() => [] as string[]);
      for (const relay of relays) answeredBy.add(normalizeRelayUrl(relay));
    }
  } catch {
    // Fall through with whatever (possibly nothing) was collected — an
    // incomplete answeredBy set correctly yields fullyCovered: false below.
  }

  const fullyCovered = CONFIGURED_RELAYS.every((relay) => answeredBy.has(relay));
  return { fullyCovered, answeredBy };
}

/**
 * Resolves whether `identityPubkey` has ever published anything. See
 * {@link IdentityHistory} for what each result means and how it must be
 * used — in particular, "unknown" must never be treated as "new".
 */
export async function establishIdentityHistory(identityPubkey: string): Promise<IdentityHistory> {
  const cached = cache.get(identityPubkey);
  if (cached) return cached;

  const result = await new Promise<IdentityHistory>((resolve) => {
    let settled = false;
    let found = false;

    const filters: Filter[] = [{ kinds: EXISTENCE_KINDS, authors: [identityPubkey], limit: 1 }];
    const handle = dataLayer.observe(filters, {
      onEvent: (_event: Event) => {
        found = true;
      },
      onEose: () => {
        // Local-cache replay only — mirrors fetchDriveKeyEvents's own
        // reasoning: a warm local relay can EOSE with nothing purely because
        // its own cache is cold, which says nothing about the network.
        // Resolving "existing" here (found=true) is still safe the moment
        // any single event is seen, cache or not.
        if (found && !settled) {
          settled = true;
          handle.unobserve();
          resolve("existing");
        }
      },
    });

    // Same generous window as the Drive Key fetch this replaces the
    // reasoning of — flaky relays need real time, not a snap judgment.
    setTimeout(() => {
      void (async () => {
        if (settled) return;
        settled = true;
        handle.unobserve();

        if (found) {
          resolve("existing");
          return;
        }

        const { fullyCovered } = await proveRelayCoverage();
        resolve(fullyCovered ? "new" : "unknown");
      })();
    }, 20000);
  });

  // Never cache "unknown" — it's a statement about right-now connectivity,
  // not about the identity, and the next call deserves a fresh chance.
  if (result !== "unknown") {
    cache.set(identityPubkey, result);
  }
  return result;
}
