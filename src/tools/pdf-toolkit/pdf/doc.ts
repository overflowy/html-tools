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

export const openPdf = (
  env: Env,
  bytes: Uint8Array,
  password = ""
): PDFDocument => {
  const doc = env.mupdf.Document.openDocument(bytes, "application/pdf");
  const pdf = doc.asPDF();
  if (!pdf) {
    throw new Error("Not a PDF.");
  }
  if (pdf.needsPassword() && pdf.authenticatePassword(password) === 0) {
    pdf.destroy();
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

/**
 * A full rewrite: unused objects dropped, new streams compressed.
 *
 * In two passes. MuPDF (1.28.1) loses the data of a stream it has read in
 * when its dictionary refers to another object (an image's
 * `/DecodeParms 12 0 R`) and the save renumbers objects: the image is left a
 * dictionary, and every reader fails on it. Saved first as it is, with
 * nothing renumbered, then opened afresh, nothing has been read in yet.
 */
export const savePdf = (
  env: Env,
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
  const fresh = openPdf(env, doc.saveToBuffer("").asUint8Array());
  try {
    // A copy: the buffer's memory belongs to MuPDF and goes with it.
    return new Uint8Array(
      fresh.saveToBuffer([...options.values()].join(",")).asUint8Array()
    );
  } finally {
    fresh.destroy();
  }
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
    return savePdf(env, doc, opts);
  } finally {
    doc.destroy();
  }
};
