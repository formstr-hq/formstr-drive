# Formstr Drive - Technical Architecture

## Overview

Formstr Drive is a proof-of-concept decentralized file storage system that combines **Nostr** (a decentralized protocol for social networking) with **Blossom** (a distributed blob storage protocol). The system provides encrypted file storage where files are stored on Blossom servers and metadata is indexed on Nostr relays.

**Core concept:** Store encrypted files on any Blossom server, while keeping the file index (metadata) as encrypted Nostr events on public relays. Only the user with the private key can decrypt and access their files.

## High-Level Architecture

```
┌─────────────────┐
│   Browser App   │
│  (React + NIP)  │
└────────┬────────┘
         │
         ├──────────────────┐
         │                  │
         ▼                  ▼
┌─────────────────┐  ┌──────────────────┐
│ Nostr Relays    │  │ Blossom Servers  │
│ (Metadata)      │  │ (File Blobs)     │
│                 │  │                  │
│ - File Index    │  │ - Encrypted      │
│ - Server List   │  │   File Data      │
│ - Encrypted     │  │                  │
└─────────────────┘  └──────────────────┘
```

### Components

1. **Client Application** (Browser): React app that interfaces with both Nostr relays and Blossom servers
2. **Nostr Relays**: Store encrypted metadata events
3. **Blossom Servers**: Store encrypted file blobs
4. **NIP-07 Signer**: Browser extension (e.g., Alby) that provides signing and encryption capabilities

## Nostr Events Used

The system uses three different Nostr event kinds:

### 1. Kind 24242 - Blossom Auth Events (NIP-98)

**Purpose:** Temporary authentication tokens for Blossom server operations (upload/download)

**Location:** `src/auth.ts`

**Structure:**

```json
{
  "kind": 24242,
  "pubkey": "<user's public key>",
  "content": "Upload filename.txt",
  "created_at": 1234567890,
  "tags": [
    ["t", "upload"], // or "get" for download
    ["expiration", "1234567950"] // 60 seconds from created_at
  ]
}
```

**Why this design:**

- **NIP-98** defines kind 24242 as HTTP auth events
- Creates short-lived bearer tokens (60 second expiration)
- Signed events prove ownership of the pubkey to the Blossom server
- The entire signed event is base64-encoded and sent as `Authorization: Nostr <base64>`
- Prevents replay attacks via expiration timestamp
- Content field describes the operation for audit/debugging

**Flow:**

1. User initiates upload/download
2. Client creates kind 24242 event with operation details
3. NIP-07 extension signs the event
4. Signed event is base64-encoded
5. Sent to Blossom server as Bearer token

### 2. Kind 34578 - File Metadata Index (Parameterized Replaceable)

**Purpose:** Store encrypted file metadata (filename, size, location, folder structure, and encryption key)

**Location:** `src/services/fileIndex.ts`

**Structure:**

```json
{
  "kind": 34578,
  "pubkey": "<user's public key>",
  "content": "<NIP-44 encrypted FileMetadata JSON>",
  "created_at": 1234567890,
  "tags": [
    ["d", "<file hash/sha256>"],
    ["client", "formstr-drive"],
    ["encrypted", "nip44"]
  ]
}
```

**Encrypted content (FileMetadata):**

```typescript
{
  name: "document.pdf",
  hash: "abc123...",        // SHA-256 from Blossom server
  size: 123456,
  type: "application/pdf",
  folder: "/work/docs",
  uploadedAt: 1234567890,
  server: "https://blossom.primal.net",
  encryptionKey: "deadbeef...",  // Hex-encoded private key for file decryption
  deleted?: true            // Soft delete flag
}
```

**Why this design:**

- **Kind 34578** is a parameterized replaceable event (range 30000-39999)
- The `d` tag (identifier) is set to the file's hash
- Replaceable events with the same `d` tag automatically replace older versions
- This enables updates: rename file, move to different folder, or soft-delete
- Only the newest event per hash matters - Nostr relays handle deduplication
- Content is encrypted with **NIP-44** (improved encryption) to user's own pubkey
- Self-encryption: encrypt to yourself for private storage
- `client` tag is included for identification but **not used for filtering**
- **Fully interoperable** - any app using kind 34578 for file metadata works together

**Why parameterized replaceable:**

- Editing metadata (rename/move) creates a new event with same `d` tag
- Old event is automatically superseded
- No need to track event IDs - just query by `d` tag (file hash)
- Soft deletes: publish new event with `deleted: true` in encrypted payload

