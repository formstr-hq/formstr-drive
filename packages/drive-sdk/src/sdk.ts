import { generateSecretKey } from "nostr-tools";
import { bytesToHex } from "nostr-tools/utils";
import { BlossomClient } from "./blossom";
import {
  aesGcmDecryptBytes,
  decryptFileWithKey,
  decryptNipFsChunk,
  deriveConversationKeyFromHex,
  encryptNipFsChunk,
} from "./crypto";
import { DriveSdkError } from "./errors";
import {
  DEFAULT_CHUNK_SIZE,
  buildDriveKeyEvent,
  buildFileDeletionEvent,
  buildFileMetadataEvent,
  createBlossomAuthHeader,
  createDriveKeyEntry,
  decryptFileMetadata,
  generateFileId,
  isLegacyFileMetadata,
  isNipFsFileMetadata,
  normalizeFolder,
  parseDriveKeyPayload,
  sha256Hex,
  type DriveKeyEntry,
} from "./protocol";
import { NostrRelayAdapter } from "./relay";
import { ManagedTransferTask } from "./transfer";
import type {
  ChunkRef,
  DriveBinarySource,
  DriveBlobClient,
  DriveDownloadOptions,
  DriveFile,
  DriveKeyValueStore,
  DrivePlatformAdapter,
  DriveRelayAdapter,
  DriveSigner,
  DriveTransferTask,
  DriveUploadOptions,
  FileMetadata,
  FolderInfo,
  NipFsFileMetadata,
  NostrEvent,
} from "./types";

const HEX_PUBKEY = /^[0-9a-f]{64}$/i;
const METADATA_KIND = 34578;

interface FileRecordBase {
  id: string;
  event: NostrEvent;
}

type FileRecord =
  | (FileRecordBase & { format: "nip-fs"; metadata: NipFsFileMetadata })
  | (FileRecordBase & { format: "legacy"; metadata: FileMetadata });

interface PreparedBlob {
  hash: string;
  server: string;
  read: () => Promise<Uint8Array>;
}

interface PreparedUpload {
  id: string;
  metadata: NipFsFileMetadata;
  chunks: PreparedBlob[];
  preview?: PreparedBlob;
  driveConversationKey: Uint8Array;
  signedMetadata: NostrEvent;
  uploadAuth: string;
}

export interface FormstrDriveSDKOptions {
  signer: DriveSigner;
  relays: readonly string[];
  blossomServers: readonly string[];
  relayAdapter?: DriveRelayAdapter;
  blobClientFactory?: (server: string) => DriveBlobClient;
  storage?: DriveKeyValueStore;
  platformAdapter?: DrivePlatformAdapter;
}

export class FormstrDriveSDK {
  readonly signer: DriveSigner;
  readonly relayAdapter: DriveRelayAdapter;
  readonly storage?: DriveKeyValueStore;
  readonly platformAdapter?: DrivePlatformAdapter;

  private readonly relayUrls: readonly string[];
  private readonly blossomUrls: readonly string[];
  private readonly blobClientFactory: (server: string) => DriveBlobClient;
  private readonly blobClients = new Map<string, DriveBlobClient>();
  private readonly records = new Map<string, FileRecord>();
  private driveKeyQueue: Promise<void> = Promise.resolve();
  private publicKey: string | null = null;
  private keyring: DriveKeyEntry[] | null = null;
  private foundDriveKeyEvents = false;

  constructor(options: FormstrDriveSDKOptions) {
    if (!options.signer) {
      throw new DriveSdkError("INVALID_CONFIGURATION", "A Drive signer is required");
    }
    if (options.relays.length === 0) {
      throw new DriveSdkError("INVALID_CONFIGURATION", "At least one Nostr relay is required");
    }
    if (options.blossomServers.length === 0) {
      throw new DriveSdkError("INVALID_CONFIGURATION", "At least one Blossom server is required");
    }

    this.signer = options.signer;
    this.relayAdapter = options.relayAdapter ?? new NostrRelayAdapter();
    this.blobClientFactory = options.blobClientFactory ?? ((server) => new BlossomClient(server));
    this.storage = options.storage;
    this.platformAdapter = options.platformAdapter;
    this.relayUrls = Object.freeze([...options.relays]);
    this.blossomUrls = Object.freeze(options.blossomServers.map(cleanServerUrl));
  }

