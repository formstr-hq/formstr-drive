import { FormstrDriveSDK, type DriveFile, type DriveSigner, type NostrEvent } from "@formstr/drive-sdk";
import type { EventTemplate } from "nostr-tools";
import { signerManager } from "../signer/manager";
import type { FileMetadata } from "../types/metadata";
import { APP_RELAYS } from "../utils/common";

interface CachedSdk {
  pubkey: string;
  sdk: FormstrDriveSDK;
}

let cachedSdk: CachedSdk | null = null;
let pendingSdk: Promise<FormstrDriveSDK> | null = null;
let sdkGeneration = 0;

signerManager.onChange(() => {
  // The signer implementation can change while keeping the same public key
  // (for example, switching from NIP-07 to a bunker). Never retain an SDK that
  // still calls the previous signer object.
  sdkGeneration += 1;
  cachedSdk = null;
  pendingSdk = null;
});

/** Return the initialized SDK instance for the currently connected signer. */
export async function getDriveSdk(defaultBlossomServer: string): Promise<FormstrDriveSDK> {
  const signer = await signerManager.getSigner();
  const pubkey = (await signer.getPublicKey()).toLowerCase();
  if (cachedSdk?.pubkey === pubkey) return cachedSdk.sdk;
  if (pendingSdk) return pendingSdk;

  const requestedGeneration = sdkGeneration;
  const creation = (async () => {
    const driveSigner: DriveSigner = {
      getPublicKey: () => signer.getPublicKey(),
      signEvent: async (event: NostrEvent) =>
        signer.signEvent(event as EventTemplate) as unknown as Promise<NostrEvent>,
      ...(signer.nip44Encrypt
        ? { nip44Encrypt: (target: string, plaintext: string) => signer.nip44Encrypt!(target, plaintext) }
        : {}),
      ...(signer.nip44Decrypt
        ? { nip44Decrypt: (target: string, ciphertext: string) => signer.nip44Decrypt!(target, ciphertext) }
        : {}),
    };
    const sdk = new FormstrDriveSDK({
      signer: driveSigner,
      relays: APP_RELAYS,
      blossomServers: [defaultBlossomServer],
    });
    await sdk.initialize();
    if (sdkGeneration === requestedGeneration) cachedSdk = { pubkey, sdk };
    return sdk;
  })();
  pendingSdk = creation;

  try {
    return await creation;
  } finally {
    if (pendingSdk === creation) pendingSdk = null;
  }
}

/** Keep the existing UI model while using the NIP-FS `d` value as its ID. */
export function driveFileToMetadata(file: DriveFile): FileMetadata {
  return {
    name: file.name,
    hash: file.id,
    size: file.size,
    type: file.type,
    folder: file.folder,
    uploadedAt: file.uploadedAt,
    server: file.server,
    encryptionKey: file.encryptionKey,
    encryptionAlgorithm: file.encryptionAlgorithm,
    ...(file.unencryptedFileHash
      ? { unencryptedFileHash: file.unencryptedFileHash }
      : {}),
    ...(file.previewHash ? { previewHash: file.previewHash } : {}),
    chunks: file.chunks,
    protocol: file.format,
  };
}
