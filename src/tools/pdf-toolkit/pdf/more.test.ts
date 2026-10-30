import { expect, test } from "bun:test";

import * as mupdf from "mupdf";

import { makePdf, openTest, pageTexts, testEnv } from "../test-env";
import {
  editAttachments,
  extractAttachments,
  listAttachments,
} from "./attachments";
import { toPdf } from "./convert";
import {
  compress,
  exifOrientation,
  extractImages,
  imagesToPdf,
} from "./images";
import {
  info,
  linearize,
  parsePdfDate,
  pdfDate,
  readMetadata,
  validate,
  writeMetadata,
} from "./inspect";
import { addTextLayers } from "./ocr";
import { writeOutline } from "./outline";
import {
  protect,
  redact,
  removeSignatures,
  sanitize,
  unlock,
} from "./security";
import type { ProtectOptions } from "./security";
import { split, splitPlan } from "./split";
import { pageText } from "./text";

const PROTECT: ProtectOptions = {
  accessibility: true,
  annotate: true,
  assemble: true,
  bits: 256,
  copy: false,
  forms: true,
  modify: false,
  ownerPassword: "",
  print: "none",
  userPassword: "a, b = c",
};

/** A photo-like RGB pixmap: noise, so it does not compress losslessly. */
const noise = (w: number, h: number) => {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false);
  const px = pix.getPixels();
  let seed = 7;
  for (let i = 0; i < px.length; i += 1) {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    px[i] = Math.floor(seed / 65_536) % 256;
  }
  return pix;
};

test("a password with commas and an equals sign protects, restricts, and unlocks", async () => {
  const env = await testEnv();
  const locked = protect(env, makePdf(1), PROTECT);
  const doc = env.mupdf.Document.openDocument(locked, "application/pdf");
  expect(doc.needsPassword()).toBe(true);
  expect(doc.authenticatePassword("a, b = c")).toBeGreaterThan(0);
  expect(doc.hasPermission("print")).toBe(false);
  expect(() => unlock(env, locked, "wrong")).toThrow();
  const open = env.mupdf.Document.openDocument(
    unlock(env, locked, "a, b = c"),
    "application/pdf"
  );
  expect(open.needsPassword()).toBe(false);
  expect(open.hasPermission("print")).toBe(true);
});

test("redaction removes the text under the box, not just covers it", async () => {
  const env = await testEnv();
  const src = makePdf(1);
  const [[quad] = []] = openTest(src).loadPage(0).search("Page 1", "");
  const out = redact(env, src, {
    black: true,
    images: "pixels",
    lineArt: false,
    marks: [{ page: 0, quads: quad ? [quad] : [] }],
  });
  expect(pageTexts(out)).toEqual([""]);
  expect(new TextDecoder("latin1").decode(out)).not.toContain("Page 1");
});

test("sanitize strips metadata, scripts, attachments, and outside links", async () => {
  const env = await testEnv();
  const doc = openTest(makePdf(1));
  doc.setMetaData("info:Author", "Someone Private");
  const js = doc.newDictionary();
  js.put("S", doc.newName("JavaScript"));
  js.put("JS", doc.newString("app.alert('hi')"));
  doc.getTrailer().get("Root").put("OpenAction", js);
  doc.insertEmbeddedFile(
    "secret.txt",
    doc.addEmbeddedFile(
      "secret.txt",
      "text/plain",
      "s3cret",
      new Date(),
      new Date()
    )
  );
  doc.loadPage(0).createLink([0, 0, 50, 50], "https://example.com/track");
  const dirty = new Uint8Array(doc.saveToBuffer("").asUint8Array());
  const { bytes, report } = sanitize(env, dirty, {
    attachments: true,
    javascript: true,
    links: true,
    metadata: true,
    privateData: true,
    thumbnails: true,
  });
  expect(report.metadata).toBeGreaterThan(0);
  expect(report.scripts).toBeGreaterThan(0);
  expect(report.attachments).toBe(1);
  expect(report.links).toBe(1);
  const text = new TextDecoder("latin1").decode(bytes);
  for (const leak of [
    "Someone Private",
    "app.alert",
    "s3cret",
    "example.com",
  ]) {
    expect(text).not.toContain(leak);
  }
  expect(pageTexts(bytes)).toEqual(["Page 1"]);
});

