import { describe, it, expect } from "vitest";
import { resolvePreviewMode } from "../fileTypeHelpers";
import { parseDocxToHtml } from "../docxParser";

describe("DOCX Preview and Parser Integration", () => {
  it("resolves preview mode to 'docx' for .docx and .doc extensions and MIME types", () => {
    expect(
      resolvePreviewMode("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
    ).toBe("docx");
    expect(resolvePreviewMode("application/msword")).toBe("docx");
    expect(resolvePreviewMode("", "team.docx")).toBe("docx");
    expect(resolvePreviewMode("application/octet-stream", "proposal.docx")).toBe("docx");
    expect(resolvePreviewMode("", "legacy.doc")).toBe("docx");
  });

  it("fails gracefully with clean error message when DOCX bytes are empty or corrupted", async () => {
    await expect(parseDocxToHtml(new Uint8Array([]))).rejects.toThrow("DOCX file is empty");
    await expect(parseDocxToHtml(new Uint8Array([1, 2, 3]))).rejects.toThrow(
      "missing ZIP archive header"
    );
  });
});
