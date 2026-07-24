package com.formstr.drive.files;

import android.app.NotificationManager;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
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
import android.graphics.Point;
import android.content.res.AssetFileDescriptor;

import java.util.List;
import java.util.UUID;

public class DriveFilesDocumentsProvider extends DocumentsProvider {
    private static final String TAG = "DriveFilesProvider";
    private static final String ROOT_SUMMARY_EMPTY = "Open the app to sign in and sync files";
    private static final String ROOT_SUMMARY_READY = "Browse the latest synced Drive snapshot";

    private static final AtomicInteger notifIdCounter = new AtomicInteger(0);

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
    public AssetFileDescriptor openDocumentThumbnail(String documentId, Point sizeHint, CancellationSignal signal) throws FileNotFoundException {
        DriveManifestStore.DriveManifest manifest = loadManifestOrThrow();
        DriveManifestStore.FileEntry file = manifest.getFileById(documentId);
        if (file == null || file.previewHash == null || file.previewHash.isEmpty()) {
            throw new FileNotFoundException("No thumbnail available for: " + documentId);
        }

        try {
            File thumbnailFile = ensureThumbnailFile(file, signal);
            ParcelFileDescriptor pfd = ParcelFileDescriptor.open(thumbnailFile, ParcelFileDescriptor.MODE_READ_ONLY);
            return new AssetFileDescriptor(pfd, 0, AssetFileDescriptor.UNKNOWN_LENGTH);
        } catch (IOException error) {
            Log.e(TAG, "Failed to export Drive file thumbnail", error);
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
        if (file.previewHash != null && !file.previewHash.isEmpty()) {
            flags |= DocumentsContract.Document.FLAG_SUPPORTS_THUMBNAIL;
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
        DriveFileDownloader.ensureNotificationChannel(nm);

        int notifId = notifIdCounter.incrementAndGet();
        final DriveFileDownloader.ProgressCallback finalOnProgress;

        if (nm.areNotificationsEnabled()) {
            NotificationCompat.Builder notif = new NotificationCompat.Builder(context, DriveFileDownloader.DOWNLOAD_CHANNEL_ID)
                    .setContentTitle("Formstr Drive")
                    .setContentText("Downloading " + file.name)
                    .setSmallIcon(android.R.drawable.stat_sys_download)
                    .setProgress(100, 0, true)
                    .setOngoing(true)
                    .setSilent(true);
            nm.notify(notifId, notif.build());

            finalOnProgress = (percent) -> {
                notif.setProgress(100, percent, false);
                nm.notify(notifId, notif.build());
            };
        } else {
            finalOnProgress = null;
        }

        try {
            File tempFile = new File(exportDirectory, file.hash + ".tmp");
            try (FileOutputStream outputStream = new FileOutputStream(tempFile, false)) {
                DriveFileDownloader.downloadAndDecryptToStream(
                        file.server,
                        file.chunks,
                        file.hash,
                        file.encryptionKey,
                        file.protocol,
                        outputStream,
                        finalOnProgress,
                        signal
                );
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

    private File ensureThumbnailFile(
            DriveManifestStore.FileEntry file,
            @Nullable CancellationSignal signal
    ) throws IOException {
        Context context = ensureContext();
        File thumbnailsDirectory = new File(context.getFilesDir(), "drive-thumbnails");
        if (!thumbnailsDirectory.exists() && !thumbnailsDirectory.mkdirs()) {
            throw new IOException("Failed to create thumbnails directory");
        }
        
        File thumbnailFile = new File(thumbnailsDirectory, file.previewHash + ".bin");
        if (thumbnailFile.exists() && thumbnailFile.length() > 0) {
            return thumbnailFile;
        }

        byte[] encryptedBlob = DriveFileDownloader.downloadEncryptedBlob(file.server, file.previewHash, signal, null);
        byte[] decryptedBytes;

        try {
            decryptedBytes = DriveFilesCrypto.decryptEncryptedBlob(encryptedBlob, file.encryptionKey);
        } catch (Exception error) {
            throw new IOException("Failed to decrypt Drive file thumbnail", error);
        }

        File tempFile = new File(thumbnailsDirectory, file.previewHash + ".tmp");
        try (FileOutputStream outputStream = new FileOutputStream(tempFile, false)) {
            outputStream.write(decryptedBytes);
            outputStream.flush();
        }

        if (thumbnailFile.exists() && !thumbnailFile.delete()) {
            throw new IOException("Failed to replace cached thumbnail");
        }

        if (!tempFile.renameTo(thumbnailFile)) {
            throw new IOException("Failed to finalize cached thumbnail");
        }

        return thumbnailFile;
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
