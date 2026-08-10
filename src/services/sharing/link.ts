import {
  uint8ArrayToBase64,
  base64ToUint8Array,
} from "../../crypto";
import { SHARE_HASH_PREFIX, type ShareLinkPayload } from "./types";

export const METADATA_KIND = 34578;
export const CLIENT_TAG = "formstr-drive";

/** Splits an addressable coordinate ("kind:pubkey:d") into its parts. Throws
 *  on anything malformed — every caller is handling either a link a user
 *  pasted or a coordinate this module itself wrote, so a bad shape here is
 *  always a real error, not an expected outcome. */
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

function encodePayload(payload: ShareLinkPayload): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return uint8ArrayToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodePayload(encoded: string): ShareLinkPayload {
  let b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4 !== 0) b64 += "=";
  const json = new TextDecoder().decode(base64ToUint8Array(b64));
  const parsed = JSON.parse(json);
  if (parsed?.v !== 1 || (parsed.kind !== "file" && parsed.kind !== "folder") || !parsed.a || !parsed.k) {
    throw new Error("Malformed share link.");
  }
  return parsed as ShareLinkPayload;
}

export function buildShareUrl(payload: ShareLinkPayload): string {
  return `${window.location.origin}${window.location.pathname}${SHARE_HASH_PREFIX}${encodePayload(payload)}`;
}

/** Returns the decoded payload if `hash` (e.g. `location.hash`) is a share
 *  link, or null otherwise. Never throws. */
export function parseShareHash(hash: string): ShareLinkPayload | null {
  if (!hash.startsWith(SHARE_HASH_PREFIX)) return null;
  try {
    return decodePayload(hash.slice(SHARE_HASH_PREFIX.length));
  } catch {
    return null;
  }
}
