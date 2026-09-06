import { generateSecretKey, type Event } from "nostr-tools";
import { bytesToHex } from "nostr-tools/utils";
import { generateFileId, type FileMetadata } from "../types/metadata";
import { prepareUpload, SEGMENT_SIZE, computePlaintextHash } from "../services/uploadFile";
import { segmentCount } from "../crypto";
import { previewFile } from "../services/Preview/previewManager";
import {
  buildSignedMetadataEvent,
  recordPublishedMetadata,
  saveFileMetadata,
  findDuplicateByHash,
} from "../services/fileIndex";
import {
  dequeueMetadataEvent,
  publishAndDequeue,
  replaceQueuedMetadataEvent,
} from "../services/metadataOutbox";
import { createAuthEvent, BACKGROUND_UPLOAD_AUTH_EXPIRATION_SECONDS } from "../auth";
import { APP_RELAYS, defaultRelays, mergeRelayLists } from "../utils/common";
import { isAbortError } from "../utils/abortError";
import { describeAllServersFailed } from "../services/uploadErrors";
import {
  cancelNativeUpload,
  ensureNotificationPermission,
  stageNativeUploadChunk,
  startNativeUpload,
  startNativeUploadService,
  subscribeNativeUploadEvents,
  type NativeUploadBlob,
  type NativeUploadMetadataEvent,
} from "../native/driveManifest";

// The transfer bar is split between the two phases: everything JS does
// (encrypt + stage) fills the first slice, the native network phase the rest.
// Staging is roughly proportional to file size, so a fixed split tracks real
// elapsed time closely enough and never goes backwards at the handoff.
//
// Exported so nativeAdoption.ts can apply the identical rescale to uploads
// re-adopted after an app relaunch (which only ever see the network phase,
// but should still report progress on the same 0-100 scale as a live
// session row). Must also match PREPARE_PROGRESS_SHARE in
// DriveUploadService.java, which uses it to rescale the notification's
// displayed percent to agree with this in-app number.
export const PREPARE_PROGRESS_SHARE = 40;

/**
 * The Android upload path. Unlike the web driver (`uploadDriver.ts`), which
 * does encryption *and* every network request inside the WebView, this one
 * splits the upload in two:
 *
 *  1. **Prepare (foreground, WebView).** Encrypt each chunk, stage the
 *     ciphertext to app-private storage, generate the preview, and sign the two
 *     Nostr events the network phase will need. This phase needs JS and the
 *     signer, so it cannot survive the app being killed.
 *  2. **Upload (native foreground service).** `DriveUploadService` PUTs the
 *     staged blobs and publishes the metadata event. It touches no crypto and
 *     no signer, so it keeps running when the app is backgrounded or swiped
 *     away — which is the entire point.
 *
 * The user still approves exactly one signature (the Blossom auth event): the
 * kind-34578 metadata events are signed locally with the Drive Key and cost no
 * prompt, which is what makes pre-signing one variant per candidate server
 * affordable.
 */
