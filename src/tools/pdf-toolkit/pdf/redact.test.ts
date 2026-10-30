import { expect, test } from "bun:test";

import * as mupdf from "mupdf";

import { OPS } from "../ops";
import { makePdf, openTest, pageTexts, testEnv } from "../test-env";
import { pageContents } from "./compose";
import { findElsewhere } from "./elsewhere";
import type { Place } from "./elsewhere";
import { redact } from "./security";
import type { RedactMark, RedactOptions, RedactResult } from "./security";
import { queryRegExp } from "./text";
import { parseContent } from "./tokens";

/* ---------------- building test files ---------------- */

const bytesOf = (s: string) => Uint8Array.from(s, (c) => c.codePointAt(0) ?? 0);
const stringOf = (b: Uint8Array) => {
  let s = "";
  for (const x of b) {
    s += String.fromCodePoint(x);
  }
  return s;
};

type Body = string | { dict?: string; data: string };

const body = (b: Body) =>
  typeof b === "string"
    ? b
    : `<< ${b.dict ?? ""} /Length ${b.data.length} >>\nstream\n${b.data}\nendstream`;

/** A PDF of hand-written objects, numbered from 1 (the catalog). */
const build = (objs: Body[], trailer = ""): Uint8Array => {
  let out = "%PDF-1.7\n";
  const offsets: number[] = [];
  for (const [i, b] of objs.entries()) {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body(b)}\nendobj\n`;
  }
  const xref = out.length;
  const rows = offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${rows.join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R ${trailer} >>\nstartxref\n${xref}\n%%EOF\n`;
  return bytesOf(out);
};

const CATALOG = "<< /Type /Catalog /Pages 2 0 R >>";
const PAGES = "<< /Type /Pages /Kids [4 0 R] /Count 1 >>";
const HELV =
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
const H = 792;
const page = (extra = "", resources = "/Font << /F1 3 0 R >>") =>
  `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 ${H}] /Resources << ${resources} >> /Contents 5 0 R ${extra} >>`;

/** A box in display space from PDF-space corners, on an unrotated page. */
const box = (x0: number, y0: number, x1: number, y1: number): RedactMark => ({
  page: 0,
  rect: [x0, H - y1, x1, H - y0],
});

const OPTIONS: Omit<RedactOptions, "marks"> = {
  black: true,
  images: "pixels",
  lineArt: "covered",
};

const run = async (
  src: Uint8Array,
  marks: RedactMark[],
  o: Partial<Omit<RedactOptions, "marks">> = {}
): Promise<RedactResult> =>
  redact(await testEnv(), src, { ...OPTIONS, ...o, marks });

/** Everything someone could read out of the file: its bytes, every stream decoded, every object written out. */
const everything = (bytes: Uint8Array): string => {
  const doc = openTest(bytes);
  const parts = [stringOf(bytes)];
  for (let i = 1; i < doc.countObjects(); i += 1) {
    const ref = doc.newIndirect(i);
    try {
      if (ref.isStream()) {
        parts.push(stringOf(ref.readStream().asUint8Array()));
      }
      parts.push(ref.resolve().toString());
    } catch {
      // A free object: nothing to read.
    }
  }
  return parts.join("\n");
};

const contentOf = (bytes: Uint8Array, index = 0) =>
  stringOf(pageContents(openTest(bytes).findPage(index)));

const searchQuads = (
  bytes: Uint8Array,
  needle: string,
  index = 0
): RedactMark => ({
  page: index,
  quads: openTest(bytes).loadPage(index).search(needle, "").flat() as never,
});

/** How many pixels in `rect` (display space) are dark, rendering annotations and fields too. */
const darkPixels = (
  bytes: Uint8Array,
  rect: [number, number, number, number]
) => {
  const pix = openTest(bytes)
    .loadPage(0)
    .toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, false, true);
  const [px, w] = [pix.getPixels(), pix.getWidth()];
  const [x0, y0, x1, y1] = rect;
  let n = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      if ((px[y * w + x] ?? 255) < 128) {
        n += 1;
      }
    }
  }
  return n;
};

/* ---------------- text ---------------- */

