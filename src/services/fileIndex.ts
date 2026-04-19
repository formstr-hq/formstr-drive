import { SimplePool, type Filter } from "nostr-tools";
import type { FileMetadata, NostrEvent, PublicSharePayload } from "../types/metadata";
import { decryptSharePayload, encryptSharePayload } from "../utils/shareTokens";

const METADATA_KIND = 34578;
const PUBLIC_SHARE_KIND = 34579;
const CLIENT_TAG = "formstr-drive";
const FETCH_TIMEOUT_MS = 10000;

const RELAYS = [
  "wss://relay.damus.io",
  "wss://relay.nostr.band",
  "wss://nos.lol",
];

async function getNostr() {
  if (!window.nostr) throw new Error("Nostr signer not found");
  return window.nostr;
}

function collectEvents(filter: Filter): Promise<any[]> {
  const pool = new SimplePool();

  return new Promise((resolve) => {
    const events: any[] = [];
    const seenIds = new Set<string>();

    // @ts-ignore subscribeMany accepts a single filter at runtime in this codebase
    const sub = pool.subscribeMany(RELAYS, filter, {
      onevent(event) {
        if (!seenIds.has(event.id)) {
          seenIds.add(event.id);
          events.push(event);
        }
      },
    });

    setTimeout(() => {
      sub.close();
      pool.close(RELAYS);
      resolve(events);
    }, FETCH_TIMEOUT_MS);
  });
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

  const filter: Filter = {
    kinds: [METADATA_KIND],
    authors: [pubkey],
  };
    console.log("[FileIndex] Query filter:", JSON.stringify(filter));
    console.log("[FileIndex] Filter as array:", JSON.stringify([filter]));

  return new Promise((resolve) => {
    collectEvents(filter).then(async (events) => {
      console.log(`[FileIndex] Timeout reached, processing ${events.length} events`);

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
    });
  });
}

export async function publishPublicShareEvent(payload: PublicSharePayload, secret: string): Promise<void> {
  const nostr = await getNostr();
  const pubkey = await nostr.getPublicKey();
  const pool = new SimplePool();

  try {
    const encrypted = await encryptSharePayload(payload, secret);
    const event: NostrEvent = {
      kind: PUBLIC_SHARE_KIND,
      pubkey,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["d", payload.shareId],
        ["client", CLIENT_TAG],
        ["share", "public"],
      ],
      content: JSON.stringify(encrypted),
    };

    const signedEvent = await nostr.signEvent(event as object);
    const publishPromises = pool.publish(RELAYS, signedEvent as any);
    await Promise.any(publishPromises);
  } finally {
    pool.close(RELAYS);
  }
}

export async function resolvePublicShareEvent(
  shareId: string,
  secret: string
): Promise<PublicSharePayload | null> {
  const filter: Filter = {
    kinds: [PUBLIC_SHARE_KIND],
    "#d": [shareId],
  };

  const events = await collectEvents(filter);
  if (events.length === 0) {
    return null;
  }

  events.sort((a, b) => b.created_at - a.created_at);

  for (const event of events) {
    try {
      const parsed = JSON.parse(event.content) as { ciphertext: string; iv: string };
      const payload = await decryptSharePayload(parsed.ciphertext, parsed.iv, secret);
      if (payload.shareId === shareId) {
        return payload;
      }
    } catch {
      // Ignore incompatible events and continue scanning older candidates.
    }
  }

  return null;
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
