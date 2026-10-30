// Annotations: the markup a reader adds on top of a page (highlights,
// notes, drawings, text boxes, shapes), listed, added, and removed. They stay
// annotations, editable in any PDF reader; Flatten makes them page content.
// Coordinates are display space, which is what MuPDF's annotation API takes.

import type { PDFAnnotation, PDFDocument, PDFPage } from "mupdf";

import { parseColor } from "./compose";
import { openPdf, savePdf } from "./doc";
import type { Env } from "./doc";
import type { Point, Rect } from "./geometry";
import type { Quad } from "./text";

export type MarkupKind = "highlight" | "underline" | "strikeout" | "squiggly";
export type ShapeKind = "rect" | "ellipse" | "line" | "arrow";
export type AnnotKind = MarkupKind | ShapeKind | "note" | "ink" | "text";

export interface NewAnnot {
  page: number;
  kind: AnnotKind;
  /** `#rrggbb`. */
  color: string;
  opacity: number;
  /** Text markup: the quads of the text it covers. */
  quads?: Quad[];
  /** Notes (top left corner), text boxes, rectangles, ellipses. */
  rect?: Rect;
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
  ink: "Ink",
  line: "Line",
  note: "Text",
  rect: "Square",
  squiggly: "Squiggly",
  strikeout: "StrikeOut",
  text: "FreeText",
  underline: "Underline",
} as const;

/** A note's icon is drawn this many points square. */
const NOTE_SIZE = 20;

const create = (page: PDFPage, a: NewAnnot) => {
  const annot = page.createAnnotation(MUPDF_TYPE[a.kind]);
  const color = parseColor(a.color);
  if (a.kind === "text") {
    // A text box's colour is its text's; the box itself stays clear.
    annot.setDefaultAppearance("Helv", a.fontSize ?? 12, color);
  } else {
    annot.setColor(color);
  }
  annot.setOpacity(a.opacity);
  if (a.quads?.length) {
    annot.setQuadPoints(a.quads);
  }
  if (a.kind === "note" && a.rect) {
    const [x, y] = a.rect;
    annot.setRect([x, y, x + NOTE_SIZE, y + NOTE_SIZE]);
    annot.setIcon("Comment");
  } else if (a.rect && annot.hasRect()) {
    annot.setRect(a.rect);
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
  if (a.width !== undefined && annot.hasBorder()) {
    annot.setBorderWidth(a.width);
  }
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
    for (const a of o.add) {
      if (a.page >= 0 && a.page < doc.countPages()) {
        create(doc.loadPage(a.page), a);
      }
    }
    return savePdf(doc);
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