test("removing signatures clears signature fields", async () => {
  const env = await testEnv();
  const doc = openTest(makePdf(1));
  const page = doc.loadPage(0);
  const sigValue = doc.addObject(doc.newDictionary());
  sigValue.put("Type", doc.newName("Sig"));
  const w = doc.addObject(doc.newDictionary());
  w.put("Type", doc.newName("Annot"));
  w.put("Subtype", doc.newName("Widget"));
  w.put("FT", doc.newName("Sig"));
  w.put("T", doc.newString("Signature1"));
  w.put("V", sigValue);
  const rect = doc.newArray();
  for (const v of [10, 10, 100, 40]) {
    rect.push(doc.newReal(v));
  }
  w.put("Rect", rect);
  w.put("P", page.getObject());
  const annots = doc.newArray();
  annots.push(w);
  page.getObject().put("Annots", annots);
  const form = doc.newDictionary();
  const fields = doc.newArray();
  fields.push(w);
  form.put("Fields", fields);
  doc.getTrailer().get("Root").put("AcroForm", form);
  const signed = new Uint8Array(doc.saveToBuffer("").asUint8Array());
  expect(info(env, signed).signatures).toBe(1);
  const cleared = removeSignatures(env, signed, { removeFields: false });
  expect(cleared.count).toBe(1);
  expect(info(env, cleared.bytes).signatures).toBe(1);
  const gone = removeSignatures(env, signed, { removeFields: true });
  expect(info(env, gone.bytes).signatures).toBe(0);
});

test("info counts pages by size, fonts, and the rest", async () => {
  const env = await testEnv();
  const src = makePdf(3);
  const r = info(env, src);
  expect(r.pages).toBe(3);
  expect(r.sizes).toEqual([{ count: 3, size: "A4" }]);
  expect(r.fonts.map((f) => [f.name, f.embedded, f.pages])).toEqual([
    ["Helvetica", false, [1, 2, 3]],
  ]);
  expect(r.linearized).toBe(false);
  expect(info(env, linearize(env, src)).linearized).toBe(true);
});

test("metadata is written, cleared, and dated", async () => {
  const env = await testEnv();
  const out = writeMetadata(env, makePdf(1), {
    touch: true,
    values: {
      author: "Ada",
      creator: "",
      keywords: "a, b",
      language: "en-GB",
      producer: "",
      subject: "",
      title: "Notes – über",
    },
  });
  const md = readMetadata(openTest(out));
  expect(md.title).toBe("Notes – über");
  expect(md.author).toBe("Ada");
  expect(md.language).toBe("en-GB");
  expect(parsePdfDate(md.modified)?.getFullYear()).toBe(
    new Date().getFullYear()
  );
  const d = new Date("2024-03-05T06:07:08Z");
  expect(parsePdfDate(pdfDate(d))?.getTime()).toBe(d.getTime());
});

test("validation reports a clean file as clean", async () => {
  const env = await testEnv();
  const r = validate(env, makePdf(2));
  expect(r.qpdf.ok).toBe(true);
  expect(r.mupdf.repaired).toBe(false);
});

test("attachments are added, listed, saved out, and removed", async () => {
  const env = await testEnv();
  const added = editAttachments(env, makePdf(1), {
    add: [
      {
        bytes: new TextEncoder().encode("hello"),
        mime: "text/plain",
        modified: Date.now(),
        name: "a.txt",
      },
      {
        bytes: new TextEncoder().encode("again"),
        mime: "text/plain",
        modified: Date.now(),
        name: "a.txt",
      },
    ],
    remove: [],
  });
  const listed = listAttachments(openTest(added));
  expect(listed.map((a) => [a.key, a.bytes])).toEqual([
    ["a (2).txt", 5],
    ["a.txt", 5],
  ]);
  const [file] = extractAttachments(env, added, ["a.txt"]);
  expect(new TextDecoder().decode(file?.bytes)).toBe("hello");
  const removed = editAttachments(env, added, { add: [], remove: ["a.txt"] });
  expect(listAttachments(openTest(removed)).map((a) => a.key)).toEqual([
    "a (2).txt",
  ]);
});

test("images go into pages, come back out, and shrink when recompressed", async () => {
  const env = await testEnv();
  const jpeg = noise(1200, 900).asJPEG(95, false);
  const pdf = imagesToPdf(env, [new Uint8Array(jpeg)], {
    fit: "contain",
    margin: 10,
    orientation: "auto",
    page: "a4",
  });
  const [[w = 0, h = 0] = []] = [openTest(pdf).loadPage(0).getBounds()].map(
    ([x0, y0, x1, y1]) => [x1 - x0, y1 - y0]
  );
  expect(w).toBeGreaterThan(h);
  const { files, images } = extractImages(env, pdf, { minSide: 8 });
  expect(images.map((i) => [i.format, i.width, i.height])).toEqual([
    ["JPEG", 1200, 900],
  ]);
  expect(files[0]?.bytes.length).toBe(jpeg.length);
  const { report } = compress(env, pdf, {
    images: "low",
    objectStreams: true,
    subsetFonts: true,
  });
  expect(report.images).toBe(1);
  expect(report.after).toBeLessThan(report.before / 2);
});