  async initialize(): Promise<string> {
    let publicKey: string;
    try {
      publicKey = await this.signer.getPublicKey();
    } catch (error) {
      throw new DriveSdkError("SIGNER_UNAVAILABLE", "Unable to read the signer public key", error);
    }

    if (!HEX_PUBKEY.test(publicKey)) {
      throw new DriveSdkError("SIGNER_UNAVAILABLE", "The signer returned an invalid Nostr public key");
    }

    this.publicKey = publicKey.toLowerCase();
    return this.publicKey;
  }

  getPublicKey(): string {
    if (!this.publicKey) {
      throw new DriveSdkError("NOT_INITIALIZED", "Call initialize() before using the Drive SDK");
    }
    return this.publicKey;
  }

  get relays(): readonly string[] {
    return this.relayUrls;
  }

  get blossomServers(): readonly string[] {
    return this.blossomUrls;
  }

  /** Create and publish a new drive key encrypted to the user's identity key. */
  async createDriveKey(): Promise<void> {
    await this.withDriveKeyLock(() => this.createDriveKeyUnlocked());
  }

  private async createDriveKeyUnlocked(): Promise<void> {
    const pubkey = this.getPublicKey();
    if (!this.signer.nip44Encrypt) {
      throw new DriveSdkError(
        "SIGNER_UNAVAILABLE",
        "The signer must support NIP-44 encryption to create a drive key",
      );
    }

    await this.loadDriveKeys();
    const newestTimestamp = this.keyring?.[0]?.createdAt ?? 0;
    const entry = createDriveKeyEntry(
      Math.max(Math.floor(Date.now() / 1000), newestTimestamp + 1),
    );
    const payload = JSON.stringify({ encryptionKey: entry.secretKeyHex });
    const encryptedContent = await this.signer.nip44Encrypt(pubkey, payload);
    const event = buildDriveKeyEvent(pubkey, encryptedContent, entry.createdAt);
    const signed = await this.signer.signEvent(event);
    await this.relayAdapter.publish(this.relayUrls, signed);
    this.keyring = [entry, ...(this.keyring ?? [])];
    this.foundDriveKeyEvents = true;
  }

  /** List the latest decryptable event for every file ID. */
  async listFiles(): Promise<DriveFile[]> {
    const pubkey = this.getPublicKey();
    await this.loadDriveKeys();
    const events = await this.relayAdapter.query(this.relayUrls, {
      kinds: [METADATA_KIND, 5],
      authors: [pubkey],
    });

    const deletedAt = new Map<string, number>();
    const addressPrefix = `${METADATA_KIND}:${pubkey}:`;
    for (const event of events) {
      if (event.kind !== 5) continue;
      for (const tag of event.tags) {
        if (tag[0] !== "a" || !tag[1]?.startsWith(addressPrefix)) continue;
        const id = tag[1].slice(addressPrefix.length);
        deletedAt.set(id, Math.max(deletedAt.get(id) ?? 0, event.created_at));
      }
    }

    const latest = new Map<string, NostrEvent>();
    for (const event of [...events].sort((a, b) => b.created_at - a.created_at)) {
      if (event.kind !== METADATA_KIND) continue;
      const id = getTag(event, "d");
      if (!id || id.startsWith("0:") || latest.has(id)) continue;
      if ((deletedAt.get(id) ?? -1) >= event.created_at) continue;
      latest.set(id, event);
    }

    this.records.clear();
    const files: DriveFile[] = [];
    for (const [id, event] of latest) {
      const record = await this.decryptRecord(id, event);
      if (!record || (record.format === "legacy" && record.metadata.deleted)) continue;
      this.records.set(id, record);
      files.push(toDriveFile(record));
    }

    return files.sort((a, b) => b.uploadedAt - a.uploadedAt);
  }