test("redaction removes the text under the box, not just covers it", async () => {
  const src = makePdf(1);
  const [[quad] = []] = openTest(src).loadPage(0).search("Page 1", "");
  const out = await run(src, [{ page: 0, quads: quad ? [quad] : [] }], {
    lineArt: "keep",
  });
  expect(pageTexts(out.bytes)).toEqual([""]);
  expect(new TextDecoder("latin1").decode(out.bytes)).not.toContain("Page 1");
});

/* ---------------- comments and form fields ---------------- */

test("comments under a mark go, with their pop-ups; one elsewhere stays", async () => {
  const src = build([
    CATALOG,
    PAGES,
    HELV,
    page("/Annots [6 0 R 7 0 R 8 0 R 9 0 R 10 0 R]"),
    { data: "BT /F1 24 Tf 72 700 Td (Secret name) Tj ET" },
    "<< /Type /Annot /Subtype /Text /Rect [72 700 92 720] /Contents (note about the name) /Popup 10 0 R >>",
    "<< /Type /Annot /Subtype /Square /Rect [70 695 250 725] /Contents (square comment) >>",
    "<< /Type /Annot /Subtype /Highlight /Rect [70 695 250 725] /QuadPoints [72 722 230 722 72 697 230 697] /Contents (highlight comment) /C [1 1 0] >>",
    "<< /Type /Annot /Subtype /Text /Rect [500 100 520 120] /Contents (keep this note) >>",
    "<< /Type /Annot /Subtype /Popup /Rect [300 600 400 700] /Parent 6 0 R >>",
  ]);
  const out = await run(src, [searchQuads(src, "Secret name")]);
  expect(out.annotations).toBe(3);
  expect(out.fields).toBe(0);
  const p = openTest(out.bytes).loadPage(0);
  expect(p.getAnnotations().map((a) => a.getContents())).toEqual([
    "keep this note",
  ]);
  // The pop-up of the note went with it.
  expect(p.getObject().get("Annots").length).toBe(1);
  const all = everything(out.bytes);
  for (const gone of [
    "note about",
    "square comment",
    "highlight comment",
    "Secret name",
  ]) {
    expect(all).not.toContain(gone);
  }
});

test("a filled form field under a mark goes, value and all; one elsewhere stays and still shows", async () => {
  const ap = (text: string) => ({
    data: `1 g 0 0 230 40 re f /Tx BMC BT 0 g /Helv 14 Tf 4 14 Td (${text}) Tj ET EMC`,
    dict: "/Type /XObject /Subtype /Form /BBox [0 0 230 40] /Resources << /Font << /Helv 3 0 R >> >>",
  });
  const src = build([
    "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [6 0 R 8 0 R 10 0 R] /CO [6 0 R] /DA (/Helv 12 Tf 0 g) /DR << /Font << /Helv 3 0 R >> >> >> >>",
    PAGES,
    HELV,
    page("/Annots [6 0 R 8 0 R 11 0 R]"),
    { data: "BT /F1 12 Tf 72 745 Td (Name:) Tj ET" },
    "<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /V (Jane Q Public) /Rect [70 690 300 730] /DA (/Helv 14 Tf 0 g) /AP << /N 7 0 R >> /P 4 0 R /F 4 >>",
    ap("Jane Q Public"),
    "<< /Type /Annot /Subtype /Widget /FT /Tx /T (city) /V (Springfield) /Rect [70 100 300 140] /DA (/Helv 14 Tf 0 g) /AP << /N 9 0 R >> /P 4 0 R /F 4 >>",
    ap("Springfield"),
    "<< /FT /Tx /T (account) /V (ACCT-998877) /Kids [11 0 R] >>",
    "<< /Type /Annot /Subtype /Widget /Parent 10 0 R /Rect [70 640 300 680] /P 4 0 R /F 4 >>",
  ]);
  const out = await run(src, [box(60, 635, 320, 740)]);
  expect(out.fields).toBe(2);
  expect(out.annotations).toBe(0);
  const p = openTest(out.bytes).loadPage(0);
  expect(p.getWidgets().map((w) => [w.getName(), w.getValue()])).toEqual([
    ["city", "Springfield"],
  ]);
  const all = everything(out.bytes);
  expect(all).not.toContain("Jane Q Public");
  expect(all).not.toContain("ACCT-998877");
  // The field left is drawn as before, fonts subset and all.
  expect(darkPixels(out.bytes, [70, H - 140, 300, H - 100])).toBeGreaterThan(
    50
  );
});