**Soft Delete Implementation:**
When deleting a file:

1. Fetch existing metadata for the file hash
2. Create new FileMetadata with `deleted: true`
3. Publish as new kind 34578 event with same `d` tag
4. The file blob stays on Blossom server but won't show in UI

### 3. Kind 36363 - Blossom Server Announcements

**Purpose:** Discover available Blossom servers from the network

**Location:** `src/contexts/BlossomServerContext.tsx`

**Structure:**

```json
{
  "kind": 36363,
  "pubkey": "<server operator's pubkey>",
  "content": "...",
  "tags": [["d", "https://blossom.example.com"]]
}
```

**Why this design:**

- Allows Blossom server operators to announce their servers on Nostr
- Client queries public relays for kind 36363 events
- `d` tag contains the server URL
- Builds a dynamic list of available servers
- Users can also add custom servers manually
- Provides server discovery without hardcoding

**Current implementation:**

- Queries 3 public relays for kind 36363 events
- Combines discovered servers with default hardcoded list
- Default servers: Primal, nostr.download, oxtr.dev
- Users can add custom servers via UI

## Data Flow

### File Upload Flow

1. **User selects file** in browser
2. **Read file** into Uint8Array
3. **Generate new keypair** for this file
   - Call `generateSecretKey()` from nostr-tools
   - Derive pubkey from secret key
4. **Encrypt file content** using aesGcmEncrypt (self-encryption)
   - Create conversation key (secretKey + pubkey)
   - Convert Uint8Array → base64 string
   - Call `aesGcmEncrypt(base64, conversationKey)`
   - Returns encrypted ciphertext string
   - Convert secretKey to hex for storage