  getFolders(files?: readonly DriveFile[]): FolderInfo[] {
    const source = files ?? Array.from(this.records.values(), toDriveFile);
    const paths = new Set<string>(["/"]);
    for (const file of source) {
      const parts = normalizeFolder(file.folder).split("/").filter(Boolean);
      let current = "";
      for (const part of parts) {
        current += `/${part}`;
        paths.add(current);
      }
    }

    return [...paths]
      .sort()
      .map((path) => ({
        path,
        name: path === "/" ? "/" : path.slice(path.lastIndexOf("/") + 1),
        fileCount: source.filter((file) => normalizeFolder(file.folder) === path).length,
      }));
  }

  upload(
    source: DriveBinarySource,
    options: DriveUploadOptions = {},
  ): DriveTransferTask<DriveFile> {
    this.getPublicKey();
    const taskId = generateFileId(12);
    let prepared: PreparedUpload | null = null;
    let needsFreshSignatures = false;
    let retryAfterCreatedAt = 0;

    return new ManagedTransferTask(taskId, async (signal, report) => {
      try {
        if (!prepared) {
          report({ state: "preparing", percent: 0, message: "Encrypting file chunks" });
          prepared = await this.prepareUpload(source, options, signal, report);
        }
        if (needsFreshSignatures) {
          prepared = await this.refreshUploadSignatures(
            prepared,
            retryAfterCreatedAt,
            signal,
            report,
          );
          needsFreshSignatures = false;
          retryAfterCreatedAt = 0;
        }
        throwIfAborted(signal);

        const uploaded: PreparedBlob[] = [];
        let metadataPublishAttempted = false;
        try {
          report({ state: "publishing-metadata", percent: 0 });
          metadataPublishAttempted = true;
          await this.relayAdapter.publish(this.relayUrls, prepared.signedMetadata);
          throwIfAborted(signal);

          if (prepared.preview) {
            report({ state: "uploading-preview", percent: 0 });
            await this.uploadBlob(prepared.preview, prepared.uploadAuth, signal, (percent) =>
              report({ state: "uploading-preview", percent }),
            );
            uploaded.push(prepared.preview);
          }

          for (let index = 0; index < prepared.chunks.length; index += 1) {
            const chunk = prepared.chunks[index]!;
            throwIfAborted(signal);
            await this.uploadBlob(chunk, prepared.uploadAuth, signal, (chunkPercent) => {
              const percent = Math.round(
                ((index + chunkPercent / 100) / prepared!.chunks.length) * 100,
              );
              report({
                state: "uploading-chunks",
                percent,
                currentChunk: index + 1,
                totalChunks: prepared!.chunks.length,
              });
            });
            uploaded.push(chunk);
          }
        } catch (error) {
          if (metadataPublishAttempted || uploaded.length > 0) {
            const deletionCreatedAt = await this.cleanupIncompleteUpload(prepared, uploaded);
            if (!signal.aborted) {
              needsFreshSignatures = true;
              retryAfterCreatedAt = Math.max(retryAfterCreatedAt, deletionCreatedAt);
            }
          }
          throw error;
        }

        const record: FileRecord = {
          id: prepared.id,
          event: prepared.signedMetadata,
          format: "nip-fs",
          metadata: prepared.metadata,
        };
        this.records.set(record.id, record);
        return toDriveFile(record);
      } catch (error) {
        if (signal.aborted) throw error;
        if (error instanceof DriveSdkError) throw error;
        const detail = error instanceof Error && error.message ? `: ${error.message}` : "";
        throw new DriveSdkError("TRANSFER_FAILED", `File upload failed${detail}`, error);
      }
    });
  }

