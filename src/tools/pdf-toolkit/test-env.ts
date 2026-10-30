// The engines for unit tests: MuPDF from its npm package, qpdf through the
// same loader the worker uses, both at the versions the Tool pins. Imported
// by tests only, never by the Tool.

import * as mupdf from "mupdf";

import { Qpdf } from "./engine/qpdf";
import type { Env } from "./pdf/doc";

const QPDF_DIR = new URL(
  "../../../node_modules/@neslinesli93/qpdf-wasm/dist/",
  import.meta.url
);

const dataUrl = (source: string) =>
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;

let env: Promise<Env> | null = null;

export const testEnv = (): Promise<Env> => {
  env ??= (async () => {
    const glue = await Bun.file(new URL("qpdf.js", QPDF_DIR)).text();
    const wasm = await Bun.file(new URL("qpdf.wasm", QPDF_DIR)).arrayBuffer();
    const qpdf = await Qpdf.create(glue, wasm, dataUrl);
    const warnings: string[] = [];
    mupdf.setLog({
      error: (m: string) => warnings.push(m),
      warning: (m: string) => warnings.push(m),
    } as never);
    return { mupdf, qpdf, warnings };
  })();
  return env;
};

/** A PDF of `pages` pages, each saying "<label> <n>" near its top, sized `w`×`h` and rotated `rotate`. */
export const makePdf = (
  pages: number,
  opts: {
    label?: string;
    w?: number;
    h?: number;
    rotate?: 0 | 90 | 180 | 270;
  } = {}
): Uint8Array => {
  const { label = "Page", w = 595, h = 842, rotate = 0 } = opts;
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font("Helvetica"));
  for (let i = 0; i < pages; i += 1) {
    const resources = doc.newDictionary();
    const fonts = doc.newDictionary();
    fonts.put("F1", font);
    resources.put("Font", fonts);
    doc.insertPage(
      -1,
      doc.addPage(
        [0, 0, w, h],
        rotate,
        resources,
        `BT /F1 24 Tf 72 ${h - 72} Td (${label} ${i + 1}) Tj ET`
      )
    );
  }
  return new Uint8Array(doc.saveToBuffer("compress").asUint8Array());
};

/** The text of every page of `bytes`, trimmed. */
export const pageTexts = (bytes: Uint8Array): string[] => {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  const out: string[] = [];
  for (let i = 0; i < doc.countPages(); i += 1) {
    out.push(
      doc
        .loadPage(i)
        .toStructuredText("")
        .asText()
        .replaceAll(/\s+/gu, " ")
        .trim()
    );
  }
  return out;
};

export const openTest = (bytes: Uint8Array): mupdf.PDFDocument => {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf").asPDF();
  if (!doc) {
    throw new Error("not a PDF");
  }
  return doc;
};
