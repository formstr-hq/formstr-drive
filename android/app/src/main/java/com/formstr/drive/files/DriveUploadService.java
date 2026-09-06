package com.formstr.drive.files;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

import com.formstr.drive.MainActivity;
import com.formstr.drive.R;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Owns the network phase of an upload (chunk/preview PUTs + relay publish),
 * plus a persistent foreground notification that starts the instant an upload
 * begins — while the JS layer is still encrypting and staging chunks — so the
 * user sees progress and the process keeps foreground priority throughout.
 *
 * Two phases per upload, keyed by uploadId (mirrors DriveDownloadService):
 *  - PREPARING: JS is encrypting + staging chunks in the WebView. The service
 *    only holds a "Preparing…" notification. This phase CANNOT survive the app
 *    being swiped away (JS/crypto dies with the WebView) — onTaskRemoved turns
 *    it into an "interrupted" notification instead of a stuck one.
 *  - UPLOADING: everything is staged + both Nostr events are pre-signed, so
 *    DriveUploadWorker runs pure network I/O with no signer/crypto. This phase
 *    survives the app closing (stopWithTask=false + wake lock).
 */
public class DriveUploadService extends Service {
    public static final String UPLOAD_CHANNEL_ID = "formstr_drive_uploads";
    /** Separate channel for terminal (complete/error/interrupted) alerts so they can sound/vibrate. */
    public static final String UPLOAD_DONE_CHANNEL_ID = "formstr_drive_uploads_done";

    public static final String ACTION_PREPARE = "com.formstr.drive.action.PREPARE_UPLOAD";
    public static final String ACTION_START = "com.formstr.drive.action.START_UPLOAD";
    public static final String ACTION_CANCEL = "com.formstr.drive.action.CANCEL_UPLOAD";

    public static final String EXTRA_ID = "uploadId";
    public static final String EXTRA_SERVERS_JSON = "serversJson";
    public static final String EXTRA_FILE_NAME = "fileName";
    public static final String EXTRA_AUTH_HEADER = "authHeader";
    public static final String EXTRA_METADATA_EVENTS_JSON = "metadataEventsJson";
    public static final String EXTRA_RELAYS_JSON = "relaysJson";
    public static final String EXTRA_BLOBS_JSON = "blobsJson";

    public static final String EVENT_PROGRESS = "progress";
    public static final String EVENT_COMPLETE = "complete";
    public static final String EVENT_ERROR = "error";
    public static final String EVENT_CANCELLED = "cancelled";

    /**
     * Must match PREPARE_PROGRESS_SHARE in src/transfers/nativeUploadDriver.ts.
     * The in-app transfer bar shows one combined 0-100 number spanning both the
     * JS prepare phase (encrypt + stage, 0-40) and this service's network phase
     * (40-100) — nativeUploadDriver.ts rescales the raw 0-100 network percent
     * this service reports into that range before showing it. The notification
     * previously showed the raw, un-rescaled percent instead, so it disagreed
     * with the in-app bar for the entire upload (e.g. tray "50%" while the app
     * showed "70%"). toOverallPercent() applies the same rescale here so both
     * surfaces show the same number at every point in the upload.
     */
    private static final int PREPARE_PROGRESS_SHARE = 40;

    private static int toOverallPercent(int rawNetworkPercent) {
        return PREPARE_PROGRESS_SHARE
                + Math.round(rawNetworkPercent / 100f * (100 - PREPARE_PROGRESS_SHARE));
    }

    /** In-process event sink — mirrors DriveDownloadService.EventListener. */
    public interface EventListener {
        void onUploadEvent(
                String type,
                String id,
                @Nullable Integer percent,
                @Nullable String message,
                @Nullable String server,
                @Nullable Integer status);
    }

    private static final List<EventListener> LISTENERS = new CopyOnWriteArrayList<>();

    public static void addListener(EventListener listener) {
        LISTENERS.add(listener);
    }

    public static void removeListener(EventListener listener) {
        LISTENERS.remove(listener);
    }

    private enum Phase { PREPARING, UPLOADING }

    private static final class UploadState {
        final String fileName;
        final int notifId;
        volatile Phase phase;
        volatile int percent;
        final AtomicBoolean cancelled = new AtomicBoolean(false);

