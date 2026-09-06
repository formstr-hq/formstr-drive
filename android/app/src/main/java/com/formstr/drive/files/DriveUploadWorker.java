package com.formstr.drive.files;

import androidx.annotation.Nullable;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Pure network orchestrator for a single upload: PUTs each pre-encrypted,
 * pre-hashed blob (chunks + optional preview) to a Blossom server using a
 * pre-signed auth header, then publishes the pre-signed metadata event. No
 * crypto and no Nostr signer here — everything it touches was already
 * produced/signed in the foreground before this worker started, so it can
 * safely run after the app closes.
 *
 * <p>Fallback is all-or-nothing per server: if a candidate can't take every
 * blob, the whole file restarts on the next candidate rather than ending up
 * split across two. That is a deliberate constraint of running without a
 * signer — the metadata event names one server and was signed before any bytes
 * moved, so the foreground pre-signs one variant per candidate
 * ({@code metadataEvents}) and this worker publishes whichever one matches the
 * server that actually took the blobs. Re-PUTting to a fresh server is safe:
 * Blossom addresses blobs by hash, so an upload is idempotent.
 */
public final class DriveUploadWorker {
    private static final int MAX_RETRIES = 3;
    private static final long RETRY_BACKOFF_MS = 3000;
    private static final int CONNECT_TIMEOUT_MS = 15000;
    private static final int READ_TIMEOUT_MS = 60000;
    private static final int BUFFER_SIZE = 65536;

    /**
     * Rejections that retrying can never fix, mirroring the status->kind table
     * in src/services/uploadErrors.ts: 413 (blob too large for this server),
     * 415 (server sniffed the blob as an unsupported media type), 401/403
     * (auth rejected outright). Burning three retries on a foregone conclusion
     * just delays the fallback to the next server.
     */
    private static final Set<Integer> PERMANENT_FAILURE_STATUS =
            new HashSet<>(Arrays.asList(401, 403, 413, 415));

    public static final class Blob {
        public final String path;
        public final String hash;
        public final String contentType;
        /**
         * Best-effort blobs (today: the preview thumbnail) are skipped when they
         * fail instead of failing the file or forcing a fallback to another
         * server — matching uploadPreviewWithRetry in src/services/uploadFile.ts,
         * where a thumbnail never costs the user their upload.
         */
        public final boolean optional;

        public Blob(String path, String hash, String contentType, boolean optional) {
            this.path = path;
            this.hash = hash;
            this.contentType = contentType;
            this.optional = optional;
        }
    }

    public interface Listener {
        void onProgress(int percent);

        /** @param server the Blossom server every blob landed on. */
        void onComplete(String server);

        /**
         * @param server non-null only when every blob uploaded successfully and
         *               the failure was the relay publish — the caller uses this
         *               to keep the metadata event queued for a later retry
         *               instead of discarding a file that really is stored.
         * @param status the server's HTTP status, when the failure was an actual
         *               rejection (as opposed to a network-level failure, relay
         *               publish failure, or exhausted candidates with no status
         *               to report) — lets the JS side classify the failure with
         *               the same logic web uses (src/services/uploadErrors.ts)
         *               instead of pattern-matching this class's message text.
         */
        void onError(String message, @Nullable String server, @Nullable Integer status);

        void onCancelled();
    }

    private interface ProgressCallback {
        void onProgress(int percent);
    }

    private static final class CancelledException extends RuntimeException {
    }

    /**
     * An HTTP-level rejection from a Blossom server, carrying the status code
     * so callers can classify it themselves (see src/services/uploadErrors.ts
     * on the JS side, which is the single place that turns a status into user
     * wording — this class deliberately stays a raw fact carrier, not prose).
     */
    private static class BlossomHttpException extends IOException {
        final int status;
        BlossomHttpException(@Nullable String message, int status) {
            super(message);
            this.status = status;
        }
    }

    /** A server rejected this upload in a way retrying can't fix. */
    private static final class PermanentRejectionException extends BlossomHttpException {
        PermanentRejectionException(@Nullable String message, int status) {
            super(message, status);
        }
    }

    private final List<String> servers;
    private final List<Blob> blobs;
    private final String authHeader;
    /** server URL -> pre-signed kind-34578 event JSON naming that server. */
    private final Map<String, String> metadataEventsByServer;
    private final List<String> relays;
    private final AtomicBoolean cancelled;
    private final Listener listener;

    public DriveUploadWorker(
            List<String> servers,
            List<Blob> blobs,
            String authHeader,
            Map<String, String> metadataEventsByServer,
            List<String> relays,
            AtomicBoolean cancelled,
            Listener listener
    ) {
        this.servers = servers;
        this.blobs = blobs;
        this.authHeader = authHeader;
        this.metadataEventsByServer = metadataEventsByServer;
        this.relays = relays;
        this.cancelled = cancelled;
        this.listener = listener;
    }

    public void run() {
        try {
            String usedServer = uploadAllBlobs();
            if (usedServer == null) {
                // uploadAllBlobs already reported cancellation or exhaustion.
                return;
            }

            if (cancelled.get()) {
                listener.onCancelled();
                return;
            }

            String eventJson = metadataEventsByServer.get(usedServer);
            if (eventJson == null) {
                listener.onError("No metadata event was prepared for " + usedServer, usedServer, null);
                return;
            }

            boolean published = NostrRelayPublisher.publishWithRetry(
                    relays, NostrRelayPublisher.extractEventId(eventJson), eventJson);
            if (!published) {
                // The blobs are stored; only the relay publish failed. Reporting
                // the server lets the JS side keep the matching metadata event in
                // its outbox so the file isn't lost.
                listener.onError("Failed to publish file metadata to any relay", usedServer, null);
                return;
            }

            listener.onComplete(usedServer);
        } catch (CancelledException e) {
            listener.onCancelled();
        } catch (Exception e) {
            listener.onError(e.getMessage() != null ? e.getMessage() : "Upload failed", null, null);
        } finally {
            cleanupStagedFiles();
        }
    }

