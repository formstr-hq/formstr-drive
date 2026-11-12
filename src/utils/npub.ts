import { nip19 } from "nostr-tools";

/** `npub1abcdef…uvwxyz` - enough to tell accounts apart in a list or a prompt. */
export function shortNpub(pubkey: string): string {
  const npub = nip19.npubEncode(pubkey);
  return `${npub.slice(0, 12)}…${npub.slice(-6)}`;
}