test("EXIF orientation is read and turns the page", async () => {
  const env = await testEnv();
  const jpeg = new Uint8Array(noise(300, 200).asJPEG(80, false));
  // APP1 "Exif\0\0", a big-endian TIFF header, one IFD entry: Orientation = 6.
  const app1 = new Uint8Array([
    0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x4d, 0x4d,
    0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x01, 0x01, 0x12, 0x00, 0x03,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]);
  const turned = new Uint8Array(jpeg.length + app1.length);
  turned.set(jpeg.subarray(0, 2));
  turned.set(app1, 2);
  turned.set(jpeg.subarray(2), 2 + app1.length);
  expect(exifOrientation(turned)).toBe(6);
  const pdf = imagesToPdf(env, [turned], {
    fit: "contain",
    margin: 0,
    orientation: "auto",
    page: "image",
  });
  const [x0, y0, x1, y1] = openTest(pdf).loadPage(0).getBounds();
  // Stored landscape, seen portrait.
  expect(y1 - y0).toBeGreaterThan(x1 - x0);
});

test("split plans by count, ranges, and bookmarks", async () => {
  const base = { base: "doc", depth: 1, every: 2, ranges: "" };
  const every = splitPlan(5, [], { ...base, mode: "every" });
  expect(every.ok && every.parts.map((p) => [p.name, p.pages])).toEqual([
    ["doc-1-2.pdf", [0, 1]],
    ["doc-3-4.pdf", [2, 3]],
    ["doc-5.pdf", [4]],
  ]);
  const ranges = splitPlan(5, [], {
    ...base,
    mode: "ranges",
    ranges: "1-2; 5,3",
  });
  expect(ranges.ok && ranges.parts.map((p) => p.pages)).toEqual([
    [0, 1],
    [4, 2],
  ]);
  expect(splitPlan(5, [], { ...base, mode: "ranges", ranges: "9" }).ok).toBe(
    false
  );
  const outline = [
    { children: [], open: false, page: 1, title: "Chapter: One/Two", y: null },
    { children: [], open: false, page: 3, title: "Two", y: null },
  ];
  const marks = splitPlan(5, outline, { ...base, mode: "bookmarks" });
  expect(marks.ok && marks.parts.map((p) => [p.name, p.pages])).toEqual([
    ["doc-0 front matter.pdf", [0]],
    ["doc-1 Chapter One Two.pdf", [1, 2]],
    ["doc-2 Two.pdf", [3, 4]],
  ]);
  const env = await testEnv();
  const doc = openTest(makePdf(5));
  writeOutline(doc, outline);
  const src = new Uint8Array(doc.saveToBuffer("").asUint8Array());
  const files = split(env, src, marks.ok ? marks.parts : []);
  expect(files.map((f) => pageTexts(f.bytes))).toEqual([
    ["Page 1"],
    ["Page 2", "Page 3"],
    ["Page 4", "Page 5"],
  ]);
});

test("a text layer makes a page's text selectable without changing how it looks", async () => {
  const env = await testEnv();
  // Stand-in for Tesseract's output: a page of invisible text.
  const layer = new mupdf.PDFDocument();
  const font = layer.addSimpleFont(new mupdf.Font("Helvetica"));
  const res = layer.newDictionary();
  const fonts = layer.newDictionary();
  fonts.put("F1", font);
  res.put("Font", fonts);
  layer.insertPage(
    -1,
    layer.addPage(
      [0, 0, 1000, 1400],
      0,
      res,
      "BT 3 Tr /F1 40 Tf 100 1200 Td (Scanned words) Tj ET"
    )
  );
  const scan = imagesToPdf(env, [new Uint8Array(noise(100, 140).asPNG())], {
    fit: "contain",
    margin: 0,
    orientation: "auto",
    page: "a4",
  });
  const out = addTextLayers(env, scan, [
    { page: 0, pdf: new Uint8Array(layer.saveToBuffer("").asUint8Array()) },
  ]);
  expect(pageText(openTest(out).loadPage(0)).text).toContain("Scanned words");
});

test("XHTML is laid out into PDF pages", async () => {
  const env = await testEnv();
  const xhtml = new TextEncoder().encode(
    '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Laid out</h1><p>Flowing text.</p></body></html>'
  );
  const pdf = toPdf(env, xhtml, "xhtml");
  expect(pageTexts(pdf)[0]).toContain("Laid out Flowing text.");
});