    /**
     * Puts every blob on one server, falling through to the next candidate if
     * any blob fails. Returns the server that took them all, or null when the
     * run ended without one (cancelled, or every candidate exhausted) — in which
     * case the terminal event has already been reported.
     */
    @Nullable
    private String uploadAllBlobs() {
        IOException lastError = null;

        for (String server : servers) {
            if (cancelled.get()) {
                listener.onCancelled();
                return null;
            }

            try {
                int totalBlobs = blobs.size();
                for (int i = 0; i < totalBlobs; i++) {
                    if (cancelled.get()) {
                        listener.onCancelled();
                        return null;
                    }
                    int blobIndex = i;
                    Blob blob = blobs.get(i);
                    try {
                        uploadBlobWithRetry(server, blob, (percent) ->
                                listener.onProgress((blobIndex * 100 + percent) / totalBlobs));
                    } catch (IOException error) {
                        if (!blob.optional) {
                            throw error;
                        }
                        // Best-effort blob: log by moving on. The file's own
                        // chunks are what matter, and a missing preview only
                        // means the thumbnail won't render.
                        listener.onProgress(((blobIndex + 1) * 100) / totalBlobs);
                    }
                }
                return server;
            } catch (CancelledException e) {
                listener.onCancelled();
                return null;
            } catch (IOException error) {
                // This candidate couldn't take the whole file; the next one
                // starts over from the first blob. Already-stored blobs on the
                // failed server are harmless — Blossom dedupes by hash and the
                // metadata never references that server.
                lastError = error;
            }
        }

        // Raw message + status only — src/services/uploadErrors.ts on the JS
        // side turns this into user wording (and picks the right wording for
        // multi-server vs. single-server, network vs. rejection) so this class
        // and the web driver never drift into two different phrasings for the
        // same failure.
        Integer status = lastError instanceof BlossomHttpException
                ? ((BlossomHttpException) lastError).status
                : null;
        String message = lastError != null && lastError.getMessage() != null
                ? lastError.getMessage()
                : "Upload failed";
        listener.onError(message, null, status);
        return null;
    }

    private void uploadBlobWithRetry(String server, Blob blob, ProgressCallback onProgress)
            throws IOException {
        int retries = MAX_RETRIES;
        IOException lastError = null;

        while (retries > 0) {
            if (cancelled.get()) throw new CancelledException();
            try {
                putBlob(server, blob, onProgress);
                return;
            } catch (PermanentRejectionException error) {
                // Retrying can't change this answer — fall through to the next
                // candidate server immediately.
                throw error;
            } catch (IOException error) {
                lastError = error;
                retries--;
                if (retries > 0 && !cancelled.get()) {
                    try {
                        Thread.sleep(RETRY_BACKOFF_MS);
                    } catch (InterruptedException ignored) {
                        Thread.currentThread().interrupt();
                    }
                }
            }
        }

        throw lastError != null ? lastError : new IOException("Upload failed");
    }

    private void putBlob(String server, Blob blob, ProgressCallback onProgress) throws IOException {
        String normalizedServer = server.endsWith("/")
                ? server.substring(0, server.length() - 1)
                : server;
        File file = new File(blob.path);
        long length = file.length();
        URL url = new URL(normalizedServer + "/upload");
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setRequestMethod("PUT");
        connection.setDoOutput(true);
        connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
        connection.setReadTimeout(READ_TIMEOUT_MS);
        connection.setFixedLengthStreamingMode(length);
        connection.setRequestProperty("Authorization", authHeader);
        connection.setRequestProperty("Content-Type", blob.contentType);
        connection.setRequestProperty("X-SHA-256", blob.hash);

        try {
            try (OutputStream out = connection.getOutputStream();
                 InputStream in = new FileInputStream(file)) {
                byte[] buffer = new byte[BUFFER_SIZE];
                long sent = 0;
                int bytesRead;
                while ((bytesRead = in.read(buffer)) != -1) {
                    if (cancelled.get()) throw new CancelledException();
                    out.write(buffer, 0, bytesRead);
                    sent += bytesRead;
                    if (length > 0) {
                        onProgress.onProgress((int) (sent * 100 / length));
                    }
                }
            }

            int responseCode = connection.getResponseCode();
            if (responseCode < 200 || responseCode >= 300) {
                // The server's own reason, unadorned — classification and
                // wording happen once, in src/services/uploadErrors.ts.
                String reason = connection.getHeaderField("X-Reason");
                if (PERMANENT_FAILURE_STATUS.contains(responseCode)) {
                    throw new PermanentRejectionException(reason, responseCode);
                }
                throw new BlossomHttpException(reason, responseCode);
            }
        } finally {
            connection.disconnect();
        }
    }

    private void cleanupStagedFiles() {
        File parent = null;
        for (Blob blob : blobs) {
            try {
                File file = new File(blob.path);
                parent = file.getParentFile();
                if (file.exists()) {
                    file.delete();
                }
            } catch (Exception ignored) {
                // best-effort cleanup
            }
        }
        if (parent != null) {
            parent.delete();
        }
    }
}