  download(
    id: string,
    options: DriveDownloadOptions = {},
  ): DriveTransferTask<Uint8Array> {
    this.getPublicKey();
    const taskId = generateFileId(12);
    return new ManagedTransferTask(taskId, async (signal, report) => {
      const record = await this.getRecord(id);
      const metadata = record.metadata;
      const chunks = getStoredChunks(record);
      const decryptedChunks: Uint8Array[] = [];

      for (let index = 0; index < chunks.length; index += 1) {
        throwIfAborted(signal);
        const chunk = chunks[index]!;
        const server = cleanServerUrl(chunk.server ?? metadata.server);
        const encrypted = await this.getBlobClient(server).download(
          chunk.hash,
          undefined,
          undefined,
          signal,
        );

        let decrypted: Uint8Array;
        try {
          if (record.format === "nip-fs") {
            decrypted = await decryptNipFsChunk(encrypted, metadata.encryptionKey);
          } else if (metadata.chunks && metadata.chunks.length > 0) {
            decrypted = await aesGcmDecryptBytes(
              encrypted,
              deriveConversationKeyFromHex(metadata.encryptionKey),
              index,
            );
          } else {
            decrypted = await decryptFileWithKey(
              new TextDecoder().decode(encrypted),
              metadata.encryptionKey,
            );
          }
        } catch (error) {
          throw new DriveSdkError("DECRYPTION_ERROR", `Unable to decrypt chunk ${index + 1}`, error);
        }
        decryptedChunks.push(decrypted);
        report({
          state: "downloading",
          percent: Math.round(((index + 1) / chunks.length) * 100),
          currentChunk: index + 1,
          totalChunks: chunks.length,
        });
      }

      const result = concatenate(decryptedChunks);
      const expectedHash =
        record.format === "nip-fs" ? record.metadata.unencryptedFileHash : undefined;
      if (expectedHash && options.verifyHash !== false) {
        const actualHash = await sha256Hex(result);
        if (actualHash !== expectedHash) {
          throw new DriveSdkError("INTEGRITY_ERROR", "Downloaded file hash does not match metadata");
        }
      }
      return result;
    });
  }

  async getPreview(id: string): Promise<Uint8Array | null> {
    const record = await this.getRecord(id);
    const hash = record.metadata.previewHash;
    if (!hash) return null;
    const encrypted = await this.getBlobClient(record.metadata.server).download(hash);
    try {
      return record.format === "nip-fs"
        ? await decryptNipFsChunk(encrypted, record.metadata.encryptionKey)
        : await decryptFileWithKey(
            new TextDecoder().decode(encrypted),
            record.metadata.encryptionKey,
          );
    } catch (error) {
      throw new DriveSdkError("DECRYPTION_ERROR", "Unable to decrypt file preview", error);
    }
  }

  async renameFile(id: string, name: string): Promise<DriveFile> {
    if (!name.trim()) throw new DriveSdkError("INVALID_CONFIGURATION", "File name cannot be empty");
    return this.updateFile(id, { name: name.trim() });
  }

  async moveFile(id: string, folder: string): Promise<DriveFile> {
    return this.updateFile(id, { folder: normalizeFolder(folder) });
  }

  async deleteFile(id: string): Promise<void> {
    const pubkey = this.getPublicKey();
    const record = await this.getRecord(id);
    const blobs = getStoredChunks(record).map((chunk) => ({
      hash: chunk.hash,
      server: cleanServerUrl(chunk.server ?? record.metadata.server),
    }));
    if (record.metadata.previewHash) {
      blobs.unshift({
        hash: record.metadata.previewHash,
        server: cleanServerUrl(record.metadata.server),
      });
    }

    const unique = uniqueBlobs(blobs);
    if (unique.length > 0) {
      const auth = await createBlossomAuthHeader(
        this.signer,
        pubkey,
        "delete",
        unique.map((blob) => blob.hash),
        `Delete ${record.metadata.name} from Formstr Drive`,
      );
      for (const blob of unique) {
        try {
          await this.getBlobClient(blob.server).delete(blob.hash, auth);
        } catch {
          // Blob cleanup is best-effort. Keep trying the remaining blobs and
          // remove the index entry so an unavailable server cannot make a file
          // permanently impossible to delete from the drive.
        }
      }
    }

    const deletionCreatedAt = Math.max(
      Math.floor(Date.now() / 1000),
      record.event.created_at + 1,
    );
    const deletion = await this.signer.signEvent(
      buildFileDeletionEvent(pubkey, id, deletionCreatedAt),
    );
    await this.relayAdapter.publish(this.relayUrls, deletion);
    this.records.delete(id);
  }

