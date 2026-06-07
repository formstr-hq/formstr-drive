package com.formstr.drive.files;

import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.OutputStream;

@CapacitorPlugin(name = "DriveFiles")
public class DriveFilesPlugin extends Plugin {

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
}
