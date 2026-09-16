// The ONLY place relay routing for the sharing feature is decided. Two
// halves of one problem: where a share's relay hints come FROM when
// publishing, and how they get USED when resolving a link someone else
// opens.
//
// `naddr` has an optional relay-hint slot, but populating it alone changes
// nothing — `DataLayer.observe` (the query path every resolve goes through)
// has no per-query relay targeting, only `localOnly`
// (node_modules/@formstr/local-relay/dist/index.d.ts). The only routing
// control that exists is `LocalRelayClient.setUserRelays`, which is global
// and advisory ("a routing-policy input, not a command"). So consuming a
// hint means temporarily widening that global policy for the one resolve
// call that needs it, then putting it back — contained here so no caller
// has to reason about mutating shared state.
import { getLocalRelayClient } from "../../dataLayer/bootstrap";
import { APP_RELAYS, defaultRelays, mergeRelayLists } from "../../utils/common";
import type { PublishResult } from "@formstr/local-relay";

/** The relay set every non-sharing part of the app already routes through
 *  (`dataLayer/bootstrap.ts`). Relay hints are additive to this, never a
 *  replacement — a share resolve should never narrow what's reachable. */
function baseRelays(): string[] {
  return mergeRelayLists(APP_RELAYS, defaultRelays);
}

/**
 * The relays a publish actually landed on — the honest source for a hint,
 * as opposed to assuming `APP_RELAYS` (the assumption that's broken today:
 * a link recipient querying only `APP_RELAYS` is exactly why links can fail
 * for everyone but the sender). Only `"accepted"` counts; a relay that
 * rejected, timed out, or failed isn't somewhere the event can be found.
 */
export function relaysFromPublish(result: PublishResult): string[] {
  const accepted = result.relayResults
    .filter((r) => r.status === "accepted")
    .map((r) => r.relay);
  return Array.from(new Set(accepted));
}

/**
 * Runs `fn` with `relays` folded into the routing policy, then restores the
 * prior policy — including if `fn` throws, so a resolve failure can never
 * leave the app permanently pointed at some stranger's relay hints.
 *
 * No-op (just calls `fn`) if there's nothing to add or the client hasn't
 * bootstrapped yet — `SharedView` can in principle render before
 * `bootstrapDataLayer` has run, and a share resolve without hints should
 * still fall back to whatever policy is already in place rather than throw.
 */
export async function withRelayHints<T>(relays: string[], fn: () => Promise<T>): Promise<T> {
  const client = getLocalRelayClient();
  if (!client || relays.length === 0) return fn();

  client.setUserRelays(mergeRelayLists(baseRelays(), relays));
  try {
    return await fn();
  } finally {
    client.setUserRelays(baseRelays());
  }
}