  private async loadDriveKeys(): Promise<DriveKeyEntry[]> {
    if (this.keyring) return this.keyring;
    const pubkey = this.getPublicKey();
    const events = await this.relayAdapter.query(this.relayUrls, {
      kinds: [METADATA_KIND],
      authors: [pubkey],
      "#d": [`0:${pubkey}`],
    });
    this.foundDriveKeyEvents = events.length > 0;

    if (!this.signer.nip44Decrypt) {
      this.keyring = [];
      return this.keyring;
    }

    const seen = new Set<string>();
    const entries: DriveKeyEntry[] = [];
    for (const event of [...events].sort((a, b) => b.created_at - a.created_at)) {
      try {
        const plaintext = await this.signer.nip44Decrypt(pubkey, event.content);
        const secretKeyHex = parseDriveKeyPayload(plaintext);
        if (!secretKeyHex || seen.has(secretKeyHex)) continue;
        seen.add(secretKeyHex);
        entries.push({
          secretKeyHex,
          conversationKey: deriveConversationKeyFromHex(secretKeyHex),
          createdAt: event.created_at,
        });
      } catch {
        // A client must skip drive-key events it cannot decrypt.
      }
    }
    this.keyring = entries;
    return entries;
  }

  private async getActiveDriveKey(): Promise<DriveKeyEntry> {
    return this.withDriveKeyLock(async () => {
      const entries = await this.loadDriveKeys();
      if (entries[0]) return entries[0];
      if (this.foundDriveKeyEvents) {
        throw new DriveSdkError(
          "DRIVE_KEY_UNAVAILABLE",
          "Drive key events exist but none can be decrypted; refusing to replace them",
        );
      }
      await this.createDriveKeyUnlocked();
      return this.keyring![0]!;
    });
  }

  private async decryptRecord(id: string, event: NostrEvent): Promise<FileRecord | null> {
    const hasFilesTag = event.tags.some((tag) => tag[0] === "t" && tag[1] === "files");
    const attempts: Array<() => Promise<unknown>> = [];

    if (hasFilesTag) {
      for (const key of this.keyring ?? []) {
        attempts.push(async () => decryptFileMetadata(event.content, key.conversationKey));
      }
      attempts.push(() => this.decryptWithIdentity(event.content));
    } else {
      attempts.push(() => this.decryptWithIdentity(event.content));
      for (const key of this.keyring ?? []) {
        attempts.push(async () => decryptFileMetadata(event.content, key.conversationKey));
      }
    }

    for (const attempt of attempts) {
      try {
        const value = await attempt();
        if (isNipFsFileMetadata(value)) {
          return { id, event, format: "nip-fs", metadata: value };
        }
        if (isLegacyFileMetadata(value)) {
          return { id, event, format: "legacy", metadata: value };
        }
      } catch {
        // Try the next drive key or the legacy identity-key format.
      }
    }
    return null;
  }

  private async decryptWithIdentity(ciphertext: string): Promise<unknown> {
    if (!this.signer.nip44Decrypt) throw new Error("NIP-44 decryption unavailable");
    const plaintext = await this.signer.nip44Decrypt(this.getPublicKey(), ciphertext);
    return JSON.parse(plaintext);
  }

