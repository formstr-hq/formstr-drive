// Self-hosted, same-origin service worker that lets large decrypted downloads
// stream straight to disk in *every* browser, not just Chromium (which has the
// File System Access API). Nothing here talks to any server — it only relays
// bytes the page has already decrypted locally into a real HTTP response the
// browser's download manager can stream to disk without buffering the whole
// file in memory.
//
// Protocol (page <-> SW), over a MessageChannel port transferred with the
// initial "start" message on navigator.serviceWorker.controller:
//   page -> sw:   { type: "start", id, fileName, size, mimeType }
//   sw   -> page: { type: "ready" }
//   sw   -> page: { type: "pull" }               (backpressure signal)
//   sw   -> page: { type: "fetch-attached" }      (iframe reached the SW fetch)
//   page -> sw:   { type: "chunk", buffer }       (ArrayBuffer, transferred)
//   page -> sw:   { type: "end" }
//   sw   -> page: { type: "complete" }            (stream closed; safe to tear down)
//   page -> sw:   { type: "abort", message }
//
// The page then navigates a hidden iframe to /__stream_download__/<id>, which
// this worker answers with a streamed Response built from the chunks above.
//
// A second, independent protocol serves seekable <video>/<iframe> previews
// of large encrypted files without decrypting the whole file up front. The
// page never hands over the decryption key — it answers "give me these
// plaintext bytes" requests from the worker, over its own MessageChannel:
//   page -> sw:   { type: "media-start", id, size, mimeType }  + port
//   sw   -> page: { type: "media-ready" }
//   sw fetch:     GET /__stream_media__/<id>  (with or without a Range header)
//   sw   -> page: { type: "range", reqId, start, end }
//   page -> sw:   { type: "range-data", reqId, buffer }         (transferred)
//   page -> sw:   { type: "range-error", reqId, message }
//   page -> sw:   { type: "media-end", id }
//
// The <video>/<iframe> element itself drives this — it issues whatever Range
// requests it wants (seeking, buffering ahead) and this worker just relays
// each one to the page and answers with what comes back. Unlike the download
// protocol above there's no backpressure/pull handshake: each fetch is a
// single request/response, not a long-lived stream.

const pendingStreams = new Map();
const mediaSessions = new Map();

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Each Range GET the media element issues is capped to this many bytes
// before being relayed to the page — an unbounded `bytes=0-` (the natural
// first request from a <video>/<iframe>, before any seeking) would otherwise
// mean decrypting and buffering the entire file at once, exactly the OOM
// risk NIP-FS segmentation exists to avoid. Returning fewer bytes than asked
// is legal HTTP (RFC 7233) — the element just issues a follow-up request for
// the rest, which is how normal progressive playback/scrubbing already works.
const MAX_MEDIA_RANGE_BYTES = 4 * 1024 * 1024;

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") {
    return;
  }

  if (data.type === "media-start") {
    const port = event.ports && event.ports[0];
    if (!port) return;

    const { id, size, mimeType } = data;
    const pendingRequests = new Map();
    let reqCounter = 0;

    port.onmessage = (portEvent) => {
      const msg = portEvent.data;
      if (msg && msg.type === "media-end") {
        // The page closed this preview (modal closed/unmounted) — drop the
        // session so it stops holding the port and its pendingRequests map,
        // and reject anything still in flight rather than let it dangle
        // until its own 30s timeout.
        const entry = mediaSessions.get(id);
        if (entry) {
          for (const waiter of entry.pendingRequests.values()) {
            waiter.reject(new Error("Preview session closed"));
          }
        }
        mediaSessions.delete(id);
        return;
      }
      const waiter = msg && pendingRequests.get(msg.reqId);
      if (!waiter) return;
      pendingRequests.delete(msg.reqId);
      if (msg.type === "range-data") {
        waiter.resolve(new Uint8Array(msg.buffer));
      } else if (msg.type === "range-error") {
        waiter.reject(new Error(msg.message || "Range read failed"));
      }
    };
    port.start();

    mediaSessions.set(id, {
      port,
      size,
      mimeType,
      pendingRequests,
      nextReqId: () => ++reqCounter,
    });
    port.postMessage({ type: "media-ready" });
    return;
  }

  if (data.type !== "start") {
    return;
  }

  const port = event.ports && event.ports[0];
  if (!port) {
    return;
  }

  const { id, fileName, size, mimeType } = data;
  let streamController = null;
  let finishedResolver = null;
  const finished = new Promise((resolve) => {
    finishedResolver = resolve;
  });

  const stream = new ReadableStream({
    start(controller) {
      streamController = controller;
    },
    pull() {
      // Default queuing strategy holds ~1 chunk, so this fires again roughly
      // once per chunk consumed — a natural pull/ack handshake that keeps at
      // most one chunk in flight and bounds memory to that single chunk.
      port.postMessage({ type: "pull" });
    },
    cancel(reason) {
      port.postMessage({ type: "cancelled", message: String(reason) });
      const entry = pendingStreams.get(id);
      if (entry) entry.finishedResolver();
      pendingStreams.delete(id);
    },
  });

  port.onmessage = (portEvent) => {
    const msg = portEvent.data;
    const entry = pendingStreams.get(id);
    if (!entry || !entry.controller) {
      return;
    }

    if (msg.type === "chunk") {
      entry.controller.enqueue(new Uint8Array(msg.buffer));
    } else if (msg.type === "end") {
      entry.controller.close();
      entry.finishedResolver();
      // Ack that the stream is closed so the page can tear down the iframe
      // without racing an in-progress write, instead of a blind timeout.
      entry.port.postMessage({ type: "complete" });
      pendingStreams.delete(id);
    } else if (msg.type === "abort") {
      entry.controller.error(new Error(msg.message || "Download aborted"));
      entry.finishedResolver();
      pendingStreams.delete(id);
    }
  };

  pendingStreams.set(id, { stream, controller: streamController, port, fileName, size, mimeType, finished, finishedResolver });
  port.postMessage({ type: "ready" });
});

