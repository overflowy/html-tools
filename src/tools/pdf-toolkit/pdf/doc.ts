// Opening and saving, and what every operation is handed. An operation
// takes the bytes of one PDF and returns new bytes (or files, or a report):
// it opens its own copy, so nothing it does can leak into the Sources or
// into the next operation.

import type { PDFDocument, PDFPage } from "mupdf";

import type { MupdfModule } from "../engine/load";
import type { Qpdf } from "../engine/qpdf";

export interface Env {
  mupdf: MupdfModule;
  qpdf: Qpdf;
  /** What MuPDF warned about since the list was last emptied. */
  warnings: string[];
}

/** A file an operation produced besides (or instead of) a PDF. */
export interface OutFile {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

export const openPdf = (env: Env, bytes: Uint8Array): PDFDocument => {
  const doc = env.mupdf.Document.openDocument(bytes, "application/pdf");
  const pdf = doc.asPDF();
  if (!pdf) {
    throw new Error("Not a PDF.");
  }
  if (pdf.needsPassword()) {
    throw new Error("The PDF is password protected.");
  }
  return pdf;
};

export interface SaveOptions {
  /** Keep only the glyphs used of every font added (or present). */
  subset?: boolean;
  /** Extra MuPDF write options. */
  extra?: string[];
}

/** A full rewrite: unused objects dropped, new streams compressed. */
export const savePdf = (
  doc: PDFDocument,
  opts: SaveOptions = {}
): Uint8Array => {
  if (opts.subset) {
    doc.subsetFonts();
  }
  // MuPDF refuses an option given twice: a later one replaces an earlier one with its key.
  const options = new Map<string, string>([
    ["garbage", "garbage=compact"],
    ["compress", "compress"],
  ]);
  for (const o of opts.extra ?? []) {
    options.set(o.split("=")[0] ?? o, o);
  }
  // A copy: the buffer's memory belongs to MuPDF and goes with it.
  return new Uint8Array(
    doc.saveToBuffer([...options.values()].join(",")).asUint8Array()
  );
};

/** Each page of the document (or each of `only`), loaded, with its 0-based index. */
export const pagesOf = (
  doc: PDFDocument,
  only?: Set<number>
): { index: number; page: PDFPage }[] => {
  const out: { index: number; page: PDFPage }[] = [];
  const n = doc.countPages();
  for (let i = 0; i < n; i += 1) {
    if (!only || only.has(i)) {
      out.push({ index: i, page: doc.loadPage(i) });
    }
  }
  return out;
};

/** Run `body` on a fresh copy of `bytes` and save the result. */
export const transform = (
  env: Env,
  bytes: Uint8Array,
  body: (doc: PDFDocument) => void,
  opts: SaveOptions = {}
): Uint8Array => {
  const doc = openPdf(env, bytes);
  try {
    body(doc);
    return savePdf(doc, opts);
  } finally {
    doc.destroy();
  }
};
