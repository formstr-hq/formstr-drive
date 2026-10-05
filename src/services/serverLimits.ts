/**
 * Per-server upload size limits.
 *
 * Servers don't publish their cap, and they check auth before size, so the
 * only way to learn it is a BUD-06 `HEAD /upload` carrying a signed event.
 * Three sources, cheapest first, none of which query on every visit:
 *  1. KNOWN_LIMITS — measured once for the default servers and shipped here.
 *  2. Refusals — a real upload preflight that gets a 413 stating the cap
 *     (see BlossomClient.canAccept) records it exactly.
 *  3. A one-time probe of a server the user adds (probeServerLimit), signed
 *     with a throwaway key so it needs no signer prompt and touches no
 *     account. Its result, or the fact that it was inconclusive, is cached.
 */
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";

const STORAGE_KEY = "formstr-drive:server-limits";
const PROBED_KEY = "formstr-drive:server-limits-probed";

export interface ServerLimit {
  bytes: number;
  /** True when found by the probe ladder rather than stated by the server. */
  approx?: boolean;
}

type Limits = Record<string, ServerLimit>;

const GIB = 1024 ** 3;

/** Measured against the live servers (Oct 2026). primal.net accepts any size
 *  on HEAD and oxtr.dev only allows whitelisted pubkeys, so neither can be
 *  read this way and they're left unlisted rather than guessed. */
const KNOWN_LIMITS: Limits = {
  "https://blossom.data.haus": { bytes: 2 * GIB },
  "https://nostr.download": { bytes: 10 * GIB },
};

const normalize = (url: string) => url.replace(/\/+$/, "");

let learned: Limits | null = null;
let snapshot: Limits | null = null;
const listeners = new Set<() => void>();

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable — values still live in memory for this session.
  }
}

function getLearned(): Limits {
  if (!learned) learned = readJson<Limits>(STORAGE_KEY, {});
  return learned;
}

function publish() {
  snapshot = { ...getLearned(), ...KNOWN_LIMITS };
  listeners.forEach((l) => l());
}

/** Pulls a byte count out of a server's refusal text, e.g.
 *  "File too large. Maximum allowed size is 2147483648 bytes" or "max 100MB". */
export function parseMaxBytes(reason: string | null | undefined): number | undefined {
  if (!reason) return undefined;
  const m = reason.match(/(\d+(?:\.\d+)?)\s*(bytes?|[kmgt]i?b)\b/i);
  if (!m) return undefined;
  const unit = m[2].toLowerCase();
  const base = unit.includes("i") ? 1024 : 1000;
  const pow = unit.startsWith("b") ? 0 : "kmgt".indexOf(unit[0]) + 1;
  const bytes = Math.round(parseFloat(m[1]) * base ** pow);
  return Number.isFinite(bytes) && bytes > 0 ? bytes : undefined;
}

export function recordServerLimit(url: string, bytes: number, approx = false): void {
  const key = normalize(url);
  const limits = getLearned();
  if (limits[key]?.bytes === bytes && !!limits[key]?.approx === approx) return;
  learned = { ...limits, [key]: { bytes, approx: approx || undefined } };
  writeJson(STORAGE_KEY, learned);
  publish();
}

/** For useSyncExternalStore. */
export function subscribeServerLimits(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getServerLimitsSnapshot(): Limits {
  if (!snapshot) snapshot = { ...getLearned(), ...KNOWN_LIMITS };
  return snapshot;
}

export function getServerLimit(url: string): ServerLimit | undefined {
  return lookupLimit(getServerLimitsSnapshot(), url);
}

/** Looks `url` up in a snapshot (e.g. the one useSyncExternalStore returned),
 *  so callers don't need to know how keys are normalised. */
export function lookupLimit(limits: Limits, url: string): ServerLimit | undefined {
  return limits[normalize(url)];
}

export function formatLimit({ bytes, approx }: ServerLimit): string {
  const gib = bytes / GIB;
  const text = gib >= 1 ? `${+gib.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
  return approx ? `~${text}` : text;
}

// Common caps, ascending. The probe finds the largest one a server accepts.
const LADDER = [50, 100, 256, 512, 1024, 2048, 5120, 10240, 20480, 51200, 102400].map(
  (mb) => mb * 1024 ** 2,
);
const PROBE_HASH = "0".repeat(64);

/**
 * One-time background probe for a server whose limit isn't known. Safe to
 * call whenever a server is added: it no-ops if the limit is already known
 * or the server was probed before, and never prompts the signer.
 */
const probesInFlight = new Set<string>();

export async function probeServerLimit(url: string): Promise<void> {
  const key = normalize(url);
  if (getServerLimit(key) || probesInFlight.has(key)) return;
  const probed = readJson<Record<string, number>>(PROBED_KEY, {});
  if (probed[key]) return;

  probesInFlight.add(key);
  try {
    // Remembered only for a conclusive answer. A network failure or timeout says
    // nothing about the server, so it stays eligible for the next attempt.
    const conclusive = await runProbe(key);
    if (conclusive) writeJson(PROBED_KEY, { ...readJson<Record<string, number>>(PROBED_KEY, {}), [key]: Date.now() });
  } finally {
    probesInFlight.delete(key);
  }
}

/** Returns false when the outcome was a transient failure worth retrying. */
async function runProbe(key: string): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const event = finalizeEvent(
    {
      kind: 24242,
      created_at: now,
      content: "Upload limit check",
      tags: [
        ["t", "upload"],
        ["expiration", String(now + 120)],
        ["x", PROBE_HASH],
      ],
    },
    generateSecretKey(),
  );
  const auth = `Nostr ${btoa(JSON.stringify(event))}`;

  const head = async (size: number) => {
    try {
      const res = await fetch(`${key}/upload`, {
        method: "HEAD",
        signal: AbortSignal.timeout(8000),
        headers: {
          Authorization: auth,
          "X-Content-Length": String(size),
          "X-Content-Type": "application/octet-stream",
          "X-SHA-256": PROBE_HASH,
        },
      });
      return { status: res.status, reason: res.headers.get("X-Reason") };
    } catch {
      return null;
    }
  };
  const accepted = (r: { status: number }) => r.status >= 200 && r.status < 300;

  // The smallest size must be accepted, or the answer says nothing about size
  // (whitelist, BUD-06 unimplemented). That is the server's answer, so conclusive.
  const first = await head(LADDER[0]);
  if (!first) return false;
  if (!accepted(first)) return true;

  // A server that accepts the largest rung on HEAD isn't enforcing a cap here.
  const top = await head(LADDER[LADDER.length - 1]);
  if (!top) return false;
  if (accepted(top) || top.status !== 413) return true;
  const stated = parseMaxBytes(top.reason);
  if (stated) {
    recordServerLimit(key, stated);
    return true;
  }

  let lo = 0;
  let hi = LADDER.length - 1; // LADDER[lo] accepted, LADDER[hi] refused
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    const res = await head(LADDER[mid]);
    if (!res) return false;
    if (accepted(res)) lo = mid;
    else if (res.status === 413) hi = mid;
    else return true;
  }
  recordServerLimit(key, LADDER[lo], true);
  return true;
}
