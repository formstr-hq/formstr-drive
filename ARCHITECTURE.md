# Formstr Drive - Technical Architecture

## Overview

Formstr Drive is an experimental, end-to-end encrypted file store built on **Nostr** (identity, signing and the file index) and **Blossom** (blob storage). File contents are encrypted on the client and stored as opaque blobs on Blossom servers. The file index (names, folders, sizes, keys) is stored as encrypted Nostr events on relays. Only the holder of the Nostr identity key can recover the keys needed to read either.

It ships as a web app and as an Android app (Capacitor).

## High-Level Architecture

```
┌──────────────────────────────────────────────┐
│ Client (React web app / Capacitor Android)   │
│                                              │
│  UI ── transfer queue ── crypto (WebCrypto)  │
│   │                                          │
│   ├── signer (@formstr/signer)               │
│   └── data layer (@formstr/local-relay)      │
│        └─ relay worker + IndexedDB cache     │
└────────┬───────────────────────┬─────────────┘
         │                       │
         ▼                       ▼
┌─────────────────┐     ┌──────────────────┐
│ Nostr relays    │     │ Blossom servers  │
│ - Drive Key     │     │ - Encrypted      │
│ - File index    │     │   chunks         │
│ - Server lists  │     │ - Encrypted      │
│                 │     │   previews       │
└─────────────────┘     └──────────────────┘
```

### Components

