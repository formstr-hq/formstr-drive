import { afterEach, describe, expect, it, vi } from "vitest";
import { abortable, ThumbnailTimeout } from "../abort";
import { enqueue } from "../queue";
import { awaitThumbnail, thumbnailGraceMs } from "../../uploadFile";
import { planFrames } from "../engines/video/capture";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("abortable", () => {
  it("returns the result and cleans up", async () => {
    expect(await abortable(async () => 7)).toBe(7);
  });

  it("rejects with a ThumbnailTimeout when the budget runs out and aborts the work", async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | undefined;
    const run = abortable((signal) => {
      seen = signal;
      return new Promise<never>(() => {});
    }, { timeoutMs: 1000 });
    const assertion = expect(run).rejects.toBeInstanceOf(ThumbnailTimeout);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(seen?.aborted).toBe(true);
  });

  it("propagates a parent abort to the work", async () => {
    const parent = new AbortController();
    let seen: AbortSignal | undefined;
    const run = abortable((signal) => {
      seen = signal;
      return new Promise<never>(() => {});
    }, { signal: parent.signal });
    parent.abort();
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(seen?.aborted).toBe(true);
  });

  it("rejects immediately when already aborted", async () => {
    const parent = new AbortController();
    parent.abort();
    await expect(abortable(async () => 1, { signal: parent.signal })).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("enqueue", () => {
  it("runs tasks strictly one at a time, in order", async () => {
    const order: string[] = [];
    const task = (name: string, ms: number) => async () => {
      order.push(`${name}:start`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${name}:end`);
    };
    await Promise.all([enqueue(task("a", 15)), enqueue(task("b", 1))]);
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("skips a task whose signal aborted while it waited, without blocking later ones", async () => {
    const ctl = new AbortController();
    const ran: string[] = [];
    const first = enqueue(() => new Promise<void>((r) => setTimeout(r, 10)));
    const skipped = enqueue(async () => void ran.push("skipped"), ctl.signal);
    ctl.abort();
    const last = enqueue(async () => void ran.push("last"));
    await first;
    await expect(skipped).rejects.toMatchObject({ name: "AbortError" });
    await last;
    expect(ran).toEqual(["last"]);
  });
});

describe("awaitThumbnail (upload budget)", () => {
  it("returns the bytes of a thumbnail that is ready", async () => {
    const bytes = new Uint8Array([1]);
    expect(await awaitThumbnail({ promise: Promise.resolve(bytes), cancel: () => {} }, 1000)).toBe(bytes);
  });

  it("returns null when there is no thumbnail", async () => {
    expect(await awaitThumbnail(undefined, 1000)).toBeNull();
    expect(await awaitThumbnail({ promise: Promise.resolve(null), cancel: () => {} }, 1000)).toBeNull();
  });

  it("gives up on a thumbnail that never resolves, cancels it, and does not block the upload", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "info").mockImplementation(() => {});
    const cancel = vi.fn();
    const result = awaitThumbnail({ promise: new Promise(() => {}), cancel }, 1000);
    await vi.advanceTimersByTimeAsync(thumbnailGraceMs(1000));
    expect(await result).toBeNull();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("scales the grace period with file size, capped", () => {
    expect(thumbnailGraceMs(0)).toBe(10_000);
    expect(thumbnailGraceMs(900 * 1024 * 1024)).toBe(19_000);
    expect(thumbnailGraceMs(50 * 1024 * 1024 * 1024)).toBe(30_000);
  });
});

describe("planFrames", () => {
  it("samples the first 2.5 seconds with 7 frames and a clamped delay", () => {
    const plan = planFrames(120);
    expect(plan.timestamps).toHaveLength(7);
    expect(plan.timestamps[0]).toBeCloseTo(0.1);
    expect(plan.timestamps[6]).toBeCloseTo(2.5);
    expect(plan.delayMs).toBeGreaterThanOrEqual(80);
    expect(plan.delayMs).toBeLessThanOrEqual(500);
  });

  it("uses a single frame for an empty clip and stays inside a very short one", () => {
    expect(planFrames(0).timestamps).toHaveLength(1);
    const short = planFrames(0.05).timestamps;
    expect(Math.max(...short)).toBeLessThanOrEqual(0.05);
    expect(Math.min(...short)).toBeGreaterThanOrEqual(0);
  });
});