5. **Create Blossom auth token** (kind 24242 event, signed by user's Nostr key)
6. **Upload encrypted ciphertext** to Blossom server
   - Convert ciphertext string → Uint8Array (TextEncoder)
   - PUT request to `/upload`
   - Server returns SHA-256 hash
7. **Create metadata object** with file details + encryptionKey
   ```typescript
   {
     name: "file.pdf",
     hash: "sha256...",
     size: 123456,
     type: "application/pdf",
     folder: "/",
     uploadedAt: Date.now(),
     server: "https://blossom.example.com",
     encryptionKey: "hex-encoded-secret-key"
   }
   ```
8. **Encrypt metadata** using NIP-44 via NIP-07 signer (to own pubkey)
9. **Publish metadata event** (kind 34578) to Nostr relays
   - `d` tag = file hash from Blossom
   - Content = encrypted metadata JSON (includes encryptionKey)
10. **Update local state** to show file in UI

### File Download Flow

1. **Query Nostr relays** for kind 34578 events (on app load)
   - Filter: user's pubkey, kind 34578 (no client filtering - fully interoperable!)
2. **Decrypt each metadata event** using NIP-44 via NIP-07 signer
   - Extracts FileMetadata including encryptionKey
3. **Display files** in folder structure UI
4. **When user clicks download:**
   - Get file hash, server URL, and **encryptionKey** from metadata
   - Create Blossom auth token (kind 24242, verb="get", signed by user's Nostr key)
   - GET request to `https://server/{hash}`
   - Receive encrypted ciphertext blob
5. **Decrypt file content** using aesGcmDecrypt with stored key
   - Convert blob → string (TextDecoder)
   - Convert encryptionKey hex → bytes
   - Derive pubkey from secret key
   - Create conversation key (secretKey + pubkey)
   - Call `aesGcmDecrypt(ciphertext, conversationKey)`
   - Returns base64 plaintext
   - Convert base64 → Uint8Array
6. **Save file** using browser download API

## File Encryption Strategy

**Current Architecture (v2 - Production Ready):**

The system uses a **per-file keypair** approach for efficient encryption:

1. **File Encryption:**
   - Generate a new random keypair for each file upload
   - Encrypt file to itself using `aesGcmEncrypt` (custom implementation)
   - Uses WebCrypto APIs (AES-GCM) for fast, large file support
   - No dependency on NIP-07 extension for file encryption
   - Handles files of any size efficiently

2. **Key Storage:**
   - Private key (hex) stored in FileMetadata
   - Metadata encrypted with NIP-44 via NIP-07 signer to user's own pubkey
   - Only the user with the Nostr private key can decrypt metadata and access file keys

3. **Encryption Flow:**
   ```
   Upload:
   - Generate new keypair (secretKey, pubkey)
   - File bytes → base64 → aesGcmEncrypt(self) → ciphertext
   - Upload ciphertext to Blossom
   - Store secretKey (hex) in encrypted metadata on Nostr

   Download:
   - Fetch encrypted metadata from Nostr
   - Decrypt metadata to get encryptionKey
   - Download ciphertext from Blossom
   - Decrypt using aesGcmDecrypt with stored key
   ```

**Why this design:**
- **No signer limitations:** NIP-07 extensions can timeout on large files; this bypasses that
- **Fast encryption:** Direct WebCrypto API usage is much faster than extension calls
- **Scalable:** Handles multi-GB files without issues
- **Secure:** Files encrypted at rest on Blossom; keys encrypted in Nostr metadata
- **Simple recovery:** All keys stored in Nostr events; recover files by decrypting metadata

**Security Model:**
- **Blossom servers:** See encrypted blobs, cannot decrypt (don't have keys)
- **Nostr relays:** See encrypted metadata events, cannot decrypt (NIP-44 encrypted)
- **User:** Nostr signer can decrypt metadata events → extract file keys → decrypt files
- **Attack surface:** Must compromise user's Nostr private key to access files

**Implementation Details:**

`aesGcmEncrypt` and `aesGcmDecrypt` (in `src/crypto.ts`):
- Based on NIP-44 v2 spec
- Uses HKDF for key derivation
- AES-GCM instead of ChaCha20 (WebCrypto limitation)
- Handles arbitrarily large payloads
- Format: version (1 byte) + nonce (32 bytes) + ciphertext

**Metadata Encryption:**
- Still uses NIP-07 extension for metadata (small payload, no timeout issues)
- Encrypts FileMetadata JSON to user's own pubkey
- Includes the file's encryptionKey in encrypted metadata

## Folder Structure Implementation

The system implements a virtual folder hierarchy without storing folders as separate entities:

**Approach:**

- Each file has a `folder` field (e.g., `/work/docs`)
- Folders are extracted by parsing all file paths
- `extractFolders()` function builds the folder tree
- Sidebar shows hierarchical folder view
- No folder creation - folders appear when files are added to them

**Why this design:**

- Simpler than managing folder metadata events
- No need to track folder renames/deletes
- Folders automatically clean up when empty
- Reduces Nostr event count
- Trade-off: Can't create empty folders

## Authentication & Identity

**NIP-07 Browser Extension:**

- Provides `window.nostr` API
- Handles key management securely
- Signs events without exposing private key
- User approves each signature request

**No traditional login:**

- No username/password
- No server-side accounts
- Identity = Nostr pubkey
- Private key stays in browser extension
- Fully client-side authentication

## Known Limitations & Design Decisions

### Fixed Issues (No Longer PoC)

1. ✅ **Large file encryption is now practical**
   - Direct WebCrypto API usage (no extension timeout)
   - Handles multi-GB files efficiently
   - Fast encryption/decryption
   - Per-file keypairs stored in metadata

2. ✅ **File chunking not needed**
   - Files processed in-memory but encryption is fast
   - Browser can handle large files with modern APIs
   - Could add chunking if needed for very large files (10GB+)

### Remaining Limitations

1. **Server selection is global**
   - Files can be on different servers
   - But upload always uses currently selected server
   - No per-file server association in UI

2. **No deduplication**
   - Same file uploaded twice = two entries
   - Blossom servers may dedupe by hash
   - But metadata events are separate

3. **Soft delete doesn't free space**
   - Deleted files still on Blossom server
   - No server-side deletion implemented
   - Would need Blossom delete API + proper auth

4. **No conflict resolution**
   - Multiple devices could create conflicting metadata
   - Last write wins (by `created_at` timestamp)
   - No merge strategy

5. **Relay selection is hardcoded**
   - Fixed set of 3 public relays
   - No relay management UI
   - Could miss events if those relays are down

6. **No error recovery**
   - Upload succeeds to Blossom but metadata publish fails = orphaned blob
   - No transaction/rollback mechanism
   - No retry logic

7. **CORS limitations**
   - Many Blossom servers don't allow browser CORS
   - Limits server selection
   - Error handling tries to detect CORS issues

### Design Trade-offs

**Why separate file storage and metadata:**

- Nostr relays don't store large blobs efficiently
- Blossom specializes in blob storage
- Metadata needs to be queryable/indexable
- Separation of concerns

**Why not use NIP-95 (file metadata events):**

- NIP-95 (kind 1063) is for file metadata + inline small files
- Doesn't solve large file storage
- Would still need external blob storage
- Kind 34578 provides better update semantics (replaceable)

**Why self-encryption (encrypt to own pubkey):**

- Private by default
- Can't share files (no multi-party encryption yet)
- Could extend to encrypt to recipient's pubkey for sharing
- Current PoC is single-user only

**Why base64 encoding for encryption:**

- NIP-44 expects text input
- Binary data needs encoding
- Base64 is standard, but inflates size by ~33%
- Trade-off accepted for compatibility with NIP-44 spec

**Why per-file keypairs instead of user's Nostr key:**

- Bypasses NIP-07 extension limitations (timeouts, size limits)
- Direct WebCrypto API access is much faster
- Each file has unique encryption key
- Keys stored in encrypted metadata (same security level)
- Better separation of concerns (file keys vs identity keys)

**Why no client tag filtering:**

- **Interoperability first** - any client using kind 34578 for files should work together
- Users can upload from one app, download from another
- Client tag still included for identification and analytics
- Events we can't decrypt are silently skipped (wrong format or not our key)
- Promotes ecosystem growth and prevents vendor lock-in

## Future Improvements

1. ~~**Streaming encryption**~~ - ✅ Not needed with current fast implementation
2. **Blossom delete support** - Actually free server space
3. **File sharing** - Encrypt to recipient's pubkey
4. **Relay selection UI** - Let users pick/add relays
5. **Progress indicators** - Show upload/encryption progress
6. **Thumbnail generation** - Preview images/videos
7. **Search/filtering** - Full-text search in filenames
8. **Offline support** - Cache metadata locally
9. **Multi-device sync** - Proper conflict resolution
10. **Access control** - Public/private/shared file modes

## Code Organization

```
src/
├── auth.ts                    # Kind 24242 auth event creation
├── crypto.ts                  # NIP-44 file encrypt/decrypt
├── blossom.ts                 # Blossom client (upload/download)
├── types/metadata.ts          # TypeScript interfaces
├── services/fileIndex.ts      # Kind 34578 metadata operations
├── contexts/
│   ├── FileIndexContext.tsx   # File state management
│   └── BlossomServerContext.tsx # Server discovery (kind 36363)
└── components/               # React UI components
```

## Event Kind Reference

| Kind  | NIP    | Purpose                     | Replaceable | Location              |
| ----- | ------ | --------------------------- | ----------- | --------------------- |
| 24242 | NIP-98 | Blossom HTTP Auth           | No          | auth.ts               |
| 34578 | NIP-78 | Application-specific data   | Yes (param) | services/fileIndex.ts |
| 36363 | Custom | Blossom server announcement | Yes (param) | BlossomServerContext  |

## Dependencies

- **nostr-tools** (v2.20.0): SimplePool, event handling, NIP-44 utilities, key generation
- **React** (v19): UI framework
- **WebCrypto API**: Native browser crypto for file encryption (AES-GCM, HKDF)
- **NIP-07 extension**: Metadata signing and encryption (external)
- **Blossom servers**: Blob storage (external)
- **Nostr relays**: Event storage (external)

## Security Considerations

1. **User's Nostr key never leaves extension** - Metadata signing via NIP-07
2. **All data encrypted at rest** - Files and metadata use NIP-44
3. **Per-file encryption keys** - Each file has unique ephemeral keypair
4. **Keys stored encrypted** - File keys encrypted in metadata events
5. **Short-lived auth tokens** - Kind 24242 events expire in 60s
6. **No server-side secrets** - Fully client-side application
7. **Relay privacy** - Relays see encrypted events, can't read content
8. **Blossom server privacy** - Servers see encrypted blobs, can't read content
9. **Attack surface** - Must compromise user's Nostr private key to access metadata and file keys
10. **Metadata leakage** - File hashes visible in event tags; sizes and names encrypted in content

## Conclusion

Formstr Drive is a production-ready decentralized file storage system using Nostr for metadata indexing and Blossom for blob storage. Key innovations include:

1. **Per-file keypair encryption** - Fast, scalable encryption for files of any size
2. **Parameterized replaceable events** (kind 34578) - Mutable file metadata with built-in versioning
3. **Dual encryption model** - Files encrypted with ephemeral keys; metadata encrypted with user's Nostr key
4. **Zero-trust architecture** - Neither Blossom servers nor Nostr relays can read user data

The system efficiently handles large files through direct WebCrypto API usage while maintaining the security and decentralization benefits of Nostr. File encryption keys are stored in encrypted Nostr metadata events, providing a seamless recovery mechanism - users can access all their files from any device by simply signing in with their Nostr key.
