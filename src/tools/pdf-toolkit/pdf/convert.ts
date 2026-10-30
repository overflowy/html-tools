// Documents that are not PDFs but that MuPDF can lay out and draw (EPUB,
// FictionBook, MOBI, comic book archives, XHTML), made into PDFs by
// drawing each page into MuPDF's PDF writer. Text stays text and vectors
// stay vectors; it is the document as MuPDF renders it.

import type { Env } from "./doc";

/** File extensions MuPDF opens as documents, with the type it is told. */
export const CONVERTIBLE: Record<string, string> = {
  cbz: "application/vnd.comicbook+zip",
  epub: "application/epub+zip",
  fb2: "text/xml",
  mobi: "application/x-mobipocket-ebook",
  xhtml: "application/xhtml+xml",
};

/** The formats that flow into whatever page they are given (MuPDF.js's isReflowable() never returns its answer). */
const REFLOWABLE = new Set(["epub", "fb2", "mobi", "xhtml"]);

/** Reflowable formats are laid out on this page, in points: A5, as an e-reader shows them. */
const REFLOW_W = 420;
const REFLOW_H = 595;
const REFLOW_EM = 11;

export const toPdf = (
  env: Env,
  bytes: Uint8Array,
  kind: string
): Uint8Array => {
  const doc = env.mupdf.Document.openDocument(bytes, CONVERTIBLE[kind] ?? kind);
  try {
    if (doc.needsPassword()) {
      throw new Error("The document is password protected.");
    }
    if (REFLOWABLE.has(kind)) {
      doc.layout(REFLOW_W, REFLOW_H, REFLOW_EM);
    }
    const out = new env.mupdf.Buffer();
    const writer = new env.mupdf.DocumentWriter(out, "pdf", "");
    const n = doc.countPages();
    for (let i = 0; i < n; i += 1) {
      const page = doc.loadPage(i);
      const device = writer.beginPage(page.getBounds());
      page.run(device, [1, 0, 0, 1, 0, 0]);
      writer.endPage();
    }
    writer.close();
    return new Uint8Array(out.asUint8Array());
  } finally {
    doc.destroy();
  }
};
