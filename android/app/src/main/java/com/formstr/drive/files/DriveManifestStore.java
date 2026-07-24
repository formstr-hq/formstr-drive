package com.formstr.drive.files;

import android.content.Context;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.util.Log;

import androidx.annotation.Nullable;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class DriveManifestStore {
    public static final String ROOT_DOCUMENT_ID = "root";
    public static final String ROOT_ID = "formstr-drive-root";
    public static final String ROOT_TITLE = "My Drive";

    private static final String TAG = "DriveManifestStore";
    private static final String MANIFEST_DIRECTORY_NAME = "drive-files";
    private static final String MANIFEST_FILE_NAME = "manifest.json";
    private static final String EXPORTS_DIRECTORY_NAME = "exports";
    private static final String PENDING_IMPORTS_DIRECTORY_NAME = "pending-imports";
    private static final String PENDING_IMPORTS_FILE_NAME = "pending-imports.json";
    private static final String PENDING_IMPORT_FILES_DIRECTORY_NAME = "files";
    private static final String FOLDER_DOCUMENT_PREFIX = "folder:";
    private static final String FILE_DOCUMENT_PREFIX = "file:";
    private static final String PENDING_FILE_DOCUMENT_PREFIX = "pending:";

    private DriveManifestStore() {}

    public static void writeManifest(Context context, String manifestJson) throws IOException {
        File directory = getManifestDirectory(context);
        if (!directory.exists() && !directory.mkdirs()) {
            throw new IOException("Unable to create manifest directory");
        }

        File manifestFile = getManifestFile(context);
        try (FileOutputStream outputStream = new FileOutputStream(manifestFile, false)) {
            outputStream.write(manifestJson.getBytes(StandardCharsets.UTF_8));
            outputStream.flush();
        }

        notifyProviderChanged(context, ROOT_DOCUMENT_ID);
    }

    public static void clearManifest(Context context) {
        deleteIfExists(getManifestFile(context));
        clearExports(context);
        clearPendingImports(context);
        notifyProviderChanged(context, ROOT_DOCUMENT_ID);
    }

    @Nullable
    public static DriveManifest loadRemoteManifest(Context context) {
        File manifestFile = getManifestFile(context);
        if (!manifestFile.exists()) {
            return null;
        }

        try (FileInputStream inputStream = new FileInputStream(manifestFile);
             ByteArrayOutputStream outputStream = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int bytesRead;

            while ((bytesRead = inputStream.read(buffer)) != -1) {
                outputStream.write(buffer, 0, bytesRead);
            }

            return DriveManifest.fromJson(
                    outputStream.toString(StandardCharsets.UTF_8.name())
            );
        } catch (IOException | JSONException error) {
            Log.e(TAG, "Failed to load native drive manifest", error);
            return null;
        }
    }

    public static boolean hasRemoteManifest(Context context) {
        File manifestFile = getManifestFile(context);
        return manifestFile.exists() && manifestFile.isFile();
    }

    @Nullable
    public static DriveManifest loadEffectiveManifest(Context context) {
        DriveManifest remoteManifest = loadRemoteManifest(context);
        List<PendingImportEntry> pendingImports = listPendingImports(context);

        if (remoteManifest == null && pendingImports.isEmpty()) {
            return null;
        }

        return mergeManifest(remoteManifest, pendingImports);
    }

    public static List<PendingImportEntry> listPendingImports(Context context) {
        return readPendingImports(context);
    }

    @Nullable
    public static PendingImportEntry getPendingImportById(Context context, String pendingId) {
        for (PendingImportEntry entry : readPendingImports(context)) {
            if (entry.id.equals(pendingId)) {
                return entry;
            }
        }
        return null;
    }

    public static void addPendingImport(Context context, PendingImportEntry entry) throws IOException {
        List<PendingImportEntry> pendingImports = readPendingImports(context);
        pendingImports.add(entry);
        writePendingImports(context, pendingImports);
        notifyProviderChanged(context, entry.parentId);
    }

    public static void updatePendingImportSize(Context context, String pendingId, long size) throws IOException {
        List<PendingImportEntry> pendingImports = readPendingImports(context);
        boolean updated = false;
        String parentId = ROOT_DOCUMENT_ID;

        for (int index = 0; index < pendingImports.size(); index += 1) {
            PendingImportEntry entry = pendingImports.get(index);
            if (!entry.id.equals(pendingId)) {
                continue;
            }

            pendingImports.set(index, entry.withSize(size));
            parentId = entry.parentId;
            updated = true;
            break;
        }

        if (updated) {
            writePendingImports(context, pendingImports);
            notifyProviderChanged(context, parentId);
        }
    }

    public static void removePendingImport(Context context, String pendingId) throws IOException {
        List<PendingImportEntry> pendingImports = readPendingImports(context);
        PendingImportEntry removedEntry = null;

        for (int index = pendingImports.size() - 1; index >= 0; index -= 1) {
            PendingImportEntry entry = pendingImports.get(index);
            if (!entry.id.equals(pendingId)) {
                continue;
            }

            removedEntry = entry;
            pendingImports.remove(index);
            break;
        }

        if (removedEntry == null) {
            return;
        }

        writePendingImports(context, pendingImports);
        deleteRecursively(new File(removedEntry.localPath));
        notifyProviderChanged(context, removedEntry.parentId);
    }

    public static File createPendingImportFile(Context context, String pendingId) throws IOException {
        File directory = getPendingImportFilesDirectory(context);
        if (!directory.exists() && !directory.mkdirs()) {
            throw new IOException("Unable to create pending import file directory");
        }

        return new File(directory, pendingId + ".bin");
    }

    public static File getExportsDirectory(Context context) {
        File directory = new File(getManifestDirectory(context), EXPORTS_DIRECTORY_NAME);
        if (!directory.exists()) {
            //noinspection ResultOfMethodCallIgnored
            directory.mkdirs();
        }
        return directory;
    }

    public static void clearExports(Context context) {
        deleteRecursively(new File(getManifestDirectory(context), EXPORTS_DIRECTORY_NAME));
    }

    public static void clearPendingImports(Context context) {
        deleteIfExists(getPendingImportsFile(context));
        deleteRecursively(getPendingImportsDirectory(context));
    }

    public static String normalizePath(String path) {
        if (path == null) {
            return "/";
        }

        String trimmed = path.trim();
        if (trimmed.isEmpty() || "/".equals(trimmed)) {
            return "/";
        }

        String withLeadingSlash = trimmed.startsWith("/") ? trimmed : "/" + trimmed;
        String collapsed = withLeadingSlash.replaceAll("/+", "/");
        return collapsed.length() > 1 && collapsed.endsWith("/")
                ? collapsed.substring(0, collapsed.length() - 1)
                : collapsed;
    }

    public static String folderDocumentId(String path) {
        return FOLDER_DOCUMENT_PREFIX + normalizePath(path);
    }

    public static String fileDocumentId(String hash) {
        return FILE_DOCUMENT_PREFIX + hash;
    }

    public static String pendingFileDocumentId(String pendingId) {
        return PENDING_FILE_DOCUMENT_PREFIX + pendingId;
    }

    public static String folderName(String path) {
        String normalized = normalizePath(path);
        if ("/".equals(normalized)) {
            return ROOT_TITLE;
        }

        int lastSlashIndex = normalized.lastIndexOf('/');
        return lastSlashIndex >= 0 ? normalized.substring(lastSlashIndex + 1) : normalized;
    }

    private static File getManifestDirectory(Context context) {
        return new File(context.getFilesDir(), MANIFEST_DIRECTORY_NAME);
    }

    private static File getManifestFile(Context context) {
        return new File(getManifestDirectory(context), MANIFEST_FILE_NAME);
    }

    private static File getPendingImportsDirectory(Context context) {
        return new File(getManifestDirectory(context), PENDING_IMPORTS_DIRECTORY_NAME);
    }

    private static File getPendingImportsFile(Context context) {
        return new File(getPendingImportsDirectory(context), PENDING_IMPORTS_FILE_NAME);
    }

    private static File getPendingImportFilesDirectory(Context context) {
        return new File(getPendingImportsDirectory(context), PENDING_IMPORT_FILES_DIRECTORY_NAME);
    }

    private static List<PendingImportEntry> readPendingImports(Context context) {
        File pendingImportsFile = getPendingImportsFile(context);
        if (!pendingImportsFile.exists()) {
            return new ArrayList<>();
        }

        try (FileInputStream inputStream = new FileInputStream(pendingImportsFile);
             ByteArrayOutputStream outputStream = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int bytesRead;

            while ((bytesRead = inputStream.read(buffer)) != -1) {
                outputStream.write(buffer, 0, bytesRead);
            }

            JSONArray jsonArray = new JSONArray(outputStream.toString(StandardCharsets.UTF_8.name()));
            List<PendingImportEntry> pendingImports = new ArrayList<>();

            for (int index = 0; index < jsonArray.length(); index += 1) {
                pendingImports.add(PendingImportEntry.fromJson(jsonArray.getJSONObject(index)));
            }

            pendingImports.sort(Comparator.comparing(entry -> entry.name, String.CASE_INSENSITIVE_ORDER));
            return pendingImports;
        } catch (IOException | JSONException error) {
            Log.e(TAG, "Failed to read pending imports", error);
            return new ArrayList<>();
        }
    }

    private static void writePendingImports(Context context, List<PendingImportEntry> pendingImports)
            throws IOException {
        File directory = getPendingImportsDirectory(context);
        if (!directory.exists() && !directory.mkdirs()) {
            throw new IOException("Unable to create pending imports directory");
        }

        JSONArray jsonArray = new JSONArray();
        for (PendingImportEntry entry : pendingImports) {
            try {
                jsonArray.put(entry.toJson());
            } catch (JSONException error) {
                throw new IOException("Failed to serialize pending import metadata", error);
            }
        }

        File pendingImportsFile = getPendingImportsFile(context);
        try (FileOutputStream outputStream = new FileOutputStream(pendingImportsFile, false)) {
            outputStream.write(jsonArray.toString().getBytes(StandardCharsets.UTF_8));
            outputStream.flush();
        }
    }

    private static DriveManifest mergeManifest(
            @Nullable DriveManifest remoteManifest,
            List<PendingImportEntry> pendingImports
    ) {
        long syncedAt = remoteManifest != null ? remoteManifest.syncedAt : 0L;
        Map<String, FolderEntry> folderMap = new LinkedHashMap<>();
        List<FileEntry> files = new ArrayList<>();

        if (remoteManifest != null) {
            for (FolderEntry folder : remoteManifest.folders) {
                folderMap.put(folder.id, folder);
            }
            files.addAll(remoteManifest.files);
        }

        for (PendingImportEntry pendingImport : pendingImports) {
            String normalizedFolderPath = normalizePath(pendingImport.folderPath);
            if (!"/".equals(normalizedFolderPath)) {
                String[] parts = normalizedFolderPath.split("/");
                String currentPath = "";

                for (String part : parts) {
                    if (part == null || part.isEmpty()) {
                        continue;
                    }

                    currentPath += "/" + part;
                    String folderId = folderDocumentId(currentPath);
                    if (folderMap.containsKey(folderId)) {
                        continue;
                    }

                    String parentPath = currentPath.lastIndexOf('/') > 0
                            ? currentPath.substring(0, currentPath.lastIndexOf('/'))
                            : "/";
                    String parentId = "/".equals(parentPath)
                            ? ROOT_DOCUMENT_ID
                            : folderDocumentId(parentPath);

                    folderMap.put(
                            folderId,
                            new FolderEntry(folderId, currentPath, folderName(currentPath), parentId)
                    );
                }
            }

            files.add(FileEntry.fromPendingImport(pendingImport));
        }

        List<FolderEntry> folders = new ArrayList<>(folderMap.values());
        folders.sort(Comparator.comparing(folder -> folder.path));
        files.sort(Comparator.comparing(file -> file.name, String.CASE_INSENSITIVE_ORDER));

        return new DriveManifest(syncedAt, folders, files);
    }

    private static void notifyProviderChanged(Context context, @Nullable String parentId) {
        String authority = context.getPackageName() + ".documents";
        try {
            context.getContentResolver().notifyChange(
                    DocumentsContract.buildRootsUri(authority),
                    null
            );

            Uri rootDocumentUri = DocumentsContract.buildDocumentUri(authority, ROOT_DOCUMENT_ID);
            context.getContentResolver().notifyChange(rootDocumentUri, null);
            context.getContentResolver().notifyChange(
                    DocumentsContract.buildChildDocumentsUri(authority, ROOT_DOCUMENT_ID),
                    null
            );

            if (parentId != null && !ROOT_DOCUMENT_ID.equals(parentId)) {
                Uri parentUri = DocumentsContract.buildDocumentUri(authority, parentId);
                context.getContentResolver().notifyChange(parentUri, null);
                context.getContentResolver().notifyChange(
                        DocumentsContract.buildChildDocumentsUri(authority, parentId),
                        null
                );
            }
        } catch (Exception error) {
            Log.w(TAG, "Failed to notify Files provider updates", error);
        }
    }

    private static void deleteIfExists(File file) {
        if (file.exists() && !file.delete()) {
            Log.w(TAG, "Failed to delete file: " + file.getAbsolutePath());
        }
    }

    private static void deleteRecursively(File file) {
        if (!file.exists()) {
            return;
        }

        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) {
                for (File child : children) {
                    deleteRecursively(child);
                }
            }
        }

        if (!file.delete()) {
            Log.w(TAG, "Failed to delete path: " + file.getAbsolutePath());
        }
    }

    public static final class PendingImportEntry {
        public final String id;
        public final String name;
        public final String mimeType;
        public final long size;
        public final String folderPath;
        public final String parentId;
        public final long createdAt;
        public final String localPath;

        public PendingImportEntry(
                String id,
                String name,
                String mimeType,
                long size,
                String folderPath,
                String parentId,
                long createdAt,
                String localPath
        ) {
            this.id = id;
            this.name = name;
            this.mimeType = mimeType;
            this.size = size;
            this.folderPath = folderPath;
            this.parentId = parentId;
            this.createdAt = createdAt;
            this.localPath = localPath;
        }

        public PendingImportEntry withSize(long updatedSize) {
            return new PendingImportEntry(
                    id,
                    name,
                    mimeType,
                    updatedSize,
                    folderPath,
                    parentId,
                    createdAt,
                    localPath
            );
        }

        JSONObject toJson() throws JSONException {
            JSONObject jsonObject = new JSONObject();
            jsonObject.put("id", id);
            jsonObject.put("name", name);
            jsonObject.put("mimeType", mimeType);
            jsonObject.put("size", size);
            jsonObject.put("folderPath", folderPath);
            jsonObject.put("parentId", parentId);
            jsonObject.put("createdAt", createdAt);
            jsonObject.put("localPath", localPath);
            return jsonObject;
        }

        static PendingImportEntry fromJson(JSONObject jsonObject) {
            String id = jsonObject.optString("id");
            String folderPath = normalizePath(jsonObject.optString("folderPath", "/"));
            String parentId = jsonObject.optString(
                    "parentId",
                    "/".equals(folderPath) ? ROOT_DOCUMENT_ID : folderDocumentId(folderPath)
            );

            return new PendingImportEntry(
                    id,
                    jsonObject.optString("name", id),
                    jsonObject.optString("mimeType", "application/octet-stream"),
                    jsonObject.optLong("size", 0L),
                    folderPath,
                    parentId,
                    jsonObject.optLong("createdAt", 0L),
                    jsonObject.optString("localPath")
            );
        }
    }

    public static final class FolderEntry {
        public final String id;
        public final String path;
        public final String name;
        public final String parentId;

        private FolderEntry(String id, String path, String name, String parentId) {
            this.id = id;
            this.path = path;
            this.name = name;
            this.parentId = parentId;
        }

        static FolderEntry fromJson(JSONObject jsonObject) {
            String path = normalizePath(jsonObject.optString("path", "/"));
            String id = jsonObject.optString("id", folderDocumentId(path));
            String name = jsonObject.optString("name", folderName(path));
            String parentId = jsonObject.optString("parentId", ROOT_DOCUMENT_ID);
            return new FolderEntry(id, path, name, parentId);
        }
    }

    public static final class FileEntry {
        public final String id;
        public final String hash;
        public final String name;
        public final String mimeType;
        public final long size;
        public final String folderPath;
        public final String parentId;
        public final long uploadedAt;
        public final String server;
        public final String encryptionKey;
        public final String protocol;
        @Nullable public final String previewHash;
        @Nullable public final List<String> chunks;
        public final boolean isPendingImport;
        @Nullable public final String pendingImportId;
        @Nullable public final String localPath;

        private FileEntry(
                String id,
                String hash,
                String name,
                String mimeType,
                long size,
                String folderPath,
                String parentId,
                long uploadedAt,
                String server,
                String encryptionKey,
                String protocol,
                @Nullable String previewHash,
                @Nullable List<String> chunks,
                boolean isPendingImport,
                @Nullable String pendingImportId,
                @Nullable String localPath
        ) {
            this.id = id;
            this.hash = hash;
            this.name = name;
            this.mimeType = mimeType;
            this.size = size;
            this.folderPath = folderPath;
            this.parentId = parentId;
            this.uploadedAt = uploadedAt;
            this.server = server;
            this.encryptionKey = encryptionKey;
            this.protocol = protocol;
            this.previewHash = previewHash;
            this.chunks = chunks;
            this.isPendingImport = isPendingImport;
            this.pendingImportId = pendingImportId;
            this.localPath = localPath;
        }

        static FileEntry fromJson(JSONObject jsonObject) {
            String hash = jsonObject.optString("hash");
            String id = jsonObject.optString("id", fileDocumentId(hash));
            String name = jsonObject.optString("name", hash);
            String mimeType = jsonObject.optString("mimeType", "application/octet-stream");
            long size = jsonObject.optLong("size", 0L);
            String folderPath = normalizePath(jsonObject.optString("folderPath", "/"));
            String parentId = jsonObject.optString(
                    "parentId",
                    "/".equals(folderPath) ? ROOT_DOCUMENT_ID : folderDocumentId(folderPath)
            );
            long uploadedAt = jsonObject.optLong("uploadedAt", 0L);
            String server = jsonObject.optString("server");
            String encryptionKey = jsonObject.optString("encryptionKey");
            String protocol = jsonObject.optString("protocol", "legacy");
            String previewHash = jsonObject.has("previewHash") ? jsonObject.optString("previewHash") : null;
            
            List<String> chunks = null;
            if (jsonObject.has("chunks")) {
                JSONArray chunksJson = jsonObject.optJSONArray("chunks");
                if (chunksJson != null) {
                    chunks = new ArrayList<>();
                    for (int i = 0; i < chunksJson.length(); i++) {
                        chunks.add(chunksJson.optString(i));
                    }
                }
            }

            return new FileEntry(
                    id,
                    hash,
                    name,
                    mimeType,
                    size,
                    folderPath,
                    parentId,
                    uploadedAt,
                    server,
                    encryptionKey,
                    protocol,
                    previewHash,
                    chunks,
                    false,
                    null,
                    null
            );
        }

        static FileEntry fromPendingImport(PendingImportEntry entry) {
            return new FileEntry(
                    pendingFileDocumentId(entry.id),
                    entry.id,
                    entry.name,
                    entry.mimeType,
                    entry.size,
                    entry.folderPath,
                    entry.parentId,
                    entry.createdAt,
                    "",
                    "",
                    "legacy",
                    null,
                    null,
                    true,
                    entry.id,
                    entry.localPath
            );
        }
    }

    public static final class DriveManifest {
        public final long syncedAt;
        public final List<FolderEntry> folders;
        public final List<FileEntry> files;

        private DriveManifest(long syncedAt, List<FolderEntry> folders, List<FileEntry> files) {
            this.syncedAt = syncedAt;
            this.folders = Collections.unmodifiableList(folders);
            this.files = Collections.unmodifiableList(files);
        }

        static DriveManifest fromJson(String manifestJson) throws JSONException {
            JSONObject jsonObject = new JSONObject(manifestJson);
            long syncedAt = jsonObject.optLong("syncedAt", 0L);

            List<FolderEntry> folders = new ArrayList<>();
            JSONArray foldersJson = jsonObject.optJSONArray("folders");
            if (foldersJson != null) {
                for (int index = 0; index < foldersJson.length(); index += 1) {
                    folders.add(FolderEntry.fromJson(foldersJson.getJSONObject(index)));
                }
            }

            List<FileEntry> files = new ArrayList<>();
            JSONArray filesJson = jsonObject.optJSONArray("files");
            if (filesJson != null) {
                for (int index = 0; index < filesJson.length(); index += 1) {
                    files.add(FileEntry.fromJson(filesJson.getJSONObject(index)));
                }
            }

            folders.sort(Comparator.comparing(folder -> folder.path));
            files.sort(Comparator.comparing(file -> file.name, String.CASE_INSENSITIVE_ORDER));

            return new DriveManifest(syncedAt, folders, files);
        }

        @Nullable
        public FolderEntry getFolderById(String documentId) {
            for (FolderEntry folder : folders) {
                if (folder.id.equals(documentId)) {
                    return folder;
                }
            }
            return null;
        }

        @Nullable
        public FileEntry getFileById(String documentId) {
            for (FileEntry file : files) {
                if (file.id.equals(documentId)) {
                    return file;
                }
            }
            return null;
        }

        public List<FolderEntry> getChildFolders(String parentId) {
            List<FolderEntry> children = new ArrayList<>();
            for (FolderEntry folder : folders) {
                if (folder.parentId.equals(parentId)) {
                    children.add(folder);
                }
            }
            children.sort(Comparator.comparing(folder -> folder.name, String.CASE_INSENSITIVE_ORDER));
            return children;
        }

        public List<FileEntry> getChildFiles(String parentId) {
            List<FileEntry> children = new ArrayList<>();
            for (FileEntry file : files) {
                if (file.parentId.equals(parentId)) {
                    children.add(file);
                }
            }
            children.sort(Comparator.comparing(file -> file.name, String.CASE_INSENSITIVE_ORDER));
            return children;
        }

        public boolean isChildDocument(String parentId, String documentId) {
            if (ROOT_DOCUMENT_ID.equals(parentId)) {
                return !ROOT_DOCUMENT_ID.equals(documentId)
                        && (getFolderById(documentId) != null || getFileById(documentId) != null);
            }

            String currentParent = getParentId(documentId);
            while (currentParent != null) {
                if (parentId.equals(currentParent)) {
                    return true;
                }
                if (ROOT_DOCUMENT_ID.equals(currentParent)) {
                    return false;
                }
                currentParent = getParentId(currentParent);
            }
            return false;
        }

        @Nullable
        private String getParentId(String documentId) {
            FolderEntry folder = getFolderById(documentId);
            if (folder != null) {
                return folder.parentId;
            }

            FileEntry file = getFileById(documentId);
            if (file != null) {
                return file.parentId;
            }

            return null;
        }
    }
}
