// Marks added to existing pages: a text watermark, an image stamp, another
// PDF over or under the pages (letterhead), text in the margins (headers,
// footers, page numbers, Bates numbers), and reading modes that recolour a
// page. All of it is real page content, drawn in each page's display space,
// so it sits where the user saw it whatever the page's rotation.

import type { PDFDocument, PDFPage } from "mupdf";

import { Painter, pageForm, grafter, parseColor } from "./compose";
import type { BlendMode, Rgb } from "./compose";
import { openPdf, pagesOf, savePdf } from "./doc";
import type { Env } from "./doc";
import { Fonts } from "./fonts";
import type { FontFamily } from "./fonts";
import { POINTS_PER_MM, chain, fitInto } from "./geometry";
import type { Matrix, Rect } from "./geometry";

/** Open, run `body` on each page asked for, save. */
const eachPage = (
  env: Env,
  bytes: Uint8Array,
  pages: number[] | undefined,
  body: (
    painter: Painter,
    page: PDFPage,
    at: number,
    of: number,
    doc: PDFDocument
  ) => void,
  prepare?: (doc: PDFDocument) => void
): Uint8Array => {
  const doc = openPdf(env, bytes);
  try {
    prepare?.(doc);
    const fonts = new Fonts(env.mupdf, doc);
    const only = pages ? new Set(pages) : undefined;
    const chosen = pagesOf(doc, only);
    for (const [at, { page }] of chosen.entries()) {
      body(new Painter(doc, page, fonts), page, at, chosen.length, doc);
    }
    return savePdf(doc, { subset: true });
  } finally {
    doc.destroy();
  }
};

/* ---------------- watermark ---------------- */

export interface WatermarkOptions {
  text: string;
  family: FontFamily;
  bold: boolean;
  /** Points; 0 sizes the text to span the page. */
  size: number;
  color: string;
  /** 0..1. */
  opacity: number;
  /** Degrees counter-clockwise. */
  angle: number;
  /** Once across the middle, or repeated over the whole page. */
  layout: "center" | "tile";
  layer: "over" | "under";
  pages?: number[];
}

/** The size at which text `advance` em long, turned by `angle`, spans 80% of the page either way. */
export const fittingSize = (
  advance: number,
  angle: number,
  w: number,
  h: number
): number => {
  const r = (angle * Math.PI) / 180;
  const c = Math.abs(Math.cos(r));
  const s = Math.abs(Math.sin(r));
  // The text's box is `advance` by about one em; turned, it spans this much.
  const across = advance * c + s;
  const down = advance * s + c;
  return Math.max(4, Math.min((0.8 * w) / across, (0.8 * h) / down));
};

/** `p` turned `deg` degrees (clockwise in display space) about `c`. */
const turnAbout = (
  p: [number, number],
  c: [number, number],
  deg: number
): [number, number] => {
  const r = (deg * Math.PI) / 180;
  const dx = p[0] - c[0];
  const dy = p[1] - c[1];
  return [
    c[0] + dx * Math.cos(r) - dy * Math.sin(r),
    c[1] + dx * Math.sin(r) + dy * Math.cos(r),
  ];
};

export const watermark = (
  env: Env,
  bytes: Uint8Array,
  o: WatermarkOptions
): Uint8Array =>
  eachPage(env, bytes, o.pages, (painter) => {
    const text = o.text.trim();
    if (!text) {
      return;
    }
    const style = {
      anchor: "middle" as const,
      angle: o.angle,
      bold: o.bold,
      color: parseColor(o.color),
      family: o.family,
      middle: true,
      opacity: o.opacity,
      size: o.size,
    };
    if (style.size <= 0) {
      const em = painter.measure(text, { ...style, size: 1 });
      style.size = fittingSize(em, o.angle, painter.w, painter.h);
    }
    if (o.layout === "center") {
      painter.text(text, painter.w / 2, painter.h / 2, style);
    } else {
      const tw = painter.measure(text, style);
      const stepX = tw + style.size * 3;
      const stepY = style.size * 4;
      // Rows reach past the corners so a turned grid still covers them.
      const reach = Math.hypot(painter.w, painter.h);
      let row = 0;
      for (let y = -reach / 2; y < painter.h + reach / 2; y += stepY) {
        const shift = row % 2 === 0 ? 0 : stepX / 2;
        for (
          let x = -reach / 2 + shift;
          x < painter.w + reach / 2;
          x += stepX
        ) {
          const [cx, cy] = turnAbout(
            [x, y],
            [painter.w / 2, painter.h / 2],
            -o.angle
          );
          if (
            cx > -tw &&
            cx < painter.w + tw &&
            cy > -tw &&
            cy < painter.h + tw
          ) {
            painter.text(text, cx, cy, style);
          }
        }
        row += 1;
      }
    }
    painter.apply(o.layer);
  });

