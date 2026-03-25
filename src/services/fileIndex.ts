import { SimplePool, type Filter } from "nostr-tools";
import type { FileMetadata, NostrEvent } from "../types/metadata";

const METADATA_KIND = 34578;
const CLIENT_TAG = "formstr-drive";

const RELAYS = [
  "wss://relay.damus.io",
  "wss://relay.nostr.band",
  "wss://nos.lol",
];

async function getNostr() {
  if (!window.nostr) throw new Error("Nostr signer not found");
  return window.nostr;
}

async function encryptMetadata(metadata: FileMetadata): Promise<string> {
  const nostr = await getNostr();
  const pubkey = await nostr.getPublicKey();
  const json = JSON.stringify(metadata);
  return nostr.nip44.encrypt(pubkey, json);
}

async function decryptMetadata(ciphertext: string): Promise<FileMetadata> {
  const nostr = await getNostr();
  const pubkey = await nostr.getPublicKey();
  const json = await (nostr.nip44.decrypt as any)(pubkey, ciphertext);
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

    const events: any[] = [];
    const seenIds = new Set<string>();

    // Subscribe to relays
    // @ts-ignore - try passing filter directly, not as array
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
  const nostr = await getNostr();
  const pubkey = await nostr.getPublicKey();
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
    const signedEvent = await nostr.signEvent(event as object);
    console.log("[FileIndex] Signed event:", signedEvent);

    const publishPromises = pool.publish(RELAYS, signedEvent as any);
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
  const nostr = await getNostr();
  const pubkey = await nostr.getPublicKey();
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