test("on a rotated page with an offset crop box, a mark finds the comment over its text", async () => {
  const src = build([
    CATALOG,
    PAGES,
    HELV,
    `<< /Type /Page /Parent 2 0 R /MediaBox [-50 100 562 892] /CropBox [0 150 500 850] /Rotate 90 /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R /Annots [6 0 R 7 0 R] >>`,
    {
      data: "BT /F1 24 Tf 72 700 Td (Rotated secret) Tj ET BT /F1 24 Tf 72 300 Td (kept) Tj ET",
    },
    "<< /Type /Annot /Subtype /Text /Rect [72 700 92 720] /Contents (over the secret) >>",
    "<< /Type /Annot /Subtype /Text /Rect [300 300 320 320] /Contents (elsewhere) >>",
  ]);
  const out = await run(src, [searchQuads(src, "Rotated secret")]);
  expect(out.annotations).toBe(1);
  expect(pageTexts(out.bytes)).toEqual(["kept"]);
  expect(
    openTest(out.bytes)
      .loadPage(0)
      .getAnnotations()
      .map((a) => a.getContents())
  ).toEqual(["elsewhere"]);
});

/* ---------------- drawings ---------------- */

test("line art: covered keeps a drawing crossing the box whole, touched removes it", async () => {
  const src = build([
    CATALOG,
    PAGES,
    HELV,
    page("", ""),
    { data: "100 700 m 150 720 l S\n50 650 m 550 650 l S" },
  ]);
  const mark = box(90, 640, 200, 730);
  const contentAfter = async (lineArt: RedactOptions["lineArt"]) => {
    const out = await run(src, [mark], { lineArt });
    return contentOf(out.bytes);
  };
  const kept = await contentAfter("keep");
  const covered = await contentAfter("covered");
  const touched = await contentAfter("touched");
  expect(kept).toContain("150 720");
  expect(kept).toContain("550 650");
  expect(covered).not.toContain("150 720");
  expect(covered).toContain("550 650");
  expect(touched).not.toContain("150 720");
  expect(touched).not.toContain("550 650");
});

/* ---------------- what does not show ---------------- */

test("stand-in text (ActualText) goes, inline and named, even when a box takes only part of its text", async () => {
  const src = build([
    CATALOG,
    PAGES,
    HELV,
    page(
      "",
      "/Font << /F1 3 0 R >> /Properties << /MC0 << /ActualText (Named secret) >> >>"
    ),
    {
      data: "/Span << /ActualText (Full secret word) /Lang (en) >> BDC BT /F1 24 Tf 72 700 Td (ABCDEFGH) Tj ET EMC /Span /MC0 BDC BT /F1 24 Tf 72 500 Td (XYZ) Tj ET EMC",
    },
  ]);
  const out = await run(src, [box(60, 690, 110, 730), box(60, 490, 200, 530)]);
  const [text = ""] = pageTexts(out.bytes);
  expect(text).toContain("DEFGH");
  expect(text).not.toContain("Full secret");
  const all = everything(out.bytes);
  expect(all).not.toContain("Full secret word");
  expect(all).not.toContain("Named secret");
  // What else the dictionary says stays.
  expect(contentOf(out.bytes)).toContain("/Lang");
});

