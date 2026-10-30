// The fonts text is stamped in: the PDF base fonts MuPDF carries, embedded
// as Identity-H fonts so any glyph they have can be shown by its id, and a
// wide fallback for scripts they lack.

import type { Font, PDFDocument, PDFObject } from "mupdf";

import type { MupdfModule } from "../engine/load";

export type FontFamily = "helvetica" | "times" | "courier";

const BASE14: Record<FontFamily, [regular: string, bold: string]> = {
  courier: ["Courier", "Courier-Bold"],
  helvetica: ["Helvetica", "Helvetica-Bold"],
  times: ["Times-Roman", "Times-Bold"],
};

/** MuPDF's built-in font with the widest reach: Latin, Greek, Cyrillic, and CJK. */
const FALLBACK = "zh-Hans";

interface LoadedFont {
  font: Font;
  ref: PDFObject;
}

/**
 * The fonts one document draws text in, each added to it once. Text in a
 * script the chosen family lacks falls back to MuPDF's wide font. Fonts go
 * in whole; call `doc.subsetFonts()` before saving to keep only the glyphs
 * used.
 */
export class Fonts {
  private readonly mupdf: MupdfModule;
  private readonly doc: PDFDocument;
  private readonly loaded = new Map<string, LoadedFont>();

  constructor(mupdf: MupdfModule, doc: PDFDocument) {
    this.mupdf = mupdf;
    this.doc = doc;
  }

  private load(name: string): LoadedFont {
    let f = this.loaded.get(name);
    if (!f) {
      const font = new this.mupdf.Font(name);
      f = { font, ref: this.doc.addFont(font) };
      this.loaded.set(name, f);
    }
    return f;
  }

  /** The family's font if it has every character of `text`, else the fallback. */
  pick(family: FontFamily, bold: boolean, text: string): LoadedFont {
    const [regular, heavy] = BASE14[family];
    const first = this.load(bold ? heavy : regular);
    const covers = (f: Font) =>
      [...text].every((ch) => /\s/u.test(ch) || f.encodeCharacter(ch) !== 0);
    return covers(first.font) ? first : this.load(FALLBACK);
  }
}

/** The text as glyph ids for an Identity-H font, and its advance in em. */
export const encodeText = (
  font: Font,
  text: string
): { hex: string; advance: number } => {
  let hex = "";
  let advance = 0;
  for (const ch of text) {
    const gid = font.encodeCharacter(ch);
    hex += gid.toString(16).padStart(4, "0");
    advance += font.advanceGlyph(gid);
  }
  return { advance, hex };
};
