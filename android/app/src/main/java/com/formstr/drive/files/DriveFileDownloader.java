package com.formstr.drive.files;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.os.Build;
import android.os.CancellationSignal;

import androidx.annotation.Nullable;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.List;

/**
 * Shared streaming download + decrypt primitives, used by both the read-only
 * Files DocumentsProvider export path and the explicit "Save to Downloads" flow.
 * Chunks are streamed and written out one at a time so peak memory stays around
 * one chunk, never the full file size.
 */
public final class DriveFileDownloader {
    public static final String DOWNLOAD_CHANNEL_ID = "formstr_drive_downloads";
    /** Separate channel for terminal (complete/error) alerts so they can sound/vibrate. */
    public static final String DOWNLOAD_DONE_CHANNEL_ID = "formstr_drive_downloads_done";

    public interface ProgressCallback {
        void onProgress(int percent);
    }

    /**
     * One encrypted chunk and the Blossom server it actually lives on. A chunk
     * that fell back to a different server during upload must be fetched from
     * that server, not the file's primary one — this mirrors resolveChunks() in
     * src/types/metadata.ts, and is why the native side can no longer treat a
     * file as "one server, N hashes".
     */
    public static final class Chunk {
        public final String hash;
        public final String server;

        public Chunk(String hash, String server) {
            this.hash = hash;
            this.server = server;
        }
    }

    private DriveFileDownloader() {
    }

    /**
     * Reads a chunk list in either published shape: the current
     * {@code [{ "hash": …, "server"?: … }]} objects, or the legacy bare
     * {@code ["hash", …]} strings. Entries without their own server resolve to
     * {@code fallbackServer} (the file's primary). Returns null for absent or
     * unparseable input so callers can fall back to the single-blob path.
     */
    @Nullable
    public static List<Chunk> parseChunks(@Nullable String chunksJson, String fallbackServer) {
        if (chunksJson == null || chunksJson.trim().isEmpty()) {
            return null;
        }

        try {
            return parseChunks(new JSONArray(chunksJson), fallbackServer);
        } catch (JSONException error) {
            return null;
        }
    }

    @Nullable
    public static List<Chunk> parseChunks(@Nullable JSONArray chunksJson, String fallbackServer) {
        if (chunksJson == null) {
            return null;
        }

        List<Chunk> chunks = new ArrayList<>(chunksJson.length());
        for (int i = 0; i < chunksJson.length(); i++) {
            JSONObject entry = chunksJson.optJSONObject(i);
            if (entry != null) {
                String hash = entry.optString("hash", "");
                if (hash.isEmpty()) {
                    return null;
                }
                String server = entry.optString("server", "");
                chunks.add(new Chunk(hash, server.isEmpty() ? fallbackServer : server));
                continue;
            }

            String hash = chunksJson.optString(i, "");
            if (hash.isEmpty()) {
                return null;
            }
            chunks.add(new Chunk(hash, fallbackServer));
        }

        return chunks;
    }

    public static void ensureNotificationChannel(NotificationManager nm) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        // Progress channel: silent + low importance so ongoing updates don't buzz.
        if (nm.getNotificationChannel(DOWNLOAD_CHANNEL_ID) == null) {
            NotificationChannel channel = new NotificationChannel(
                    DOWNLOAD_CHANNEL_ID, "Form* Drive Downloads", NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("File download progress");
            channel.setSound(null, null);
            nm.createNotificationChannel(channel);
        }
        // Terminal channel: default importance so complete/error alerts sound + vibrate.
        if (nm.getNotificationChannel(DOWNLOAD_DONE_CHANNEL_ID) == null) {
            NotificationChannel doneChannel = new NotificationChannel(
                    DOWNLOAD_DONE_CHANNEL_ID, "Form* Drive Download Alerts", NotificationManager.IMPORTANCE_DEFAULT
            );
            doneChannel.setDescription("Download complete and error alerts");
            nm.createNotificationChannel(doneChannel);
        }
    }

    /**
     * Dispatches to the NIP-FS single-blob path when {@code blobHash} is
     * present, otherwise the legacy chunk-per-blob path — mirrors the
     * blobHash-vs-chunks branch in every web download path
     * (src/services/downloadFile.ts / swStreamDownload.ts) and
     * isLegacyBlobFormat (src/types/metadata.ts).
     */
    public static void downloadAndDecryptToStream(
            String server,
            @Nullable String blobHash,
            int chunkSize,
            long size,
            @Nullable List<Chunk> chunks,
            String encryptionKey,
            @Nullable String unencryptedFileHash,
            OutputStream outputStream,
            @Nullable ProgressCallback onProgress,
            @Nullable CancellationSignal signal
    ) throws IOException {
        if (blobHash != null && !blobHash.isEmpty()) {
            downloadAndDecryptSingleBlobToStream(
                    server, blobHash, chunkSize, size, encryptionKey, unencryptedFileHash,
                    outputStream, onProgress, signal);
            return;
        }
        downloadAndDecryptChunkedToStream(
                server, chunks, encryptionKey, unencryptedFileHash, outputStream, onProgress, signal);
    }

