import { SimplePool, type Filter } from "nostr-tools";
import type { FileMetadata, NostrEvent } from "../types/metadata";
import { signerManager } from "../signer/manager";
import { APP_RELAYS } from "../utils/common";

const METADATA_KIND = 34578;
export const SHARED_METADATA_KIND = 1064;
const CLIENT_TAG = "formstr-drive";

const RELAYS = APP_RELAYS;

async function getSigner() {
  return signerManager.getSigner();
}

async function encryptMetadata(metadata: FileMetadata): Promise<string> {
  const signer = await getSigner();
  if (!signer.nip44Encrypt) {
    throw new Error("Signer does not support NIP-44 encryption");
  }

  const pubkey = await signer.getPublicKey();
  const json = JSON.stringify(metadata);
  return signer.nip44Encrypt(pubkey, json);
}

async function decryptMetadata(ciphertext: string): Promise<FileMetadata> {
  const signer = await getSigner();
  if (!signer.nip44Decrypt) {
    throw new Error("Signer does not support NIP-44 decryption");
  }

  const pubkey = await signer.getPublicKey();
  const json = await signer.nip44Decrypt(pubkey, ciphertext);
  return JSON.parse(json);
}

export async function fetchFileIndex(pubkey: string): Promise<FileMetadata[]> {
  console.log("[FileIndex] Starting fetch from relays:", RELAYS);
  console.log("[FileIndex] User pubkey:", pubkey);

  const pool = new SimplePool();

  return new Promise((resolve) => {
    const filter: Filter = {
      kinds: [METADATA_KIND],
      authors: [pubkey],
    };
    console.log("[FileIndex] Query filter:", JSON.stringify(filter));
    console.log("[FileIndex] Filter as array:", JSON.stringify([filter]));

    const events: NostrEvent[] = [];
    const seenIds = new Set<string>();

    // Subscribe to relays
    const sub = pool.subscribeMany(RELAYS, filter, {
        onevent(event) {
          if (!seenIds.has(event.id)) {
            console.log("[FileIndex] Received event:", event.id);
            seenIds.add(event.id);
            events.push(event);
          }
        },
        oneose() {
          console.log("[FileIndex] EOSE received from relay");
        },
        onclose(reasons) {
          console.log("[FileIndex] Subscription closed:", reasons);
        },
      }
    );

    // Wait 10 seconds for events to come in, then process
    setTimeout(async () => {
      console.log(`[FileIndex] Timeout reached, processing ${events.length} events`);
      sub.close();
      pool.close(RELAYS);

      const files: FileMetadata[] = [];
      const seenHashes = new Set<string>();

      // Sort by created_at descending to get latest versions first
      events.sort((a, b) => b.created_at - a.created_at);

      for (const event of events) {
        console.log("[FileIndex] Processing event:", event.id, "tags:", event.tags);
        const dTag = event.tags.find((t: string[]) => t[0] === "d");
        const hash = dTag?.[1];

        if (!hash) {
          console.warn("[FileIndex] Event missing d tag:", event.id);
          continue;
        }

        if (seenHashes.has(hash)) {
          console.log("[FileIndex] Skipping duplicate hash:", hash);
          continue;
        }

        seenHashes.add(hash);

        try {
          const metadata = await decryptMetadata(event.content);
          console.log("[FileIndex] Decrypted metadata:", metadata);
          if (!metadata.deleted) {
            files.push(metadata);
          } else {
            console.log("[FileIndex] Skipping deleted file:", metadata.name);
          }
        } catch (e) {
          console.debug("[FileIndex] Skipping incompatible event:", event.id, e);
        }
      }

      console.log(`[FileIndex] Successfully loaded ${files.length} files`);
      resolve(files);
    }, 10000); // 10 second timeout
  });
}

