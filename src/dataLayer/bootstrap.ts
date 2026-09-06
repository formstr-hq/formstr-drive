/**
 * Browser bootstrap for the DataLayer — the only place that touches platform
 * globals (Worker, document) and the app's signer. Spawns the relay worker,
 * wires the NIP-42 sign RPC + publish signing to `signerManager`, tracks the
 * active account, and pauses/resumes upstream on app visibility changes.
 *
 * Ported from nostr-polls' bootstrap, minus what drive doesn't use: no search
 * relays, no DM relays, no NIP-65 outbox tracking — drive reads and writes a
 * fixed app relay set (APP_RELAYS).
 */
import {
  DataLayer,
  LocalRelayClient,
  workerChannel,
  getDataLayer,
  setDataLayer,
  type Channel,
  type Event,
} from "@formstr/local-relay";
import { signerManager } from "../signer/manager";
import { APP_RELAYS, defaultRelays, mergeRelayLists } from "../utils/common";
import { notifyRelayRefresh } from "./relayRefresh";

let started = false;

/** Idempotent: spawns the worker + wires the DataLayer once, returns the singleton. */
export function bootstrapDataLayer(): DataLayer {
  if (started) return getDataLayer();
  started = true;

  // Vite emits a same-origin module-worker chunk for this URL form; loads under
  // http(s)/capacitor origins alike.
  const worker = new Worker(new URL("../worker/relay.worker.ts", import.meta.url), {
    type: "module",
  });
  const baseChannel = workerChannel(worker);

  // Wrap the channel to watch the worker boundary for moments when it can newly
  // serve cached data: `hydrated` (posted by our worker entry once IndexedDB load
  // finishes — interests declared during boot EOSE'd on an empty store and missed
  // it) and a repeat `ready` (a worker restart that dropped its in-memory
  // interests — the case Capacitor hits when Android suspends the WebView). Both
  // bump the refresh signal so observers re-declare. Unknown frames are passed
  // straight through to the client, which ignores them.
  let readyCount = 0;
  const channel: Channel = {
    post: (m) => baseChannel.post(m),
    close: () => baseChannel.close(),
    onMessage: (handler) =>
      baseChannel.onMessage((m) => {
        const kind = (m as { kind?: string } | null)?.kind;
        if (kind === "hydrated") {
          notifyRelayRefresh();
        } else if (kind === "ready") {
          readyCount += 1;
          if (readyCount > 1) notifyRelayRefresh(); // restart, not first boot
        }
        handler(m);
      }),
  };

  const client = new LocalRelayClient(channel, {
    // The worker asks us to sign NIP-42 AUTH challenges; route to the active signer.
    onSignRequest: async (template) => {
      try {
        const signer = await signerManager.getSigner();
        return (await signer.signEvent(template)) as Event;
      } catch {
        return null; // refuse → worker treats the relay as auth-failed (counts as done)
      }
    },
  });

  // Drive's app relays carry the kind-34578 file index; the wider default set
  // backs profile (kind 0) and Blossom server (kind 36363) discovery, which the
  // old per-component pools queried against defaultRelays.
  client.setUserRelays(mergeRelayLists(APP_RELAYS, defaultRelays));

  // Active account → worker scope. setActiveAccount does NOT rehydrate the
  // shared store; decryption is per-account and the keyring code already
  // handles "can't decrypt".
  const applyAccount = () => {
    client.setActiveAccount(signerManager.getPubkey() ?? null);
  };
  applyAccount();
  signerManager.onChange(applyAccount);

  // Lifecycle: drop all sockets when backgrounded, reconnect syncs on return.
  if (typeof document !== "undefined" && document.addEventListener) {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") client.pause();
      else client.resume();
    });
  }

  const dataLayer = new DataLayer({
    client,
    sign: async (template) => {
      const signer = await signerManager.getSigner();
      return (await signer.signEvent(template)) as Event;
    },
  });
  setDataLayer(dataLayer);
  return dataLayer;
}
