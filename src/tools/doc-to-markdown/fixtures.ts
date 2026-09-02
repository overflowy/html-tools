// Hand-built fixtures for the smoke test: the smallest PDFs and DOCX that
// exercise each path (text layer, scanned page, mixed, office). Not part of
// the Tool; imported by smoke.ts only.

const enc = new TextEncoder();

function concat(parts: (Uint8Array | string)[]): Uint8Array {
  const chunks = parts.map((p) => (typeof p === "string" ? enc.encode(p) : p));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/* ---------------- PDF ---------------- */

export interface PdfPageSpec {
  /** Lines of Helvetica text drawn top-down, or none. */
  text?: string[];
  /** A JPEG to draw filling the page. */
  jpeg?: { bytes: Uint8Array; width: number; height: number };
}

/** A Letter-size PDF with one page per spec. Text pages have a real text layer; image pages have none. */
export function buildPdf(pages: PdfPageSpec[]): Uint8Array {
  const objects: (Uint8Array | string)[] = [];
  const add = (body: Uint8Array | string) => {
    objects.push(body);
    return objects.length;
  };
  const W = 612, H = 792;
  const fontId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const pageIds: number[] = [];
  const pagesId = objects.length + 1 + pages.length * 3; // reserved after all page objects
  for (const spec of pages) {
    let content = "";
    const resources: string[] = [`/Font << /F1 ${fontId} 0 R >>`];
    if (spec.text) {
      content += "BT /F1 14 Tf 72 720 Td 18 TL\n";
      for (const line of spec.text) content += "(" + line.replace(/[\\()]/g, (c) => "\\" + c) + ") Tj T*\n";
      content += "ET\n";
    }
    let imgId = 0;
    if (spec.jpeg) {
      const { bytes, width, height } = spec.jpeg;
      const stream = concat([
        `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>\nstream\n`,
        bytes,
        "\nendstream",
      ]);
      imgId = add(stream);
      resources.push(`/XObject << /Im1 ${imgId} 0 R >>`);
      content += `q ${W - 72} 0 0 ${(W - 72) * height / width} 36 ${H - 36 - (W - 72) * height / width} cm /Im1 Do Q\n`;
    }
    const contentId = add(`<< /Length ${enc.encode(content).length} >>\nstream\n${content}endstream`);
    const pageId = add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${W} ${H}] /Resources << ${resources.join(" ")} >> /Contents ${contentId} 0 R >>`);
    if (!spec.jpeg) add("<< >>"); // keep the object count per page constant so pagesId is right
    pageIds.push(pageId);
  }
  const realPagesId = add(`<< /Type /Pages /Kids [${pageIds.map((id) => id + " 0 R").join(" ")}] /Count ${pageIds.length} >>`);
  if (realPagesId !== pagesId) throw new Error("fixture: pages object id mismatch " + realPagesId + " vs " + pagesId);
  const catalogId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  const parts: (Uint8Array | string)[] = ["%PDF-1.4\n%\xe2\xe3\xcf\xd3\n"];
  const offsets: number[] = [];
  let length = enc.encode(parts[0] as string).length;
  objects.forEach((body, i) => {
    offsets.push(length);
    const head = `${i + 1} 0 obj\n`;
    const tail = "\nendobj\n";
    parts.push(head, body, tail);
    length += enc.encode(head).length + (typeof body === "string" ? enc.encode(body).length : body.length) + enc.encode(tail).length;
  });
  const xref = length;
  let table = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) table += String(o).padStart(10, "0") + " 00000 n \n";
  table += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  parts.push(table);
  return concat(parts);
}

/* ---------------- DOCX ---------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function le16(n: number) {
  return new Uint8Array([n & 0xff, (n >> 8) & 0xff]);
}
function le32(n: number) {
  return new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]);
}

/** A stored (uncompressed) zip. */
export function buildZip(files: Record<string, string>): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = enc.encode(name);
    const data = enc.encode(text);
    const crc = crc32(data);
    const local = concat([le32(0x04034b50), le16(20), le16(0), le16(0), le16(0), le16(0), le32(crc), le32(data.length), le32(data.length), le16(nameBytes.length), le16(0), nameBytes, data]);
    locals.push(local);
    centrals.push(concat([le32(0x02014b50), le16(20), le16(20), le16(0), le16(0), le16(0), le16(0), le32(crc), le32(data.length), le32(data.length), le16(nameBytes.length), le16(0), le16(0), le16(0), le16(0), le32(0), le32(offset), nameBytes]));
    offset += local.length;
  }
  const central = concat(centrals);
  const eocd = concat([le32(0x06054b50), le16(0), le16(0), le16(locals.length), le16(locals.length), le32(central.length), le32(offset), le16(0)]);
  return concat([...locals, central, eocd]);
}

/** A minimal Word document: a heading and paragraphs. */
export function buildDocx(heading: string, paragraphs: string[]): Uint8Array {
  const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const body =
    `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${escapeXml(heading)}</w:t></w:r></w:p>` +
    paragraphs.map((p) => `<w:p><w:r><w:t>${escapeXml(p)}</w:t></w:r></w:p>`).join("");
  return buildZip({
    "[Content_Types].xml":
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
    "_rels/.rels":
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/_rels/document.xml.rels":
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    "word/styles.xml":
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style></w:styles>`,
    "word/document.xml":
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  });
}