/* ---------------- image stamp ---------------- */

export interface ImageStampOptions {
  image: Uint8Array;
  /** Centre, as fractions of the page's width and height. */
  cx: number;
  cy: number;
  /** Width as a fraction of the page's width; the height follows the image. */
  width: number;
  opacity: number;
  layer: "over" | "under";
  pages?: number[];
}

export const imageStamp = (
  env: Env,
  bytes: Uint8Array,
  o: ImageStampOptions
): Uint8Array => {
  let ref: ReturnType<PDFDocument["addImage"]> | null = null;
  let aspect = 1;
  return eachPage(
    env,
    bytes,
    o.pages,
    (painter) => {
      if (!ref) {
        return;
      }
      const w = o.width * painter.w;
      const h = w * aspect;
      const x = o.cx * painter.w - w / 2;
      const y = o.cy * painter.h - h / 2;
      painter.image(ref, [x, y, x + w, y + h], o.opacity);
      painter.apply(o.layer);
    },
    (doc) => {
      let image;
      try {
        image = new env.mupdf.Image(o.image);
      } catch {
        throw new Error(
          "The stamp is not an image MuPDF can read (PNG, JPEG, GIF, BMP, or TIFF)."
        );
      }
      aspect = image.getHeight() / image.getWidth();
      ref = doc.addImage(image);
    }
  );
};

/* ---------------- overlay / underlay ---------------- */

export interface OverlayOptions {
  template: Uint8Array;
  layer: "over" | "under";
  opacity: number;
  /** Which template page goes on each page: always the first, one after another and round again, or page for page (and none past the template's end). */
  repeat: "first" | "cycle" | "match";
  /** Stretch the template to the page, fit it inside keeping its shape, or use it at its own size from the top left. */
  fit: "stretch" | "fit" | "actual";
  pages?: number[];
}

export const overlay = (
  env: Env,
  bytes: Uint8Array,
  o: OverlayOptions
): Uint8Array => {
  let template: PDFDocument;
  try {
    template = openPdf(env, o.template);
  } catch (error) {
    throw new Error(
      `The overlay is not a readable PDF: ${(error as Error).message}`,
      {
        cause: error,
      }
    );
  }
  try {
    template.bake(true, true);
    const count = template.countPages();
    const forms = new Map<number, ReturnType<typeof pageForm>>();
    let graft: ReturnType<typeof grafter> | null = null;
    return eachPage(env, bytes, o.pages, (painter, _page, at, _of, doc) => {
      const index = { cycle: at % count, first: 0, match: at }[o.repeat];
      if (index >= count) {
        return;
      }
      graft ??= grafter(doc, template);
      let form = forms.get(index);
      if (!form) {
        form = pageForm(doc, template.loadPage(index), graft);
        forms.set(index, form);
      }
      const target: Rect = [0, 0, painter.w, painter.h];
      const place: Matrix =
        o.fit === "actual"
          ? form.toDisplay
          : chain(
              form.toDisplay,
              fitInto(form.w, form.h, target, o.fit === "fit")
            );
      painter.xobject(form.ref, place, { clip: target, opacity: o.opacity });
      painter.apply(o.layer);
    });
  } finally {
    template.destroy();
  }
};

/* ---------------- margin text ---------------- */

export type Position =
  | "tl"
  | "tc"
  | "tr"
  | "ml"
  | "mc"
  | "mr"
  | "bl"
  | "bc"
  | "br";

export interface Slot {
  position: Position;
  /** Text with Tokens: {n} {total} {roman} {ROMAN} {bates} {date} {filename} {title}. */
  text: string;
}

export interface MarginTextOptions {
  slots: Slot[];
  family: FontFamily;
  bold: boolean;
  size: number;
  color: string;
  opacity: number;
  /** Millimetres from the edge. */
  margin: number;
  /** The number the first stamped page gets. */
  start: number;
  /** Digits a Bates number is padded to. */
  digits: number;
  /** Swap left and right on every other stamped page, as a book's outer edge. */
  mirror: boolean;
  /** The values of {filename}, {title}, {date}. */
  filename: string;
  title: string;
  date: string;
  pages?: number[];
}

const ROMAN: [number, string][] = [
  [1000, "M"],
  [900, "CM"],
  [500, "D"],
  [400, "CD"],
  [100, "C"],
  [90, "XC"],
  [50, "L"],
  [40, "XL"],
  [10, "X"],
  [9, "IX"],
  [5, "V"],
  [4, "IV"],
  [1, "I"],
];

export const roman = (n: number): string => {
  if (n <= 0 || n >= 4000) {
    return String(n);
  }
  let left = n;
  let out = "";
  for (const [value, digits] of ROMAN) {
    while (left >= value) {
      out += digits;
      left -= value;
    }
  }
  return out;
};

