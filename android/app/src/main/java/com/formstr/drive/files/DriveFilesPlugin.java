package com.formstr.drive.files;

import android.Manifest;
import android.app.NotificationManager;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;

import com.formstr.drive.R;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

@CapacitorPlugin(
        name = "DriveFiles",
        permissions = {
                @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications")
        }
)
public class DriveFilesPlugin extends Plugin implements DriveDownloadService.EventListener, DriveUploadService.EventListener {

    private final Map<String, PluginCall> pendingDownloadCalls = new ConcurrentHashMap<>();
    private final Map<String, PluginCall> pendingUploadCalls = new ConcurrentHashMap<>();

    @Override
    protected void handleOnStart() {
        super.handleOnStart();
        DriveDownloadService.addListener(this);
        DriveUploadService.addListener(this);
        sweepOrphanedUploadDirs();
    }

    @Override
    protected void handleOnDestroy() {
        DriveDownloadService.removeListener(this);
        DriveUploadService.removeListener(this);
        super.handleOnDestroy();
    }

    /** Deletes staged-chunk directories left behind by a crash/kill, but never ones an active worker is using. */
    private void sweepOrphanedUploadDirs() {
        try {
            File uploadsRoot = new File(getContext().getFilesDir(), "uploads");
            File[] dirs = uploadsRoot.listFiles();
            if (dirs == null) return;

            Set<String> activeIds = DriveUploadService.activeIds();
            for (File dir : dirs) {
                if (dir.isDirectory() && !activeIds.contains(dir.getName())) {
                    deleteRecursive(dir);
                }
            }
        } catch (Exception ignored) {
            // best-effort crash cleanup
        }
    }

    private static void deleteRecursive(File file) {
        File[] children = file.listFiles();
        if (children != null) {
            for (File child : children) {
                deleteRecursive(child);
            }
        }
        file.delete();
    }

    @Override
    public void onUploadEvent(
            String type,
            String id,
            @Nullable Integer percent,
            @Nullable String message,
            @Nullable String server,
            @Nullable Integer status
    ) {
        JSObject data = new JSObject();
        data.put("id", id);
        data.put("type", type);
        if (percent != null) data.put("percent", percent);
        if (message != null) data.put("message", message);
        if (server != null) data.put("server", server);
        if (status != null) data.put("status", status);
        notifyListeners("uploadEvent", data);

        PluginCall call = pendingUploadCalls.get(id);
        if (call == null) {
            return;
        }

        if (DriveUploadService.EVENT_COMPLETE.equals(type)) {
            pendingUploadCalls.remove(id);
            // The resolved server tells JS which pre-signed metadata variant was
            // published, so the file index records the right one.
            JSObject response = new JSObject();
            response.put("server", server);
            call.resolve(response);
        } else if (DriveUploadService.EVENT_ERROR.equals(type)) {
            pendingUploadCalls.remove(id);
            // The `code` carries the raw HTTP status (as a string) when this was
            // an actual server rejection, so nativeUploadDriver.ts can run it
            // through the same classifyUploadFailure() the web driver uses
            // instead of guessing from message text. No status (network-level
            // failure, relay-publish failure, exhausted candidates) leaves code
            // null, same as today.
            call.reject(message != null ? message : "Upload failed", status != null ? String.valueOf(status) : null);
        } else if (DriveUploadService.EVENT_CANCELLED.equals(type)) {
            pendingUploadCalls.remove(id);
            call.reject("Upload cancelled", "ABORT_ERR");
        }
    }

    @Override
    public void onDownloadEvent(String type, String id, @Nullable Integer percent, @Nullable String uri, @Nullable String message) {
        JSObject data = new JSObject();
        data.put("id", id);
        data.put("type", type);
        if (percent != null) data.put("percent", percent);
        if (uri != null) data.put("uri", uri);
        if (message != null) data.put("message", message);
        notifyListeners("downloadEvent", data);

        PluginCall call = pendingDownloadCalls.get(id);
        if (call == null) {
            return;
        }

        if (DriveDownloadService.EVENT_COMPLETE.equals(type)) {
            pendingDownloadCalls.remove(id);
            JSObject response = new JSObject();
            response.put("uri", uri);
            call.resolve(response);
        } else if (DriveDownloadService.EVENT_ERROR.equals(type)) {
            pendingDownloadCalls.remove(id);
            call.reject(message != null ? message : "Download failed");
        } else if (DriveDownloadService.EVENT_CANCELLED.equals(type)) {
            pendingDownloadCalls.remove(id);
            call.reject("Download cancelled", "ABORT_ERR");
        }
    }

