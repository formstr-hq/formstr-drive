import { BlossomClient } from "../blossom";
import { decryptSegment, segmentCount } from "../crypto";
import type { FileMetadata } from "../types/metadata";

/**
 * Per-server cache of whether Range requests are actually honored (status
 * 206) — Range support is optional per BUD-01 and varies by server
 * (confirmed by probing: blossom.data.haus honors it, others don't), so this
 * must be discovered at runtime rather than assumed. Cached after the first
 * range read against a given server for the lifetime of the page.
 */
const rangeSupport = new Map<string, boolean>();

export function serverSupportsRange(server: string): boolean | undefined {
  return rangeSupport.get(server);
}

/**
 * Cheap capability probe (a 1-byte range request) so a caller can decide
 * whether to open a seekable preview session BEFORE committing to it — a
 * server that ignores Range and returns the whole blob would otherwise only
 * decode correctly for a request starting at byte 0, then fail every
 * subsequent seek with a GCM tag mismatch (the returned bytes wouldn't
 * actually start where they were asked to). Cached per server, so this only
 * costs a real request once per server per page load.
 */
export async function probeRangeSupport(
  file: FileMetadata & { blobHash: string },
): Promise<boolean> {
  const cached = rangeSupport.get(file.server);
  if (cached !== undefined) return cached;
  try {
    const client = new BlossomClient(file.server);
    const { satisfied } = await client.downloadRange(file.blobHash, 0, 0);
    rangeSupport.set(file.server, satisfied);
    return satisfied;
  } catch {
    rangeSupport.set(file.server, false);
    return false;
  }
}

/**
 * Reads and decrypts the plaintext byte range [start, end] (inclusive) of a
 * NIP-FS single-blob file, fetching only the ciphertext segments that range
 * overlaps rather than the whole blob.
 *
 * Two things that are easy to get wrong here (both would silently produce a
 * failed GCM tag check, not a subtly wrong result — so a mistake surfaces
 * loudly, but it's worth stating why):
 *  - The LAST segment in the file is shorter than `chunkSize` (frame is
 *    `size - chunkSize*(total-1) + 16`, not `chunkSize + 16`) — this matters
 *    whenever the requested range reaches the end of the file.
 *  - `isLast` passed to decryptSegment means "this is the file's last
 *    segment", not "this is the last segment in the requested range" — the
 *    nonce is baked in at encryption time from the segment's absolute
 *    position, so decrypting segment i mid-file with isLast=true (because
 *    it's the last one THIS range happens to touch) recomputes the wrong
 *    nonce and fails.
 */
export async function readPlaintextRange(
  file: FileMetadata & { blobHash: string; chunkSize: number },
  blobKey: Uint8Array,
  start: number,
  end: number,
  signal?: AbortSignal,
): Promise<{ bytes: Uint8Array; satisfied: boolean }> {
  const { blobHash, chunkSize, size, server } = file;
  const total = segmentCount(size, chunkSize);
  const frameSize = chunkSize + 16;
  const blobSize = size + 16 * total;

  const clampedEnd = Math.min(end, size - 1);
  const i0 = Math.floor(start / chunkSize);
  const i1 = Math.floor(clampedEnd / chunkSize);

  const blobStart = i0 * frameSize;
  const blobEnd = Math.min(blobSize, (i1 + 1) * frameSize) - 1;

  const client = new BlossomClient(server);
  const { bytes: raw, satisfied } = await client.downloadRange(blobHash, blobStart, blobEnd, undefined, signal);
  rangeSupport.set(server, satisfied);

  const segments: Uint8Array[] = [];
  let offset = 0;
  for (let i = i0; i <= i1; i++) {
    const isLast = i === total - 1;
    const plainLen = isLast ? size - chunkSize * (total - 1) : chunkSize;
    const frameLen = plainLen + 16;
    const frame = raw.subarray(offset, offset + frameLen);
    offset += frameLen;
    segments.push(await decryptSegment(frame, blobKey, i, isLast));
  }

  const plaintext = segments.length === 1 ? segments[0] : concat(segments);
  const trimHead = start - i0 * chunkSize;
  const length = clampedEnd - start + 1;
  return { bytes: plaintext.subarray(trimHead, trimHead + length), satisfied };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