/** A Slot's text with its Tokens filled in for one page. */
export const expandTokens = (
  template: string,
  values: {
    n: number;
    total: number;
    digits: number;
    filename: string;
    title: string;
    date: string;
  }
): string =>
  template.replaceAll(/\{(?<token>[a-z]+)\}/giu, (whole, token: string) => {
    switch (token) {
      case "n": {
        return String(values.n);
      }
      case "total": {
        return String(values.total);
      }
      case "roman": {
        return roman(values.n).toLowerCase();
      }
      case "ROMAN": {
        return roman(values.n);
      }
      case "bates": {
        return String(values.n).padStart(values.digits, "0");
      }
      case "date": {
        return values.date;
      }
      case "filename": {
        return values.filename;
      }
      case "title": {
        return values.title;
      }
      default: {
        return whole;
      }
    }
  });

const MIRRORED: Partial<Record<Position, Position>> = {
  bl: "br",
  br: "bl",
  ml: "mr",
  mr: "ml",
  tl: "tr",
  tr: "tl",
};

export const marginText = (
  env: Env,
  bytes: Uint8Array,
  o: MarginTextOptions
): Uint8Array =>
  eachPage(env, bytes, o.pages, (painter, _page, at, of) => {
    const m = o.margin * POINTS_PER_MM;
    const values = {
      date: o.date,
      digits: o.digits,
      filename: o.filename,
      n: o.start + at,
      title: o.title,
      total: o.start + of - 1,
    };
    for (const slot of o.slots) {
      const text = expandTokens(slot.text, values).trim();
      if (!text) {
        continue;
      }
      const pos =
        o.mirror && at % 2 === 1
          ? (MIRRORED[slot.position] ?? slot.position)
          : slot.position;
      const [v, hz] = [pos[0], pos[1]];
      const x = { c: painter.w / 2, l: m, r: painter.w - m }[hz ?? "c"] ?? m;
      // Top text hangs from the margin, bottom text stands on it.
      const y =
        { b: painter.h - m, m: painter.h / 2, t: m + o.size * 0.75 }[
          v ?? "b"
        ] ?? m;
      painter.text(text, x, y, {
        anchor: { c: "middle", l: "start", r: "end" }[hz ?? "c"] as
          | "middle"
          | "start"
          | "end",
        bold: o.bold,
        color: parseColor(o.color),
        family: o.family,
        middle: v === "m",
        opacity: o.opacity,
        size: o.size,
      });
    }
    painter.apply("over");
  });

/* ---------------- reading modes ---------------- */

export interface RecolorOptions {
  /** Dark: light text on dark, hues kept. Invert: every colour flipped. Contrast: grey, inverted. Sepia: warm and soft. */
  mode: "dark" | "invert" | "contrast" | "sepia";
  pages?: number[];
}

const WHITE: Rgb = [1, 1, 1];
const BLACK: Rgb = [0, 0, 0];
/** What dark mode lifts black paper to. */
const DARK_PAPER: Rgb = [0.12, 0.12, 0.12];

/** The fills laid over the page for each mode, in order, each with its blend mode. */
const RECOLOR_STEPS: Record<RecolorOptions["mode"], [BlendMode, Rgb][]> = {
  contrast: [
    ["Difference", WHITE],
    ["Saturation", BLACK],
  ],
  dark: [["Difference", WHITE]],
  invert: [["Difference", WHITE]],
  sepia: [
    ["Saturation", BLACK],
    ["Color", [0.44, 0.26, 0.08]],
    ["Multiply", [0.96, 0.93, 0.85]],
  ],
};

/**
 * Recolouring by blend modes over the page, so text and drawings stay
 * vectors. Blank paper is no colour at all to blend with, so each page gets
 * white paper under its content first. Dark mode draws the page once more
 * on top, contributing only its hues: inverting alone would turn red to
 * cyan.
 */
export const recolor = (
  env: Env,
  bytes: Uint8Array,
  o: RecolorOptions
): Uint8Array =>
  eachPage(
    env,
    bytes,
    o.pages,
    (painter, page, _at, _of, doc) => {
      const all: Rect = [0, 0, painter.w, painter.h];
      // Taken before the paper goes under it: white paper has no hue to give.
      const hues =
        o.mode === "dark" ? pageForm(doc, page, (x) => x, true) : null;
      const paper = new Painter(doc, page, painter.fonts);
      paper.rect(all, { fill: WHITE });
      paper.apply("under");
      for (const [blend, fill] of RECOLOR_STEPS[o.mode]) {
        painter.rect(all, { fill }, 1, blend);
      }
      if (hues) {
        painter.xobject(hues.ref, hues.toDisplay, { blend: "Hue" });
        painter.rect(all, { fill: DARK_PAPER }, 1, "Lighten");
      }
      painter.apply("over");
    },
    (doc) => doc.bake(true, true)
  );