        UploadState(String fileName, int notifId, Phase phase) {
            this.fileName = fileName;
            this.notifId = notifId;
            this.phase = phase;
            this.percent = 0;
        }
    }

    /** Snapshot of one tracked upload, for JS-side progress rehydration. */
    public static final class ActiveUpload {
        public final String id;
        public final String fileName;
        public final int percent;
        /** True while JS is still encrypting/staging (see Phase.PREPARING). */
        public final boolean preparing;

        ActiveUpload(String id, String fileName, int percent, boolean preparing) {
            this.id = id;
            this.fileName = fileName;
            this.percent = percent;
            this.preparing = preparing;
        }
    }

    private static final Map<String, UploadState> UPLOADS = new ConcurrentHashMap<>();
    private static final long WAKE_LOCK_TIMEOUT_MS = 6 * 60 * 60 * 1000L;

    private ExecutorService executor;
    @Nullable
    private PowerManager.WakeLock wakeLock;

    @Override
    public void onCreate() {
        super.onCreate();
        executor = Executors.newCachedThreadPool();
    }

    @Override
    public void onDestroy() {
        releaseWakeLock();
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    /** Cancels an upload in either phase; safe to call for an unknown id. */
    public static void cancel(String uploadId) {
        UploadState state = UPLOADS.get(uploadId);
        if (state != null) {
            state.cancelled.set(true);
        }
    }

    /** Upload ids currently active in this process, so the plugin never sweeps their staged files. */
    public static java.util.Set<String> activeIds() {
        return new java.util.HashSet<>(UPLOADS.keySet());
    }

    /** Uploads currently tracked in this process, for JS-side rehydration. */
    public static List<ActiveUpload> activeUploads() {
        List<ActiveUpload> snapshot = new ArrayList<>(UPLOADS.size());
        for (Map.Entry<String, UploadState> entry : UPLOADS.entrySet()) {
            UploadState state = entry.getValue();
            snapshot.add(new ActiveUpload(
                    entry.getKey(), state.fileName, state.percent, state.phase == Phase.PREPARING));
        }
        return snapshot;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            return START_NOT_STICKY;
        }

        String action = intent.getAction();
        if (ACTION_CANCEL.equals(action)) {
            handleCancel(intent.getStringExtra(EXTRA_ID));
            return START_NOT_STICKY;
        }
        if (ACTION_PREPARE.equals(action)) {
            handlePrepare(intent);
            return START_NOT_STICKY;
        }
        // Default / ACTION_START: begin the network phase.
        handleStart(intent);
        return START_NOT_STICKY;
    }

    private void handlePrepare(Intent intent) {
        String id = intent.getStringExtra(EXTRA_ID);
        String fileName = intent.getStringExtra(EXTRA_FILE_NAME);
        if (id == null) {
            return;
        }
        String name = fileName != null ? fileName : "file";

        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        ensureNotificationChannel(nm);
        int notifId = notificationIdFor(id);

        UPLOADS.put(id, new UploadState(name, notifId, Phase.PREPARING));
        acquireWakeLock();
        startForeground(notifId, buildPreparingNotification(id, name, notifId));
    }