test("a figure's alternate text goes when its image is redacted; one on another page stays", async () => {
  const image = {
    data: "\u0080\u0080\u0080\u0080",
    dict: "/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8",
  };
  const src = build([
    "<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 6 0 R /MarkInfo << /Marked true >> >>",
    "<< /Type /Pages /Kids [4 0 R 10 0 R] /Count 2 >>",
    HELV,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 9 0 R >> >> /Contents 5 0 R /StructParents 0 >>",
    { data: "/Figure << /MCID 0 >> BDC q 100 0 0 100 72 400 cm /Im1 Do Q EMC" },
    "<< /Type /StructTreeRoot /K [7 0 R 8 0 R] /ParentTree << /Nums [0 [7 0 R] 1 [8 0 R]] >> >>",
    "<< /Type /StructElem /S /Figure /P 6 0 R /Pg 4 0 R /K 0 /Alt (Passport photo of Jane) >>",
    "<< /Type /StructElem /S /Figure /P 6 0 R /Pg 10 0 R /K 0 /Alt (Company logo) >>",
    image,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 9 0 R >> >> /Contents 11 0 R /StructParents 1 >>",
    { data: "/Figure << /MCID 0 >> BDC q 100 0 0 100 72 400 cm /Im1 Do Q EMC" },
  ]);
  const out = await run(src, [box(60, 390, 200, 510)], { images: "remove" });
  const all = everything(out.bytes);
  expect(all).not.toContain("Passport photo");
  expect(all).toContain("Company logo");
});

test("a redacted page's thumbnail goes", async () => {
  const src = build([
    CATALOG,
    PAGES,
    HELV,
    page("/Thumb 6 0 R"),
    { data: "BT /F1 24 Tf 72 700 Td (Hidden) Tj ET" },
    {
      data: "THUMBSECRET".repeat(18).slice(0, 192),
      dict: "/Width 8 /Height 8 /ColorSpace /DeviceRGB /BitsPerComponent 8",
    },
  ]);
  const out = await run(src, [box(60, 690, 400, 730)]);
  expect(openTest(out.bytes).findPage(0).get("Thumb").isNull()).toBe(true);
  expect(everything(out.bytes)).not.toContain("THUMBSECRET");
});

/** The CIDs each hex string of a content stream shows. */
const cidsOf = (content: string): number[][] =>
  [...content.matchAll(/<(?<hex>[0-9A-Fa-f]+)>/gu)].map(
    (m) =>
      m.groups?.hex?.match(/.{4}/gu)?.map((h) => Number.parseInt(h, 16)) ?? []
  );

/** Dark pixels each glyph of the document's one embedded CFF font draws. */
const glyphInk = (bytes: Uint8Array, gids: number[]): number[] => {
  const doc = openTest(bytes);
  for (let i = 1; i < doc.countObjects(); i += 1) {
    const o = doc.newIndirect(i).resolve();
    const file = o.isDictionary() ? o.get("FontFile3") : null;
    if (file?.isStream()) {
      const font = new mupdf.Font("probe", file.readStream());
      return gids.map((gid) => {
        const pix = new mupdf.Pixmap(
          mupdf.ColorSpace.DeviceGray,
          [0, 0, 60, 60],
          false
        );
        pix.clear(255);
        const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
        const t = new mupdf.Text();
        t.showGlyph(font, [40, 0, 0, -40, 10, 45], gid, 0);
        dev.fillText(
          t,
          mupdf.Matrix.identity,
          mupdf.ColorSpace.DeviceGray,
          [0],
          1
        );
        dev.close();
        return pix.getPixels().filter((p) => p < 128).length;
      });
    }
  }
  return [];
};

test("glyphs only the redacted text drew go from the font", async () => {
  const buf = new mupdf.Buffer();
  const writer = new mupdf.DocumentWriter(buf, "pdf", "");
  const dev = writer.beginPage([0, 0, 612, 792]);
  const text = new mupdf.Text();
  const font = new mupdf.Font("Times-Roman");
  text.showString(font, [24, 0, 0, -24, 72, 92], "QZXJK");
  text.showString(font, [12, 0, 0, -12, 72, 300], "public body");
  dev.fillText(
    text,
    mupdf.Matrix.identity,
    mupdf.ColorSpace.DeviceGray,
    [0],
    1
  );
  writer.endPage();
  writer.close();
  const src = new Uint8Array(buf.asUint8Array());
  const [secret = [], kept = []] = cidsOf(contentOf(src));
  expect(glyphInk(src, secret).every((n) => n > 0)).toBe(true);
  const out = await run(src, [{ page: 0, rect: [60, 60, 400, 100] }]);
  expect(pageTexts(out.bytes)).toEqual(["public body"]);
  expect(glyphInk(out.bytes, secret)).toEqual([0, 0, 0, 0, 0]);
  expect(glyphInk(out.bytes, kept).filter((n) => n > 0).length).toBe(10);
});

