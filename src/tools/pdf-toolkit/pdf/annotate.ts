// Annotations: the markup a reader adds on top of a page (highlights,
// notes, drawings, text boxes, shapes, images), listed, added, and removed. They stay
// annotations, editable in any PDF reader; Flatten makes them page content.
// Coordinates are display space, which is what MuPDF's annotation API takes.

import type { Font, Image, PDFAnnotation, PDFDocument, PDFPage } from "mupdf";

import { parseColor } from "./compose";
import { openPdf, savePdf } from "./doc";
import type { Env } from "./doc";
import type { Point, Rect } from "./geometry";
import type { Quad } from "./text";

export type MarkupKind = "highlight" | "underline" | "strikeout" | "squiggly";
export type ShapeKind = "rect" | "ellipse" | "line" | "arrow";
export type AnnotKind =
  | MarkupKind
  | ShapeKind
  | "note"
  | "ink"
  | "text"
  | "image";

export interface NewAnnot {
  page: number;
  kind: AnnotKind;
  /** `#rrggbb`. */
  color: string;
  opacity: number;
  /** Text markup: the quads of the text it covers. */
  quads?: Quad[];
  /** Notes (top left corner), rectangles, ellipses, images (the box the image fills). */
  rect?: Rect;
  /** An image's file, in a format MuPDF reads (PNG, JPEG, and the like). */
  image?: Uint8Array;
  /** A text box: where its text starts, top left. Its box is made to fit the text. */
  at?: Point;
  /** Freehand strokes. */
  ink?: Point[][];
  /** Lines and arrows. */
  line?: [Point, Point];
  /** A note's text, or a text box's. */
  text?: string;
  /** Stroke width in points, for ink and shapes. */
  width?: number;
  /** A text box's font size. */
  fontSize?: number;
}

export interface AnnotInfo {
  page: number;
  /** Position among the page's annotations, for removing it. */
  index: number;
  type: string;
  rect: Rect;
  contents: string;
  author: string;
  color: string;
}

/** Annotations the user would call markup: not form fields, links, or the popups that belong to notes. */
const LISTED = (a: PDFAnnotation) =>
  !["Widget", "Link", "Popup"].includes(a.getType());

const hex = (c: number[]): string =>
  c.length === 3
    ? `#${c
        .map((v) =>
          Math.round(v * 255)
            .toString(16)
            .padStart(2, "0")
        )
        .join("")}`
    : "";

export const listAnnots = (doc: PDFDocument): AnnotInfo[] => {
  const out: AnnotInfo[] = [];
  const n = doc.countPages();
  for (let p = 0; p < n; p += 1) {
    for (const [index, a] of doc.loadPage(p).getAnnotations().entries()) {
      if (LISTED(a)) {
        out.push({
          author: a.hasAuthor() ? a.getAuthor() : "",
          color: hex(a.getColor()),
          contents: a.getContents(),
          index,
          page: p,
          rect: a.getBounds() as Rect,
          type: a.getType(),
        });
      }
    }
  }
  return out;
};

const MUPDF_TYPE = {
  arrow: "Line",
  ellipse: "Circle",
  highlight: "Highlight",
  image: "Stamp",
  ink: "Ink",
  line: "Line",
  note: "Text",
  rect: "Square",
  squiggly: "Squiggly",
  strikeout: "StrikeOut",
  text: "FreeText",
  underline: "Underline",
} as const;

/** A note's box is this many points square, from where it was put. */
const NOTE_SIZE = 20;
/** MuPDF draws a note's icon this many points square, in the top left of its box. */
export const NOTE_ICON = 16;

/** MuPDF sets a text box's lines this many font sizes apart, the first baseline 0.8 of one below its top, with no inset. */
export const TEXT_LINE = 1.2;
export const TEXT_BASELINE = 0.8;

/**
 * The box a text box's text fills from `at`: as wide as its longest line
 * (`advance` measures a line at a size of 1), a line high per line, so MuPDF
 * neither wraps nor clips it. A point to spare for rounding.
 */
export const textBoxRect = (
  advance: (line: string) => number,
  at: Point,
  text: string,
  size: number
): Rect => {
  const lines = text.split("\n");
  const widest = Math.max(...lines.map(advance));
  return [
    at[0],
    at[1],
    at[0] + widest * size + 1,
    at[1] + lines.length * TEXT_LINE * size,
  ];
};

