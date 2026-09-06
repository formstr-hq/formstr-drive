import { dataLayer, type Event } from "@formstr/local-relay";
import { signerManager } from "../signer/manager";

/**
 * BUD-03 "User Server List": a replaceable kind-10063 event listing the Blossom
 * servers this user uses, as `["server", url]` tags in preference order.
 *
 * Authored by the IDENTITY key rather than the Drive Key, deliberately: this is
 * a cross-client standard, so publishing it under the identity means other
 * Blossom-aware clients can read (and contribute to) the same list. The cost is
 * one signer approval per change — acceptable because adding a server is a rare,
 * explicit user action, unlike file metadata which is written constantly and is
 * why THAT is signed locally with the Drive Key instead.
 */
const SERVER_LIST_KIND = 10063;

/** Reads the `server` tags out of a kind-10063 event, in published order. */
export function serversFromEvent(event: Event): string[] {
  return event.tags
    .filter((tag) => tag[0] === "server" && typeof tag[1] === "string" && tag[1])
    .map((tag) => tag[1]);
}

/**
 * Publishes the user's Blossom server list so every device sees the same set.
 * `urls` is written in order — per BUD-03 the first entry is the preferred
 * server. Throws if no relay accepts it, so callers can tell the user their
 * change didn't sync rather than silently pretending it did.
 */
export async function publishServerList(urls: string[]): Promise<void> {
  const signer = await signerManager.getSigner();
  const pubkey = await signer.getPublicKey();

  const template = {
    kind: SERVER_LIST_KIND,
    pubkey,
    created_at: Math.floor(Date.now() / 1000),
    tags: urls.map((url) => ["server", url]),
    content: "",
  };

  const signedEvent = (await signer.signEvent(template)) as Event;
  const result = await dataLayer.publishEvent(signedEvent);

  if (!result.ok) {
    throw new Error(
      `Your server list couldn't be saved to any relay (${result.accepted}/${result.total}) — ` +
        `it's still active on this device, but other devices won't see it until this succeeds.`,
    );
  }
}

/**
 * Standing interest in this user's own kind-10063 list. Fires whenever a newer
 * one arrives — including one published by another device, which is the whole
 * point. Returns an unobserve function.
 *
 * Only events strictly newer than the last one seen are surfaced, so a relay
 * replaying an older copy can't clobber a fresher list.
 */
export function observeServerList(
  identityPubkey: string,
  onServers: (urls: string[]) => void,
): () => void {
  let newestSeen = 0;

  const handle = dataLayer.observe(
    [{ kinds: [SERVER_LIST_KIND], authors: [identityPubkey] }],
    {
      onEvent: (event: Event) => {
        if (event.created_at <= newestSeen) return;
        newestSeen = event.created_at;
        onServers(serversFromEvent(event));
      },
    },
  );

  return () => handle.unobserve();
}
