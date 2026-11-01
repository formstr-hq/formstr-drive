/**
 * src/utils/docxParser.ts
 * Lightweight, zero-dependency browser-native parser for .docx (Office Open XML) archives.
 * Decompresses word/document.xml using browser DecompressionStream and converts
 * paragraphs, headings, formatting (bold/italic/underline), lists, and tables into clean HTML.
 */

/**
 * Lightweight ZIP entry extractor for uncompressed or Deflate-compressed entries.
 */
export async function extractZipEntry(zipBytes: Uint8Array, entryName: string): Promise<Uint8Array | null> {
  const len = zipBytes.length;
  let offset = 0;

  while (offset + 30 <= len) {
    // Check for local file header signature: 0x04034b50 (PK\x03\x04)
    if (
      zipBytes[offset] === 0x50 &&
      zipBytes[offset + 1] === 0x4b &&
      zipBytes[offset + 2] === 0x03 &&
      zipBytes[offset + 3] === 0x04
    ) {
      const compression = zipBytes[offset + 8] | (zipBytes[offset + 9] << 8);
      const compressedSize =
        zipBytes[offset + 18] |
        (zipBytes[offset + 19] << 8) |
        (zipBytes[offset + 20] << 16) |
        (zipBytes[offset + 21] << 24);
      const fileNameLen = zipBytes[offset + 26] | (zipBytes[offset + 27] << 8);
      const extraLen = zipBytes[offset + 28] | (zipBytes[offset + 29] << 8);

      const nameStart = offset + 30;
      const nameEnd = nameStart + fileNameLen;
      if (nameEnd > len) break;

      const currentName = new TextDecoder().decode(zipBytes.subarray(nameStart, nameEnd));
      const dataStart = nameEnd + extraLen;
      const dataEnd = dataStart + compressedSize;

      if (currentName === entryName) {
        if (dataEnd > len) break;
        const compressedData = zipBytes.subarray(dataStart, dataEnd);

        if (compression === 0) {
          return compressedData;
        }

        if (compression === 8) {
          if (typeof DecompressionStream !== "undefined") {
            try {
              const ds = new DecompressionStream("deflate-raw");
              const stream = new Response(new Blob([compressedData as unknown as BlobPart]).stream().pipeThrough(ds));
              const buf = await stream.arrayBuffer();
              return new Uint8Array(buf);
            } catch {
              try {
                const ds = new DecompressionStream("deflate");
                const stream = new Response(new Blob([compressedData as unknown as BlobPart]).stream().pipeThrough(ds));
                const buf = await stream.arrayBuffer();
                return new Uint8Array(buf);
              } catch {
                return null;
              }
            }
          }
        }
        return null;
      }

      offset = dataEnd;
    } else {
      offset++;
    }
  }

  return null;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export interface DocxParseResult {
  html: string;
  text: string;
  wordCount: number;
}

/**
 * Parses raw DOCX bytes into HTML and plain text for in-app viewing.
 */
export async function parseDocxToHtml(docxBytes: Uint8Array): Promise<DocxParseResult> {
  if (!docxBytes || docxBytes.length === 0) {
    throw new Error("DOCX file is empty");
  }

  // Check for ZIP magic bytes: PK\x03\x04
  if (docxBytes.length < 4 || docxBytes[0] !== 0x50 || docxBytes[1] !== 0x4b) {
    throw new Error("Invalid DOCX format: missing ZIP archive header");
  }

  const xmlBytes = await extractZipEntry(docxBytes, "word/document.xml");

  if (!xmlBytes) {
    // Fallback: scan for <w:t> tags in raw archive
    const textDecoder = new TextDecoder("utf-8", { fatal: false });
    const rawXml = textDecoder.decode(docxBytes);
    const textMatches = rawXml.match(/<w:t[^>]*>(.*?)<\/w:t>/g);

    if (textMatches && textMatches.length > 0) {
      const extractedText = textMatches
        .map((m) => m.replace(/<[^>]*>/g, ""))
        .join(" ")
        .trim();
      const words = extractedText.split(/\s+/).filter(Boolean).length;
      return {
        html: `<p>${escapeHtml(extractedText)}</p>`,
        text: extractedText,
        wordCount: words,
      };
    }

    throw new Error("Unable to locate word/document.xml in DOCX archive");
  }

  const xmlStr = new TextDecoder().decode(xmlBytes);

  const htmlParts: string[] = [];
  const textParts: string[] = [];

  // Match all <w:p>...</w:p> and <w:tbl>...</w:tbl> blocks
  const blockRegex = /<(w:p|w:tbl)\b[^>]*>([\s\S]*?)<\/\1>/g;
  let blockMatch: RegExpExecArray | null;

  while ((blockMatch = blockRegex.exec(xmlStr)) !== null) {
    const tagName = blockMatch[1];
    const blockXml = blockMatch[2];

    if (tagName === "w:tbl") {
      // Process table
      const rows: string[] = [];
      const trRegex = /<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g;
      let trMatch: RegExpExecArray | null;

      while ((trMatch = trRegex.exec(blockXml)) !== null) {
        const cells: string[] = [];
        const tcRegex = /<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g;
        let tcMatch: RegExpExecArray | null;

        while ((tcMatch = tcRegex.exec(trMatch[1])) !== null) {
          const tMatches = tcMatch[1].match(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g) || [];
          const cellText = tMatches.map((t) => t.replace(/<[^>]*>/g, "")).join("");
          cells.push(`<td>${escapeHtml(cellText)}</td>`);
        }
        if (cells.length > 0) {
          rows.push(`<tr>${cells.join("")}</tr>`);
        }
      }

      if (rows.length > 0) {
        htmlParts.push(`<table class="docx-table">${rows.join("")}</table>`);
      }
      continue;
    }

    // Process paragraph (<w:p>)
    const styleMatch = blockXml.match(/<w:pStyle\s+[^>]*w:val="Heading(\d)"/i);
    const headingLevel = styleMatch ? Number(styleMatch[1]) : 0;
    const isListItem = /<w:numPr\b/.test(blockXml);

    const runRegex = /<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g;
    let rMatch: RegExpExecArray | null;
    const inlineHtml: string[] = [];
    let pText = "";

    while ((rMatch = runRegex.exec(blockXml)) !== null) {
      const rXml = rMatch[1];
      const isBold = /<w:b(\s*\/|>|\s+[^>]*\/>)/.test(rXml);
      const isItalic = /<w:i(\s*\/|>|\s+[^>]*\/>)/.test(rXml);
      const isUnderline = /<w:u(\s*\/|>|\s+[^>]*\/>)/.test(rXml);

      const tMatch = rXml.match(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/);
      if (tMatch && tMatch[1]) {
        const text = tMatch[1];
        pText += text;
        let formatted = escapeHtml(text);

        if (isBold) formatted = `<strong>${formatted}</strong>`;
        if (isItalic) formatted = `<em>${formatted}</em>`;
        if (isUnderline) formatted = `<u>${formatted}</u>`;

        inlineHtml.push(formatted);
      }
    }

    if (pText.trim().length > 0) {
      textParts.push(pText.trim());
      const content = inlineHtml.join("");

      if (headingLevel >= 1 && headingLevel <= 6) {
        htmlParts.push(`<h${headingLevel}>${content}</h${headingLevel}>`);
      } else if (isListItem) {
        htmlParts.push(`<li>${content}</li>`);
      } else {
        htmlParts.push(`<p>${content}</p>`);
      }
    }
  }

  const fullText = textParts.join("\n\n");
  const wordCount = fullText.split(/\s+/).filter(Boolean).length;

  return {
    html: htmlParts.length > 0 ? htmlParts.join("") : "<p><em>(Empty document)</em></p>",
    text: fullText,
    wordCount,
  };
}
