/**
 * Worker entry — the thin platform shell around RelayService (shipped by
 * @formstr/local-relay). Drive does NOT use the package's ready-made worker
 * entry because it needs a custom prune policy: the default policy TTLs every
 * kind outside 10000–19999 after 7 days and caps the store at 50k events,
 * which would silently evict the kind-34578 file-index and Drive Key events
 * from cache — cold loads would regress to network speed and offline would
 * break. Spawned from the main thread via:
 *   new Worker(new URL("../worker/relay.worker.ts", import.meta.url), { type: "module" })
 */
import {
  RelayService,
  selfChannel,
  IndexedDBStorage,
  defaultPrunePolicy,
} from "@formstr/local-relay";

const channel = selfChannel(
  self as unknown as {
    postMessage: (m: unknown) => void;
    onmessage: ((e: MessageEvent) => void) | null;
  },
);

// Both the file index AND the Drive Key keyring live in kind 34578 (the key
// under the `0:<pubkey>` d-tag) — protecting the kind covers them all.
const prunePolicy = defaultPrunePolicy();
prunePolicy.protectedKinds.add(34578);

const service = new RelayService({
  channel,
  storage: new IndexedDBStorage("formstr-drive"),
  persistence: { prunePolicy },
});

// Hydrate from IndexedDB, then begin write-through + pruning. The worker emits
// `ready` from its constructor (before hydration), and hydration's bulkLoad
// suppresses change emits — so interests declared during boot can EOSE on an
// empty store and miss the hydrated cache. We post a `hydrated` frame once the
// store is loaded so the main thread can re-declare its interests against it.
void service.start().then(() => {
  channel.post({ kind: "hydrated" });
});

export {};
