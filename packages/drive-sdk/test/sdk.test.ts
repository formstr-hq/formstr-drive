import { describe, expect, it } from "vitest";
import {
  DriveSdkError,
  FormstrDriveSDK,
  chunkHashes,
  type DriveSigner,
  type NostrEvent,
} from "../src";

const PUBKEY = "ab".repeat(32);

function signer(publicKey = PUBKEY): DriveSigner {
  return {
    getPublicKey: async () => publicKey,
    signEvent: async (event: NostrEvent) => event,
  };
}

describe("FormstrDriveSDK foundation", () => {
  it("initializes with a signer and keeps immutable endpoint lists", async () => {
    const relays = ["wss://relay.example.com"];
    const blossomServers = ["https://blossom.example.com"];
    const sdk = new FormstrDriveSDK({ signer: signer(), relays, blossomServers });

    relays.push("wss://unexpected.example.com");
    blossomServers.push("https://unexpected.example.com");

    await expect(sdk.initialize()).resolves.toBe(PUBKEY);
    expect(sdk.getPublicKey()).toBe(PUBKEY);
    expect(sdk.relays).toEqual(["wss://relay.example.com"]);
    expect(sdk.blossomServers).toEqual(["https://blossom.example.com"]);
  });

  it("requires initialization before exposing the public key", () => {
    const sdk = new FormstrDriveSDK({
      signer: signer(),
      relays: ["wss://relay.example.com"],
      blossomServers: ["https://blossom.example.com"],
    });

    expect(() => sdk.getPublicKey()).toThrowError(DriveSdkError);
  });

  it("rejects invalid configuration and signer public keys", async () => {
    expect(
      () =>
        new FormstrDriveSDK({
          signer: signer(),
          relays: [],
          blossomServers: ["https://blossom.example.com"],
        }),
    ).toThrow("At least one Nostr relay is required");

    const sdk = new FormstrDriveSDK({
      signer: signer("not-a-pubkey"),
      relays: ["wss://relay.example.com"],
      blossomServers: ["https://blossom.example.com"],
    });
    await expect(sdk.initialize()).rejects.toMatchObject({
      code: "SIGNER_UNAVAILABLE",
    });
  });
});

describe("legacy metadata helpers", () => {
  it("normalizes current object chunks and legacy hash arrays", () => {
    expect(chunkHashes([{ hash: "one" }, { hash: "two", server: "https://b.test" }])).toEqual([
      "one",
      "two",
    ]);
    expect(chunkHashes(["legacy-one", "legacy-two"])).toEqual([
      "legacy-one",
      "legacy-two",
    ]);
    expect(chunkHashes(undefined)).toEqual([]);
  });
});
