import { describe, it, expect, vi } from "vitest";
import {
  handleCardTapLogic,
  handleCardKeyDownLogic,
  canOpenPreview,
} from "../FileCard";

describe("FileCard Real Tap & Interaction Controller Logic", () => {
  describe("handleCardTapLogic", () => {
    it("opens the file when idle", () => {
      const onOpen = vi.fn();
      const onToggleSelection = vi.fn();
      handleCardTapLogic({ isSelectionMode: false, fileId: "file-abc", onToggleSelection, onOpen });
      expect(onOpen).toHaveBeenCalledTimes(1);
      expect(onToggleSelection).not.toHaveBeenCalled();
    });

    it("toggles selection in selection mode and does not open", () => {
      const onOpen = vi.fn();
      const onToggleSelection = vi.fn();
      handleCardTapLogic({ isSelectionMode: true, fileId: "file-xyz", onToggleSelection, onOpen });
      expect(onToggleSelection).toHaveBeenCalledWith("file-xyz");
      expect(onOpen).not.toHaveBeenCalled();
    });
  });

  describe("handleCardKeyDownLogic", () => {
    const base = { fileId: "file-key", onToggleSelection: vi.fn() };

    it("activates on Enter and Space when the card itself is the target", () => {
      const onOpen = vi.fn();
      const preventDefault = vi.fn();
      const onToggleSelection = vi.fn();

      expect(
        handleCardKeyDownLogic({ key: "Enter", isDirectTarget: true, preventDefault, isSelectionMode: false, fileId: "file-key", onToggleSelection, onOpen }),
      ).toBe(true);
      expect(onOpen).toHaveBeenCalledTimes(1);

      expect(
        handleCardKeyDownLogic({ key: " ", isDirectTarget: true, preventDefault, isSelectionMode: true, fileId: "file-key", onToggleSelection, onOpen }),
      ).toBe(true);
      expect(preventDefault).toHaveBeenCalledTimes(2);
      expect(onToggleSelection).toHaveBeenCalledWith("file-key");
    });

    it("ignores non-activation keys and events bubbled from child buttons", () => {
      const onOpen = vi.fn();
      const preventDefault = vi.fn();
      for (const [key, isDirectTarget] of [["Tab", true], ["ArrowDown", true], ["Enter", false]] as const) {
        expect(
          handleCardKeyDownLogic({ ...base, key, isDirectTarget, preventDefault, isSelectionMode: false, onOpen }),
        ).toBe(false);
      }
      expect(preventDefault).not.toHaveBeenCalled();
      expect(onOpen).not.toHaveBeenCalled();
    });
  });

  describe("canOpenPreview (5 MB Preview Gate)", () => {
    it("allows preview for non-streamable files under 5 MB limit", () => {
      const result = canOpenPreview({
        fileType: "image/png",
        fileSize: 2 * 1024 * 1024, // 2 MB
        isLegacyBlob: false,
      });

      expect(result.allowed).toBe(true);
    });

    it("rejects preview for non-streamable files exceeding 5 MB limit", () => {
      const result = canOpenPreview({
        fileType: "image/png",
        fileSize: 6 * 1024 * 1024, // 6 MB
        isLegacyBlob: false,
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Preview isn't available");
    });

    it("allows preview for large video/pdf when using modern streamable blob format", () => {
      const videoResult = canOpenPreview({
        fileType: "video/mp4",
        fileSize: 50 * 1024 * 1024, // 50 MB
        isLegacyBlob: false,
      });
      expect(videoResult.allowed).toBe(true);

      const pdfResult = canOpenPreview({
        fileType: "application/pdf",
        fileSize: 20 * 1024 * 1024, // 20 MB
        isLegacyBlob: false,
      });
      expect(pdfResult.allowed).toBe(true);
    });

    it("rejects preview for large video when using legacy non-streamable format", () => {
      const legacyResult = canOpenPreview({
        fileType: "video/mp4",
        fileSize: 10 * 1024 * 1024, // 10 MB
        isLegacyBlob: true,
      });

      expect(legacyResult.allowed).toBe(false);
      expect(legacyResult.reason).toContain("Preview isn't available");
    });
  });
});
