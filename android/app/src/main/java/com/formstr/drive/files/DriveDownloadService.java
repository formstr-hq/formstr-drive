package com.formstr.drive.files;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.CancellationSignal;
import android.os.Environment;
import android.os.IBinder;
import android.os.PowerManager;
import android.provider.MediaStore;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

import com.formstr.drive.MainActivity;
import com.formstr.drive.R;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Runs a Drive download + decrypt fully in the background, independent of the
 * JS bridge thread and independent of the app being foregrounded. Owns the
 * MediaStore Downloads entry and a persistent progress/completion notification.
 * Multiple downloads can be active at once, each tracked by its own downloadId.
 */
public class DriveDownloadService extends Service {
    public static final String ACTION_START = "com.formstr.drive.action.START_DOWNLOAD";
    public static final String ACTION_CANCEL = "com.formstr.drive.action.CANCEL_DOWNLOAD";

    public static final String EXTRA_ID = "downloadId";
    public static final String EXTRA_SERVER = "server";
    public static final String EXTRA_HASH = "hash";
    public static final String EXTRA_ENCRYPTION_KEY = "encryptionKey";
    public static final String EXTRA_FILE_NAME = "fileName";
    public static final String EXTRA_MIME_TYPE = "mimeType";
    public static final String EXTRA_CHUNKS_JSON = "chunksJson";
    public static final String EXTRA_UNENCRYPTED_FILE_HASH = "unencryptedFileHash";

    public static final String EVENT_PROGRESS = "progress";
    public static final String EVENT_COMPLETE = "complete";
    public static final String EVENT_ERROR = "error";
    public static final String EVENT_CANCELLED = "cancelled";

    /** In-process event sink — simpler and more immediate than a system broadcast for same-process delivery. */
    public interface EventListener {
        void onDownloadEvent(String type, String id, @Nullable Integer percent, @Nullable String uri, @Nullable String message);
    }

    private static final List<EventListener> LISTENERS = new CopyOnWriteArrayList<>();

    public static void addListener(EventListener listener) {
        LISTENERS.add(listener);
    }

    public static void removeListener(EventListener listener) {
        LISTENERS.remove(listener);
    }

    private static final Map<String, CancellationSignal> ACTIVE_SIGNALS = new ConcurrentHashMap<>();
    private static final long WAKE_LOCK_TIMEOUT_MS = 6 * 60 * 60 * 1000L;

    /** Live progress of in-flight downloads, so the JS layer can rehydrate the in-app UI after a reopen. */
    private static final Map<String, ActiveDownload> ACTIVE_DOWNLOADS = new ConcurrentHashMap<>();

    /** Snapshot of one in-flight download (id + display name + last-reported percent). */
    public static final class ActiveDownload {
        public final String id;
        public final String fileName;
        public volatile int percent;

        ActiveDownload(String id, String fileName) {
            this.id = id;
            this.fileName = fileName;
            this.percent = 0;
        }
    }

    /** Downloads currently active in this process, for JS-side progress rehydration. */
    public static List<ActiveDownload> activeDownloads() {
        return new ArrayList<>(ACTIVE_DOWNLOADS.values());
    }

    private ExecutorService executor;
    private final AtomicInteger activeCount = new AtomicInteger(0);

