// Reads single entries out of a ZIP (docx/xlsx/pptx/odt/epub...) with slice()
// reads only: the end-of-central-directory record, the central directory, then
// the one entry's bytes. Memory does not scale with archive size. ZIP64
// archives (over 4 GB) are not handled and report "not readable".

import { ZIP_ENTRY_MAX_BYTES } from "./limits";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_COMMENT = 0xffff;
const FLAG_ENCRYPTED = 0x1;

async function readView(file: Blob, start: number, end: number): Promise<DataView> {
  return new DataView(await file.slice(Math.max(0, start), end).arrayBuffer());
}

type CentralEntry = {
  name: string;
  flags: number;
  method: number;
  compressedSize: number;
  localOffset: number;
};

async function readCentralDirectory(file: Blob): Promise<CentralEntry[] | null> {
  const tailSize = Math.min(file.size, 22 + MAX_COMMENT);
  const tail = await readView(file, file.size - tailSize, file.size);
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const total = tail.getUint16(eocd + 10, true);
  const cdSize = tail.getUint32(eocd + 12, true);
  const cdOffset = tail.getUint32(eocd + 16, true);
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff || cdOffset + cdSize > file.size) return null;

  const cd = await readView(file, cdOffset, cdOffset + cdSize);
  const decoder = new TextDecoder();
  const entries: CentralEntry[] = [];
  let pos = 0;
  for (let n = 0; n < total && pos + 46 <= cd.byteLength; n++) {
    if (cd.getUint32(pos, true) !== CENTRAL_SIGNATURE) break;
    const nameLength = cd.getUint16(pos + 28, true);
    entries.push({
      flags: cd.getUint16(pos + 8, true),
      method: cd.getUint16(pos + 10, true),
      compressedSize: cd.getUint32(pos + 20, true),
      localOffset: cd.getUint32(pos + 42, true),
      name: decoder.decode(new Uint8Array(cd.buffer, cd.byteOffset + pos + 46, nameLength)),
    });
    pos += 46 + nameLength + cd.getUint16(pos + 30, true) + cd.getUint16(pos + 32, true);
  }
  return entries;
}

/** Inflates raw deflate data, giving up (null) once the output passes maxBytes. */
async function inflateRaw(data: Uint8Array, maxBytes: number): Promise<Uint8Array | null> {
  const stream = new Blob([data as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export type ZipReader = {
  names: string[];
  /** Entry bytes, or null when missing, encrypted, unsupported, corrupt or over maxBytes. */
  read(name: string, maxBytes?: number): Promise<Uint8Array | null>;
};

/** Opens a ZIP central directory; null when the file is not a readable ZIP. */
export async function openZip(file: Blob): Promise<ZipReader | null> {
  if (file.size < 22 || typeof DecompressionStream === "undefined") return null;
  const entries = await readCentralDirectory(file);
  if (!entries) return null;
  const byName = new Map(entries.map((entry) => [entry.name, entry]));

  return {
    names: entries.map((entry) => entry.name),
    async read(name, maxBytes = ZIP_ENTRY_MAX_BYTES) {
      const entry = byName.get(name);
      if (!entry || entry.flags & FLAG_ENCRYPTED || entry.compressedSize > maxBytes) return null;
      try {
        const header = await readView(file, entry.localOffset, entry.localOffset + 30);
        if (header.getUint32(0, true) !== LOCAL_SIGNATURE) return null;
        const start = entry.localOffset + 30 + header.getUint16(26, true) + header.getUint16(28, true);
        const raw = new Uint8Array(await file.slice(start, start + entry.compressedSize).arrayBuffer());
        if (entry.method === 0) return raw;
        if (entry.method === 8) return await inflateRaw(raw, maxBytes);
        return null;
      } catch {
        return null;
      }
    },
  };
}