1. **Client app**: React 19 + Vite. Encrypts, hashes, uploads and downloads in the client.
2. **Signer** (`src/signer/`): wraps `@formstr/signer`. Holds identity and account state, and signs events and NIP-44 payloads. See [Authentication & Identity](#authentication--identity).
3. **Data layer** (`src/dataLayer/`, `src/worker/relay.worker.ts`): `@formstr/local-relay` runs a local relay in a web worker, backed by an IndexedDB cache. The app reads and writes events through it, and the worker syncs with upstream relays.
4. **Nostr relays**: store the Drive Key event and the encrypted file index.
5. **Blossom servers**: store encrypted blobs.
6. **Android native layer** (`src/native/driveManifest.ts` plus a Capacitor plugin): background uploads and downloads, notifications, and importing files shared into the app.

## Key Hierarchy

There are three layers of key, and the split is the core of the design:

| Key                                | Where it lives                                                                 | What it protects                           |
| ---------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------ |
| **Identity key** (Nostr key)       | The signer (extension, bunker, native signer app, or passphrase-encrypted local key) | The Drive Key event; Blossom auth events   |
| **Drive Key** (random secp256k1 key) | Kind 34578 event, NIP-44 encrypted to the identity key; decrypted copy only in memory | Every file metadata event                  |
| **File key** (random secp256k1 key per file) | Inside that file's encrypted metadata                                  | The file's chunks and preview              |

Why a Drive Key at all: encrypting every metadata event through the signer means one signer round-trip (and often a user prompt) per file when loading the index. With a Drive Key the signer decrypts one small event once, and all file metadata is then decrypted locally with WebCrypto-speed NIP-44.

## Nostr Events Used

### 1. Kind 24242 - Blossom Authorization

**Purpose:** Short-lived bearer tokens for Blossom upload, get and delete requests.

**Location:** `src/auth.ts`

```json
{
  "kind": 24242,
  "pubkey": "<user's public key>",
  "content": "Upload filename.txt",
  "created_at": 1234567890,
  "tags": [
    ["t", "upload"],
    ["x", "<sha256 of blob 1>"],
    ["x", "<sha256 of blob 2>"],
    ["expiration", "1234569690"]
  ]
}
```

- `t` is the verb: `upload`, `get` or `delete`.
- One `x` tag per blob hash scopes the token to exactly those blobs (BUD-11 tag scoping), so a **single signature covers every chunk of a file plus its preview**.
- The signed event is base64-encoded and sent as `Authorization: Nostr <base64>`.
- Expiry depends on the operation: 60 seconds by default, 30 minutes for uploads, 10 minutes for deletes, and 6 hours when the token must outlive the foreground app so a native background upload can finish (`BACKGROUND_UPLOAD_AUTH_EXPIRATION_SECONDS`).

### 2. Kind 34578 - Drive Key and File Index (parameterized replaceable)

Both the Drive Key and every file's metadata are kind 34578 (NIP-78 application-specific data). They are told apart by the `d` tag.

**Drive Key event** (`src/services/driveKey.ts`)

```json
{
  "kind": 34578,
  "tags": [
    ["d", "0:<user pubkey>"],
    ["client", "formstr-drive"]
  ],
  "content": "<NIP-44 to the identity key of: [[\"encryptionKey\", \"<64 hex>\"]]>"
}
```

**File metadata event** (`src/services/fileIndex.ts`)

```json
{
  "kind": 34578,
  "tags": [
    ["d", "<file hash>"],
    ["t", "files"],
    ["client", "formstr-drive"],
    ["encrypted", "nip44"]
  ],
  "content": "<NIP-44 FileMetadata JSON, encrypted with the Drive Key>"
}
```

**Encrypted content** (`src/types/metadata.ts`):

```typescript
{
  name: "document.pdf",
  hash: "abc123...",              // hash of the first chunk; also the `d` tag
  size: 123456,
  type: "application/pdf",
  folder: "/work/docs",
  uploadedAt: 1234567890,
  server: "https://blossom.primal.net",
  encryptionKey: "deadbeef...",   // this file's secret key (hex)
  encryptionAlgorithm: "aes-gcm",
  chunks: [{ hash: "abc123...", server?: "https://..." }],
  previewHash?: "...",            // encrypted preview blob, if any
  deleted?: true                  // tombstone
}
```

`chunks[].server` is optional and only set when a chunk lives on a different server than `server`. Older metadata stores `chunks` as bare hash strings; `chunkHashes()` reads both forms.

**Why parameterized replaceable:** a new event with the same `d` tag supersedes the old one, so rename, move and delete are just a republish. The newest event per hash wins.

**Reading the index:**

1. Resolve the **Drive Key keyring** (below).
2. Observe kind 34578 events for the user. Events whose `d` starts with `0:` are the Drive Key, not files, and are skipped.
3. Events tagged `["t","files"]` are decrypted with each Drive Key in turn until the NIP-44 MAC validates.
4. Events without that tag, or that no Drive Key can open, are **legacy**: encrypted directly to the identity key through the signer. They are still shown and are re-saved under the Drive Key in the background (`autoMigrateLegacyFiles`).
5. The newest event per `d` tag wins. A failed decrypt of the newest event is still recorded, so an older decryptable version cannot resurrect a file that was superseded.

**Drive Key keyring** (`getDriveKeyring`):

- A user can end up with more than one Drive Key (for example two devices creating one before syncing). All are kept; the **newest** is the active key used to encrypt new metadata, and every key is tried when decrypting.
- Only the still-encrypted key events are cached on disk, namespaced per pubkey. Decrypted keys live in memory and are cleared on logout.
- A returning user opens from cache and reconciles with relays in the background.
- A new key is offered **only** when relays are reachable, report no Drive Key, and the local cache is empty. If key events exist but cannot be decrypted, or relays are unreachable, the app errors instead of offering to create a key, since that would orphan existing files.

**Deleting a file** (`FileIndexProvider.deleteFile`):

1. Sign one kind 24242 `delete` token covering all chunk hashes and the preview.
2. Send Blossom `DELETE` for each chunk on that chunk's server, then for the preview. Each is best-effort: one failure does not stop the rest, because an orphaned blob is better than a file stuck in the index.
3. Publish a new metadata event with `deleted: true` as a tombstone. Tombstoned files are hidden from the UI.

### 3. Kind 36363 - Blossom Server Announcements

**Purpose:** discover Blossom servers announced by operators.

**Location:** `src/Provider/BlossomServerProvider.tsx`

```json
{ "kind": 36363, "tags": [["d", "https://blossom.example.com"]] }
```

- A standing observer on the data layer picks up announcements (cached ones instantly, new ones live) and merges them with the defaults (`nostr.download`, `blossom.primal.net`, `blossom.oxtr.dev`) and any custom servers the user added.
- Upload goes to the server currently selected in the UI. The server is recorded per file (and optionally per chunk) in the metadata, so files can live on different servers.

## File Encryption

Each file gets its own random keypair. The file key's **conversation key** (`nip44.v2.getConversationKey(secret, ownPubkey)`) is the root for that file's encryption. File encryption does not use the signer, so it is not limited by extension timeouts or prompt latency.

### Chunks (`src/crypto.ts`: `aesGcmEncryptBytes`)

Files are split into **50 MB chunks** (`CHUNK_SIZE`). Each chunk is encrypted as raw bytes (no base64):

1. `salt = HMAC-SHA256(conversationKey, chunkIndex)` (4-byte big-endian index). It is deterministic, so it is not stored.
2. HKDF-SHA256 with that salt and info `"nip44-v2"` derives a 32-byte key and a 12-byte nonce.
3. AES-GCM encrypts the chunk with the 4-byte chunk index as **AAD**, so chunks cannot be reordered or swapped between positions.
4. Blob format v3: `version (1 byte = 3) | ciphertext`.

Decryption also reads the legacy **v2** format (`version = 2 | salt (32) | ciphertext`), so older uploads keep working.

Nonce reuse is not a concern here because the conversation key is unique per file and the index is unique per chunk.

### Previews

For images, videos and PDFs, a small encrypted preview (image thumbnail, video frame, PDF first page) is uploaded alongside the file. It uses the older whole-payload path: base64, `aesGcmEncrypt`, format `version | nonce | ciphertext`. Its hash is stored as `previewHash`. Preview upload is best-effort: failure never fails the file.

### Security model

- **Blossom servers** see encrypted chunks. They cannot decrypt them.
- **Relays** see encrypted events. Visible metadata is the event kind, the `d` tag (a file hash or `0:<pubkey>`), timestamps and the `client` tag. Names, sizes, folders and keys are inside the ciphertext.
- **The user** needs the identity key to decrypt the Drive Key, which unlocks every file key.
- **Compromise of the identity key** exposes the Drive Key and therefore all files. Compromise of one file key exposes only that file.

## Upload Flow

Uploads run through a transfer queue (`src/transfers/`), with **one upload at a time**: each upload needs a signer approval, and signers such as extensions and Amber cannot service concurrent prompts. Downloads run two at a time.

1. **Generate a file key** (`generateSecretKey`).
2. **Start preview generation** in parallel (best-effort).
3. **Pass 1, encrypt and hash:** each 50 MB chunk is encrypted and its SHA-256 computed. Where the browser supports OPFS, ciphertext is staged to a temporary OPFS directory so it is off the JS heap. Otherwise chunks are re-encrypted in pass 2, which is safe because encryption is deterministic.
4. **Sign one kind 24242 `upload` token** with an `x` tag for every chunk hash and the preview hash.
5. **Pass 2, upload:** upload each chunk to the server, with up to 3 retries per chunk, then the preview.
6. **Publish the metadata event** (Drive Key encrypted, kind 34578) through the local relay. The event is stored locally at once and fanned out to relays by the worker. It throws only if no relay accepts it.
7. The file index is updated optimistically on upload completion.

On Android, uploads can be handed to a native foreground service so they continue in the background. The auth token and metadata event are signed up front while the signer is available, and the native side publishes them later.

## Download Flow

1. The file index (above) provides the metadata, including the file key and chunk list.
2. For each chunk, GET it from that chunk's server (or `file.server`). An `Authorization` token is attached only when the caller supplies one.
3. Decrypt each chunk with `aesGcmDecryptBytes`. At most two chunks are fetched and decrypted ahead of the writer, so memory stays at a few chunks, not the whole file.
4. Write to disk:
   - **File System Access API** where available, streaming straight to the chosen file.
   - **Service-worker streaming** (`/sw.js`, `swStreamDownload.ts`) for browsers without it, such as Firefox and Safari. Decrypted bytes only pass to the browser's own download manager.
   - **Native download** on Android, with notifications.
   - Without streaming support, an in-memory fallback is refused above 500 MB.

Previews and the in-app viewer decrypt the same way: images, video, PDF and text are shown in the app, and office documents can open in Nostr Docs via a deeplink.

## Data Layer and Relays

All relay traffic goes through `@formstr/local-relay`:

- A **web worker** holds the relay connections and an IndexedDB event store. The UI declares standing interests (`dataLayer.observe`) and receives cached events first, then live ones.
- **Relay set:** `APP_RELAYS` (damus, nostr.band, nos.lol) carry the file index. The wider `defaultRelays` list is added for profiles (kind 0) and Blossom server announcements (kind 36363).
- **NIP-42:** AUTH challenges from relays are signed with the active account.
- **Lifecycle:** sockets are dropped when the app is backgrounded and resume on return. The refresh signal re-declares interests after a worker restart (for example when Android suspends the WebView).
- **Accounts:** the worker's active account follows the signer, so cached data stays scoped per account.
- A `relayHealth()` probe distinguishes "no events exist" from "offline", which the Drive Key logic depends on.

## Authentication & Identity

Identity is a Nostr pubkey. There are no usernames, passwords or server accounts. `@formstr/signer` (wrapped by `SignerManager`) supports:

- **NIP-07** browser extensions (Alby, nos2x)
- **NIP-46** remote signers: bunker URI and `nostrconnect`
- **Android signer apps** (such as Amber), through a Capacitor plugin
- **Local keys**: an imported or generated key stored as a passphrase-encrypted `ncryptsec`, unlocked at start. Older plaintext-nsec storage is migrated to this form.

Multiple accounts can be stored; switching changes the active signer, the data-layer scope and the Drive Key cache namespace.

## Folder Structure

Folders are virtual. Each file has a `folder` path (e.g. `/work/docs`), and `extractFolders()` builds the tree from the file list. There are no folder events, so folders appear when a file is placed in them and disappear when empty. Empty folders cannot be created.

## Known Limitations

1. **No sharing.** Everything is encrypted to the user's own Drive Key. Sharing would need per-recipient key wrapping.
2. **No deduplication.** The same file uploaded twice produces two index entries (and, with a fresh file key each time, two different sets of ciphertext).
3. **Last write wins.** Metadata edits from multiple devices are resolved by `created_at`, with no merge.
4. **Fixed relay set.** There is no relay management UI. If every app relay is down, the index cannot sync (the local cache still works).
5. **Orphaned blobs.** If the blob upload succeeds but the metadata publish fails, the blobs remain on the server with no index entry. Blob deletion is best-effort for the same reason: servers that do not support Blossom `DELETE`, or that reject the token, keep the data.
6. **Drive Key loss.** If the Drive Key event cannot be found, creating a new key makes files encrypted under the old one unreadable. The app guards against this when relays are reachable but cannot protect against a user deliberately accepting a new key.
7. **CORS.** Some Blossom servers do not allow browser origins, which limits server choice on web.
8. **Metadata leakage.** File hashes are visible in `d` tags, and a user's event count reveals roughly how many files they have.
9. **Per-chunk cost.** Chunks are uploaded sequentially with a short pause between them, trading speed for reliability against server rate limits.

## Design Trade-offs

**Why separate blobs and metadata:** relays are poor at large blobs, Blossom is built for them, and the index needs to be queryable and replaceable.

**Why not NIP-95:** it targets inline small files and cannot hold large ones. Replaceable kind 34578 gives clean update semantics.

**Why per-file keys:** a leaked file key exposes one file, and file encryption bypasses signer limits.

**Why the Drive Key sits between identity and files:** one signer decrypt unlocks the whole index. It also keeps the identity key out of bulk crypto.

**Why no `client`-tag filtering:** the tag identifies the writer but is not used to filter reads, so another client using the same kind and format can read the same files. Events that cannot be decrypted are skipped.

**Why deterministic chunk salts:** the salt is derived from the key and index, so it need not be stored and the encrypt pass can be repeated to identical output.

## Code Organization

```
src/
├── auth.ts                       # Kind 24242 Blossom auth events
├── crypto.ts                     # Chunk and preview encryption, key helpers
├── blossom.ts                    # Blossom client (upload, download, delete)
├── types/metadata.ts             # FileMetadata, ChunkRef
├── services/
│   ├── driveKey.ts               # Drive Key keyring
│   ├── fileIndex.ts              # Kind 34578 file index
│   ├── uploadFile.ts             # Chunked encrypt + upload
│   ├── downloadFile.ts           # Chunked download + decrypt
│   ├── swStreamDownload.ts       # Service-worker streaming download
│   └── Preview/                  # Image, PDF and video previews
├── transfers/                    # Upload/download queue and drivers
├── signer/                       # Signer and account management
├── dataLayer/, worker/           # Local relay bootstrap and worker
├── Provider/                     # File index, Blossom servers, profile state
├── native/                       # Android plugin bridge
└── components/                   # React UI
```

## Event Kind Reference

| Kind  | Spec   | Purpose                             | Replaceable | Location                       |
| ----- | ------ | ----------------------------------- | ----------- | ------------------------------ |
| 24242 | BUD-01 | Blossom authorization               | No          | `auth.ts`                      |
| 34578 | NIP-78 | Drive Key (`d`=`0:<pubkey>`) and file index (`d`=hash) | Yes (param) | `driveKey.ts`, `fileIndex.ts` |
| 36363 | Custom | Blossom server announcement         | Yes (param) | `BlossomServerProvider.tsx`    |

## Dependencies

- **nostr-tools**: key generation, NIP-44, events
- **@formstr/local-relay**: worker-backed local relay and data layer
- **@formstr/signer**: NIP-07, NIP-46, local-key and Android signers
- **React 19, Ant Design**: UI
- **WebCrypto**: AES-GCM, HKDF, HMAC, SHA-256
- **Capacitor**: Android shell and native plugins
- **Blossom servers, Nostr relays**: external services
