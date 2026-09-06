import { dataLayer, type Event, type Filter } from "@formstr/local-relay";

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

/**
 * Same-shape network-reachability check `driveKey.ts`'s mint guard already
 * used (connectedCount >= 2 AND the data layer's own online() judgment) —
 * reused here rather than duplicated so both callers agree on what "the
 * network looked reachable" means.
 */
async function networkLooksReachable(): Promise<boolean> {
  try {
    const health = await dataLayer.relayHealth();
    const connectedCount = health.filter((r) => r.connected).length;
    return connectedCount >= 2 && (await dataLayer.online());
  } catch {
    return false;
  }
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

        resolve((await networkLooksReachable()) ? "new" : "unknown");
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
