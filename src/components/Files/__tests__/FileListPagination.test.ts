import { describe, it, expect } from "vitest";
import {
  PAGE_SIZE,
  calculateDisplayedFiles,
  advanceVisibleCount,
  shouldResetPagination,
  filterAndSortFiles,
  pruneSelectedHashes,
} from "../FileList";
import type { FileMetadata } from "../../../types/metadata";

function createMockFiles(count: number, overrides: Partial<FileMetadata> = {}): FileMetadata[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `file-${i}`,
    name: `File ${String(i).padStart(3, "0")}.pdf`,
    size: 1024 * (i + 1),
    type: "application/pdf",
    folder: "/",
    uploadedAt: 1700000000 + i,
    server: "https://blossom.example.com",
    encryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    encryptionAlgorithm: "aes-256-gcm",
    ...overrides,
  }));
}

describe("FileList Real Pagination & Filtering Logic", () => {
  it("exports standard PAGE_SIZE constant as 40", () => {
    expect(PAGE_SIZE).toBe(40);
  });

  describe("calculateDisplayedFiles", () => {
    it("slices files array up to visibleCount", () => {
      const files = createMockFiles(100);
      const displayed = calculateDisplayedFiles(files, PAGE_SIZE);

      expect(displayed).toHaveLength(40);
      expect(displayed[0].id).toBe("file-0");
      expect(displayed[39].id).toBe("file-39");
    });

    it("returns all files when visibleCount exceeds files length", () => {
      const files = createMockFiles(25);
      const displayed = calculateDisplayedFiles(files, 40);

      expect(displayed).toHaveLength(25);
      expect(displayed[0].id).toBe("file-0");
      expect(displayed[24].id).toBe("file-24");
    });

    it("returns empty array when files is empty", () => {
      const displayed = calculateDisplayedFiles([], 40);
      expect(displayed).toEqual([]);
    });
  });

  describe("advanceVisibleCount", () => {
    it("progressively expands pagination by PAGE_SIZE up to total files length", () => {
      const total = 95;
      let visible = PAGE_SIZE; // 40

      visible = advanceVisibleCount(visible, total, PAGE_SIZE);
      expect(visible).toBe(80);

      visible = advanceVisibleCount(visible, total, PAGE_SIZE);
      expect(visible).toBe(95); // clamped to total

      // Further advances stay clamped
      visible = advanceVisibleCount(visible, total, PAGE_SIZE);
      expect(visible).toBe(95);
    });

    it("defaults pageSize to PAGE_SIZE (40)", () => {
      const advanced = advanceVisibleCount(40, 100);
      expect(advanced).toBe(80);
    });
  });

  describe("shouldResetPagination", () => {
    it("returns true when folder changes", () => {
      expect(shouldResetPagination("/", "/docs", "test", "test", "newest", "newest")).toBe(true);
    });

    it("returns true when query changes", () => {
      expect(shouldResetPagination("/", "/", "a", "b", "newest", "newest")).toBe(true);
    });

    it("returns true when sortKey changes", () => {
      expect(shouldResetPagination("/", "/", "a", "a", "newest", "oldest")).toBe(true);
    });

    it("returns false when folder, query, and sortKey remain unchanged", () => {
      expect(shouldResetPagination("/", "/", "a", "a", "newest", "newest")).toBe(false);
    });
  });

  describe("filterAndSortFiles", () => {
    const testFiles: FileMetadata[] = [
      {
        id: "f-1",
        name: "Alpha Invoice.pdf",
        size: 5000,
        type: "application/pdf",
        folder: "/",
        uploadedAt: 100,
        server: "https://blossom.example.com",
        encryptionKey: "key1",
        encryptionAlgorithm: "aes-256-gcm",
      },
      {
        id: "f-2",
        name: "Beta Report.docx",
        size: 2000,
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        folder: "/",
        uploadedAt: 200,
        server: "https://blossom.example.com",
        encryptionKey: "key2",
        encryptionAlgorithm: "aes-256-gcm",
      },
      {
        id: "f-3",
        name: "Gamma Invoice.png",
        size: 10000,
        type: "image/png",
        folder: "/",
        uploadedAt: 150,
        server: "https://blossom.example.com",
        encryptionKey: "key3",
        encryptionAlgorithm: "aes-256-gcm",
      },
      {
        id: "f-4",
        name: "Subfolder Invoice.pdf",
        size: 1000,
        type: "application/pdf",
        folder: "/sub",
        uploadedAt: 300,
        server: "https://blossom.example.com",
        encryptionKey: "key4",
        encryptionAlgorithm: "aes-256-gcm",
      },
    ];

    it("filters by current folder", () => {
      const rootFiles = filterAndSortFiles(testFiles, "/", "", "newest");
      expect(rootFiles.map((f) => f.id)).toEqual(["f-2", "f-3", "f-1"]);

      const subFiles = filterAndSortFiles(testFiles, "/sub", "", "newest");
      expect(subFiles.map((f) => f.id)).toEqual(["f-4"]);
    });

    it("filters case-insensitively by search query", () => {
      const invoiceFiles = filterAndSortFiles(testFiles, "/", "invoice", "newest");
      expect(invoiceFiles.map((f) => f.id)).toEqual(["f-3", "f-1"]);
    });

    it("sorts by name ascending", () => {
      const sorted = filterAndSortFiles(testFiles, "/", "", "name");
      expect(sorted.map((f) => f.name)).toEqual([
        "Alpha Invoice.pdf",
        "Beta Report.docx",
        "Gamma Invoice.png",
      ]);
    });

    it("sorts by oldest uploadedAt ascending", () => {
      const sorted = filterAndSortFiles(testFiles, "/", "", "oldest");
      expect(sorted.map((f) => f.id)).toEqual(["f-1", "f-3", "f-2"]);
    });

    it("sorts by newest uploadedAt descending", () => {
      const sorted = filterAndSortFiles(testFiles, "/", "", "newest");
      expect(sorted.map((f) => f.id)).toEqual(["f-2", "f-3", "f-1"]);
    });

    it("sorts by largest size descending", () => {
      const sorted = filterAndSortFiles(testFiles, "/", "", "largest");
      expect(sorted.map((f) => f.id)).toEqual(["f-3", "f-1", "f-2"]);
    });

    it("sorts by smallest size ascending", () => {
      const sorted = filterAndSortFiles(testFiles, "/", "", "smallest");
      expect(sorted.map((f) => f.id)).toEqual(["f-2", "f-1", "f-3"]);
    });
  });

  describe("pruneSelectedHashes", () => {
    it("returns identical Set reference when all selected hashes are valid", () => {
      const initial = new Set(["f-1", "f-2"]);
      const valid = new Set(["f-1", "f-2", "f-3"]);
      const result = pruneSelectedHashes(initial, valid);
      expect(result).toBe(initial);
    });

    it("returns new Set with non-valid hashes removed", () => {
      const initial = new Set(["f-1", "f-deleted", "f-2"]);
      const valid = new Set(["f-1", "f-2"]);
      const result = pruneSelectedHashes(initial, valid);
      expect(result).not.toBe(initial);
      expect(Array.from(result)).toEqual(["f-1", "f-2"]);
    });
  });
});
