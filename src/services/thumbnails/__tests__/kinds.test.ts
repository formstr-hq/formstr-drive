import { describe, expect, it } from "vitest";
import { getFileIcon, resolvePreviewMode } from "../../../utils/fileTypeHelpers";
import { isOfficeDoc } from "../../../utils/docsIntegrationHelpers";
import { fileKind } from "../kinds";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

describe("fileKind", () => {
  it("trusts a specific MIME type over the extension", () => {
    expect(fileKind({ type: "video/mp4", name: "a.txt" })).toBe("video");
    expect(fileKind({ type: "image/png", name: "a" })).toBe("image");
    expect(fileKind({ type: "audio/mpeg", name: "a" })).toBe("audio");
    expect(fileKind({ type: "application/pdf", name: "a" })).toBe("pdf");
    expect(fileKind({ type: "text/html; charset=utf-8", name: "a" })).toBe("html");
    expect(fileKind({ type: DOCX, name: "a" })).toBe("docx");
    expect(fileKind({ type: "application/json", name: "a" })).toBe("text");
  });

  it("falls back to the extension for empty and generic types", () => {
    expect(fileKind({ type: "", name: "clip.MKV" })).toBe("video");
    expect(fileKind({ type: "", name: "photo.HEIC" })).toBe("image");
    expect(fileKind({ type: "application/octet-stream", name: "x.pdf" })).toBe("pdf");
    expect(fileKind({ type: "application/zip", name: "report.docx" })).toBe("docx");
    expect(fileKind({ type: "application/x-zip-compressed", name: "sheet.xlsx" })).toBe("office");
    expect(fileKind({ type: "", name: "main.rs" })).toBe("text");
    expect(fileKind({ type: "", name: "page.htm" })).toBe("html");
  });

  it("does not let the extension override a specific unrelated type", () => {
    expect(fileKind({ type: "application/x-tar", name: "a.mp4" })).toBe("archive");
  });

  it("identifies archives and unknown files", () => {
    expect(fileKind({ type: "application/zip", name: "backup.zip" })).toBe("archive");
    expect(fileKind({ type: "", name: "blob.bin" })).toBe("other");
    expect(fileKind({ type: "", name: "noextension" })).toBe("other");
  });

  it("treats small .ts files as source and large ones as video", () => {
    expect(fileKind({ type: "video/mp2t", name: "app.ts", size: 4_000 })).toBe("text");
    expect(fileKind({ type: "", name: "app.ts", size: 4_000 })).toBe("text");
    expect(fileKind({ type: "video/mp2t", name: "clip.ts", size: 500_000_000 })).toBe("video");
  });
});

describe("helpers derived from fileKind agree with it", () => {
  it("resolvePreviewMode", () => {
    expect(resolvePreviewMode(DOCX)).toBe("docx");
    expect(resolvePreviewMode("application/msword")).toBe("docx");
    expect(resolvePreviewMode("", "legacy.doc")).toBe("docx");
    expect(resolvePreviewMode("application/octet-stream", "proposal.docx")).toBe("docx");
    expect(resolvePreviewMode("text/html")).toBe("html");
    expect(resolvePreviewMode("audio/mpeg", "a.mp3")).toBe("unsupported");
    expect(resolvePreviewMode("application/zip", "a.zip")).toBe("unsupported");
  });

  it("getFileIcon", () => {
    expect(getFileIcon(DOCX)).toBe("doc");
    expect(getFileIcon("audio/mpeg")).toBe("aud");
    expect(getFileIcon("application/zip")).toBe("zip");
    expect(getFileIcon("text/plain")).toBe("txt");
    expect(getFileIcon("application/octet-stream")).toBe("file");
  });

  it("isOfficeDoc covers word-processing files only", () => {
    expect(isOfficeDoc({ type: DOCX })).toBe(true);
    expect(isOfficeDoc({ name: "notes.odt" })).toBe(true);
    expect(isOfficeDoc({ name: "sheet.xlsx" })).toBe(false);
  });
});
