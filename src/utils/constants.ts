export const FILE_HASH_MIME = "application/x-formstr-file-hash";

export type SortKey = "name" | "newest" | "oldest" | "largest" | "smallest";

export const SORT_LABEL: Record<SortKey, string> = {
  newest: "Newest first",
  oldest: "Oldest first",
  name: "Name (A–Z)",
  largest: "Largest first",
  smallest: "Smallest first",
};

export const NIP46_RELAYS = ["wss://relay.nsec.app", "wss://nostr.oxtr.dev"];