    @PluginMethod
    public void updateManifest(PluginCall call) {
        String manifestJson = call.getString("manifestJson");
        if (manifestJson == null || manifestJson.trim().isEmpty()) {
            call.reject("manifestJson is required");
            return;
        }

        try {
            DriveManifestStore.writeManifest(getContext(), manifestJson);
            call.resolve();
        } catch (Exception error) {
            call.reject("Failed to update native drive manifest", error);
        }
    }

    @PluginMethod
    public void clearManifest(PluginCall call) {
        try {
            DriveManifestStore.clearManifest(getContext());
            call.resolve();
        } catch (Exception error) {
            call.reject("Failed to clear native drive manifest", error);
        }
    }

    @PluginMethod
    public void listPendingImports(PluginCall call) {
        try {
            JSArray imports = new JSArray();
            for (DriveManifestStore.PendingImportEntry entry : DriveManifestStore.listPendingImports(getContext())) {
                JSObject item = new JSObject();
                item.put("id", entry.id);
                item.put("documentId", DriveManifestStore.pendingFileDocumentId(entry.id));
                item.put("name", entry.name);
                item.put("mimeType", entry.mimeType);
                item.put("size", entry.size);
                item.put("folderPath", entry.folderPath);
                item.put("parentId", entry.parentId);
                item.put("createdAt", entry.createdAt);
                imports.put(item);
            }

            JSObject response = new JSObject();
            response.put("imports", imports);
            call.resolve(response);
        } catch (Exception error) {
            call.reject("Failed to list pending imports", error);
        }
    }