  private async prepareUpload(
    source: DriveBinarySource,
    options: DriveUploadOptions,
    signal: AbortSignal,
    report: (progress: {
      state: "preparing" | "awaiting-signature";
      percent?: number;
      currentChunk?: number;
      totalChunks?: number;
      message?: string;
    }) => void,
  ): Promise<PreparedUpload> {
    const pubkey = this.getPublicKey();
    const driveKey = await this.getActiveDriveKey();
    const id = generateFileId();
    const name = options.name ?? sourceName(source);
    if (!name) {
      throw new DriveSdkError("INVALID_CONFIGURATION", "A file name is required for this source");
    }
    const size = sourceSize(source);
    const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) {
      throw new DriveSdkError("INVALID_CONFIGURATION", "Chunk size must be a positive integer");
    }
    const server = cleanServerUrl(options.server ?? this.blossomUrls[0]!);
    const encryptionKey = bytesToHex(generateSecretKey());
    const totalChunks = Math.max(1, Math.ceil(size / chunkSize));
    const chunks: PreparedBlob[] = [];

    for (let index = 0; index < totalChunks; index += 1) {
      throwIfAborted(signal);
      const plaintext = await readSourceSlice(
        source,
        index * chunkSize,
        Math.min(size, (index + 1) * chunkSize),
      );
      const nonce = crypto.getRandomValues(new Uint8Array(32));
      const bytes = await encryptNipFsChunk(plaintext, encryptionKey, nonce);
      const start = index * chunkSize;
      const end = Math.min(size, (index + 1) * chunkSize);
      chunks.push({
        hash: await sha256Hex(bytes),
        server,
        read: async () =>
          // Re-encrypt with the same nonce during upload/retry. This keeps
          // preparation memory bounded to one chunk without changing its hash.
          encryptNipFsChunk(
            await readSourceSlice(source, start, end),
            encryptionKey,
            nonce,
          ),
      });
      report({
        state: "preparing",
        percent: Math.round(((index + 1) / totalChunks) * 80),
        currentChunk: index + 1,
        totalChunks,
      });
    }

    let preview: PreparedBlob | undefined;
    if (options.preview) {
      const previewPlaintext = await readWholeSource(options.preview);
      const nonce = crypto.getRandomValues(new Uint8Array(32));
      const bytes = await encryptNipFsChunk(previewPlaintext, encryptionKey, nonce);
      preview = {
        hash: await sha256Hex(bytes),
        server,
        read: () => encryptNipFsChunk(previewPlaintext, encryptionKey, nonce),
      };
    }

    let unencryptedFileHash: string | undefined;
    if (options.includeUnencryptedHash) {
      unencryptedFileHash = await sha256Hex(await readWholeSource(source));
    }

    const metadata: NipFsFileMetadata = {
      name,
      ...(unencryptedFileHash ? { unencryptedFileHash } : {}),
      size,
      type: options.type ?? sourceType(source) ?? "application/octet-stream",
      folder: normalizeFolder(options.folder),
      uploadedAt: Date.now(),
      server,
      encryptionKey,
      encryptionAlgorithm: "aes-gcm",
      ...(preview ? { previewHash: preview.hash } : {}),
      chunks: chunks.map((chunk) => ({ hash: chunk.hash })),
    };

    report({ state: "awaiting-signature", percent: 85, message: "Signing file metadata" });
    const metadataEvent = buildFileMetadataEvent(
      pubkey,
      id,
      metadata,
      driveKey.conversationKey,
    );
    const signedMetadata = await this.signer.signEvent(metadataEvent);
    throwIfAborted(signal);