test("a pattern and a soft mask that drew text under the box go from the file", async () => {
  const cell = {
    data: "BT /F1 10 Tf 0 2 Td (Pattern secret) Tj ET",
    dict: "/Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 80 14] /XStep 80 /YStep 14 /Resources << /Font << /F1 3 0 R >> >>",
  };
  const mask = {
    data: "1 g 0 0 612 792 re f 0 g BT /F1 24 Tf 72 600 Td (Mask secret) Tj ET",
    dict: "/Type /XObject /Subtype /Form /BBox [0 0 612 792] /Group << /S /Transparency /CS /DeviceGray >> /Resources << /Font << /F1 3 0 R >> >>",
  };
  const src = build([
    CATALOG,
    PAGES,
    HELV,
    page(
      "",
      "/Font << /F1 3 0 R >> /Pattern << /P1 6 0 R >> /ExtGState << /G1 << /SMask << /S /Luminosity /G 7 0 R >> >> /G2 << /CA 0.5 >> >>"
    ),
    {
      data: "q /Pattern cs /P1 scn 72 690 300 40 re f Q q /G1 gs 0 0 1 rg 72 590 300 40 re f Q q /G2 gs BT /F1 12 Tf 72 300 Td (still here) Tj ET Q",
    },
    cell,
    mask,
  ]);
  const out = await run(src, [box(60, 580, 400, 740)]);
  const all = everything(out.bytes);
  expect(all).not.toContain("Pattern secret");
  expect(all).not.toContain("Mask secret");
  expect(pageTexts(out.bytes)).toEqual(["still here"]);
  const res = openTest(out.bytes).findPage(0).get("Resources");
  expect(res.get("ExtGState").get("G2").isNull()).toBe(false);
  expect(res.get("ExtGState").get("G1").isNull()).toBe(true);
});

test("pruning a redacted page's resources takes nothing from the pages sharing them", async () => {
  const src = build([
    CATALOG,
    "<< /Type /Pages /Kids [4 0 R 7 0 R] /Count 2 /Resources 6 0 R >>",
    HELV,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R >>",
    {
      data: "BT /F1 24 Tf 72 700 Td (Page one secret) Tj ET q 1 0 0 1 72 400 cm /X1 Do Q",
    },
    "<< /Font << /F1 3 0 R >> /XObject << /X1 9 0 R >> >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 8 0 R >>",
    {
      data: "BT /F1 24 Tf 72 700 Td (Page two) Tj ET q 1 0 0 1 72 400 cm /X1 Do Q",
    },
    {
      data: "BT /F1 12 Tf 0 0 Td (Shared form) Tj ET",
      dict: "/Type /XObject /Subtype /Form /BBox [0 0 200 40]",
    },
  ]);
  const out = await run(src, [box(60, 690, 400, 730)]);
  expect(pageTexts(out.bytes)).toEqual(["Shared form", "Page two Shared form"]);
});

test("the content reader steps over strings, comments, and inline images whole", () => {
  const ops = parseContent(
    bytesOf(
      [
        "(a \\) BT (nested) Tj) Tj <414243> Tj /Na#20me gs",
        "BI /W 4 /H 1 /CS /G /BPC 8 ID AEIB EI Q % comment Tj",
        "BI /W 4 /H 1 /CS /G /BPC 8 /L 4 ID  EI EI q",
        "[(x) 1 (y)] TJ << /K [1 2] /S (str >> EMC) >> BDC EMC",
      ].join("\n")
    )
  );
  expect(ops.map((o) => o.operator)).toEqual([
    "Tj",
    "Tj",
    "gs",
    "BI",
    "Q",
    "BI",
    "q",
    "TJ",
    "BDC",
    "EMC",
  ]);
  const gs = ops[2]?.operands[0];
  expect(gs?.kind === "name" ? gs.name : "").toBe("Na me");
  const bdc = ops[8]?.operands[0];
  expect(bdc?.kind === "dict" ? bdc.entries.map((e) => e.key) : []).toEqual([
    "K",
    "S",
  ]);
});