export async function saveFileMetadata(metadata: FileMetadata): Promise<void> {
  console.log("[FileIndex] Saving metadata:", metadata);
  const signer = await getSigner();
  const pubkey = await signer.getPublicKey();
  const pool = new SimplePool();

  try {
    const encrypted = await encryptMetadata(metadata);
    console.log("[FileIndex] Encrypted metadata length:", encrypted.length);

    const event: NostrEvent = {
      kind: METADATA_KIND,
      pubkey,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["d", metadata.hash],
        ["client", CLIENT_TAG],
        ["encrypted", "nip44"],
      ],
      content: encrypted,
    };

    console.log("[FileIndex] Event to publish:", event);
    const signedEvent = await signer.signEvent(event);
    console.log("[FileIndex] Signed event:", signedEvent);

    const publishPromises = pool.publish(RELAYS, signedEvent);
    console.log("[FileIndex] Publishing to relays:", RELAYS);

    await Promise.any(publishPromises);
    console.log("[FileIndex] Successfully published to at least one relay");
  } catch (e) {
    console.error("[FileIndex] Failed to save metadata:", e);
    throw e;
  } finally {
    pool.close(RELAYS);
  }
}

export async function deleteFileMetadata(_hash: string, currentMetadata: FileMetadata): Promise<void> {
  const deletedMetadata: FileMetadata = {
    ...currentMetadata,
    deleted: true,
  };
  await saveFileMetadata(deletedMetadata);
}

export async function updateFileMetadata(
  hash: string,
  updates: Partial<Pick<FileMetadata, "name" | "folder">>
): Promise<void> {
  const signer = await getSigner();
  const pubkey = await signer.getPublicKey();
  const files = await fetchFileIndex(pubkey);
  const existing = files.find((f) => f.hash === hash);

  if (!existing) {
    throw new Error("File not found");
  }

  const updated: FileMetadata = {
    ...existing,
    ...updates,
  };

  await saveFileMetadata(updated);
}

export function extractFolders(files: FileMetadata[]): string[] {
  const folders = new Set<string>();
  folders.add("/");

  for (const file of files) {
    const parts = file.folder.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current += "/" + part;
      folders.add(current);
    }
  }

  return Array.from(folders).sort();
}

export async function shareFileMetadata(recipientPubkey: string, file: FileMetadata): Promise<void> {
  const signer = await getSigner();
  const pubkey = await signer.getPublicKey();
  const pool = new SimplePool();

  if (!signer.nip44Encrypt) {
    throw new Error("Signer does not support NIP-44 encryption");
  }

  try {
    const json = JSON.stringify(file);
    // Encrypt with the recipient's public key
    const encrypted = await signer.nip44Encrypt(recipientPubkey, json);

    const event: NostrEvent = {
      kind: SHARED_METADATA_KIND,
      pubkey,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["p", recipientPubkey],
        ["client", CLIENT_TAG],
        ["encrypted", "nip44"],
      ],
      content: encrypted,
    };

    const signedEvent = await signer.signEvent(event);
    const publishPromises = pool.publish(RELAYS, signedEvent);
    await Promise.any(publishPromises);
  } finally {
    pool.close(RELAYS);
  }
}

export async function fetchSharedWithMe(pubkey: string): Promise<{ file: FileMetadata; sender: string; eventId: string }[]> {
  const pool = new SimplePool();
  const signer = await getSigner();

  return new Promise((resolve) => {
    const filter: Filter = {
      kinds: [SHARED_METADATA_KIND],
      "#p": [pubkey],
    };

    const events: NostrEvent[] = [];
    const seenIds = new Set<string>();

    const sub = pool.subscribeMany(RELAYS, filter, {
      onevent(event) {
        if (!seenIds.has(event.id)) {
          seenIds.add(event.id);
          events.push(event);
        }
      },
    });

    setTimeout(async () => {
      sub.close();
      pool.close(RELAYS);

      const files: { file: FileMetadata; sender: string; eventId: string }[] = [];
      const seenHashes = new Set<string>();

      // Sort by created_at descending
      events.sort((a, b) => b.created_at - a.created_at);

      if (!signer.nip44Decrypt) {
        resolve([]);
        return;
      }

      for (const event of events) {
        try {
          // Decrypt with the sender's public key
          const json = await signer.nip44Decrypt(event.pubkey, event.content);
          const metadata: FileMetadata = JSON.parse(json);
          
          if (!seenHashes.has(metadata.hash)) {
            seenHashes.add(metadata.hash);
            files.push({ file: metadata, sender: event.pubkey, eventId: event.id! });
          }
        } catch (e) {
          console.debug("[FileIndex] Failed to decrypt shared file:", e);
        }
      }

      resolve(files);
    }, 5000);
  });
}