    report({ state: "awaiting-signature", percent: 95, message: "Signing Blossom upload access" });
    const hashes = [...(preview ? [preview.hash] : []), ...chunks.map((chunk) => chunk.hash)];
    const uploadAuth = await createBlossomAuthHeader(
      this.signer,
      pubkey,
      "upload",
      hashes,
      `Upload ${name} to Formstr Drive`,
      6 * 60 * 60,
    );
    return {
      id,
      metadata,
      chunks,
      preview,
      driveConversationKey: driveKey.conversationKey,
      signedMetadata,
      uploadAuth,
    };
  }

  private async refreshUploadSignatures(
    prepared: PreparedUpload,
    retryAfterCreatedAt: number,
    signal: AbortSignal,
    report: (progress: {
      state: "preparing" | "awaiting-signature";
      percent?: number;
      currentChunk?: number;
      totalChunks?: number;
      message?: string;
    }) => void,
  ): Promise<PreparedUpload> {
    const pubkey = this.getPublicKey();
    const createdAt = Math.max(
      Math.floor(Date.now() / 1000),
      prepared.signedMetadata.created_at + 1,
      retryAfterCreatedAt + 1,
    );

    report({
      state: "awaiting-signature",
      percent: 85,
      message: "Signing a fresh file metadata event",
    });
    const signedMetadata = await this.signer.signEvent(
      buildFileMetadataEvent(
        pubkey,
        prepared.id,
        prepared.metadata,
        prepared.driveConversationKey,
        createdAt,
      ),
    );
    throwIfAborted(signal);

    report({
      state: "awaiting-signature",
      percent: 95,
      message: "Signing fresh Blossom upload access",
    });
    const hashes = [
      ...(prepared.preview ? [prepared.preview.hash] : []),
      ...prepared.chunks.map((chunk) => chunk.hash),
    ];
    const uploadAuth = await createBlossomAuthHeader(
      this.signer,
      pubkey,
      "upload",
      hashes,
      `Upload ${prepared.metadata.name} to Formstr Drive`,
      6 * 60 * 60,
    );
    throwIfAborted(signal);
    return { ...prepared, signedMetadata, uploadAuth };
  }

  private async uploadBlob(
    blob: PreparedBlob,
    auth: string,
    signal: AbortSignal,
    onProgress: (percent: number) => void,
  ): Promise<void> {
    const bytes = await blob.read();
    const returnedHash = await this.getBlobClient(blob.server).upload(
      bytes,
      auth,
      onProgress,
      signal,
    );
    if (/^[0-9a-f]{64}$/i.test(returnedHash) && returnedHash.toLowerCase() !== blob.hash) {
      throw new DriveSdkError("INTEGRITY_ERROR", "Blossom returned a different blob hash");
    }
  }

  private async cleanupIncompleteUpload(
    prepared: PreparedUpload,
    uploaded: readonly PreparedBlob[],
  ): Promise<number> {
    const pubkey = this.getPublicKey();
    const blobs = uniqueBlobs(uploaded);
    const deletionCreatedAt = Math.max(
      Math.floor(Date.now() / 1000),
      prepared.signedMetadata.created_at + 1,
    );
    if (blobs.length > 0) {
      try {
        const auth = await createBlossomAuthHeader(
          this.signer,
          pubkey,
          "delete",
          blobs.map((blob) => blob.hash),
          `Clean up incomplete upload of ${prepared.metadata.name}`,
        );
        for (const blob of blobs) {
          try {
            await this.getBlobClient(blob.server).delete(blob.hash, auth);
          } catch {
            // A blob server failure must not leave the already-published file
            // metadata visible. Continue cleaning up the remaining blobs.
          }
        }
      } catch {
        // The metadata deletion below is independent and must still be tried.
      }
    }
    try {
      const deletion = await this.signer.signEvent(
        buildFileDeletionEvent(pubkey, prepared.id, deletionCreatedAt),
      );
      await this.relayAdapter.publish(this.relayUrls, deletion);
    } catch {
      // Cleanup remains best-effort; a retry publishes newer metadata for the
      // same file ID and is still safe.
    }
    return deletionCreatedAt;
  }

  private withDriveKeyLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.driveKeyQueue.then(operation, operation);
    this.driveKeyQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async updateFile(
    id: string,
    updates: Pick<Partial<NipFsFileMetadata>, "name" | "folder">,
  ): Promise<DriveFile> {
    const record = await this.getRecord(id);
    const driveKey = await this.getActiveDriveKey();
    const createdAt = Math.max(Math.floor(Date.now() / 1000), record.event.created_at + 1);
    const metadata = { ...record.metadata, ...updates };
    const event = buildFileMetadataEvent(
      this.getPublicKey(),
      id,
      metadata,
      driveKey.conversationKey,
      createdAt,
    );
    const signed = await this.signer.signEvent(event);
    await this.relayAdapter.publish(this.relayUrls, signed);
    const updated: FileRecord = record.format === "nip-fs"
      ? { id, event: signed, format: "nip-fs", metadata: metadata as NipFsFileMetadata }
      : { id, event: signed, format: "legacy", metadata: metadata as FileMetadata };
    this.records.set(id, updated);
    return toDriveFile(updated);
  }

  private async getRecord(id: string): Promise<FileRecord> {
    let record = this.records.get(id);
    if (!record) {
      await this.listFiles();
      record = this.records.get(id);
    }
    if (!record) throw new DriveSdkError("FILE_NOT_FOUND", `File ${id} was not found`);
    return record;
  }

  private getBlobClient(server: string): DriveBlobClient {
    const baseUrl = cleanServerUrl(server);
    let client = this.blobClients.get(baseUrl);
    if (!client) {
      client = this.blobClientFactory(baseUrl);
      this.blobClients.set(baseUrl, client);
    }
    return client;
  }
}