test("the redact operation reports what it removed", async () => {
  const env = await testEnv();
  const src = build([
    CATALOG,
    PAGES,
    HELV,
    page("/Annots [6 0 R]"),
    { data: "BT /F1 24 Tf 72 700 Td (Secret) Tj ET" },
    "<< /Type /Annot /Subtype /Square /Rect [70 695 250 725] >>",
  ]);
  const r = OPS.redact(env, src, {
    ...OPTIONS,
    marks: [box(60, 690, 400, 730)],
  });
  expect(r.report).toEqual({ annotations: 1, fields: 0 });
  expect(pageTexts(r.bytes)).toEqual([""]);
});

/* ---------------- elsewhere ---------------- */

test("elsewhere finds the text in every place outside the pages", async () => {
  const xmp =
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>Zanz&#105;bar &amp; co</dc:creator></rdf:Description></rdf:RDF></x:xmpmeta>';
  const src = build(
    [
      "<< /Type /Catalog /Pages 2 0 R /Outlines 7 0 R /Metadata 9 0 R /Names << /Dests << /Names [(Zanzibar-dest) [4 0 R /Fit]] >> /EmbeddedFiles << /Names [(zanzibar.txt) 10 0 R] >> >> /PageLabels << /Nums [0 << /S /D >> 1 << /S /D /P (Zanzibar-) >>] >> /AcroForm << /Fields [13 0 R] >> >>",
      "<< /Type /Pages /Kids [4 0 R 6 0 R] /Count 2 >>",
      HELV,
      page("/Annots [11 0 R 12 0 R 13 0 R]"),
      { data: "BT /F1 24 Tf 72 700 Td (Nothing to see) Tj ET" },
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R >>",
      "<< /Type /Outlines /First 8 0 R /Last 8 0 R /Count 1 >>",
      "<< /Title (Zanzibar trip) /Parent 7 0 R /First 15 0 R /Last 15 0 R /Dest [4 0 R /Fit] >>",
      { data: xmp, dict: "/Type /Metadata /Subtype /XML" },
      "<< /Type /Filespec /F (zanzibar.txt) /UF (zanzibar.txt) /Desc (notes) /EF << /F 14 0 R >> >>",
      "<< /Type /Annot /Subtype /Text /Rect [72 700 92 720] /Contents (see Zanzibar) /Popup 12 0 R >>",
      "<< /Type /Annot /Subtype /Popup /Rect [300 600 400 700] /Parent 11 0 R /Contents (see Zanzibar) >>",
      "<< /Type /Annot /Subtype /Widget /FT /Tx /T (city) /V (Zanzibar) /Rect [70 100 300 140] /P 4 0 R >>",
      { data: "nothing here", dict: "/Type /EmbeddedFile" },
      "<< /Title (More Zanzibar) /Parent 8 0 R /Dest [4 0 R /Fit] >>",
      "<< /Title (Zanzibar report) /Author (Someone) >>",
    ],
    "/Info 16 0 R"
  );
  const re = queryRegExp("zanzibar", {
    caseSensitive: false,
    regex: false,
    wholeWords: false,
  });
  if (typeof re === "string") {
    throw new TypeError(re);
  }
  const places = findElsewhere(openTest(src), re);
  const expected: Place[] = [
    { kind: "bookmark", label: "Zanzibar trip" },
    { kind: "bookmark", label: "More Zanzibar" },
    { kind: "metadata", label: "Title" },
    { kind: "metadata", label: "XMP" },
    { kind: "comment", label: "Text", page: 0 },
    { kind: "field", label: "city", page: 0 },
    { kind: "destination", label: "Zanzibar-dest" },
    { kind: "pageLabel", label: "Zanzibar-", page: 1 },
    { kind: "attachment", label: "zanzibar.txt" },
  ];
  expect(places).toEqual(expected);
  const env = await testEnv();
  const bad = OPS.elsewhere(env, src, {
    options: { caseSensitive: false, regex: true, wholeWords: false },
    query: "(",
  });
  expect(bad.report?.error).not.toBe("");
  expect(bad.report?.places).toEqual([]);
});