    @PluginMethod
    public void readPendingImport(PluginCall call) {
        String pendingId = call.getString("id");
        if (pendingId == null || pendingId.trim().isEmpty()) {
            call.reject("id is required");
            return;
        }

        try {
            DriveManifestStore.PendingImportEntry entry = DriveManifestStore.getPendingImportById(
                    getContext(),
                    pendingId
            );
            if (entry == null) {
                call.reject("Pending import not found");
                return;
            }

            File file = new File(entry.localPath);
            if (!file.exists()) {
                call.reject("Pending import file is missing");
                return;
            }

            byte[] bytes = readFileBytes(file);
            JSObject response = new JSObject();
            response.put("id", entry.id);
            response.put("name", entry.name);
            response.put("mimeType", entry.mimeType);
            response.put("size", entry.size);
            response.put("folderPath", entry.folderPath);
            response.put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP));
            call.resolve(response);
        } catch (Exception error) {
            call.reject("Failed to read pending import", error);
        }
    }

    @PluginMethod
    public void removePendingImport(PluginCall call) {
        String pendingId = call.getString("id");
        if (pendingId == null || pendingId.trim().isEmpty()) {
            call.reject("id is required");
            return;
        }

        try {
            DriveManifestStore.removePendingImport(getContext(), pendingId);
            call.resolve();
        } catch (Exception error) {
            call.reject("Failed to remove pending import", error);
        }
    }

    @PluginMethod
    public void saveToDownloads(PluginCall call) {
        String base64 = call.getString("base64");
        String fileName = call.getString("fileName");
        String mimeType = call.getString("mimeType");

        if (base64 == null || fileName == null || mimeType == null) {
            call.reject("base64, fileName, and mimeType are required");
            return;
        }

        try {
            byte[] bytes = Base64.decode(base64, Base64.NO_WRAP);

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, fileName);
                values.put(MediaStore.Downloads.MIME_TYPE, mimeType);
                values.put(MediaStore.Downloads.IS_PENDING, 1);

                Uri collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
                Uri fileUri = getContext().getContentResolver().insert(collection, values);

                if (fileUri == null) {
                    call.reject("Failed to create file in Downloads");
                    return;
                }

                try (OutputStream outputStream = getContext().getContentResolver().openOutputStream(fileUri)) {
                    if (outputStream == null) {
                        call.reject("Failed to open output stream");
                        return;
                    }
                    outputStream.write(bytes);
                }

                values.clear();
                values.put(MediaStore.Downloads.IS_PENDING, 0);
                getContext().getContentResolver().update(fileUri, values, null, null);

                JSObject response = new JSObject();
                response.put("uri", fileUri.toString());
                call.resolve(response);
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

                try (FileOutputStream outputStream = new FileOutputStream(outFile)) {
                    outputStream.write(bytes);
                }

                JSObject response = new JSObject();
                response.put("uri", outFile.getAbsolutePath());
                call.resolve(response);
            }
        } catch (Exception error) {
            call.reject("Failed to save file to Downloads", error);
        }
    }

    @PluginMethod
    public void downloadToDownloads(PluginCall call) {
        String server = call.getString("server");
        String correlationId = call.getString("correlationId");
        String encryptionKey = call.getString("encryptionKey");
        String fileName = call.getString("fileName");
        String mimeType = call.getString("mimeType");

        if (server == null || correlationId == null || encryptionKey == null
                || fileName == null || mimeType == null) {
            call.reject("server, correlationId, encryptionKey, fileName, and mimeType are required");
            return;
        }

        startDownload(call);
    }

    private void startDownload(PluginCall call) {
        String server = call.getString("server");
        String correlationId = call.getString("correlationId");
        String encryptionKey = call.getString("encryptionKey");
        String fileName = call.getString("fileName");
        String mimeType = call.getString("mimeType");
        String unencryptedFileHash = call.getString("unencryptedFileHash");
        String blobHash = call.getString("blobHash");
        // getLong avoids getInt's 32-bit range, which a >2GB file's size
        // could exceed.
        long size = call.getLong("size", 0L);
        int chunkSize = call.getInt("chunkSize", 0);
        JSArray chunksArray = call.getArray("chunks");

        // Chunks arrive as `{ hash, server? }` objects so per-chunk routing
        // survives the bridge; the array is forwarded verbatim and parsed by
        // DriveFileDownloader.parseChunks, which also still accepts the legacy
        // bare-string shape.
        String chunksJson = chunksArray != null ? chunksArray.toString() : null;

        String downloadId = UUID.randomUUID().toString();
        pendingDownloadCalls.put(downloadId, call);
        call.setKeepAlive(true);

        Intent intent = new Intent(getContext(), DriveDownloadService.class);
        intent.putExtra(DriveDownloadService.EXTRA_ID, downloadId);
        intent.putExtra(DriveDownloadService.EXTRA_SERVER, server);
        intent.putExtra(DriveDownloadService.EXTRA_ENCRYPTION_KEY, encryptionKey);
        intent.putExtra(DriveDownloadService.EXTRA_FILE_NAME, fileName);
        intent.putExtra(DriveDownloadService.EXTRA_MIME_TYPE, mimeType);
        intent.putExtra(DriveDownloadService.EXTRA_SIZE, size);
        if (unencryptedFileHash != null && !unencryptedFileHash.isEmpty()) {
            intent.putExtra(DriveDownloadService.EXTRA_UNENCRYPTED_FILE_HASH, unencryptedFileHash);
        }
        if (blobHash != null && !blobHash.isEmpty()) {
            // NIP-FS single-blob file — chunkSize travels alongside it;
            // chunksJson is never sent for this shape.
            intent.putExtra(DriveDownloadService.EXTRA_BLOB_HASH, blobHash);
            intent.putExtra(DriveDownloadService.EXTRA_CHUNK_SIZE, chunkSize);
        } else if (chunksJson != null) {
            intent.putExtra(DriveDownloadService.EXTRA_CHUNKS_JSON, chunksJson);
        }

        ContextCompat.startForegroundService(getContext(), intent);

        JSObject started = new JSObject();
        started.put("id", downloadId);
        // Echo the caller's token back so the JS side can correlate this
        // randomly-generated download id to the transfer it started
        // (progress/cancel are keyed by id).
        started.put("correlationId", correlationId);
        notifyListeners("downloadStarted", started);
    }

    @PluginMethod
    public void cancelDownload(PluginCall call) {
        String id = call.getString("id");
        if (id == null) {
            call.reject("id is required");
            return;
        }

        DriveDownloadService.cancel(id);
        call.resolve();
    }

    @PluginMethod
    public void getActiveDownloads(PluginCall call) {
        JSArray downloads = new JSArray();
        for (DriveDownloadService.ActiveDownload active : DriveDownloadService.activeDownloads()) {
            JSObject item = new JSObject();
            item.put("id", active.id);
            item.put("fileName", active.fileName);
            item.put("percent", active.percent);
            downloads.put(item);
        }
        JSObject response = new JSObject();
        response.put("downloads", downloads);
        call.resolve(response);
    }

    @PluginMethod
    public void openFile(PluginCall call) {
        String uriString = call.getString("uri");
        String mimeType = call.getString("mimeType");

        if (uriString == null || mimeType == null) {
            call.reject("uri and mimeType are required");
            return;
        }

        try {
            Uri uri;
            if (uriString.startsWith("content://")) {
                uri = Uri.parse(uriString);
            } else {
                File file = new File(uriString);
                uri = FileProvider.getUriForFile(
                    getContext(),
                    getContext().getPackageName() + ".fileprovider",
                    file
                );
            }

            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, mimeType);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception error) {
            call.reject("Failed to open file", error);
        }
    }

    private byte[] readFileBytes(File file) throws Exception {
        try (FileInputStream inputStream = new FileInputStream(file);
             ByteArrayOutputStream outputStream = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int bytesRead;

            while ((bytesRead = inputStream.read(buffer)) != -1) {
                outputStream.write(buffer, 0, bytesRead);
            }

            return outputStream.toByteArray();
        }
    }

    @PluginMethod
    public void requestNotificationPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
                || getPermissionState("notifications") == PermissionState.GRANTED) {
            JSObject response = new JSObject();
            response.put("granted", true);
            call.resolve(response);
            return;
        }

        requestPermissionForAlias("notifications", call, "notificationPermissionResult");
    }

    @PermissionCallback
    private void notificationPermissionResult(PluginCall call) {
        JSObject response = new JSObject();
        response.put("granted", getPermissionState("notifications") == PermissionState.GRANTED);
        call.resolve(response);
    }

    @PluginMethod
    public void startUploadService(PluginCall call) {
        String uploadId = call.getString("uploadId");
        String fileName = call.getString("fileName", "file");
        if (uploadId == null) {
            call.reject("uploadId is required");
            return;
        }

        Intent intent = new Intent(getContext(), DriveUploadService.class);
        intent.setAction(DriveUploadService.ACTION_PREPARE);
        intent.putExtra(DriveUploadService.EXTRA_ID, uploadId);
        intent.putExtra(DriveUploadService.EXTRA_FILE_NAME, fileName);
        ContextCompat.startForegroundService(getContext(), intent);
        call.resolve();
    }

    /**
     * Writes one slice of a staged upload blob to app-private storage. A 50MB
     * chunk would cost ~67MB of base64 in a single bridge message, so the JS
     * side streams it in small slices: the first call for an index writes
     * (append=false, truncating any leftover from an earlier attempt) and the
     * rest append. The file is only complete once JS stops appending.
     */
    @PluginMethod
    public void stageUploadChunk(PluginCall call) {
        String uploadId = call.getString("uploadId");
        Integer index = call.getInt("index");
        String base64 = call.getString("base64");
        boolean append = Boolean.TRUE.equals(call.getBoolean("append", Boolean.FALSE));

        if (uploadId == null || index == null || base64 == null) {
            call.reject("uploadId, index, and base64 are required");
            return;
        }

        try {
            byte[] bytes = Base64.decode(base64, Base64.NO_WRAP);
            File dir = new File(new File(getContext().getFilesDir(), "uploads"), uploadId);
            if (!dir.exists() && !dir.mkdirs()) {
                call.reject("Failed to create staging directory");
                return;
            }
            File chunkFile = new File(dir, "chunk-" + index + ".bin");
            try (FileOutputStream out = new FileOutputStream(chunkFile, append)) {
                out.write(bytes);
            }

            JSObject response = new JSObject();
            response.put("path", chunkFile.getAbsolutePath());
            call.resolve(response);
        } catch (Exception error) {
            call.reject("Failed to stage upload chunk", error);
        }
    }

    @PluginMethod
    public void startNativeUpload(PluginCall call) {
        String uploadId = call.getString("uploadId");
        String fileName = call.getString("fileName", "file");
        String authHeader = call.getString("authHeader");
        JSArray serversArray = call.getArray("servers");
        JSArray metadataEventsArray = call.getArray("metadataEvents");
        JSArray blobsArray = call.getArray("blobs");
        JSArray relaysArray = call.getArray("relays");

        if (uploadId == null || authHeader == null || serversArray == null
                || metadataEventsArray == null || blobsArray == null || relaysArray == null) {
            call.reject("uploadId, servers, authHeader, metadataEvents, blobs, and relays are required");
            return;
        }

        JSONArray blobsJson;
        JSONArray metadataEventsJson;
        try {
            blobsJson = new JSONArray();
            for (int i = 0; i < blobsArray.length(); i++) {
                JSONObject blob = blobsArray.getJSONObject(i);
                JSONObject entry = new JSONObject();
                entry.put("path", blob.getString("path"));
                entry.put("hash", blob.getString("hash"));
                entry.put("contentType", blob.optString("contentType", "application/octet-stream"));
                entry.put("optional", blob.optBoolean("optional", false));
                blobsJson.put(entry);
            }

            metadataEventsJson = new JSONArray();
            for (int i = 0; i < metadataEventsArray.length(); i++) {
                JSONObject variant = metadataEventsArray.getJSONObject(i);
                JSONObject entry = new JSONObject();
                entry.put("server", variant.getString("server"));
                entry.put("eventJson", variant.getString("eventJson"));
                metadataEventsJson.put(entry);
            }
        } catch (JSONException error) {
            call.reject("Invalid blobs or metadataEvents array", error);
            return;
        }

        pendingUploadCalls.put(uploadId, call);
        call.setKeepAlive(true);

        Intent intent = new Intent(getContext(), DriveUploadService.class);
        intent.setAction(DriveUploadService.ACTION_START);
        intent.putExtra(DriveUploadService.EXTRA_ID, uploadId);
        intent.putExtra(DriveUploadService.EXTRA_SERVERS_JSON, serversArray.toString());
        intent.putExtra(DriveUploadService.EXTRA_FILE_NAME, fileName);
        intent.putExtra(DriveUploadService.EXTRA_AUTH_HEADER, authHeader);
        intent.putExtra(DriveUploadService.EXTRA_METADATA_EVENTS_JSON, metadataEventsJson.toString());
        intent.putExtra(DriveUploadService.EXTRA_RELAYS_JSON, relaysArray.toString());
        intent.putExtra(DriveUploadService.EXTRA_BLOBS_JSON, blobsJson.toString());

        ContextCompat.startForegroundService(getContext(), intent);
    }

    @PluginMethod
    public void getActiveUploads(PluginCall call) {
        JSArray uploads = new JSArray();
        for (DriveUploadService.ActiveUpload active : DriveUploadService.activeUploads()) {
            JSObject item = new JSObject();
            item.put("id", active.id);
            item.put("fileName", active.fileName);
            item.put("percent", active.percent);
            item.put("preparing", active.preparing);
            uploads.put(item);
        }
        JSObject response = new JSObject();
        response.put("uploads", uploads);
        call.resolve(response);
    }

    @PluginMethod
    public void cancelNativeUpload(PluginCall call) {
        String uploadId = call.getString("uploadId");
        if (uploadId == null) {
            call.reject("uploadId is required");
            return;
        }

        DriveUploadService.cancel(uploadId);
        call.resolve();
    }

    // Lightweight, JS-driven upload notification. The in-app (OPFS) upload path
    // runs no foreground service, so the JS layer posts/updates/clears a plain
    // progress notification directly. Reuses DriveUploadService's channels.

    @PluginMethod
    public void showUploadNotification(PluginCall call) {
        String id = call.getString("id");
        String fileName = call.getString("fileName", "file");
        Integer percent = call.getInt("percent", 0);
        if (id == null) {
            call.reject("id is required");
            return;
        }

        NotificationManager nm = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        DriveUploadService.ensureNotificationChannel(nm);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(getContext(), DriveUploadService.UPLOAD_CHANNEL_ID)
                .setContentTitle("Uploading " + fileName)
                .setSmallIcon(R.drawable.ic_notification)                .setProgress(100, percent != null ? percent : 0, false)
                .setOngoing(true)
                .setSilent(true);
        nm.notify(uploadProgressNotifId(id), builder.build());
        call.resolve();
    }

    @PluginMethod
    public void finishUploadNotification(PluginCall call) {
        String id = call.getString("id");
        String fileName = call.getString("fileName", "file");
        Boolean ok = call.getBoolean("ok", Boolean.TRUE);
        String message = call.getString("message");
        if (id == null) {
            call.reject("id is required");
            return;
        }

        NotificationManager nm = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        DriveUploadService.ensureNotificationChannel(nm);
        nm.cancel(uploadProgressNotifId(id));

        NotificationCompat.Builder builder = new NotificationCompat.Builder(getContext(), DriveUploadService.UPLOAD_DONE_CHANNEL_ID);
        if (ok == null || ok) {
            builder.setContentTitle("Upload complete").setContentText(fileName);
        } else {
            builder.setContentTitle("Upload failed")
                    .setContentText(message != null ? fileName + ": " + message : fileName);
        }
        builder.setSmallIcon(R.drawable.ic_notification)                .setAutoCancel(true)
                .setOngoing(false);
        nm.notify(uploadResultNotifId(id), builder.build());
        call.resolve();
    }

    @PluginMethod
    public void clearUploadNotification(PluginCall call) {
        String id = call.getString("id");
        if (id == null) {
            call.reject("id is required");
            return;
        }
        NotificationManager nm = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        nm.cancel(uploadProgressNotifId(id));
        call.resolve();
    }

    private static int uploadProgressNotifId(String id) {
        return id.hashCode() & 0x7fffffff;
    }

    private static int uploadResultNotifId(String id) {
        return (id + ":result").hashCode() & 0x7fffffff;
    }
}