    private void handleStart(Intent intent) {
        String id = intent.getStringExtra(EXTRA_ID);
        String serversJson = intent.getStringExtra(EXTRA_SERVERS_JSON);
        String fileName = intent.getStringExtra(EXTRA_FILE_NAME);
        String authHeader = intent.getStringExtra(EXTRA_AUTH_HEADER);
        String metadataEventsJson = intent.getStringExtra(EXTRA_METADATA_EVENTS_JSON);
        String relaysJson = intent.getStringExtra(EXTRA_RELAYS_JSON);
        String blobsJson = intent.getStringExtra(EXTRA_BLOBS_JSON);

        if (id == null || serversJson == null || fileName == null || authHeader == null
                || metadataEventsJson == null || relaysJson == null || blobsJson == null) {
            finishIfIdle();
            return;
        }

        List<String> servers = parseStringArray(serversJson);
        List<String> relays = parseStringArray(relaysJson);
        List<DriveUploadWorker.Blob> blobs = parseBlobs(blobsJson);
        Map<String, String> metadataEvents = parseMetadataEvents(metadataEventsJson);
        if (servers == null || servers.isEmpty() || relays == null || blobs == null
                || blobs.isEmpty() || metadataEvents == null || metadataEvents.isEmpty()) {
            finishIfIdle();
            return;
        }

        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        ensureNotificationChannel(nm);
        int notifId = notificationIdFor(id);

        // Reuse the state from the PREPARE phase if present (keeps the same
        // cancel flag, so a cancel requested mid-staging still applies), else
        // create one for a start without a prepare (small/legacy callers).
        UploadState state = UPLOADS.get(id);
        if (state == null) {
            state = new UploadState(fileName, notifId, Phase.UPLOADING);
            UPLOADS.put(id, state);
        } else {
            state.phase = Phase.UPLOADING;
        }
        acquireWakeLock();
        startForeground(notifId, buildProgressNotification(id, fileName, toOverallPercent(0), notifId));

        // If a cancel arrived during staging, honor it before any network I/O.
        if (state.cancelled.get()) {
            onCancelled(id, notifId, nm);
            UPLOADS.remove(id);
            deleteStagedDir(id);
            finishIfIdle();
            return;
        }

        final UploadState activeState = state;
        executor.execute(() ->
                runUpload(id, servers, fileName, authHeader, metadataEvents, relays, blobs, notifId, activeState));
    }

    private void handleCancel(@Nullable String id) {
        if (id == null) {
            return;
        }
        UploadState state = UPLOADS.get(id);
        if (state == null) {
            return;
        }
        state.cancelled.set(true);

        // In UPLOADING the worker polls the flag and cleans up itself. In
        // PREPARING there's no worker running, so tear down here.
        if (state.phase == Phase.PREPARING) {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            onCancelled(id, state.notifId, nm);
            UPLOADS.remove(id);
            deleteStagedDir(id);
            finishIfIdle();
        }
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // The app was swiped away. UPLOADING uploads are self-sufficient (no
        // WebView/signer needed) and keep running. PREPARING uploads depend on
        // the now-dead WebView to finish encrypting/staging, so they can't
        // continue — surface that honestly instead of leaving a stuck bar.
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        for (Map.Entry<String, UploadState> entry : UPLOADS.entrySet()) {
            UploadState state = entry.getValue();
            if (state.phase == Phase.PREPARING) {
                String id = entry.getKey();
                nm.cancel(state.notifId);
                nm.notify(terminalNotificationIdFor(id), buildInterruptedNotification(state.fileName));
                broadcastEvent(EVENT_ERROR, id, null, "Upload interrupted — reopen the app to retry", null, null);
                UPLOADS.remove(id);
                deleteStagedDir(id);
            }
        }
        finishIfIdle();
        super.onTaskRemoved(rootIntent);
    }