/** Relays one plaintext-range request to the page and waits for the answer
 *  (or a page-side decrypt failure), so a slow/wedged page can't hang a
 *  fetch handler forever. */
function requestMediaRange(session, start, end) {
  return new Promise((resolve, reject) => {
    const reqId = session.nextReqId();
    session.pendingRequests.set(reqId, { resolve, reject });
    session.port.postMessage({ type: "range", reqId, start, end });
    setTimeout(() => {
      if (session.pendingRequests.delete(reqId)) {
        reject(new Error("Timed out waiting for the page to decrypt this range"));
      }
    }, 30000);
  });
}

/** Parses a `Range: bytes=a-b` / `bytes=a-` / `bytes=-N` header against a
 *  known total size. Returns null for anything absent/malformed so the
 *  caller falls back to "whole file" semantics — this is preview traffic
 *  from the browser's own media stack, not attacker-controlled input, so a
 *  permissive fallback is fine. */
function parseRange(rangeHeader, size) {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return null;
  const [, startStr, endStr] = match;
  if (startStr === "" && endStr === "") return null;

  let start;
  let end;
  if (startStr === "") {
    // Suffix range `bytes=-N`: the last N bytes.
    const suffixLen = parseInt(endStr, 10);
    start = Math.max(0, size - suffixLen);
    end = size - 1;
  } else {
    start = parseInt(startStr, 10);
    end = endStr === "" ? size - 1 : Math.min(parseInt(endStr, 10), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end) return null;
  return { start, end };
}

async function handleMediaFetch(session, request) {
  const { size, mimeType } = session;
  const requested = parseRange(request.headers.get("Range"), size) || { start: 0, end: size - 1 };
  const cappedEnd = Math.min(requested.end, requested.start + MAX_MEDIA_RANGE_BYTES - 1);

  let bytes;
  try {
    bytes = await requestMediaRange(session, requested.start, cappedEnd);
  } catch (e) {
    return new Response((e && e.message) || "Range read failed", { status: 500 });
  }

  const headers = { "Content-Type": mimeType || "application/octet-stream", "Accept-Ranges": "bytes" };
  const truncated = cappedEnd < size - 1;
  if (request.headers.get("Range") || truncated) {
    headers["Content-Range"] = `bytes ${requested.start}-${cappedEnd}/${size}`;
    headers["Content-Length"] = String(cappedEnd - requested.start + 1);
    return new Response(bytes, { status: 206, headers });
  }

  headers["Content-Length"] = String(size);
  return new Response(bytes, { status: 200, headers });
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  const mediaMatch = url.pathname.match(/^\/__stream_media__\/(.+)$/);
  if (mediaMatch) {
    const id = decodeURIComponent(mediaMatch[1]);
    const session = mediaSessions.get(id);
    if (!session) {
      event.respondWith(new Response("Not found", { status: 404 }));
      return;
    }
    event.respondWith(handleMediaFetch(session, event.request));
    return;
  }

  const match = url.pathname.match(/^\/__stream_download__\/(.+)$/);
  if (!match) {
    return;
  }

  const id = decodeURIComponent(match[1]);
  const entry = pendingStreams.get(id);
  if (!entry) {
    event.respondWith(new Response("Not found", { status: 404 }));
    return;
  }

  const safeAscii = (entry.fileName || "download").replace(/["\r\n\\]/g, "_");
  const encoded = encodeURIComponent(entry.fileName || "download");
  const headers = {
    "Content-Type": entry.mimeType || "application/octet-stream",
    "Content-Disposition": `attachment; filename="${safeAscii}"; filename*=UTF-8''${encoded}`,
  };
  if (entry.size) {
    headers["Content-Length"] = String(entry.size);
  }

  event.respondWith(new Response(entry.stream, { headers }));
  event.waitUntil(entry.finished);
  entry.port.postMessage({ type: "fetch-attached" });
});
