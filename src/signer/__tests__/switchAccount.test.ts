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

  it("runs overlapping switches one at a time and ends on the last one picked", async () => {
    const manager = await freshManager();
    const a = newKey();
    const b = newKey();
    const c = newKey();
    await manager.importNsec(a.nsec, "pw");
    await manager.importNsec(b.nsec, "pw");
    await manager.importNsec(c.nsec, "pw");

    const results = await Promise.all([manager.switchAccount(a.pubkey), manager.switchAccount(b.pubkey)]);

    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(manager.getPubkey()).toBe(b.pubkey);
    expect(manager.isLocked()).toBe(false);
  });

  it("never reports an unverified extension as unlocked while retrying", async () => {
    const manager = await freshManager();
    const ext = newKey();
    extensionOn(ext.pubkey);
    await manager.requestPubkey();

    // the extension is slow to answer and ends up on another key
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    g.nostr = {
      getPublicKey: async () => {
        await gate;
        return newKey().pubkey;
      },
      signEvent: async (e) => e,
    };

    const seen: boolean[] = [];
    manager.onChange(() => seen.push(manager.isLocked()));
    const retry = manager.retryUnlock();
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();

    expect(await retry).toMatchObject({ reason: "extension-other-account" });
    expect(seen).not.toContain(false);
    expect(manager.isLocked()).toBe(true);
  });

  it("does not hand out the signer while init is still checking the extension", async () => {
    const first = await freshManager();
    const ext = newKey();
    extensionOn(ext.pubkey);
    await first.requestPubkey();

    // a reload, with an extension that is slow to answer
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    g.nostr = {
      getPublicKey: async () => {
        await gate;
        return ext.pubkey;
      },
      signEvent: async (e) => e,
    };
    vi.resetModules();
    const { signerManager: manager } = await import("../manager");
    const seen: boolean[] = [];
    manager.onChange(() => seen.push(manager.isLocked()));
    const init = manager.init();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(manager.isOpening()).toBe(true);
    expect(manager.isLocked()).toBe(true);
    await expect(manager.getSigner()).rejects.toThrow();
    expect(seen).toEqual([]);

    release();
    await init;
    expect(manager.isOpening()).toBe(false);
    expect(manager.isLocked()).toBe(false);
    await expect(manager.getSigner()).resolves.toBeDefined();
    expect(seen).toEqual([false]);
  });

  it("does not hand out the signer while a switch is still checking the extension", async () => {
    const manager = await freshManager();
    const pass = newKey();
    const ext = newKey();
    await manager.importNsec(pass.nsec, "pw");
    extensionOn(ext.pubkey);
    await manager.requestPubkey();
    await manager.switchAccount(pass.pubkey);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    g.nostr = {
      getPublicKey: async () => {
        await gate;
        return ext.pubkey;
      },
      signEvent: async (e) => e,
    };
    const switching = manager.switchAccount(ext.pubkey);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(manager.getSigner()).rejects.toThrow();

    release();
    expect(await switching).toEqual({ ok: true });
    await expect(manager.getSigner()).resolves.toBeDefined();
  });

  it("re-checks the account it falls back to when the extension moved to a third key", async () => {
    const manager = await freshManager();
    const k1 = newKey();
    const k2 = newKey();
    extensionOn(k1.pubkey);
    await manager.requestPubkey();
    extensionOn(k2.pubkey);
    await manager.requestPubkey(); // k2 is active

    extensionOn(newKey().pubkey); // neither of them any more
    const result = await manager.switchAccount(k1.pubkey);

    expect(result).toMatchObject({ ok: false, need: "extension-other-account" });
    expect(manager.getPubkey()).toBe(k2.pubkey);
    expect(manager.isLocked()).toBe(true);
    await expect(manager.getSigner()).rejects.toThrow();
  });

  it("keeps the lock it had when a passphrase is wrong", async () => {
    const manager = await freshManager();
    const pass = newKey();
    const ext = newKey();
    await manager.importNsec(pass.nsec, "pw");
    extensionOn(ext.pubkey);
    await manager.requestPubkey();
    extensionOn(newKey().pubkey);
    await manager.retryUnlock();
    expect(manager.getLockInfo()?.reason).toBe("extension-other-account");

    await expect(manager.unlockAndSwitch(pass.pubkey, "wrong")).rejects.toThrow();

    expect(manager.getPubkey()).toBe(ext.pubkey);
    expect(manager.getLockInfo()?.reason).toBe("extension-other-account");
  });

  it("ignores a malformed key reported by the extension", async () => {
    const manager = await freshManager();
    const ext = newKey();
    extensionOn(ext.pubkey);
    await manager.requestPubkey();

    g.nostr = { getPublicKey: async () => "not-a-key", signEvent: async (e) => e };
    const problem = await manager.retryUnlock();

    expect(problem).toEqual({ reason: "extension-other-account" });
    expect(manager.isLocked()).toBe(true);
  });

  it("runs a retry and a switch one after the other without exposing the unverified account", async () => {
    const manager = await freshManager();
    const pass = newKey();
    const ext = newKey();
    await manager.importNsec(pass.nsec, "pw");
    extensionOn(ext.pubkey);
    await manager.requestPubkey();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    g.nostr = {
      getPublicKey: async () => {
        await gate;
        return newKey().pubkey;
      },
      signEvent: async (e) => e,
    };
    const seen: Array<[string | undefined, boolean]> = [];
    manager.onChange((pubkey) => seen.push([pubkey, manager.isLocked()]));

    const retry = manager.retryUnlock();
    const swap = manager.switchAccount(pass.pubkey);
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();

    expect(await retry).toMatchObject({ reason: "extension-other-account" });
    expect(await swap).toEqual({ ok: true });
    expect(manager.getPubkey()).toBe(pass.pubkey);
    expect(manager.isLocked()).toBe(false);
    expect(seen.filter(([pubkey, locked]) => pubkey === ext.pubkey && !locked)).toEqual([]);
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
