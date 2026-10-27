import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";

// Signer storage lives on globalThis so a fresh module graph ("a new tab")
// sees the accounts a previous one saved.
vi.mock("../storageAdapter", () => ({
  hydrateSignerStorage: async () => {
    const store = ((globalThis as Record<string, unknown>).__signerStore ??= new Map<string, string>()) as Map<string, string>;
    return {
      get: (key: string) => store.get(key) ?? null,
      set: (key: string, value: string) => void store.set(key, value),
      remove: (key: string) => void store.delete(key),
    };
  },
}));

const g = globalThis as { nostr?: { getPublicKey(): Promise<string>; signEvent(e: unknown): Promise<unknown> } };

function newKey() {
  const sk = generateSecretKey();
  return { nsec: nip19.nsecEncode(sk), pubkey: getPublicKey(sk) };
}

async function freshManager() {
  vi.resetModules();
  const { signerManager } = await import("../manager");
  await signerManager.init();
  return signerManager;
}

function extensionOn(pubkey: string) {
  g.nostr = { getPublicKey: async () => pubkey, signEvent: async (e) => e };
}

describe("signerManager.switchAccount", () => {
  beforeEach(() => {
    (globalThis as Record<string, unknown>).__signerStore = new Map();
    delete g.nostr;
  });

  it("opens an extension account on switch instead of leaving it locked", async () => {
    const manager = await freshManager();
    const pass = newKey();
    const ext = newKey();
    await manager.importNsec(pass.nsec, "pw");
    extensionOn(ext.pubkey);
    await manager.requestPubkey();

    expect(await manager.switchAccount(pass.pubkey)).toEqual({ ok: true });
    expect(manager.isLocked()).toBe(false);

    expect(await manager.switchAccount(ext.pubkey)).toEqual({ ok: true });
    expect(manager.getPubkey()).toBe(ext.pubkey);
    expect(manager.isLocked()).toBe(false);
    await expect(manager.getSigner()).resolves.toBeDefined();
  });

  it("stays on the current account when the extension is on another key", async () => {
    const manager = await freshManager();
    const pass = newKey();
    const ext = newKey();
    await manager.importNsec(pass.nsec, "pw");
    extensionOn(ext.pubkey);
    await manager.requestPubkey();
    await manager.switchAccount(pass.pubkey);

    extensionOn(newKey().pubkey);
    const result = await manager.switchAccount(ext.pubkey);

    expect(result).toMatchObject({ ok: false, need: "extension-other-account" });
    expect(manager.getPubkey()).toBe(pass.pubkey);
    expect(manager.isLocked()).toBe(false);
  });

  it("reports a missing extension and leaves the current account signing", async () => {
    const manager = await freshManager();
    const pass = newKey();
    const ext = newKey();
    await manager.importNsec(pass.nsec, "pw");
    extensionOn(ext.pubkey);
    await manager.requestPubkey();
    await manager.switchAccount(pass.pubkey);

    delete g.nostr;
    expect(await manager.switchAccount(ext.pubkey)).toMatchObject({ ok: false, need: "extension-missing" });
    expect(manager.getPubkey()).toBe(pass.pubkey);
    await expect(manager.getSigner()).resolves.toBeDefined();
  });

  it("switches back to a passphrase account unlocked this session without asking again", async () => {
    const manager = await freshManager();
    const a = newKey();
    const b = newKey();
    await manager.importNsec(a.nsec, "pw");
    await manager.importNsec(b.nsec, "pw");

    expect(await manager.switchAccount(a.pubkey)).toEqual({ ok: true });
    expect(manager.isLocked()).toBe(false);
    expect(await manager.switchAccount(b.pubkey)).toEqual({ ok: true });
  });

  it("asks for the passphrase of an account not unlocked this session, without switching", async () => {
    let manager = await freshManager();
    const a = newKey();
    const b = newKey();
    await manager.importNsec(a.nsec, "pw");
    await manager.importNsec(b.nsec, "pw");

    manager = await freshManager(); // a reload: nothing unlocked yet
    expect(manager.getPubkey()).toBe(b.pubkey);
    expect(manager.isLocked()).toBe(true);

    expect(await manager.switchAccount(a.pubkey)).toEqual({ ok: false, need: "passphrase" });
    expect(manager.getPubkey()).toBe(b.pubkey);

    await manager.unlockAndSwitch(a.pubkey, "pw");
    expect(manager.getPubkey()).toBe(a.pubkey);
    expect(manager.isLocked()).toBe(false);
  });

  it("forgets a removed account's signer", async () => {
    const manager = await freshManager();
    const a = newKey();
    const b = newKey();
    await manager.importNsec(a.nsec, "pw");
    await manager.importNsec(b.nsec, "pw");

    await manager.removeAccount(a.pubkey);
    expect(manager.listAccounts().map((acc) => acc.pubkey)).toEqual([b.pubkey]);
    await expect(manager.switchAccount(a.pubkey)).rejects.toThrow();
  });
});
