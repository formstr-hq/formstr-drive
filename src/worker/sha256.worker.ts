/// <reference lib="webworker" />
// Incremental SHA-256 off the main thread. The upload prepare pass runs two of
// these in parallel (plaintext + ciphertext) so the JS-bound hashing overlaps
// with itself and with WebCrypto's AES instead of running back to back.
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "nostr-tools/utils";

const hasher = sha256.create();

self.onmessage = (e: MessageEvent<{ type: "update"; buf: ArrayBuffer } | { type: "digest" }>) => {
  const msg = e.data;
  if (msg.type === "update") {
    hasher.update(new Uint8Array(msg.buf));
    self.postMessage({ type: "ack" });
  } else {
    self.postMessage({ type: "digest", hex: bytesToHex(hasher.digest()) });
  }
};
