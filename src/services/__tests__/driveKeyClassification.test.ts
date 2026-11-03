import { describe, expect, it } from "vitest";
import {
  classifyKeyringRead,
  type RelayState,
} from "../driveKey";

const FORMSTR = "wss://relay.formstr.app";
const DAMUS = "wss://relay.damus.io";
const NOS = "wss://nos.lol";
const USER_RELAY = "wss://user-relay.example";

function state(
  relay: string,
  options: { answered?: boolean; hasVersions?: boolean; readable?: boolean } = {},
): RelayState {
  return {
    relay,
    answered: options.answered ?? true,
    hasVersions: options.hasVersions ?? false,
    readable: options.readable ?? true,
    secrets: new Set<string>(),
  };
}

function classify(overrides: Partial<Parameters<typeof classifyKeyringRead>[0]> = {}) {
  return classifyKeyringRead({
    sawUnreadableVersion: false,
    deviceHasUsedDrive: false,
    ignoreDeviceHistory: false,
    ignoreSilentKeyRelays: false,
    states: [state(FORMSTR), state(DAMUS), state(NOS)],
    writeRelays: [],
    ...overrides,
  });
}

describe("classifyKeyringRead", () => {
  it("confirms an empty keyring only when the app-relay quorum answered none", () => {
    expect(classify()).toMatchObject({
      kind: "empty-confirmed",
      emptyRelays: [FORMSTR, DAMUS, NOS],
    });
  });

  it("does not create over an unreadable version", () => {
    expect(classify({ sawUnreadableVersion: true })).toMatchObject({
      kind: "unresolved",
      issue: "unreadable",
    });
  });

  it("does not silently create when a known write relay did not answer", () => {
    expect(
      classify({
        writeRelays: [USER_RELAY],
        states: [state(FORMSTR), state(DAMUS), state(USER_RELAY, { answered: false })],
      }),
    ).toMatchObject({
      kind: "unresolved",
      issue: "key-relay-silent",
    });
  });

  it("does not silently create when an app relay did not answer", () => {
    expect(
      classify({
        states: [state(FORMSTR), state(DAMUS), state(NOS, { answered: false })],
      }),
    ).toMatchObject({
      kind: "unresolved",
      issue: "key-relay-silent",
    });
  });

  it("keeps default relays as extra read sources, not part of the proof", () => {
    expect(
      classify({
        states: [
          state(FORMSTR),
          state(DAMUS),
          state(NOS),
          state("wss://optional-default.example", { answered: false }),
        ],
      }),
    ).toMatchObject({ kind: "empty-confirmed" });
  });

  it("lets an explicit start proceed, without writing to the silent relay", () => {
    const verdict = classify({
      ignoreSilentKeyRelays: true,
      writeRelays: [USER_RELAY],
      states: [state(FORMSTR), state(DAMUS), state(USER_RELAY, { answered: false })],
    });
    expect(verdict.kind).toBe("empty-confirmed");
    if (verdict.kind !== "empty-confirmed") return;
    expect(verdict.emptyRelays).toEqual([FORMSTR, DAMUS]);
  });

  it("matches write relays regardless of a trailing slash", () => {
    expect(
      classify({
        writeRelays: [`${USER_RELAY}/`],
        states: [state(FORMSTR), state(DAMUS), state(USER_RELAY, { answered: false })],
      }),
    ).toMatchObject({ kind: "unresolved", issue: "key-relay-silent" });
  });

  it("keeps device history as evidence even when relays look empty", () => {
    expect(classify({ deviceHasUsedDrive: true })).toMatchObject({
      kind: "unresolved",
      issue: "seen-on-device",
    });
  });

  it("does not confirm empty without two app-relay answers", () => {
    expect(
      classify({
        states: [state(FORMSTR)],
      }),
    ).toMatchObject({ kind: "unresolved", issue: "not-enough-relays" });
  });
});
