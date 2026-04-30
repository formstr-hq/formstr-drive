package com.formstr.drive.files;

import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;

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