    @Override
    public void onCreate() {
        super.onCreate();
        executor = Executors.newCachedThreadPool();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    public static void cancel(String downloadId) {
        CancellationSignal signal = ACTIVE_SIGNALS.get(downloadId);
        if (signal != null) {
            signal.cancel();
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            return START_NOT_STICKY;
        }

        if (ACTION_CANCEL.equals(intent.getAction())) {
            String cancelId = intent.getStringExtra(EXTRA_ID);
            if (cancelId != null) {
                cancel(cancelId);
            }
            return START_NOT_STICKY;
        }

        String id = intent.getStringExtra(EXTRA_ID);
        String server = intent.getStringExtra(EXTRA_SERVER);
        String hash = intent.getStringExtra(EXTRA_HASH);
        String encryptionKey = intent.getStringExtra(EXTRA_ENCRYPTION_KEY);
        String fileName = intent.getStringExtra(EXTRA_FILE_NAME);
        String mimeType = intent.getStringExtra(EXTRA_MIME_TYPE);
        String chunksJson = intent.getStringExtra(EXTRA_CHUNKS_JSON);
        String unencryptedFileHash = intent.getStringExtra(EXTRA_UNENCRYPTED_FILE_HASH);

        if (id == null || server == null || hash == null || encryptionKey == null
                || fileName == null || mimeType == null) {
            return START_NOT_STICKY;
        }

        List<DriveFileDownloader.Chunk> chunks = DriveFileDownloader.parseChunks(chunksJson, server);

        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        DriveFileDownloader.ensureNotificationChannel(nm);
        int notifId = notificationIdFor(id);

        startForeground(notifId, buildProgressNotification(id, fileName, 0, notifId));

        CancellationSignal signal = new CancellationSignal();
        ACTIVE_SIGNALS.put(id, signal);
        ACTIVE_DOWNLOADS.put(id, new ActiveDownload(id, fileName));
        activeCount.incrementAndGet();

        executor.execute(() ->
                runDownload(id, server, chunks, hash, encryptionKey, unencryptedFileHash,
                        fileName, mimeType, notifId, signal));

        return START_NOT_STICKY;
    }

    private void runDownload(
            String id,
            String server,
            @Nullable List<DriveFileDownloader.Chunk> chunks,
            String hash,
            String encryptionKey,
            @Nullable String unencryptedFileHash,
            String fileName,
            String mimeType,
            int notifId,
            CancellationSignal signal
    ) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        Uri fileUri = null;
        ContentValues pendingValues = null;
        // Pre-Q writes go straight to a real file rather than a pending
        // MediaStore entry, so a failure (including an integrity mismatch)
        // has to remove it explicitly — cleanupPending only covers MediaStore.
        File legacyOutFile = null;

        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        PowerManager.WakeLock wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "formstr:download:" + id);
        wakeLock.acquire(WAKE_LOCK_TIMEOUT_MS);

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, fileName);
                values.put(MediaStore.Downloads.MIME_TYPE, mimeType);
                values.put(MediaStore.Downloads.IS_PENDING, 1);

                Uri collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
                fileUri = getContentResolver().insert(collection, values);
                pendingValues = values;

                if (fileUri == null) {
                    throw new java.io.IOException("Failed to create file in Downloads");
                }

                try (OutputStream outputStream = getContentResolver().openOutputStream(fileUri)) {
                    if (outputStream == null) {
                        throw new java.io.IOException("Failed to open output stream");
                    }
                    DriveFileDownloader.downloadAndDecryptToStream(
                            server, chunks, hash, encryptionKey, unencryptedFileHash, outputStream,
                            (percent) -> onProgress(id, fileName, percent, notifId, nm), signal);
                }

                ContentValues finalize = new ContentValues();
                finalize.put(MediaStore.Downloads.IS_PENDING, 0);
                getContentResolver().update(fileUri, finalize, null, null);
            } else {
                File downloadsDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                if (!downloadsDir.exists()) {
                    downloadsDir.mkdirs();
                }

                File outFile = new File(downloadsDir, fileName);
                int counter = 1;
                while (outFile.exists()) {
                    int dotIndex = fileName.lastIndexOf('.');
                    String baseName = dotIndex > 0 ? fileName.substring(0, dotIndex) : fileName;
                    String ext = dotIndex > 0 ? fileName.substring(dotIndex) : "";
                    outFile = new File(downloadsDir, baseName + "(" + counter + ")" + ext);
                    counter++;
                }

                legacyOutFile = outFile;
                try (FileOutputStream outputStream = new FileOutputStream(outFile)) {
                    DriveFileDownloader.downloadAndDecryptToStream(
                            server, chunks, hash, encryptionKey, unencryptedFileHash, outputStream,
                            (percent) -> onProgress(id, fileName, percent, notifId, nm), signal);
                }

                fileUri = Uri.fromFile(outFile);
            }

            onComplete(id, fileName, mimeType, fileUri, notifId, nm);
        } catch (Exception error) {
            cleanupPending(fileUri, pendingValues != null);
            cleanupLegacyFile(legacyOutFile);
            if (signal.isCanceled()) {
                onCancelled(id, notifId, nm);
            } else {
                onError(id, fileName, error, notifId, nm);
            }
        } finally {
            if (wakeLock.isHeld()) {
                wakeLock.release();
            }
            ACTIVE_SIGNALS.remove(id);
            ACTIVE_DOWNLOADS.remove(id);
            // The progress notification (notifId) is done being shown — any
            // terminal result (complete/error) was already posted under its
            // own, separate id in onComplete/onError, so cancelling this one
            // doesn't touch it.
            nm.cancel(notifId);
            if (activeCount.decrementAndGet() <= 0) {
                ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
                stopSelf();
            }
        }
    }

    private void cleanupPending(@Nullable Uri fileUri, boolean wasMediaStoreEntry) {
        if (fileUri == null || !wasMediaStoreEntry) {
            return;
        }
        try {
            getContentResolver().delete(fileUri, null, null);
        } catch (Exception ignored) {
            // best-effort cleanup of a partial/cancelled download entry
        }
    }

    private void cleanupLegacyFile(@Nullable File outFile) {
        if (outFile == null) {
            return;
        }
        try {
            outFile.delete();
        } catch (Exception ignored) {
            // best-effort cleanup of a partial/cancelled download file
        }
    }

    private void onProgress(String id, String fileName, int percent, int notifId, NotificationManager nm) {
        ActiveDownload active = ACTIVE_DOWNLOADS.get(id);
        if (active != null) {
            active.percent = percent;
        }
        broadcastEvent(EVENT_PROGRESS, id, percent, null, null);
        nm.notify(notifId, buildProgressNotification(id, fileName, percent, notifId));
    }

    private void onComplete(String id, String fileName, String mimeType, Uri fileUri, int notifId, NotificationManager nm) {
        broadcastEvent(EVENT_COMPLETE, id, 100, fileUri != null ? fileUri.toString() : null, null);
        // Posted under a different id than the ongoing progress notification —
        // if it shared the id, cancelling/detaching the progress notification
        // when the service stops would take this one down with it.
        nm.notify(terminalNotificationIdFor(id), buildCompleteNotification(fileName, mimeType, fileUri));
    }

    private void onError(String id, String fileName, Exception error, int notifId, NotificationManager nm) {
        String message = error.getMessage() != null ? error.getMessage() : "Download failed";
        broadcastEvent(EVENT_ERROR, id, null, null, message);
        nm.notify(terminalNotificationIdFor(id), buildErrorNotification(fileName, message));
    }

    private void onCancelled(String id, int notifId, NotificationManager nm) {
        broadcastEvent(EVENT_CANCELLED, id, null, null, null);
        nm.cancel(notifId);
    }

    private void broadcastEvent(String type, String id, @Nullable Integer percent, @Nullable String uri, @Nullable String message) {
        for (EventListener listener : LISTENERS) {
            listener.onDownloadEvent(type, id, percent, uri, message);
        }
    }

    /** Tapping the notification body (not the Cancel action) brings the app to
     *  the foreground. MainActivity is singleTask, so this reuses the existing
     *  task instead of spawning a duplicate. */
    private PendingIntent openAppPendingIntent(int requestCode) {
        Intent intent = new Intent(this, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(
                this, requestCode, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private Notification buildProgressNotification(String id, String fileName, int percent, int notifId) {
        Intent cancelIntent = new Intent(this, DriveDownloadService.class);
        cancelIntent.setAction(ACTION_CANCEL);
        cancelIntent.putExtra(EXTRA_ID, id);
        PendingIntent cancelPendingIntent = PendingIntent.getService(
                this, notifId, cancelIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        return new NotificationCompat.Builder(this, DriveFileDownloader.DOWNLOAD_CHANNEL_ID)
                .setContentTitle("Downloading " + fileName)
                .setContentText(percent + "%")
                .setSmallIcon(R.drawable.ic_notification)                .setProgress(100, percent, false)
                .setOngoing(true)
                .setSilent(true)
                .setContentIntent(openAppPendingIntent(notifId))
                .addAction(0, "Cancel", cancelPendingIntent)
                .build();
    }

    private Notification buildCompleteNotification(String fileName, String mimeType, @Nullable Uri fileUri) {
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, DriveFileDownloader.DOWNLOAD_DONE_CHANNEL_ID)
                .setContentTitle("Download complete")
                .setContentText(fileName)
                .setSmallIcon(R.drawable.ic_notification)                .setAutoCancel(true)
                .setOngoing(false);

        if (fileUri != null) {
            // Prefer opening the file directly — that's what tapping a
            // completed download normally does.
            Intent viewIntent = new Intent(Intent.ACTION_VIEW);
            viewIntent.setDataAndType(fileUri, mimeType);
            viewIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            viewIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            PendingIntent contentIntent = PendingIntent.getActivity(
                    this, fileUri.hashCode(), viewIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            builder.setContentIntent(contentIntent);
        } else {
            // No URI to open (shouldn't normally happen) — fall back to just
            // opening the app rather than leaving the tap do nothing.
            builder.setContentIntent(openAppPendingIntent(fileName.hashCode() & 0x7fffffff));
        }

        return builder.build();
    }

    private Notification buildErrorNotification(String fileName, String message) {
        return new NotificationCompat.Builder(this, DriveFileDownloader.DOWNLOAD_DONE_CHANNEL_ID)
                .setContentTitle("Download failed")
                .setContentText(fileName + ": " + message)
                .setSmallIcon(R.drawable.ic_notification)                .setAutoCancel(true)
                .setOngoing(false)
                .setContentIntent(openAppPendingIntent(fileName.hashCode() & 0x7fffffff))
                .build();
    }

    private static int notificationIdFor(String downloadId) {
        return downloadId.hashCode() & 0x7fffffff;
    }

    private static int terminalNotificationIdFor(String downloadId) {
        return (downloadId + ":result").hashCode() & 0x7fffffff;
    }
}
