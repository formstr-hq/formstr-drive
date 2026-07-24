# Formstr Drive SDK

`@formstr/drive-sdk` lets a browser app build a private encrypted file drive on Nostr relays and Blossom blob servers.

It writes NIP-FS file metadata (kind `34578`), encrypts every file chunk locally, uploads encrypted blobs to Blossom, and supports listing, downloading, renaming, moving, and deleting files. It can also read existing legacy Formstr Drive file records.

## Install

```sh
pnpm add @formstr/drive-sdk
```

## Browser usage with a NIP-07 signer

```js
import { FormstrDriveSDK } from "@formstr/drive-sdk";

const signer = {
  getPublicKey: () => window.nostr.getPublicKey(),
  signEvent: (event) => window.nostr.signEvent(event),
  nip44Encrypt: (pubkey, plaintext) => window.nostr.nip44.encrypt(pubkey, plaintext),
  nip44Decrypt: (pubkey, ciphertext) => window.nostr.nip44.decrypt(pubkey, ciphertext),
};

const drive = new FormstrDriveSDK({
  signer,
  relays: ["wss://relay.damus.io", "wss://relay.nostr.band"],
  blossomServers: ["https://nostr.download"],
});

await drive.initialize();

const task = drive.upload(fileInput.files[0], {
  folder: "/documents",
  chunkSize: 5 * 1024 * 1024,
  includeUnencryptedHash: true,
});

const unsubscribe = task.subscribe((progress) => {
  console.log(progress.state, progress.percent);
});

try {
  const file = await task.result;
  console.log("Uploaded", file.id, file.chunks.length);
} finally {
  unsubscribe();
}
```

The signer needs NIP-44 encryption/decryption support. The SDK uses it to protect the drive key and file metadata; file bytes are encrypted locally before they reach a Blossom server.

## Common operations

```js
const files = await drive.listFiles();
const folders = drive.getFolders(files);

const first = files[0];

const download = drive.download(first.id);
const bytes = await download.result;
const blob = new Blob([bytes], { type: first.type });

const previewBytes = await drive.getPreview(first.id);
await drive.renameFile(first.id, "renamed-file.png");
await drive.moveFile(first.id, "/archive");
await drive.deleteFile(first.id);
```

`download()` verifies the original SHA-256 hash when the metadata contains one. Pass `{ verifyHash: false }` only when that verification is intentionally not wanted.

## Transfers

`upload()` and `download()` return a transfer task rather than a bare promise. A task exposes:

- `result` — resolves with the uploaded file or decrypted bytes.
- `subscribe(listener)` — receives progress states such as `preparing`, `awaiting-signature`, `uploading-chunks`, and `downloading`.
- `cancel()` — aborts the active transfer and cleans up an incomplete upload when possible.
- `retry()` — retries a failed transfer. It cannot retry a completed or cancelled transfer.

## Configuration and adapters

`FormstrDriveSDK` uses Nostr relay and Blossom clients by default. Apps that already manage their own networking can pass `relayAdapter` and `blobClientFactory` to the constructor. The exported `DriveSigner`, `DriveRelayAdapter`, and `DriveBlobClient` types define those interfaces.

Use one or more relays that accept your signed events and a Blossom server that accepts Nostr-authenticated uploads. A signer may prompt the user for each event it needs to sign.

## Publishing this package

Package maintainers can run the checks without publishing:

```sh
pnpm --filter @formstr/drive-sdk run release:check
pnpm --filter @formstr/drive-sdk run publish:dry-run
```
