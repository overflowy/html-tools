// A Text Layer for scanned pages. Tesseract reads each page (rendered from
// it) and writes what it read as a PDF page of its own with only invisible
// text on it, in a font with no shapes, positioned word by word. That page
// is laid over the original, stretched to it: the scan looks the same, and
// its text can now be selected, searched, and copied, in any script.

import { Painter, grafter, pageForm } from "./compose";
import { openPdf, savePdf } from "./doc";
import type { Env } from "./doc";
import { Fonts } from "./fonts";
import { chain, fitInto } from "./geometry";

export interface TextLayer {
  /** 0-based page it goes on. */
  page: number;
  /** Tesseract's text-only PDF of that page. */
  pdf: Uint8Array;
}

export const addTextLayers = (
  env: Env,
  bytes: Uint8Array,
  layers: TextLayer[]
): Uint8Array => {
  const doc = openPdf(env, bytes);
  try {
    const fonts = new Fonts(env.mupdf, doc);
    for (const layer of layers) {
      if (layer.page < 0 || layer.page >= doc.countPages()) {
        continue;
      }
      const ocr = openPdf(env, layer.pdf);
      try {
        const page = doc.loadPage(layer.page);
        const form = pageForm(doc, ocr.loadPage(0), grafter(doc, ocr));
        const painter = new Painter(doc, page, fonts);
        painter.xobject(
          form.ref,
          chain(
            form.toDisplay,
            fitInto(form.w, form.h, [0, 0, painter.w, painter.h], false)
          )
        );
        painter.apply();
      } finally {
        ocr.destroy();
      }
    }
    return savePdf(doc);
  } finally {
    doc.destroy();
  }
};
