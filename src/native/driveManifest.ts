import { registerPlugin } from "@capacitor/core";
import type { FileMetadata } from "../types/metadata";
import { isAndroidPlatform } from "../utils/platform";

type DriveFilesPlugin = {
  updateManifest(options: { manifestJson: string }): Promise<void>;
  clearManifest(): Promise<void>;
  listPendingImports(): Promise<{ imports: NativePendingImportEntry[] }>;
  readPendingImport(options: { id: string }): Promise<{
    id: string;
    name: string;
    mimeType: string;
    size: number;
    folderPath: string;
    base64: string;
  }>;
  removePendingImport(options: { id: string }): Promise<void>;
  saveToDownloads(options: { base64: string; fileName: string; mimeType: string }): Promise<{ uri: string }>;
};

export const ROOT_DOCUMENT_ID = "root";
const FOLDER_DOCUMENT_PREFIX = "folder:";
const FILE_DOCUMENT_PREFIX = "file:";

export interface NativeDriveFolderEntry {
  id: string;
  path: string;
  name: string;
  parentId: string;
}

export interface NativeDriveFileEntry {
  id: string;
  hash: string;
  name: string;
  mimeType: string;
  size: number;
  folderPath: string;
  parentId: string;
  uploadedAt: number;
  server: string;
  encryptionKey: string;
}

export interface NativeDriveManifest {
  version: 1;
  syncedAt: number;
  folders: NativeDriveFolderEntry[];
  files: NativeDriveFileEntry[];
}

export interface NativePendingImportEntry {
  id: string;
  documentId: string;
  name: string;
  mimeType: string;
  size: number;
  folderPath: string;
  parentId: string;
  createdAt: number;
}

const driveFilesPlugin = isAndroidPlatform
  ? registerPlugin<DriveFilesPlugin>("DriveFiles")
  : null;

export function normalizeFolderPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed || trimmed === "/") {
    return "/";
  }

  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const collapsed = withLeadingSlash.replace(/\/+/g, "/");
  return collapsed.length > 1 ? collapsed.replace(/\/$/, "") : collapsed;
}

function getParentFolderPath(path: string): string {
  const normalized = normalizeFolderPath(path);
  if (normalized === "/") {
    return ROOT_DOCUMENT_ID;
  }

  const lastSlashIndex = normalized.lastIndexOf("/");
  if (lastSlashIndex <= 0) {
    return ROOT_DOCUMENT_ID;
  }

  return normalized.slice(0, lastSlashIndex) || "/";
}

function getFolderName(path: string): string {
  const normalized = normalizeFolderPath(path);
  if (normalized === "/") {
    return "My Drive";
  }

  return normalized.split("/").filter(Boolean).at(-1) ?? normalized;
}

function toFolderDocumentId(path: string): string {
  return `${FOLDER_DOCUMENT_PREFIX}${normalizeFolderPath(path)}`;
}

function toFileDocumentId(hash: string): string {
  return `${FILE_DOCUMENT_PREFIX}${hash}`;
}

function deriveFolderPaths(files: FileMetadata[], customFolders: string[]): string[] {
  const folderPaths = new Set<string>();

  for (const folder of customFolders) {
    const normalized = normalizeFolderPath(folder);
    if (normalized === "/") {
      continue;
    }

    const parts = normalized.split("/").filter(Boolean);
    let currentPath = "";

    for (const part of parts) {
      currentPath += `/${part}`;
      folderPaths.add(currentPath);
    }
  }

  for (const file of files) {
    const normalized = normalizeFolderPath(file.folder);
    if (normalized === "/") {
      continue;
    }

    const parts = normalized.split("/").filter(Boolean);
    let currentPath = "";

    for (const part of parts) {
      currentPath += `/${part}`;
      folderPaths.add(currentPath);
    }
  }

  return Array.from(folderPaths).sort((left, right) => {
    const depthDiff =
      left.split("/").filter(Boolean).length - right.split("/").filter(Boolean).length;

    if (depthDiff !== 0) {
      return depthDiff;
    }

    return left.localeCompare(right);
  });
}

export function buildNativeDriveManifest(
  files: FileMetadata[],
  customFolders: string[],
): NativeDriveManifest {
  const folderPaths = deriveFolderPaths(files, customFolders);

  const folders: NativeDriveFolderEntry[] = folderPaths.map((path) => {
    const parentPath = getParentFolderPath(path);

    return {
      id: toFolderDocumentId(path),
      path,
      name: getFolderName(path),
      parentId:
        parentPath === ROOT_DOCUMENT_ID
          ? ROOT_DOCUMENT_ID
          : toFolderDocumentId(parentPath),
    };
  });

  const driveFiles: NativeDriveFileEntry[] = files.map((file) => {
    const folderPath = normalizeFolderPath(file.folder);

    return {
      id: toFileDocumentId(file.hash),
      hash: file.hash,
      name: file.name,
      mimeType: file.type || "application/octet-stream",
      size: file.size,
      folderPath,
      parentId:
        folderPath === "/" ? ROOT_DOCUMENT_ID : toFolderDocumentId(folderPath),
      uploadedAt: file.uploadedAt,
      server: file.server,
      encryptionKey: file.encryptionKey,
    };
  });

  return {
    version: 1,
    syncedAt: Date.now(),
    folders,
    files: driveFiles,
  };
}

export async function syncNativeDriveManifest(
  files: FileMetadata[],
  customFolders: string[],
): Promise<void> {
  if (!driveFilesPlugin) {
    return;
  }

  const manifest = buildNativeDriveManifest(files, customFolders);
  await driveFilesPlugin.updateManifest({
    manifestJson: JSON.stringify(manifest),
  });
}

export async function clearNativeDriveManifest(): Promise<void> {
  if (!driveFilesPlugin) {
    return;
  }

  await driveFilesPlugin.clearManifest();
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

export async function listPendingNativeImports(): Promise<NativePendingImportEntry[]> {
  if (!driveFilesPlugin) {
    return [];
  }

  const response = await driveFilesPlugin.listPendingImports();
  return response.imports ?? [];
}

export async function readPendingNativeImport(
  id: string,
): Promise<{
  id: string;
  name: string;
  mimeType: string;
  size: number;
  folderPath: string;
  bytes: Uint8Array;
} | null> {
  if (!driveFilesPlugin) {
    return null;
  }

  const response = await driveFilesPlugin.readPendingImport({ id });
  return {
    id: response.id,
    name: response.name,
    mimeType: response.mimeType,
    size: response.size,
    folderPath: response.folderPath,
    bytes: base64ToUint8Array(response.base64),
  };
}

export async function removePendingNativeImport(id: string): Promise<void> {
  if (!driveFilesPlugin) {
    return;
  }

  await driveFilesPlugin.removePendingImport({ id });
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export async function saveFileToDownloads(
  bytes: Uint8Array,
  fileName: string,
  mimeType: string,
): Promise<void> {
  if (isAndroidPlatform && driveFilesPlugin) {
    const base64 = uint8ArrayToBase64(bytes);
    await driveFilesPlugin.saveToDownloads({ base64, fileName, mimeType });
    return;
  }

  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeType }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}
