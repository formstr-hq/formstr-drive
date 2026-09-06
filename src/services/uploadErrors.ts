import { BlossomError } from "../blossom";

/**
 * Single source of truth for turning a raw upload failure (a {@link BlossomError},
 * a native Android failure, or a generic network error) into something a user can
 * act on. Both the web driver (uploadFile.ts) and the Android driver
 * (nativeUploadDriver.ts) run every failure through this module, so the two
 * platforms report identical wording for identical failures — previously each
 * had its own ad-hoc English and its own copy of the "is this worth retrying"
 * status list, and the two had drifted (see git history of uploadFile.ts and
 * DriveUploadWorker.java's PERMANENT_FAILURE_STATUS).
 */

export type UploadFailureKind =
  | "rejected-too-large"
  | "rejected-auth"
  | "rejected-media-type"
  | "network"
  | "timeout"
  | "server-error";

export interface ClassifiedUploadFailure {
  kind: UploadFailureKind;
  /** False for failures where retrying the same server can never succeed —
   *  callers should fall through to the next candidate immediately instead of
   *  burning retry attempts on a foregone conclusion. */
  retryable: boolean;
  /** User-facing description of the failure itself (no server name — callers
   *  that address multiple servers compose that in {@link describeAllServersFailed}). */
  userMessage: string;
  /** The server's own X-Reason / status text, when it sent one. Surfaced
   *  alongside userMessage so a specific server-side explanation isn't lost. */
  serverReason?: string;
  /** The HTTP status, when the failure reached the server and got a real
   *  response. Absent for network-level failures. */
  status?: number;
}

/** HTTP statuses a Blossom server uses for a rejection that retrying can never
 *  fix. Mirrors PERMANENT_FAILURE_STATUS in DriveUploadWorker.java — keep the
 *  two in sync; native reports its status back through the bridge specifically
 *  so it can be classified here instead of maintaining a second copy. */
const STATUS_KIND: Record<number, UploadFailureKind> = {
  401: "rejected-auth",
  403: "rejected-auth",
  413: "rejected-too-large",
  415: "rejected-media-type",
};

const KIND_MESSAGE: Record<UploadFailureKind, string> = {
  "rejected-too-large": "This file is too large for this server's upload limit.",
  "rejected-auth": "This server rejected the upload's authorization.",
  "rejected-media-type": "This server doesn't accept this type of file.",
  network: "The connection was blocked or dropped — this can be a CORS misconfiguration, a network hiccup, or a temporary outage.",
  timeout: "The server didn't respond in time.",
  "server-error": "The server reported an error.",
};

/**
 * Classifies a failure from a single upload attempt against a single server.
 * Accepts a {@link BlossomError} (web), a plain `{ status, message }` shape
 * (native, once its bridge reports structured failures), or any other thrown
 * value (treated as a network-ish failure — no status was ever obtained).
 */
export function classifyUploadFailure(err: unknown): ClassifiedUploadFailure {
  if (err instanceof BlossomError) {
    if (err.status !== undefined) {
      const kind = STATUS_KIND[err.status] ?? "server-error";
      return {
        kind,
        retryable: kind === "server-error",
        userMessage: KIND_MESSAGE[kind],
        serverReason: err.message || undefined,
        status: err.status,
      };
    }
    return {
      kind: "network",
      retryable: true,
      userMessage: KIND_MESSAGE.network,
      serverReason: undefined,
    };
  }

  if (err && typeof err === "object" && "status" in err) {
    const status = (err as { status?: number }).status;
    const message = (err as { message?: string }).message;
    if (typeof status === "number") {
      const kind = STATUS_KIND[status] ?? "server-error";
      return {
        kind,
        retryable: kind === "server-error",
        userMessage: KIND_MESSAGE[kind],
        serverReason: message || undefined,
        status,
      };
    }
  }

  if (err instanceof Error && /timed out/i.test(err.message)) {
    return { kind: "timeout", retryable: true, userMessage: KIND_MESSAGE.timeout, serverReason: err.message };
  }

  return {
    kind: "network",
    retryable: true,
    userMessage: KIND_MESSAGE.network,
    serverReason: err instanceof Error ? err.message : undefined,
  };
}

export function isPermanentFailure(err: unknown): boolean {
  return !classifyUploadFailure(err).retryable;
}

/**
 * Builds the final error thrown once every candidate server has been tried
 * and none accepted the upload. Names each server and the real reason it
 * failed — never a generic "temporary connectivity issue" unless every
 * failure genuinely was network-level, since blaming connectivity for an
 * outright rejection (413/401/403/415) sends the user chasing the wrong fix.
 */
export function describeAllServersFailed(
  perServerFailures: { server: string; error: unknown }[],
): Error {
  if (perServerFailures.length === 0) {
    return new Error("Upload failed: no server was attempted.");
  }

  const classified = perServerFailures.map(({ server, error }) => ({
    server,
    classified: classifyUploadFailure(error),
  }));

  const allNetwork = classified.every((c) => c.classified.kind === "network");

  if (classified.length === 1) {
    const { server, classified: c } = classified[0];
    const reason = c.serverReason ? `: ${c.serverReason}` : "";
    return new Error(`Upload to ${server} failed — ${c.userMessage}${reason}`);
  }

  const detail = classified
    .map(({ server, classified: c }) => {
      const reason = c.serverReason ? ` (${c.serverReason})` : "";
      return `${server} — ${c.userMessage}${reason}`;
    })
    .join("; ");

  if (allNetwork) {
    return new Error(
      `Could not reach any Blossom server (tried ${classified.length}) — this is usually a temporary connectivity issue. ${detail}`,
    );
  }

  return new Error(`Could not upload to any Blossom server: ${detail}`);
}