function getTag(event: NostrEvent, name: string): string | undefined {
  return event.tags.find((tag) => tag[0] === name)?.[1];
}

function cleanServerUrl(server: string): string {
  return server.replace(/\/+$/u, "");
}

function sourceName(source: DriveBinarySource): string | undefined {
  return source instanceof Blob && "name" in source && typeof source.name === "string"
    ? source.name
    : undefined;
}

function sourceType(source: DriveBinarySource): string | undefined {
  return source instanceof Blob && source.type ? source.type : undefined;
}

function sourceSize(source: DriveBinarySource): number {
  if (source instanceof Blob) return source.size;
  return source.byteLength;
}

async function readSourceSlice(
  source: DriveBinarySource,
  start: number,
  end: number,
): Promise<Uint8Array> {
  if (source instanceof Blob) {
    return new Uint8Array(await source.slice(start, end).arrayBuffer());
  }
  if (source instanceof Uint8Array) return source.slice(start, end);
  return new Uint8Array(source.slice(start, end));
}

async function readWholeSource(source: DriveBinarySource): Promise<Uint8Array> {
  return readSourceSlice(source, 0, sourceSize(source));
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Transfer aborted", "AbortError");
}

function getStoredChunks(record: FileRecord): ChunkRef[] {
  if (record.format === "nip-fs") return record.metadata.chunks;
  const chunks = record.metadata.chunks as ReadonlyArray<ChunkRef | string> | undefined;
  if (chunks && chunks.length > 0) {
    return chunks.map((chunk) => (typeof chunk === "string" ? { hash: chunk } : chunk));
  }
  return [{ hash: record.metadata.hash }];
}

function toDriveFile(record: FileRecord): DriveFile {
  const metadata = record.metadata;
  const unencryptedFileHash =
    record.format === "nip-fs" ? record.metadata.unencryptedFileHash : undefined;
  return {
    id: record.id,
    eventId: record.event.id,
    createdAt: record.event.created_at,
    format: record.format,
    name: metadata.name,
    ...(unencryptedFileHash
      ? { unencryptedFileHash }
      : {}),
    size: metadata.size,
    type: metadata.type,
    folder: normalizeFolder(metadata.folder),
    uploadedAt: metadata.uploadedAt,
    server: metadata.server,
    encryptionKey: metadata.encryptionKey,
    encryptionAlgorithm: metadata.encryptionAlgorithm,
    ...(metadata.previewHash ? { previewHash: metadata.previewHash } : {}),
    chunks: getStoredChunks(record),
  };
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function uniqueBlobs<T extends { hash: string; server: string }>(blobs: readonly T[]): T[] {
  const seen = new Set<string>();
  return blobs.filter((blob) => {
    const key = `${blob.server}\u0000${blob.hash}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