export async function nativeUploadDriver(
  file: File,
  servers: string[],
  targetFolder: string,
  signal: AbortSignal,
  onProgress: (info: {
    stage?: string;
    progress?: number;
    survivesAppClose?: boolean;
  }) => void,
): Promise<FileMetadata> {
  // NIP-FS client-level dedup: the encrypted blobHash is unique per upload
  // (fresh ephemeral key + nonces every time), so it can never catch a
  // re-upload of identical content — only the plaintext hash can. Checked
  // before the native foreground service (and its persistent notification)
  // even starts, since a duplicate needs neither: there's nothing to
  // encrypt, stage, or hand off, so it's published synchronously right here
  // instead of going through the background-survivable upload machinery.
  onProgress({ stage: "Checking for duplicates...", progress: 0 });
  const dedupHash = await computePlaintextHash(file, signal);
  const duplicate = findDuplicateByHash(dedupHash);
  if (duplicate) {
    const metadata: FileMetadata = {
      ...duplicate,
      id: generateFileId(),
      name: file.name,
      folder: targetFolder,
      uploadedAt: Date.now(),
    };
    const publishResult = await saveFileMetadata(metadata);
    if (publishResult.accepted < publishResult.total) {
      console.warn(`[Upload] Metadata saved to ${publishResult.accepted}/${publishResult.total} relays`);
    }
    onProgress({ stage: "Upload complete", progress: 100 });
    return metadata;
  }

  const uploadId = crypto.randomUUID();

  await ensureNotificationPermission();
  // Start the service in its PREPARING phase first, so the persistent
  // notification (with a working Cancel) is up before any real work begins.
  await startNativeUploadService(uploadId, file.name);

  let handedOff = false;

  // Cancelling from the notification during staging has to stop the JS loop
  // too — the service has no way to interrupt the WebView on its own. This
  // controller merges that signal with the transfer row's own × button.
  const prepareAbort = new AbortController();
  const abortPrepare = () => prepareAbort.abort();

  // The × button has to reach whichever side currently owns the upload: the JS
  // staging loop before the handoff, the foreground service after it (where
  // aborting a JS signal would do nothing at all).
  const onAbort = () => {
    abortPrepare();
    if (handedOff) {
      void cancelNativeUpload(uploadId).catch(() => {});
    }
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();

  // Set when the worker fails *after* every blob has landed — i.e. only the
  // relay publish failed. That's the one failure where the file really is on
  // Blossom, so the metadata event must stay queued (pointing at the server
  // that accepted the blobs) rather than being discarded with the transfer.
  let blobsLandedOn: string | null = null;

  const cancelListener = await subscribeNativeUploadEvents(uploadId, (event) => {
    if (event.type === "error" && event.server) {
      blobsLandedOn = event.server;
    }
    if (event.type === "cancelled" || event.type === "error") {
      abortPrepare();
    }
  });

  let queuedEvent: Event | null = null;
  let metadataByServer = new Map<string, { metadata: FileMetadata; event: Event }>();

  try {
    onProgress({ stage: "Reading file...", progress: 0 });

    // Kicked off here and awaited inside prepareUpload only after the chunk
    // loop, so preview generation overlaps encryption (same as uploadFile).
    const previewPromise = previewFile(file).catch((e: unknown) => {
      console.warn("Background preview generation failed", e);
      return null;
    });

    const privateKeyHex = bytesToHex(generateSecretKey());

    // Every segment index below `totalSegments` belongs to the file blob
    // (destination index 0, appended in order); the preview, staged
    // separately by prepareUpload at index `totalSegments`, gets its own
    // destination (index 1) and is never appended onto the file.
    const totalSegments = segmentCount(file.size, SEGMENT_SIZE);

    onProgress({ stage: "Encrypting...", progress: 0 });
    const prepared = await prepareUpload(
      file,
      privateKeyHex,
      prepareAbort.signal,
      (info) => {
        onProgress({
          stage: info.stage,
          // prepareUpload reports 0-20 for its own pass; rescale to our share.
          progress: Math.round(((info.progress ?? 0) / 20) * PREPARE_PROGRESS_SHARE),
        });
      },
      previewPromise,
      (index, bytes) =>
        index < totalSegments
          ? stageNativeUploadChunk(uploadId, 0, bytes, prepareAbort.signal, index > 0)
          : stageNativeUploadChunk(uploadId, 1, bytes, prepareAbort.signal),
      SEGMENT_SIZE,
    );

    throwIfAborted(prepareAbort.signal);

    if (!prepared.blobRef) {
      throw new Error("Upload staging did not produce a blob for the file");
    }

    const blobs: NativeUploadBlob[] = [
      { path: prepared.blobRef, hash: prepared.blobHash, contentType: "application/octet-stream" },
    ];
    if (prepared.previewRef && prepared.previewHash) {
      blobs.push({
        path: prepared.previewRef,
        hash: prepared.previewHash,
        contentType: "application/octet-stream",
        // A thumbnail must never cost the user their upload, and must never
        // push the file onto a fallback server on its own.
        optional: true,
      });
    }

    onProgress({
      stage: "Waiting for signature approval...",
      progress: PREPARE_PROGRESS_SHARE,
    });

    // One auth event covering every blob (BUD-11 tag scoping), with a long
    // expiration because the native worker's PUTs can run well after signing.
    // This is the upload's only signer prompt, and the header is
    // server-agnostic so the worker replays it across candidates for free.
    const authHeader = await createAuthEvent(
      "upload",
      `Upload ${file.name}`,
      blobs.map((blob) => blob.hash),
      BACKGROUND_UPLOAD_AUTH_EXPIRATION_SECONDS,
    );

    const baseMetadata: Omit<FileMetadata, "server" | "servers"> = {
      name: file.name,
      id: generateFileId(),
      unencryptedFileHash: prepared.unencryptedFileHash,
      size: file.size,
      type: file.type || "application/octet-stream",
      folder: targetFolder,
      uploadedAt: Date.now(),
      ...(prepared.previewHash ? { previewHash: prepared.previewHash } : {}),
      // The whole file is one blob now — no per-chunk server override is
      // possible or needed. The worker puts it on one server, falling back
      // all-or-nothing, so `server`/`servers` always describe that one blob.
      blobHash: prepared.blobHash,
      chunkSize: prepared.chunkSize,
      encryptionKey: privateKeyHex,
      encryptionAlgorithm: "aes-gcm",
    };

    // One pre-signed metadata event per candidate. The worker publishes the one
    // matching the server the blobs actually landed on — the whole reason a
    // background upload can fall back without a signer being available.
    metadataByServer = new Map<string, { metadata: FileMetadata; event: Event }>();
    const metadataEvents: NativeUploadMetadataEvent[] = [];
    for (const server of servers) {
      const metadata: FileMetadata = { ...baseMetadata, server, servers: [server] };
      const event = await buildSignedMetadataEvent(metadata);
      metadataByServer.set(server, { metadata, event });
      metadataEvents.push({ server, eventJson: JSON.stringify(event) });
    }

    // Queue the primary variant before handing off: if the app dies, or the
    // worker uploads the blobs but no relay accepts the event, the outbox drain
    // republishes it on the next launch instead of losing the file. The variant
    // is corrected below once the winning server is known.
    //
    // This is queued before a single byte has actually reached the network —
    // an app kill seconds into staging leaves the exact same queued entry as
    // one written after the blob genuinely landed. verifyBlob is what tells
    // those apart at drain time: the file's blob must actually exist on the
    // primary server before this entry is ever auto-published, or a
    // cancelled/incomplete upload would silently surface as a finished file.
    queuedEvent = metadataByServer.get(servers[0])!.event;
    await replaceQueuedMetadataEvent(queuedEvent, file.name, {
      server: servers[0],
      hash: prepared.blobHash,
    });

    throwIfAborted(prepareAbort.signal);
    handedOff = true;

    // From here the foreground service owns the upload — it no longer needs the
    // WebView, so closing the app is safe.
    onProgress({
      stage: "Uploading...",
      progress: PREPARE_PROGRESS_SHARE,
      survivesAppClose: true,
    });
    let usedServer: string;
    try {
      ({ server: usedServer } = await startNativeUpload(
        {
          uploadId,
          servers,
          fileName: file.name,
          authHeader,
          metadataEvents,
          blobs,
          relays: mergeRelayLists(APP_RELAYS, defaultRelays),
        },
        (event) => {
          if (event.type === "progress" && typeof event.percent === "number") {
            onProgress({
              stage: "Uploading...",
              progress:
                PREPARE_PROGRESS_SHARE +
                Math.round((event.percent / 100) * (100 - PREPARE_PROGRESS_SHARE)),
            });
          }
        },
      ));
    } catch (nativeError) {
      if (isAbortError(nativeError)) throw nativeError;
      // Run the native rejection through the same classification the web
      // driver uses (src/services/uploadErrors.ts), so an Android upload that
      // hit a 413/401/403/415 reports the same wording a browser upload would
      // — the native worker itself only reports raw status + message (see
      // DriveUploadWorker.Listener.onError), not English.
      throw describeAllServersFailed([
        { server: servers[0] ?? "the server", error: toClassifiableNativeError(nativeError) },
      ]);
    }

    const winner = metadataByServer.get(usedServer) ?? metadataByServer.get(servers[0])!;

    // Show the file immediately instead of waiting for its own event to round-
    // trip back through the relay subscription — the same optimistic reflection
    // saveFileMetadata does on the web path.
    recordPublishedMetadata(winner.metadata, winner.event.created_at);

    // The worker already published this to the relays, but replaying it through
    // the local data layer stores it in the local relay cache too (so a restart
    // shows the file instantly) and clears the outbox entry. Relays answer the
    // replay as a duplicate, which publishAndDequeue treats as success. If it
    // fails outright the entry simply stays queued for the background drain.
    await publishAndDequeue(winner.event).catch(() => {});
    queuedEvent = null;

    onProgress({ stage: "Uploading...", progress: 100 });
    return winner.metadata;
  } catch (e) {
    // A cancel that arrives before the handoff has to reach the service, which
    // is still holding the PREPARING notification. After the handoff the worker
    // owns cancellation and has already torn itself down.
    if (!handedOff) {
      await cancelNativeUpload(uploadId).catch(() => {});
    }
    if (queuedEvent) {
      const landed = blobsLandedOn ? metadataByServer.get(blobsLandedOn) : undefined;
      if (landed) {
        // Blobs are on Blossom and only the relay publish failed: keep the
        // event queued, corrected to the server that actually accepted them,
        // so the outbox drain finishes the job later.
        await replaceQueuedMetadataEvent(landed.event, file.name).catch(() => {});
      } else {
        // The blobs never landed (or we can't know that they did), so a queued
        // metadata event would publish a file the user can't download. Drop it
        // — a retry re-runs the whole upload and queues a fresh one.
        await dequeueMetadataEvent(queuedEvent).catch(() => {});
      }
    }
    if (isAbortError(e)) {
      throw new DOMException("Upload cancelled", "AbortError");
    }
    throw e;
  } finally {
    signal.removeEventListener("abort", onAbort);
    await cancelListener?.remove();
  }
}

/**
 * Capacitor delivers a rejected `PluginCall` as a plain object carrying
 * `message` and `code` — `code` is the stringified HTTP status when
 * DriveFilesPlugin.onUploadEvent rejected with one (see its comment), and
 * absent for network-level/relay-publish/exhausted-candidates failures.
 * `classifyUploadFailure` (uploadErrors.ts) expects a numeric `status`, so
 * this bridges the two shapes without teaching it about Capacitor specifics.
 */
function toClassifiableNativeError(e: unknown): unknown {
  if (e && typeof e === "object") {
    const code = (e as { code?: string }).code;
    const message = (e as { message?: string }).message;
    if (code && /^\d+$/.test(code)) {
      return { status: Number(code), message };
    }
  }
  return e;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException("Upload aborted", "AbortError");
  }
}
