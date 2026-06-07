package com.formstr.drive.files;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.os.Build;
import android.os.CancellationSignal;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import android.provider.DocumentsProvider;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

import java.util.concurrent.atomic.AtomicInteger;

import com.formstr.drive.R;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.List;
import java.util.UUID;

public class DriveFilesDocumentsProvider extends DocumentsProvider {
    private static final String TAG = "DriveFilesProvider";
    private static final String ROOT_SUMMARY_EMPTY = "Open the app to sign in and sync files";
    private static final String ROOT_SUMMARY_READY = "Browse the latest synced Drive snapshot";

    private static final String DOWNLOAD_CHANNEL_ID = "formstr_drive_downloads";
    private static final AtomicInteger notifIdCounter = new AtomicInteger(0);

    private interface ProgressCallback {
        void onProgress(int percent);
    }

    private static final String[] DEFAULT_ROOT_PROJECTION = new String[] {
            DocumentsContract.Root.COLUMN_ROOT_ID,
            DocumentsContract.Root.COLUMN_DOCUMENT_ID,
            DocumentsContract.Root.COLUMN_TITLE,
            DocumentsContract.Root.COLUMN_SUMMARY,
            DocumentsContract.Root.COLUMN_FLAGS,
            DocumentsContract.Root.COLUMN_ICON,
            DocumentsContract.Root.COLUMN_MIME_TYPES,
    };

    private static final String[] DEFAULT_DOCUMENT_PROJECTION = new String[] {
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_LAST_MODIFIED,
            DocumentsContract.Document.COLUMN_FLAGS,
            DocumentsContract.Document.COLUMN_SIZE,
            DocumentsContract.Document.COLUMN_ICON,
    };

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public Cursor queryRoots(String[] projection) {
        MatrixCursor cursor = new MatrixCursor(projection != null ? projection : DEFAULT_ROOT_PROJECTION);
        DriveManifestStore.DriveManifest manifest = loadManifest();
        Context context = getContext();
        boolean canCreate = context != null && DriveManifestStore.hasRemoteManifest(context);

        MatrixCursor.RowBuilder row = cursor.newRow();
        row.add(DocumentsContract.Root.COLUMN_ROOT_ID, DriveManifestStore.ROOT_ID);
        row.add(DocumentsContract.Root.COLUMN_DOCUMENT_ID, DriveManifestStore.ROOT_DOCUMENT_ID);
        row.add(DocumentsContract.Root.COLUMN_TITLE, "Formstr Drive");
        row.add(
                DocumentsContract.Root.COLUMN_SUMMARY,
                manifest == null ? ROOT_SUMMARY_EMPTY : ROOT_SUMMARY_READY
        );

        int rootFlags = DocumentsContract.Root.FLAG_SUPPORTS_IS_CHILD;
        if (canCreate) {
            rootFlags |= DocumentsContract.Root.FLAG_SUPPORTS_CREATE;
        }

        row.add(DocumentsContract.Root.COLUMN_FLAGS, rootFlags);
        row.add(DocumentsContract.Root.COLUMN_ICON, R.mipmap.ic_launcher);
        row.add(DocumentsContract.Root.COLUMN_MIME_TYPES, "*/*");

        return cursor;
    }

    @Override
    public Cursor queryDocument(String documentId, String[] projection) throws FileNotFoundException {
        MatrixCursor cursor = new MatrixCursor(projection != null ? projection : DEFAULT_DOCUMENT_PROJECTION);

        if (DriveManifestStore.ROOT_DOCUMENT_ID.equals(documentId)) {
            includeRootDocument(cursor, DriveManifestStore.hasRemoteManifest(ensureContext()));
            return cursor;
        }

        includeDocument(cursor, documentId, loadManifestOrThrow());
        return cursor;
    }

    @Override
    public Cursor queryChildDocuments(String parentDocumentId, String[] projection, String sortOrder)
            throws FileNotFoundException {
        MatrixCursor cursor = new MatrixCursor(projection != null ? projection : DEFAULT_DOCUMENT_PROJECTION);
        DriveManifestStore.DriveManifest manifest = loadManifest();

        if (manifest == null) {
            if (DriveManifestStore.ROOT_DOCUMENT_ID.equals(parentDocumentId)) {
                return cursor;
            }
            throw new FileNotFoundException("Drive manifest is not available yet");
        }

        if (!DriveManifestStore.ROOT_DOCUMENT_ID.equals(parentDocumentId)
                && manifest.getFolderById(parentDocumentId) == null) {
            throw new FileNotFoundException("Unknown parent document: " + parentDocumentId);
        }

        List<DriveManifestStore.FolderEntry> childFolders = manifest.getChildFolders(parentDocumentId);
        for (DriveManifestStore.FolderEntry folder : childFolders) {
            includeFolder(cursor, folder);
        }

        List<DriveManifestStore.FileEntry> childFiles = manifest.getChildFiles(parentDocumentId);
        for (DriveManifestStore.FileEntry file : childFiles) {
            includeFile(cursor, file);
        }

        return cursor;
    }