    /**
     * NIP-FS single-blob download: streams the one stored blob and re-chunks
     * the raw byte stream into segment-sized frames (chunkSize + 16, except
     * the last — computed from size/chunkSize the same way segmentCount does
     * in src/crypto.ts), decrypting each in order via
     * DriveFilesCrypto.decryptSegment and writing straight to outputStream.
     * Peak memory stays around one segment. Mirrors streamDecryptedSegments
     * in src/services/downloadFile.ts.
     *
     * When {@code unencryptedFileHash} is present it is verified against the
     * plaintext as it streams and a mismatch fails the download, matching the
     * web path's verifyUnencryptedFileHash.
     */
    private static void downloadAndDecryptSingleBlobToStream(
            String server,
            String blobHash,
            int chunkSize,
            long size,
            String encryptionKey,
            @Nullable String unencryptedFileHash,
            OutputStream outputStream,
            @Nullable ProgressCallback onProgress,
            @Nullable CancellationSignal signal
    ) throws IOException {
        if (chunkSize <= 0) {
            throw new IOException("Drive file is missing a valid chunkSize");
        }

        MessageDigest plaintextDigest = null;
        if (unencryptedFileHash != null && !unencryptedFileHash.isEmpty()) {
            try {
                plaintextDigest = MessageDigest.getInstance("SHA-256");
            } catch (NoSuchAlgorithmException error) {
                throw new IOException("SHA-256 is unavailable on this device", error);
            }
        }

        String normalizedServer = server.endsWith("/") ? server.substring(0, server.length() - 1) : server;
        URL url = new URL(normalizedServer + "/" + blobHash);
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setRequestMethod("GET");
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(30000);
        connection.setDoInput(true);

        try {
            connection.connect();

            if (signal != null && signal.isCanceled()) {
                throw new IOException("File open was cancelled");
            }

            int responseCode = connection.getResponseCode();
            if (responseCode < 200 || responseCode >= 300) {
                throw new IOException("Server rejected blob read with HTTP " + responseCode);
            }

            // max(1, ceil(size/chunkSize)) — mirrors segmentCount in
            // src/crypto.ts exactly: size 0 still has one (empty) last segment.
            long totalSegmentsLong = Math.max(1, (size + chunkSize - 1) / chunkSize);
            if (totalSegmentsLong > Integer.MAX_VALUE) {
                throw new IOException("File has too many segments to download: " + totalSegmentsLong);
            }
            int totalSegments = (int) totalSegmentsLong;

            try (InputStream inputStream = connection.getInputStream()) {
                for (int i = 0; i < totalSegments; i++) {
                    if (signal != null && signal.isCanceled()) {
                        throw new IOException("File open was cancelled");
                    }

                    boolean isLast = i == totalSegments - 1;
                    long plainLen = isLast ? size - (long) chunkSize * (totalSegments - 1) : chunkSize;
                    int frameLen = (int) (plainLen + 16);

                    byte[] frame = readExactly(inputStream, frameLen, signal);
                    byte[] decrypted;
                    try {
                        decrypted = DriveFilesCrypto.decryptSegment(frame, encryptionKey, i, isLast);
                    } catch (Exception error) {
                        throw new IOException("Failed to decrypt segment " + i, error);
                    }

                    if (plaintextDigest != null) {
                        plaintextDigest.update(decrypted);
                    }
                    outputStream.write(decrypted);

                    if (onProgress != null) {
                        onProgress.onProgress((int) ((i + 1) * 100L / totalSegments));
                    }
                }
            }

            outputStream.flush();

            if (plaintextDigest != null) {
                String actual = bytesToHex(plaintextDigest.digest());
                if (!actual.equalsIgnoreCase(unencryptedFileHash)) {
                    throw new IOException(
                            "File integrity check failed: expected hash " + unencryptedFileHash + ", got " + actual);
                }
            }
        } finally {
            connection.disconnect();
        }
    }

    /**
     * Reads exactly {@code n} bytes from {@code inputStream}, or throws if
     * the stream ends first — a short read here means a truncated or
     * corrupted blob, which must never be handed to
     * DriveFilesCrypto.decryptSegment as if it were a whole frame. Mirrors
     * createFrameReader's readExactly in src/services/downloadFile.ts.
     */
    private static byte[] readExactly(InputStream inputStream, int n, @Nullable CancellationSignal signal)
            throws IOException {
        byte[] buffer = new byte[n];
        int totalRead = 0;
        while (totalRead < n) {
            if (signal != null && signal.isCanceled()) {
                throw new IOException("File open was cancelled");
            }
            int read = inputStream.read(buffer, totalRead, n - totalRead);
            if (read == -1) {
                throw new IOException(
                        "Downloaded blob ended early: expected " + (n - totalRead) + " more byte(s). " +
                                "The file may be corrupted, or the download was interrupted.");
            }
            totalRead += read;
        }
        return buffer;
    }

