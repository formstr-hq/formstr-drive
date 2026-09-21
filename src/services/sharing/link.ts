// The ONLY place the share URL's wire format is known. Everything else in
// `services/sharing` deals in a `{ naddr, k }` payload or the pieces that go
// into one — never in raw URL/hash string manipulation.
//
// Previously this was a hand-rolled `#shared=<base64url(JSON)>` wrapping a
// custom `{v, kind, a:"kind:pubkey:d", k}` object — a format no other Nostr
// client could parse. `naddr` (NIP-19) is the standard encoding for exactly
// this pointer shape (kind + pubkey + `d` identifier), already a dependency,
// already used elsewhere in this codebase (`src/signer/manager.ts`).
//
// `naddr` has no TLV for the ephemeral decryption key, and it must not be
// forced into one — the key is de-scoped from the pointer itself. The link
// is therefore two parts: `#shared=<naddr>&k=<hex>`.
import { nip19 } from "nostr-tools";
import { isNativePlatform } from "../../utils/platform";
import { SHARE_HASH_PREFIX, type ShareLinkPayload } from "./types";

export const METADATA_KIND = 34578;
export const CLIENT_TAG = "formstr-drive";

/** Splits an addressable coordinate ("kind:pubkey:d") into its parts. Throws
 *  on anything malformed — every caller is handling either a link a user
 *  pasted or a coordinate this module itself wrote, so a bad shape here is
 *  always a real error, not an expected outcome. This is the internal `"a"`
 *  tag format (NIP-FS's own container-member references), distinct from the
 *  outer share link's `naddr` — see {@link encodeShareLink}. */
export function parseCoordinate(coordinate: string): { kind: number; pubkey: string; d: string } {
  const [kindStr, pubkey, ...rest] = coordinate.split(":");
  const kind = Number(kindStr);
  const d = rest.join(":");
  if (!Number.isFinite(kind) || !pubkey || !d) {
    throw new Error("Malformed share link.");
  }
  return { kind, pubkey, d };
}

/** Builds a `kind:pubkey:d` addressable coordinate for a 34578 event this
 *  module signs — the inverse of `parseCoordinate`. */
export function buildCoordinate(pubkey: string, d: string): string {
  return `${METADATA_KIND}:${pubkey}:${d}`;
}

/**
 * Builds a share URL: `naddr` carries the pointer (kind, pubkey, `d`,
 * relay hints), `k` — outside the naddr, joined by `&` — carries the
 * ephemeral secret.
 */
export function encodeShareLink(params: {
  pubkey: string;
  dTag: string;
  relays: string[];
  secretKeyHex: string;
}): string {
  const naddr = nip19.naddrEncode({
    kind: METADATA_KIND,
    pubkey: params.pubkey,
    identifier: params.dTag,
    relays: params.relays,
  });
  const origin = isNativePlatform ? "https://drive.formstr.app" : window.location.origin;
  return `${origin}${window.location.pathname}${SHARE_HASH_PREFIX}${naddr}&k=${params.secretKeyHex}`;
}

/** Returns the decoded payload if `hash` (e.g. `location.hash`) is a share
 *  link, or null otherwise (including a malformed or non-naddr pointer).
 *  Never throws. */
export function decodeShareLink(hash: string): ShareLinkPayload | null {
  if (!hash.startsWith(SHARE_HASH_PREFIX)) return null;
  const rest = hash.slice(SHARE_HASH_PREFIX.length);
  const sep = rest.indexOf("&k=");
  if (sep === -1) return null;

  const naddr = rest.slice(0, sep);
  const k = rest.slice(sep + "&k=".length);
  if (!naddr || !k) return null;

  try {
    const decoded = nip19.decode(naddr);
    if (decoded.type !== "naddr" || decoded.data.kind !== METADATA_KIND) return null;
  } catch {
    return null;
  }

  return { naddr, k };
}
