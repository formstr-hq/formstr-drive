// The ONLY place a sharing event's tags are written and its content is
// encrypted+signed. Every sharing event MUST be built through
// {@link buildShareEvent} — nowhere else in `services/sharing` may call
// `finalizeEvent` directly.
//
// Previously this was 10 separate hand-written `finalizeEvent` blocks
// spread across `create.ts`, `folder/create.ts` and `shareInfo.ts`, each
// re-declaring the same four tags. `["encrypted","nip44"]` was true in
// exactly one place in the whole app (`fileIndex.ts`) and false in the
// other seven — the tag had drifted from the cipher because nothing forced
// them to agree. Building the tag list and calling
// {@link encryptSharePayload} in the same function is what makes that
// drift impossible: the "nip44" claim and the code that fulfils it can no
// longer live apart.
import { finalizeEvent, type Event } from "nostr-tools";
import { encryptSharePayload } from "./crypto";
import { METADATA_KIND, CLIENT_TAG } from "./link";
import { nextCreatedAt } from "./relay";

/**
 * Every subtype of kind-34578 event the sharing feature publishes, per
 * NIP-FS's "File/Folder Sharing" section:
 *  - `shared-file`: a file's metadata, re-encrypted to an ephemeral key and
 *    handed to a recipient.
 *  - `container`: a shared folder's member list, encrypted to the same
 *    ephemeral key (PSK) as its members.
 *  - `shared-container`: the owner's own bookkeeping record of a folder
 *    share — which container it points at, the PSK, and (per spec) the
 *    owners set — encrypted to the owner's Drive Key, never shared.
 *
 * Renamed from this app's previous ad-hoc tags (`shared-container` used to
 * mean today's `container`, and today's `shared-container` was called
 * `share-info`) to match the spec's own vocabulary — see the plan for the
 * full mapping. No back-compat: this is a clean break.
 */
export type ShareSubtype = "shared-file" | "container" | "shared-container";

export interface BuildShareEventArgs {
  subtype: ShareSubtype;
  /** The event's `d` tag. */
  dTag: string;
  /** JSON-serialized and encrypted internally — callers never touch a
   *  cipher directly. */
  payload: unknown;
  conversationKey: Uint8Array;
  signingKey: Uint8Array;
  /** Defaults to {@link nextCreatedAt}. Callers that need a specific
   *  timestamp — e.g. a superseding/revoke event that must beat whatever's
   *  currently published at the same coordinate — pass it explicitly. */
  createdAt?: number;
  /** Extra tags beyond the four every share event carries, e.g.
   *  `["revoked", "1"]` on a superseding event. */
  extraTags?: string[][];
}

/** Builds, encrypts, and signs a kind-34578 sharing event. Synchronous —
 *  {@link encryptSharePayload} and `finalizeEvent` both are; callers don't
 *  need to `await` this, though doing so is harmless. */
export function buildShareEvent(args: BuildShareEventArgs): Event {
  const { subtype, dTag, payload, conversationKey, signingKey, createdAt, extraTags } = args;
  return finalizeEvent(
    {
      kind: METADATA_KIND,
      created_at: createdAt ?? nextCreatedAt(),
      tags: [
        ["d", dTag],
        ["t", subtype],
        ["client", CLIENT_TAG],
        ["encrypted", "nip44"],
        ...(extraTags ?? []),
      ],
      content: encryptSharePayload(JSON.stringify(payload), conversationKey),
    },
    signingKey,
  );
}