    private void runUpload(
            String id,
            List<String> servers,
            String fileName,
            String authHeader,
            Map<String, String> metadataEvents,
            List<String> relays,
            List<DriveUploadWorker.Blob> blobs,
            int notifId,
            UploadState state
    ) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);

        DriveUploadWorker worker = new DriveUploadWorker(
                servers, blobs, authHeader, metadataEvents, relays, state.cancelled,
                new DriveUploadWorker.Listener() {
                    @Override
                    public void onProgress(int percent) {
                        state.percent = percent;
                        DriveUploadService.this.onProgress(id, fileName, percent, notifId, nm);
                    }

                    @Override
                    public void onComplete(String server) {
                        DriveUploadService.this.onComplete(id, fileName, server, notifId, nm);
                    }

                    @Override
                    public void onError(String message, @Nullable String server, @Nullable Integer status) {
                        DriveUploadService.this.onError(id, fileName, message, server, status, notifId, nm);
                    }

                    @Override
                    public void onCancelled() {
                        DriveUploadService.this.onCancelled(id, notifId, nm);
                    }
                }
        );

        try {
            worker.run();
        } finally {
            UPLOADS.remove(id);
            // The progress notification (notifId) is done — any terminal result
            // (complete/error) was posted under its own separate id, so
            // cancelling this one never touches it.
            nm.cancel(notifId);
            finishIfIdle();
        }
    }

    /** Stops the foreground service (and releases the wake lock) once nothing is left to do. */
    private synchronized void finishIfIdle() {
        if (UPLOADS.isEmpty()) {
            releaseWakeLock();
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
            stopSelf();
        }
    }

    private synchronized void acquireWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) {
            return;
        }
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "formstr:upload");
        wakeLock.acquire(WAKE_LOCK_TIMEOUT_MS);
    }

    private synchronized void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }
        wakeLock = null;
    }

    private void onProgress(String id, String fileName, int percent, int notifId, NotificationManager nm) {
        // Broadcast stays the raw network percent — nativeUploadDriver.ts does
        // its own rescale into the combined 0-100 bar for live session uploads.
        // Only the notification's own display is rescaled here (see
        // toOverallPercent's comment above).
        broadcastEvent(EVENT_PROGRESS, id, percent, null, null, null);
        nm.notify(notifId, buildProgressNotification(id, fileName, toOverallPercent(percent), notifId));
    }

    private void onComplete(String id, String fileName, String server, int notifId, NotificationManager nm) {
        broadcastEvent(EVENT_COMPLETE, id, 100, null, server, null);
        nm.notify(terminalNotificationIdFor(id), buildCompleteNotification(fileName));
    }

    private void onError(
            String id,
            String fileName,
            String message,
            @Nullable String server,
            @Nullable Integer status,
            int notifId,
            NotificationManager nm
    ) {
        broadcastEvent(EVENT_ERROR, id, null, message, server, status);
        nm.notify(terminalNotificationIdFor(id), buildErrorNotification(fileName, message));
    }

    private void onCancelled(String id, int notifId, NotificationManager nm) {
        broadcastEvent(EVENT_CANCELLED, id, null, null, null, null);
        nm.cancel(notifId);
    }

    private void broadcastEvent(
            String type,
            String id,
            @Nullable Integer percent,
            @Nullable String message,
            @Nullable String server,
            @Nullable Integer status
    ) {
        for (EventListener listener : LISTENERS) {
            listener.onUploadEvent(type, id, percent, message, server, status);
        }
    }

    private void deleteStagedDir(String uploadId) {
        try {
            File dir = new File(new File(getFilesDir(), "uploads"), uploadId);
            File[] children = dir.listFiles();
            if (children != null) {
                for (File child : children) {
                    child.delete();
                }
            }
            dir.delete();
        } catch (Exception ignored) {
            // best-effort — the plugin's startup sweep also cleans orphans
        }
    }

    private PendingIntent cancelPendingIntent(String id, int notifId) {
        Intent cancelIntent = new Intent(this, DriveUploadService.class);
        cancelIntent.setAction(ACTION_CANCEL);
        cancelIntent.putExtra(EXTRA_ID, id);
        return PendingIntent.getService(
                this, notifId, cancelIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** Tapping the notification body (not the Cancel action) brings the app to
     *  the foreground. MainActivity is singleTask, so this reuses the existing
     *  task instead of spawning a duplicate. */
    private PendingIntent openAppPendingIntent(int notifId) {
        Intent intent = new Intent(this, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(
                this, notifId, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private Notification buildPreparingNotification(String id, String fileName, int notifId) {
        return new NotificationCompat.Builder(this, UPLOAD_CHANNEL_ID)
                .setContentTitle("Preparing " + fileName + "…")
                .setSmallIcon(R.drawable.ic_notification)                .setProgress(0, 0, true)
                .setOngoing(true)
                .setSilent(true)
                .setContentIntent(openAppPendingIntent(notifId))
                .addAction(0, "Cancel", cancelPendingIntent(id, notifId))
                .build();
    }

    private Notification buildProgressNotification(String id, String fileName, int percent, int notifId) {
        return new NotificationCompat.Builder(this, UPLOAD_CHANNEL_ID)
                .setContentTitle("Uploading " + fileName)
                .setContentText(percent + "%")
                .setSmallIcon(R.drawable.ic_notification)                .setProgress(100, percent, false)
                .setOngoing(true)
                .setSilent(true)
                .setContentIntent(openAppPendingIntent(notifId))
                .addAction(0, "Cancel", cancelPendingIntent(id, notifId))
                .build();
    }

    private Notification buildCompleteNotification(String fileName) {
        return new NotificationCompat.Builder(this, UPLOAD_DONE_CHANNEL_ID)
                .setContentTitle("Upload complete")
                .setContentText(fileName)
                .setSmallIcon(R.drawable.ic_notification)                .setAutoCancel(true)
                .setOngoing(false)
                .setContentIntent(openAppPendingIntent(fileName.hashCode() & 0x7fffffff))
                .build();
    }

    private Notification buildErrorNotification(String fileName, String message) {
        return new NotificationCompat.Builder(this, UPLOAD_DONE_CHANNEL_ID)
                .setContentTitle("Upload failed")
                .setContentText(fileName + ": " + message)
                .setSmallIcon(R.drawable.ic_notification)                .setAutoCancel(true)
                .setOngoing(false)
                .setContentIntent(openAppPendingIntent(fileName.hashCode() & 0x7fffffff))
                .build();
    }

    private Notification buildInterruptedNotification(String fileName) {
        return new NotificationCompat.Builder(this, UPLOAD_DONE_CHANNEL_ID)
                .setContentTitle("Upload interrupted")
                .setContentText(fileName + " didn't finish — reopen the app to retry")
                .setSmallIcon(R.drawable.ic_notification)                .setAutoCancel(true)
                .setOngoing(false)
                .setContentIntent(openAppPendingIntent(fileName.hashCode() & 0x7fffffff))
                .build();
    }

    public static void ensureNotificationChannel(NotificationManager nm) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        // Progress channel: silent + low importance so ongoing updates don't buzz.
        if (nm.getNotificationChannel(UPLOAD_CHANNEL_ID) == null) {
            NotificationChannel channel = new NotificationChannel(
                    UPLOAD_CHANNEL_ID, "Formstr Drive Uploads", NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("File upload progress");
            channel.setSound(null, null);
            nm.createNotificationChannel(channel);
        }
        // Terminal channel: default importance so complete/error alerts sound + vibrate.
        if (nm.getNotificationChannel(UPLOAD_DONE_CHANNEL_ID) == null) {
            NotificationChannel doneChannel = new NotificationChannel(
                    UPLOAD_DONE_CHANNEL_ID, "Formstr Drive Upload Alerts", NotificationManager.IMPORTANCE_DEFAULT
            );
            doneChannel.setDescription("Upload complete and error alerts");
            nm.createNotificationChannel(doneChannel);
        }
    }

    private static int notificationIdFor(String uploadId) {
        return uploadId.hashCode() & 0x7fffffff;
    }

    private static int terminalNotificationIdFor(String uploadId) {
        return (uploadId + ":result").hashCode() & 0x7fffffff;
    }

    @Nullable
    private static List<String> parseStringArray(String json) {
        try {
            JSONArray array = new JSONArray(json);
            List<String> values = new ArrayList<>();
            for (int i = 0; i < array.length(); i++) {
                values.add(array.getString(i));
            }
            return values;
        } catch (JSONException error) {
            return null;
        }
    }

    /**
     * Reads the pre-signed metadata variants into a server -> event-JSON map.
     * One event per candidate server, each naming that server in its encrypted
     * payload; the worker publishes whichever matches where the blobs landed.
     */
    @Nullable
    private static Map<String, String> parseMetadataEvents(String json) {
        try {
            JSONArray array = new JSONArray(json);
            Map<String, String> events = new java.util.HashMap<>();
            for (int i = 0; i < array.length(); i++) {
                JSONObject item = array.getJSONObject(i);
                events.put(item.getString("server"), item.getString("eventJson"));
            }
            return events;
        } catch (JSONException error) {
            return null;
        }
    }

    @Nullable
    private static List<DriveUploadWorker.Blob> parseBlobs(String json) {
        try {
            JSONArray array = new JSONArray(json);
            List<DriveUploadWorker.Blob> blobs = new ArrayList<>();
            for (int i = 0; i < array.length(); i++) {
                JSONObject item = array.getJSONObject(i);
                blobs.add(new DriveUploadWorker.Blob(
                        item.getString("path"),
                        item.getString("hash"),
                        item.optString("contentType", "application/octet-stream"),
                        item.optBoolean("optional", false)
                ));
            }
            return blobs;
        } catch (JSONException error) {
            return null;
        }
    }
}
