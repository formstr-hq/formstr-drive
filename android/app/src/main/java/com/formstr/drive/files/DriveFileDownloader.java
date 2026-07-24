package com.formstr.drive.files;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.os.Build;
import android.os.CancellationSignal;

import androidx.annotation.Nullable;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
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

    private DriveFileDownloader() {
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
     * Streams chunk-by-chunk (or a single legacy blob) from the Blossom server,
     * decrypts each piece, and writes it straight to outputStream — nothing is
     * buffered beyond a single chunk.
     */
    public static void downloadAndDecryptToStream(
            String server,
            @Nullable List<String> chunks,
            String hash,
            String encryptionKey,
            String protocol,
            OutputStream outputStream,
            @Nullable ProgressCallback onProgress,
            @Nullable CancellationSignal signal
    ) throws IOException {
        if (chunks != null && !chunks.isEmpty()) {
            int totalChunks = chunks.size();
            for (int i = 0; i < totalChunks; i++) {
                String chunkHash = chunks.get(i);
                int currentChunk = i;
                ProgressCallback chunkProgress = null;
                if (onProgress != null) {
                    chunkProgress = (percent) -> {
                        int overallPercent = (currentChunk * 100 + percent) / totalChunks;
                        onProgress.onProgress(overallPercent);
                    };
                }

                byte[] encryptedBlob = downloadEncryptedBlob(server, chunkHash, signal, chunkProgress);
                byte[] decryptedBytes;
                try {
                    decryptedBytes = "nip-fs".equals(protocol)
                            ? DriveFilesCrypto.decryptEncryptedBlob(encryptedBlob, encryptionKey)
                            : DriveFilesCrypto.decryptChunkBlob(encryptedBlob, encryptionKey, i);
                } catch (Exception error) {
                    throw new IOException("Failed to decrypt chunk " + i, error);
                }
                outputStream.write(decryptedBytes);
            }
        } else {
            byte[] encryptedBlob = downloadEncryptedBlob(server, hash, signal, onProgress);
            byte[] decryptedBytes;
            try {
                decryptedBytes = DriveFilesCrypto.decryptEncryptedBlob(encryptedBlob, encryptionKey);
            } catch (Exception error) {
                throw new IOException("Failed to decrypt Drive file", error);
            }
            outputStream.write(decryptedBytes);
        }

        outputStream.flush();
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
