import { describe, it, expect, vi } from "vitest";
import { resolvePreviewMode, getFileIcon } from "../fileTypeHelpers";
import { canOpenInPages, isOfficeDoc, isTextDoc, openInNostrDocs } from "../docsIntegrationHelpers";
import { canOpenPreview } from "../../components/Files/FileCard";

describe("HTML Preview & Pages Integration", () => {
  describe("resolvePreviewMode & getFileIcon for HTML", () => {
    it("detects text/html MIME type as html preview mode", () => {
      expect(resolvePreviewMode("text/html")).toBe("html");
      expect(resolvePreviewMode("text/HTML")).toBe("html");
      expect(getFileIcon("text/html")).toBe("html");
    });

    it("detects .html and .htm extensions even if MIME type is empty or generic", () => {
      expect(resolvePreviewMode("", "index.html")).toBe("html");
      expect(resolvePreviewMode("application/octet-stream", "page.htm")).toBe("html");
      expect(getFileIcon("application/octet-stream", "index.html")).toBe("html");
    });

    it("detects application/xhtml+xml as html", () => {
      expect(resolvePreviewMode("application/xhtml+xml")).toBe("html");
    });
  });

  describe("canOpenPreview for HTML", () => {
    it("allows HTML preview under 5 MB limit", () => {
      const result = canOpenPreview({
        fileType: "text/html",
        fileName: "index.html",
        fileSize: 100 * 1024, // 100 KB
        isLegacyBlob: false,
      });
      expect(result.allowed).toBe(true);
    });

    it("rejects HTML preview when exceeding 5 MB limit", () => {
      const result = canOpenPreview({
        fileType: "text/html",
        fileName: "huge.html",
        fileSize: 6 * 1024 * 1024, // 6 MB
        isLegacyBlob: false,
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Preview isn't available");
    });
  });

  describe("canOpenInPages / document detection", () => {
    it("identifies markdown files as text docs that can open in Pages", () => {
      expect(isTextDoc({ name: "notes.md" })).toBe(true);
      expect(isTextDoc({ name: "README.markdown" })).toBe(true);
      expect(isTextDoc({ type: "text/markdown" })).toBe(true);
      expect(canOpenInPages({ name: "notes.md" })).toBe(true);
    });

    it("identifies text files as docs that can open in Pages", () => {
      expect(isTextDoc({ name: "todo.txt" })).toBe(true);
      expect(isTextDoc({ type: "text/plain" })).toBe(true);
      expect(canOpenInPages({ name: "todo.txt" })).toBe(true);
    });

    it("identifies office docs (.docx, .doc, .odt) as docs that can open in Pages", () => {
      expect(isOfficeDoc({ name: "report.docx" })).toBe(true);
      expect(isOfficeDoc({ name: "paper.doc" })).toBe(true);
      expect(isOfficeDoc({ name: "thesis.odt" })).toBe(true);
      expect(
        isOfficeDoc({
          type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        })
      ).toBe(true);
      expect(canOpenInPages({ name: "report.docx" })).toBe(true);
    });

    it("does not allow non-docs to open in Pages", () => {
      expect(canOpenInPages({ name: "photo.png", type: "image/png" })).toBe(false);
      expect(canOpenInPages({ name: "clip.mp4", type: "video/mp4" })).toBe(false);
      expect(canOpenInPages({ name: "archive.zip", type: "application/zip" })).toBe(false);
      expect(canOpenInPages({ name: "index.html", type: "text/html" })).toBe(false);
    });

    it("opens document in Pages with base64 payload deeplink", () => {
      let openedUrl = "";
      const originalWindow = globalThis.window;
      globalThis.window = {
        open: vi.fn((url) => {
          openedUrl = String(url);
          return null;
        }),
      } as unknown as Window & typeof globalThis;

      const file = {
        id: "doc-1",
        name: "test.docx",
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        server: "https://blossom.server",
        blobHash: "abc123blobhash",
        encryptionKey: "deadbeefkey",
        size: 1024,
        folder: "",
        uploadedAt: 1234567890,
        encryptionAlgorithm: "aes-256-gcm",
      };

      // Production builds (the live site and the Android app, whose WebView is
      // served from "localhost") must target the live Pages site.
      vi.stubEnv("DEV", false);
      openInNostrDocs(file);
      vi.unstubAllEnvs();

      expect(globalThis.window.open).toHaveBeenCalled();
      expect(openedUrl).toContain("https://pages.formstr.app/#payload=");

      const encodedPayload = decodeURIComponent(openedUrl.split("#payload=")[1]);
      const payload = JSON.parse(Buffer.from(encodedPayload, "base64").toString("utf-8"));
      expect(payload.server).toBe("https://blossom.server");
      expect(payload.hash).toBe("abc123blobhash");
      expect(payload.encryptionKey).toBe("deadbeefkey");
      expect(payload.name).toBe("test.docx");

      globalThis.window = originalWindow;
    });
  });
});