    @Override
    public String getDocumentType(String documentId) throws FileNotFoundException {
        if (DriveManifestStore.ROOT_DOCUMENT_ID.equals(documentId)) {
            return DocumentsContract.Document.MIME_TYPE_DIR;
        }

        DriveManifestStore.DriveManifest manifest = loadManifestOrThrow();
        DriveManifestStore.FolderEntry folder = manifest.getFolderById(documentId);
        if (folder != null) {
            return DocumentsContract.Document.MIME_TYPE_DIR;
        }

        DriveManifestStore.FileEntry file = manifest.getFileById(documentId);
        if (file != null) {
            return file.mimeType;
        }

        throw new FileNotFoundException("Unknown document: " + documentId);
    }

    @Override
    public String createDocument(String parentDocumentId, String mimeType, String displayName)
            throws FileNotFoundException {
        if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mimeType)) {
            throw new FileNotFoundException("Creating folders is not supported yet");
        }

        DriveManifestStore.DriveManifest manifest = loadManifestOrThrow();
        String parentFolderPath;

        if (DriveManifestStore.ROOT_DOCUMENT_ID.equals(parentDocumentId)) {
            parentFolderPath = "/";
        } else {
            DriveManifestStore.FolderEntry parentFolder = manifest.getFolderById(parentDocumentId);
            if (parentFolder == null) {
                throw new FileNotFoundException("Unknown parent document: " + parentDocumentId);
            }
            parentFolderPath = parentFolder.path;
        }

        String sanitizedDisplayName = sanitizeDisplayName(displayName);
        String pendingId = UUID.randomUUID().toString();
        File pendingFile;

        try {
            pendingFile = DriveManifestStore.createPendingImportFile(ensureContext(), pendingId);
            if (!pendingFile.exists() && !pendingFile.createNewFile()) {
                throw new IOException("Failed to create pending import file");
            }

            DriveManifestStore.PendingImportEntry pendingImport = new DriveManifestStore.PendingImportEntry(
                    pendingId,
                    sanitizedDisplayName,
                    normalizeMimeType(mimeType),
                    0L,
                    parentFolderPath,
                    parentDocumentId,
                    System.currentTimeMillis(),
                    pendingFile.getAbsolutePath()
            );
            DriveManifestStore.addPendingImport(ensureContext(), pendingImport);
        } catch (IOException error) {
            Log.e(TAG, "Failed to create pending Drive import", error);
            throw new FileNotFoundException(error.getMessage());
        }

        return DriveManifestStore.pendingFileDocumentId(pendingId);
    }

    @Override
    public ParcelFileDescriptor openDocument(
            String documentId,
            String mode,
            @Nullable CancellationSignal signal
    ) throws FileNotFoundException {
        if (mode == null || mode.trim().isEmpty()) {
            throw new FileNotFoundException("Document mode is required");
        }

        DriveManifestStore.DriveManifest manifest = loadManifestOrThrow();
        DriveManifestStore.FileEntry file = manifest.getFileById(documentId);
        if (file == null) {
            throw new FileNotFoundException("Document is not a file: " + documentId);
        }

        if (file.isPendingImport) {
            return openPendingImport(file, mode);
        }

        if (!mode.contains("r") || mode.contains("w")) {
            throw new FileNotFoundException("Drive files are read-only in Android Files");
        }

        try {
            File exportedFile = ensureExportFile(file, signal);
            return ParcelFileDescriptor.open(exportedFile, ParcelFileDescriptor.MODE_READ_ONLY);
        } catch (IOException error) {
            Log.e(TAG, "Failed to export Drive file", error);
            throw new FileNotFoundException(error.getMessage());
        }
    }

    @Override
    public boolean isChildDocument(String parentDocumentId, String documentId) {
        if (DriveManifestStore.ROOT_DOCUMENT_ID.equals(documentId)) {
            return DriveManifestStore.ROOT_DOCUMENT_ID.equals(parentDocumentId);
        }

        DriveManifestStore.DriveManifest manifest = loadManifest();
        if (manifest == null) {
            return false;
        }

        return manifest.isChildDocument(parentDocumentId, documentId);
    }

    private ParcelFileDescriptor openPendingImport(DriveManifestStore.FileEntry file, String mode)
            throws FileNotFoundException {
        if (file.localPath == null || file.pendingImportId == null) {
            throw new FileNotFoundException("Pending Drive import is missing local storage");
        }

        File localFile = new File(file.localPath);
        try {
            File parentDirectory = localFile.getParentFile();
            if (parentDirectory != null && !parentDirectory.exists() && !parentDirectory.mkdirs()) {
                throw new FileNotFoundException("Unable to create pending import directory");
            }
            if (!localFile.exists() && !localFile.createNewFile()) {
                throw new FileNotFoundException("Unable to create pending import file");
            }
        } catch (IOException error) {
            throw new FileNotFoundException(error.getMessage());
        }

        if (mode.contains("w")) {
            int parsedMode = ParcelFileDescriptor.parseMode(mode);
            try {
                return ParcelFileDescriptor.open(
                        localFile,
                        parsedMode,
                        new Handler(Looper.getMainLooper()),
                        closeError -> {
                            if (closeError != null) {
                                Log.w(TAG, "Pending import write failed", closeError);
                                return;
                            }

                            try {
                                DriveManifestStore.updatePendingImportSize(
                                        ensureContext(),
                                        file.pendingImportId,
                                        localFile.length()
                                );
                            } catch (IOException error) {
                                Log.e(TAG, "Failed to finalize pending import", error);
                            }
                        }
                );
            } catch (IOException error) {
                throw new FileNotFoundException(error.getMessage());
            }
        }

        if (!mode.contains("r")) {
            throw new FileNotFoundException("Unsupported pending import mode: " + mode);
        }

        return ParcelFileDescriptor.open(localFile, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    private DriveManifestStore.DriveManifest loadManifestOrThrow() throws FileNotFoundException {
        DriveManifestStore.DriveManifest manifest = loadManifest();
        if (manifest == null) {
            throw new FileNotFoundException("Drive manifest has not been synced yet");
        }
        return manifest;
    }

    @Nullable
    private DriveManifestStore.DriveManifest loadManifest() {
        if (getContext() == null) {
            return null;
        }
        return DriveManifestStore.loadEffectiveManifest(getContext());
    }

    private void includeDocument(
            MatrixCursor cursor,
            String documentId,
            DriveManifestStore.DriveManifest manifest
    ) throws FileNotFoundException {
        if (DriveManifestStore.ROOT_DOCUMENT_ID.equals(documentId)) {
            includeRootDocument(cursor, DriveManifestStore.hasRemoteManifest(ensureContext()));
            return;
        }

        DriveManifestStore.FolderEntry folder = manifest.getFolderById(documentId);
        if (folder != null) {
            includeFolder(cursor, folder);
            return;
        }

        DriveManifestStore.FileEntry file = manifest.getFileById(documentId);
        if (file != null) {
            includeFile(cursor, file);
            return;
        }

        throw new FileNotFoundException("Unknown document: " + documentId);
    }

    private void includeRootDocument(MatrixCursor cursor, boolean canCreate) {
        MatrixCursor.RowBuilder row = cursor.newRow();
        row.add(DocumentsContract.Document.COLUMN_DOCUMENT_ID, DriveManifestStore.ROOT_DOCUMENT_ID);
        row.add(DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.MIME_TYPE_DIR);
        row.add(DocumentsContract.Document.COLUMN_DISPLAY_NAME, DriveManifestStore.ROOT_TITLE);
        row.add(DocumentsContract.Document.COLUMN_LAST_MODIFIED, 0L);
        row.add(
                DocumentsContract.Document.COLUMN_FLAGS,
                canCreate ? DocumentsContract.Document.FLAG_DIR_SUPPORTS_CREATE : 0
        );
        row.add(DocumentsContract.Document.COLUMN_SIZE, null);
        row.add(DocumentsContract.Document.COLUMN_ICON, R.mipmap.ic_launcher);
    }

    private void includeFolder(MatrixCursor cursor, DriveManifestStore.FolderEntry folder) {
        MatrixCursor.RowBuilder row = cursor.newRow();
        row.add(DocumentsContract.Document.COLUMN_DOCUMENT_ID, folder.id);
        row.add(DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.MIME_TYPE_DIR);
        row.add(DocumentsContract.Document.COLUMN_DISPLAY_NAME, folder.name);
        row.add(DocumentsContract.Document.COLUMN_LAST_MODIFIED, 0L);
        row.add(DocumentsContract.Document.COLUMN_FLAGS, DocumentsContract.Document.FLAG_DIR_SUPPORTS_CREATE);
        row.add(DocumentsContract.Document.COLUMN_SIZE, null);
        row.add(DocumentsContract.Document.COLUMN_ICON, R.mipmap.ic_launcher);
    }

    private void includeFile(MatrixCursor cursor, DriveManifestStore.FileEntry file) {
        MatrixCursor.RowBuilder row = cursor.newRow();
        row.add(DocumentsContract.Document.COLUMN_DOCUMENT_ID, file.id);
        row.add(DocumentsContract.Document.COLUMN_MIME_TYPE, file.mimeType);
        row.add(DocumentsContract.Document.COLUMN_DISPLAY_NAME, file.name);
        row.add(DocumentsContract.Document.COLUMN_LAST_MODIFIED, file.uploadedAt);

        int flags = 0;
        if (file.isPendingImport) {
            flags |= DocumentsContract.Document.FLAG_SUPPORTS_WRITE;
        }

        row.add(DocumentsContract.Document.COLUMN_FLAGS, flags);
        row.add(DocumentsContract.Document.COLUMN_SIZE, file.size);
        row.add(DocumentsContract.Document.COLUMN_ICON, null);
    }

    private File ensureExportFile(
            DriveManifestStore.FileEntry file,
            @Nullable CancellationSignal signal
    ) throws IOException {
        Context context = ensureContext();
        File exportDirectory = DriveManifestStore.getExportsDirectory(context);
        File exportFile = new File(exportDirectory, file.hash + ".bin");

        if (exportFile.exists() && exportFile.length() > 0) {
            return exportFile;
        }

        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        ensureNotificationChannel(nm);

        int notifId = notifIdCounter.incrementAndGet();
        ProgressCallback onProgress = null;

        if (nm.areNotificationsEnabled()) {
            NotificationCompat.Builder notif = new NotificationCompat.Builder(context, DOWNLOAD_CHANNEL_ID)
                    .setContentTitle("Formstr Drive")
                    .setContentText("Downloading " + file.name)
                    .setSmallIcon(android.R.drawable.stat_sys_download)
                    .setProgress(100, 0, true)
                    .setOngoing(true)
                    .setSilent(true);
            nm.notify(notifId, notif.build());

            onProgress = (percent) -> {
                notif.setProgress(100, percent, false);
                nm.notify(notifId, notif.build());
            };
        }

        try {
            byte[] encryptedBlob = downloadEncryptedBlob(file.server, file.hash, signal, onProgress);
            byte[] decryptedBytes;

            try {
                decryptedBytes = DriveFilesCrypto.decryptEncryptedBlob(encryptedBlob, file.encryptionKey);
            } catch (Exception error) {
                throw new IOException("Failed to decrypt Drive file", error);
            }

            File tempFile = new File(exportDirectory, file.hash + ".tmp");
            try (FileOutputStream outputStream = new FileOutputStream(tempFile, false)) {
                outputStream.write(decryptedBytes);
                outputStream.flush();
            }

            if (exportFile.exists() && !exportFile.delete()) {
                throw new IOException("Failed to replace cached export");
            }

            if (!tempFile.renameTo(exportFile)) {
                throw new IOException("Failed to finalize cached export");
            }

            return exportFile;
        } finally {
            nm.cancel(notifId);
        }
    }

    private void ensureNotificationChannel(NotificationManager nm) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        if (nm.getNotificationChannel(DOWNLOAD_CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(
                DOWNLOAD_CHANNEL_ID, "Form* Drive Downloads", NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("File download progress");
        channel.setSound(null, null);
        nm.createNotificationChannel(channel);
    }

    private byte[] downloadEncryptedBlob(
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

            try (java.io.InputStream inputStream = connection.getInputStream();
                 java.io.ByteArrayOutputStream outputStream = new java.io.ByteArrayOutputStream()) {
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

    private Context ensureContext() throws FileNotFoundException {
        Context context = getContext();
        if (context == null) {
            throw new FileNotFoundException("Android context is not available");
        }
        return context;
    }

    private String sanitizeDisplayName(@Nullable String displayName) {
        if (displayName == null) {
            return "Untitled";
        }

        String sanitized = displayName.trim().replace('/', '_');
        return sanitized.isEmpty() ? "Untitled" : sanitized;
    }

    private String normalizeMimeType(@Nullable String mimeType) {
        if (mimeType == null || mimeType.trim().isEmpty()) {
            return "application/octet-stream";
        }
        return mimeType;
    }
}