/** How wide a line is in Helvetica (what a text box is set in) at a size of 1. */
const helveticaAdvance =
  (font: Font) =>
  (line: string): number => {
    let w = 0;
    for (const c of line) {
      w += font.advanceGlyph(font.encodeCharacter(c.codePointAt(0) ?? 32));
    }
    return w;
  };

/** Where an annotation goes: a note's corner, a text box made to fit its text, a box. */
const place = (annot: PDFAnnotation, a: NewAnnot, font: Font) => {
  if (a.kind === "note" && a.rect) {
    const [x, y] = a.rect;
    annot.setRect([x, y, x + NOTE_SIZE, y + NOTE_SIZE]);
    annot.setIcon("Comment");
  } else if (a.kind === "text" && a.at) {
    annot.setRect(
      textBoxRect(helveticaAdvance(font), a.at, a.text ?? "", a.fontSize ?? 12)
    );
  } else if (a.rect && annot.hasRect()) {
    annot.setRect(a.rect);
  }
};

/** A shape's or a stroke's line width; none around a text box. */
const border = (annot: PDFAnnotation, a: NewAnnot) => {
  if (a.kind === "text") {
    // Text written on the page, no box around it: a border would also inset the text and wrap it.
    annot.setBorderWidth(0);
  } else if (a.width !== undefined && annot.hasBorder()) {
    annot.setBorderWidth(a.width);
  }
};

const create = (
  page: PDFPage,
  a: NewAnnot,
  font: Font,
  imageOf: (bytes: Uint8Array) => Image
) => {
  const annot = page.createAnnotation(MUPDF_TYPE[a.kind]);
  const color = parseColor(a.color);
  if (a.kind === "image") {
    // A stamp whose appearance is the image, filling its box; it has no colour of its own.
    if (a.rect) {
      annot.setRect(a.rect);
    }
    if (a.image) {
      annot.setStampImage(imageOf(a.image));
    }
  } else if (a.kind === "text") {
    // A text box's colour is its text's; the box itself stays clear.
    annot.setDefaultAppearance("Helv", a.fontSize ?? 12, color);
  } else {
    annot.setColor(color);
  }
  annot.setOpacity(a.opacity);
  if (a.quads?.length) {
    annot.setQuadPoints(a.quads);
  }
  if (a.kind !== "image") {
    place(annot, a, font);
  }
  if (a.ink?.length) {
    annot.setInkList(a.ink);
  }
  if (a.line) {
    annot.setLine(a.line[0], a.line[1]);
    if (a.kind === "arrow") {
      annot.setLineEndingStyles("None", "OpenArrow");
    }
  }
  border(annot, a);
  if (a.text) {
    annot.setContents(a.text);
  }
  annot.update();
};

export interface AnnotateOptions {
  add: NewAnnot[];
  remove: { page: number; index: number }[];
}

export const annotate = (
  env: Env,
  bytes: Uint8Array,
  o: AnnotateOptions
): Uint8Array => {
  const doc = openPdf(env, bytes);
  const font = new env.mupdf.Font("Helvetica");
  try {
    // Highest index first, so removing one does not move the next.
    const removals = o.remove.toSorted(
      (a, b) => a.page - b.page || b.index - a.index
    );
    for (const r of removals) {
      const page = doc.loadPage(r.page);
      const target = page.getAnnotations()[r.index];
      if (target) {
        page.deleteAnnotation(target);
      }
    }
    const imageOf = (data: Uint8Array) => new env.mupdf.Image(data);
    for (const a of o.add) {
      if (a.page >= 0 && a.page < doc.countPages()) {
        create(doc.loadPage(a.page), a, font, imageOf);
      }
    }
    return savePdf(env, doc);
  } finally {
    doc.destroy();
  }
};

/** The quads of the text between two points, as a reader's selection would take them. */
export const selectText = (page: PDFPage, from: Point, to: Point): Quad[] => {
  const stext = page.toStructuredText("");
  try {
    return stext.highlight(from, to) as Quad[];
  } finally {
    stext.destroy();
  }
};