    /**
     * Legacy chunk-per-blob download: streams chunk-by-chunk from Blossom,
     * decrypts each piece, and writes it straight to outputStream — nothing
     * is buffered beyond a single chunk. Each chunk is fetched from its own
     * resolved server.
     *
     * When {@code unencryptedFileHash} is present it is verified against the
     * plaintext as it streams and a mismatch fails the download, matching the
     * web path's verifyUnencryptedFileHash (src/services/downloadFile.ts).
     */
    private static void downloadAndDecryptChunkedToStream(
            String server,
            @Nullable List<Chunk> chunks,
            String encryptionKey,
            @Nullable String unencryptedFileHash,
            OutputStream outputStream,
            @Nullable ProgressCallback onProgress,
            @Nullable CancellationSignal signal
    ) throws IOException {
        // Every file the app publishes carries at least one chunk. A chunk-less
        // entry could only come from a client predating chunked uploads, whose
        // blobs this build can no longer decrypt anyway — such files are dropped
        // before they ever reach the manifest (fileIndexStore.emit), so reaching
        // here means the manifest is malformed rather than merely old.
        if (chunks == null || chunks.isEmpty()) {
            throw new IOException("Drive file has no chunks to download");
        }

        MessageDigest plaintextDigest = null;
        if (unencryptedFileHash != null && !unencryptedFileHash.isEmpty()) {
            try {
                plaintextDigest = MessageDigest.getInstance("SHA-256");
            } catch (NoSuchAlgorithmException error) {
                throw new IOException("SHA-256 is unavailable on this device", error);
            }
        }

        int totalChunks = chunks.size();
        for (int i = 0; i < totalChunks; i++) {
            Chunk chunk = chunks.get(i);
            int currentChunk = i;
            ProgressCallback chunkProgress = null;
            if (onProgress != null) {
                chunkProgress = (percent) -> {
                    int overallPercent = (currentChunk * 100 + percent) / totalChunks;
                    onProgress.onProgress(overallPercent);
                };
            }

            byte[] encryptedBlob = downloadEncryptedBlob(chunk.server, chunk.hash, signal, chunkProgress);
            byte[] decryptedBytes;
            try {
                decryptedBytes = DriveFilesCrypto.decryptChunkBlob(encryptedBlob, encryptionKey, i);
            } catch (Exception error) {
                throw new IOException("Failed to decrypt chunk " + i, error);
            }
            if (plaintextDigest != null) {
                plaintextDigest.update(decryptedBytes);
            }
            outputStream.write(decryptedBytes);
        }

        outputStream.flush();

        if (plaintextDigest != null) {
            String actual = bytesToHex(plaintextDigest.digest());
            if (!actual.equalsIgnoreCase(unencryptedFileHash)) {
                throw new IOException(
                        "File integrity check failed: expected hash " + unencryptedFileHash + ", got " + actual);
            }
        }
    }

    private static String bytesToHex(byte[] bytes) {
        StringBuilder builder = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            builder.append(Character.forDigit((b >> 4) & 0xF, 16));
            builder.append(Character.forDigit(b & 0xF, 16));
        }
        return builder.toString();
    }

    public static byte[] downloadEncryptedBlob(
            String server, String hash, @Nullable CancellationSignal signal, @Nullable ProgressCallback onProgress)
            throws IOException {
        String normalizedServer = server.endsWith("/") ? server.substring(0, server.length() - 1) : server;
        URL url = new URL(normalizedServer + "/" + hash);
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setRequestMethod("GET");
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(30000);
        connection.setDoInput(true);

        try {
            connection.connect();

            if (signal != null && signal.isCanceled()) {
                throw new IOException("File open was cancelled");
            }

            int responseCode = connection.getResponseCode();
            if (responseCode < 200 || responseCode >= 300) {
                throw new IOException(
                        "Server rejected public file read with HTTP " + responseCode
                );
            }

            int contentLength = connection.getContentLength();
            byte[] buffer = new byte[65536];
            long totalRead = 0;

            try (InputStream inputStream = connection.getInputStream();
                 ByteArrayOutputStream outputStream = new ByteArrayOutputStream()) {
                int bytesRead;
                while ((bytesRead = inputStream.read(buffer)) != -1) {
                    if (signal != null && signal.isCanceled()) {
                        throw new IOException("File open was cancelled");
                    }
                    outputStream.write(buffer, 0, bytesRead);
                    totalRead += bytesRead;
                    if (onProgress != null && contentLength > 0) {
                        onProgress.onProgress((int) (totalRead * 100 / contentLength));
                    }
                }

                return outputStream.toByteArray();
            }
        } finally {
            connection.disconnect();
        }
    }
}
