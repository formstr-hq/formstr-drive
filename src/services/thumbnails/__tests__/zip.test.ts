import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { openZip } from "../zip";

type Entry = { name: string; data: Uint8Array; deflate?: boolean; flags?: number };

/** Minimal ZIP writer (no CRC; the reader never checks it). */
function buildZip(entries: Entry[], comment = ""): Blob {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const enc = new TextEncoder();

  for (const e of entries) {
    const name = enc.encode(e.name);
    const body = e.deflate ? new Uint8Array(deflateRawSync(e.data)) : e.data;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(8, e.deflate ? 8 : 0, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, e.data.length, true);
    local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, body);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(8, e.flags ?? 0, true);
    cd.setUint16(10, e.deflate ? 8 : 0, true);
    cd.setUint32(20, body.length, true);
    cd.setUint32(24, e.data.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);

    offset += 30 + name.length + body.length;
  }

  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const commentBytes = enc.encode(comment);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, offset, true);
  eocd.setUint16(20, commentBytes.length, true);

  return new Blob([...parts, ...central, new Uint8Array(eocd.buffer), commentBytes] as BlobPart[]);
}

describe("openZip", () => {
  const text = new TextEncoder().encode("hello thumbnail ".repeat(50));

  it("lists entries and reads stored and deflated data", async () => {
    const zip = await openZip(
      buildZip([
        { name: "docProps/thumbnail.jpeg", data: new Uint8Array([1, 2, 3]) },
        { name: "word/document.xml", data: text, deflate: true },
      ]),
    );
    expect(zip?.names).toEqual(["docProps/thumbnail.jpeg", "word/document.xml"]);
    expect(Array.from((await zip!.read("docProps/thumbnail.jpeg"))!)).toEqual([1, 2, 3]);
    expect(new TextDecoder().decode((await zip!.read("word/document.xml"))!)).toBe(new TextDecoder().decode(text));
  });

  it("finds the directory behind a long archive comment", async () => {
    const zip = await openZip(buildZip([{ name: "a.txt", data: text }], "x".repeat(500)));
    expect(zip?.names).toEqual(["a.txt"]);
  });

  it("returns null for missing, oversize and encrypted entries", async () => {
    const zip = await openZip(
      buildZip([
        { name: "big.bin", data: new Uint8Array(1000) },
        { name: "secret.xml", data: text, flags: 1 },
      ]),
    );
    expect(await zip!.read("nope")).toBeNull();
    expect(await zip!.read("big.bin", 10)).toBeNull();
    expect(await zip!.read("secret.xml")).toBeNull();
  });

  it("refuses to inflate past the decompressed-size cap (zip bomb)", async () => {
    const bomb = new Uint8Array(2 * 1024 * 1024); // compresses to a few KB
    const zip = await openZip(buildZip([{ name: "bomb.xml", data: bomb, deflate: true }]));
    expect(await zip!.read("bomb.xml", 100 * 1024)).toBeNull();
    expect((await zip!.read("bomb.xml", 4 * 1024 * 1024))!.length).toBe(bomb.length);
  });

  it("returns null for corrupt deflate data instead of throwing", async () => {
    const blob = buildZip([{ name: "x.xml", data: new Uint8Array([9, 9, 9, 9, 9, 9]), deflate: false }]);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    // Flip the method to deflate on both headers so the stored bytes are invalid deflate.
    const view = new DataView(bytes.buffer);
    view.setUint16(8, 8, true);
    const cdStart = view.getUint32(bytes.length - 22 + 16, true);
    view.setUint16(cdStart + 10, 8, true);
    const zip = await openZip(new Blob([bytes]));
    expect(await zip!.read("x.xml")).toBeNull();
  });

  it("returns null for data that is not a zip", async () => {
    expect(await openZip(new Blob(["definitely not a zip file at all, just plain text"]))).toBeNull();
    expect(await openZip(new Blob([]))).toBeNull();
  });
});
