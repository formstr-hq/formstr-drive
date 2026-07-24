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

const pendingStreams = new Map();

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object" || data.type !== "start") {
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

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
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
