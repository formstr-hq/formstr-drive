import { describe, expect, it } from "vitest";
import { getAndroidUploadFooter, transferSurvivesAppClose } from "../appCloseSafety";
import type { TransferItem } from "../transferStore";

const item = (over: Partial<TransferItem>): TransferItem => ({
  id: "x",
  type: "upload",
  fileDetails: { name: "f", size: 1, hash: "h" },
  status: "running",
  progress: 0,
  abortController: new AbortController(),
  ...over,
});

describe("getAndroidUploadFooter", () => {
  it("is null with no uploads", () => {
    expect(getAndroidUploadFooter([])).toBeNull();
    expect(getAndroidUploadFooter([item({ type: "download" })])).toBeNull();
  });

  it("warns while any upload has not handed off", () => {
    const footer = getAndroidUploadFooter([
      item({ survivesAppClose: true }),
      item({ survivesAppClose: false }),
    ]);
    expect(footer?.tone).toBe("warning");
  });

  it("says it is safe to close once every upload has handed off", () => {
    const footer = getAndroidUploadFooter([
      item({ survivesAppClose: true }),
      item({ survivesAppClose: true }),
    ]);
    expect(footer?.tone).toBe("info");
  });
});

describe("transferSurvivesAppClose", () => {
  it("never survives off Android", () => {
    expect(transferSurvivesAppClose(item({ survivesAppClose: true }), false)).toBe(false);
  });

  it("android downloads survive; uploads only after handoff", () => {
    expect(transferSurvivesAppClose(item({ type: "download" }), true)).toBe(true);
    expect(transferSurvivesAppClose(item({}), true)).toBe(false);
    expect(transferSurvivesAppClose(item({ survivesAppClose: true }), true)).toBe(true);
  });
});
