// Laying pages out anew: several to a sheet (N-up), folded into a booklet,
// tiled across sheets (a poster), stitched into one long page, scaled to a
// paper size, split down the middle (scanned spreads), and cropped.
//
// The ones that draw pages onto new sheets bake annotations and form fields
// into the page content first: a page drawn elsewhere brings its contents,
// not its interactive parts, so what the user saw is what comes out.

import type { PDFDocument, PDFPage } from "mupdf";

import { pageForm, Painter, newPage, grafter, placeInto } from "./compose";
import type { PageForm, Rgb } from "./compose";
import { openPdf, pagesOf, savePdf } from "./doc";
import type { Env } from "./doc";
import { Fonts } from "./fonts";
import {
  POINTS_PER_MM,
  chain,
  fitInto,
  height,
  intersect,
  invert,
  paperSize,
  scale,
  transformRect,
  translate,
  width,
} from "./geometry";
import type { Matrix, PaperId, Rect } from "./geometry";
import { copyMetadata } from "./inspect";

export type Orientation = "auto" | "portrait" | "landscape";
export type Sheet = "same" | PaperId;

const GRAY: Rgb = [0.6, 0.6, 0.6];

/* ---------------- shared ---------------- */

interface Composing {
  src: PDFDocument;
  dst: PDFDocument;
  fonts: Fonts;
  /** The Form XObject of a source page, made once. */
  form: (index: number) => PageForm;
  /** Display sizes of the source pages. */
  sizes: [number, number][];
}

/**
 * Open the input with its annotations baked in, start an empty output that
 * keeps the input's document information, run `body`, and save the output.
 */
const compose = (
  env: Env,
  bytes: Uint8Array,
  body: (c: Composing) => void,
  opts: { group?: boolean } = {}
): Uint8Array => {
  const src = openPdf(env, bytes);
  const dst = new env.mupdf.PDFDocument();
  try {
    src.bake(true, true);
    const graft = grafter(dst, src);
    copyMetadata(src, dst);
    const forms = new Map<number, PageForm>();
    const sizes = pagesOf(src).map(({ page }) => {
      const [x0, y0, x1, y1] = page.getBounds();
      return [x1 - x0, y1 - y0] as [number, number];
    });
    body({
      dst,
      fonts: new Fonts(env.mupdf, dst),
      form: (index) => {
        let f = forms.get(index);
        if (!f) {
          f = pageForm(dst, src.loadPage(index), graft, opts.group);
          forms.set(index, f);
        }
        return f;
      },
      sizes,
      src,
    });
    if (dst.countPages() === 0) {
      throw new Error("Nothing came out: there are no pages to lay out.");
    }
    return savePdf(dst, { subset: true });
  } finally {
    src.destroy();
    dst.destroy();
  }
};

/** The rectangle a page fills once placed by `m`. */
const placedRect = (form: PageForm, m: Matrix): Rect =>
  transformRect(
    m,
    transformRect(invert(form.toDisplay), [0, 0, form.w, form.h])
  );

const sheetCandidates = (
  sheet: Sheet,
  orientation: Orientation,
  base: [number, number]
): [number, number][] => {
  const [w, h] = sheet === "same" ? base : paperSize(sheet, "portrait");
  const portrait: [number, number] = [Math.min(w, h), Math.max(w, h)];
  const landscape: [number, number] = [Math.max(w, h), Math.min(w, h)];
  if (orientation === "portrait") {
    return [portrait];
  }
  if (orientation === "landscape") {
    return [landscape];
  }
  return [portrait, landscape];
};

/* ---------------- N-up ---------------- */

export interface NupOptions {
  perSheet: 2 | 4 | 6 | 8 | 9 | 16;
  sheet: Sheet;
  orientation: Orientation;
  /** Fill each row first, or each column. */
  order: "rows" | "columns";
  /** Right to left, for right-to-left reading. */
  rtl: boolean;
  /** Millimetres. */
  margin: number;
  spacing: number;
  borders: boolean;
}

const GRIDS = new Map<number, [cols: number, rows: number][]>([
  [
    2,
    [
      [2, 1],
      [1, 2],
    ],
  ],
  [4, [[2, 2]]],
  [
    6,
    [
      [3, 2],
      [2, 3],
    ],
  ],
  [
    8,
    [
      [4, 2],
      [2, 4],
    ],
  ],
  [9, [[3, 3]]],
  [16, [[4, 4]]],
]);

interface Layout {
  w: number;
  h: number;
  cols: number;
  rows: number;
}

/** The sheet and grid that show the pages biggest. */
const bestLayout = (o: NupOptions, base: [number, number]): Layout => {
  const margin = o.margin * POINTS_PER_MM;
  const gap = o.spacing * POINTS_PER_MM;
  let best: Layout & { score: number } = {
    cols: 1,
    h: base[1],
    rows: o.perSheet,
    score: -1,
    w: base[0],
  };
  for (const [w, h] of sheetCandidates(o.sheet, o.orientation, base)) {
    for (const [cols, rows] of GRIDS.get(o.perSheet) ?? [[2, 1]]) {
      const cw = (w - 2 * margin - (cols - 1) * gap) / cols;
      const ch = (h - 2 * margin - (rows - 1) * gap) / rows;
      const score = Math.min(cw / base[0], ch / base[1]);
      if (score > best.score) {
        best = { cols, h, rows, score, w };
      }
    }
  }
  return best;
};

export const nup = (env: Env, bytes: Uint8Array, o: NupOptions): Uint8Array =>
  compose(env, bytes, (c) => {
    const base = c.sizes[0] ?? [595, 842];
    const { w, h, cols, rows } = bestLayout(o, base);
    const margin = o.margin * POINTS_PER_MM;
    const gap = o.spacing * POINTS_PER_MM;
    const cw = (w - 2 * margin - (cols - 1) * gap) / cols;
    const ch = (h - 2 * margin - (rows - 1) * gap) / rows;
    const per = cols * rows;
    for (let first = 0; first < c.sizes.length; first += per) {
      const sheet = newPage(c.dst, w, h);
      const painter = new Painter(c.dst, sheet, c.fonts);
      for (let k = 0; k < per && first + k < c.sizes.length; k += 1) {
        const col0 = o.order === "rows" ? k % cols : Math.floor(k / rows);
        const row = o.order === "rows" ? Math.floor(k / cols) : k % rows;
        const col = o.rtl ? cols - 1 - col0 : col0;
        const x = margin + col * (cw + gap);
        const y = margin + row * (ch + gap);
        const form = c.form(first + k);
        const m = placeInto(form, [x, y, x + cw, y + ch], fitInto);
        painter.xobject(form.ref, m);
        if (o.borders) {
          painter.rect(placedRect(form, m), { lineWidth: 0.5, stroke: GRAY });
        }
      }
      painter.apply();
    }
  });

/* ---------------- booklet ---------------- */

export interface BookletOptions {
  sheet: Sheet;
  /** Which edge the booklet is bound on, as read. */
  binding: "left" | "right";
  /** Millimetres between the two pages of a sheet side. */
  gutter: number;
  foldLine: boolean;
}

/**
 * Saddle-stitch order: for each sheet, the outside (last, first) and the
 * inside (second, second to last), so the stack folds into page order. The
 * page count is padded to a multiple of four with blanks (null).
 */
export const bookletOrder = (
  count: number
): [number | null, number | null][] => {
  const n = Math.ceil(count / 4) * 4;
  const page = (i: number) => (i < count ? i : null);
  const sides: [number | null, number | null][] = [];
  for (let k = 0; k < n / 4; k += 1) {
    sides.push(
      [page(n - 1 - 2 * k), page(2 * k)],
      [page(2 * k + 1), page(n - 2 - 2 * k)]
    );
  }
  return sides;
};

export const booklet = (
  env: Env,
  bytes: Uint8Array,
  o: BookletOptions
): Uint8Array =>
  compose(env, bytes, (c) => {
    const [pw, ph] = c.sizes[0] ?? [595, 842];
    const gutter = o.gutter * POINTS_PER_MM;
    const [w, h] =
      o.sheet === "same"
        ? [2 * pw + gutter, ph]
        : paperSize(o.sheet, "landscape");
    const half = (w - gutter) / 2;
    for (const [left0, right0] of bookletOrder(c.sizes.length)) {
      const [left, right] =
        o.binding === "right" ? [right0, left0] : [left0, right0];
      const sheet = newPage(c.dst, w, h);
      const painter = new Painter(c.dst, sheet, c.fonts);
      for (const [index, x] of [
        [left, 0],
        [right, half + gutter],
      ] as const) {
        if (index !== null) {
          const form = c.form(index);
          painter.xobject(
            form.ref,
            placeInto(form, [x, 0, x + half, h], fitInto)
          );
        }
      }
      if (o.foldLine) {
        painter.line([w / 2, 0], [w / 2, h], GRAY, 0.25, [3, 3]);
      }
      painter.apply();
    }
  });

/* ---------------- poster ---------------- */

export interface PosterOptions {
  sheet: PaperId;
  orientation: Orientation;
  /** Tiles across and down; the page is scaled to fill them. */
  cols: number;
  rows: number;
  /** Millimetres each tile repeats of its neighbour, for gluing. */
  overlap: number;
  /** Crop marks and a tile label in the margin. */
  guides: boolean;
}

/** The margin left for crop marks and labels, in points. */
const GUIDE_MARGIN = 18;

const drawCropMarks = (painter: Painter, r: Rect) => {
  const len = 10;
  const gap = 3;
  const [x0, y0, x1, y1] = r;
  for (const [x, y, dx, dy] of [
    [x0, y0, -1, -1],
    [x1, y0, 1, -1],
    [x0, y1, -1, 1],
    [x1, y1, 1, 1],
  ] as const) {
    painter.line([x + dx * gap, y], [x + dx * (gap + len), y], GRAY, 0.3);
    painter.line([x, y + dy * gap], [x, y + dy * (gap + len)], GRAY, 0.3);
  }
};

export const poster = (
  env: Env,
  bytes: Uint8Array,
  o: PosterOptions
): Uint8Array =>
  compose(env, bytes, (c) => {
    const overlap = o.overlap * POINTS_PER_MM;
    const cols = Math.max(1, Math.round(o.cols));
    const rows = Math.max(1, Math.round(o.rows));
    for (const [index, [pw, ph]] of c.sizes.entries()) {
      const [w, h] =
        o.orientation === "auto"
          ? paperSize(o.sheet, pw * rows > ph * cols ? "landscape" : "portrait")
          : paperSize(o.sheet, o.orientation);
      const m = o.guides ? GUIDE_MARGIN : 0;
      const cw = w - 2 * m;
      const ch = h - 2 * m;
      const stepX = cw - overlap;
      const stepY = ch - overlap;
      // The whole poster: every tile's window, overlaps counted once.
      const totalW = cols * stepX + overlap;
      const totalH = rows * stepY + overlap;
      const s = Math.min(totalW / pw, totalH / ph);
      const offX = (totalW - pw * s) / 2;
      const offY = (totalH - ph * s) / 2;
      const form = c.form(index);
      for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < cols; col += 1) {
          const sheet = newPage(c.dst, w, h);
          const painter = new Painter(c.dst, sheet, c.fonts);
          const wx = col * stepX;
          const wy = row * stepY;
          const toTile = chain(
            form.toDisplay,
            scale(s),
            translate(offX - wx + m, offY - wy + m)
          );
          painter.xobject(form.ref, toTile, { clip: [m, m, m + cw, m + ch] });
          if (o.guides) {
            drawCropMarks(painter, [m, m, m + cw, m + ch]);
            painter.text(
              `${index + 1} · row ${row + 1} of ${rows} · column ${col + 1} of ${cols}`,
              m,
              m - 6,
              { color: GRAY, family: "helvetica", size: 7 }
            );
          }
          painter.apply();
        }
      }
    }
  });

/* ---------------- stitch ---------------- */

export interface StitchOptions {
  direction: "vertical" | "horizontal";
  /** Millimetres. */
  margin: number;
  spacing: number;
}

/** The largest page Acrobat opens, in points (200 inches). */
export const MAX_PAGE = 14_400;

export const stitch = (
  env: Env,
  bytes: Uint8Array,
  o: StitchOptions
): Uint8Array =>
  compose(env, bytes, (c) => {
    const margin = o.margin * POINTS_PER_MM;
    const gap = o.spacing * POINTS_PER_MM;
    const vertical = o.direction === "vertical";
    const across = Math.max(...c.sizes.map(([w, h]) => (vertical ? w : h)));
    let along = 0;
    for (const [w, h] of c.sizes) {
      along += vertical ? h : w;
    }
    along += gap * (c.sizes.length - 1);
    const w = (vertical ? across : along) + 2 * margin;
    const h = (vertical ? along : across) + 2 * margin;
    const sheet = newPage(c.dst, w, h);
    const painter = new Painter(c.dst, sheet, c.fonts);
    let at = margin;
    for (const [index, [pw, ph]] of c.sizes.entries()) {
      const form = c.form(index);
      const x = vertical ? margin + (across - pw) / 2 : at;
      const y = vertical ? at : margin + (across - ph) / 2;
      painter.xobject(form.ref, chain(form.toDisplay, translate(x, y)));
      at += (vertical ? ph : pw) + gap;
    }
    painter.apply();
  });

/* ---------------- scale ---------------- */

export interface ScaleOptions {
  /** Scale to a paper size, or by a factor. */
  mode: "paper" | "factor";
  paper: PaperId | "custom";
  /** Millimetres, for a custom paper. */
  customW: number;
  customH: number;
  orientation: Orientation;
  /** Percent, for "factor". */
  factor: number;
  /** Fit inside, fill and crop, or stretch to the paper. */
  fit: "fit" | "fill" | "stretch";
  /** Millimetres of white around the content. */
  margin: number;
}

const fillInto = (w: number, h: number, r: Rect): Matrix => {
  const s = Math.max(width(r) / w, height(r) / h);
  return chain(
    scale(s),
    translate(r[0] + (width(r) - w * s) / 2, r[1] + (height(r) - h * s) / 2)
  );
};

const targetSize = (
  o: ScaleOptions,
  pw: number,
  ph: number
): [number, number] => {
  if (o.mode === "factor") {
    const f = o.factor / 100;
    return [pw * f, ph * f];
  }
  if (o.paper === "custom") {
    const w = o.customW * POINTS_PER_MM;
    const h = o.customH * POINTS_PER_MM;
    const landscape =
      o.orientation === "landscape" || (o.orientation === "auto" && pw > ph);
    const portrait =
      o.orientation === "portrait" || (o.orientation === "auto" && pw <= ph);
    if ((landscape && w < h) || (portrait && w > h)) {
      return [h, w];
    }
    return [w, h];
  }
  return paperSize(o.paper, o.orientation, pw, ph);
};

export const scalePages = (
  env: Env,
  bytes: Uint8Array,
  o: ScaleOptions
): Uint8Array =>
  compose(env, bytes, (c) => {
    const margin = o.margin * POINTS_PER_MM;
    for (const [index, [pw, ph]] of c.sizes.entries()) {
      const [w, h] = targetSize(o, pw, ph);
      const sheet = newPage(c.dst, w, h);
      const painter = new Painter(c.dst, sheet, c.fonts);
      const form = c.form(index);
      const box: Rect = [margin, margin, w - margin, h - margin];
      const fit = {
        fill: fillInto,
        fit: fitInto,
        stretch: (fw: number, fh: number, r: Rect) => fitInto(fw, fh, r, false),
      }[o.fit];
      painter.xobject(form.ref, placeInto(form, box, fit), { clip: box });
      painter.apply();
    }
  });

/* ---------------- split spreads ---------------- */

export interface SpreadOptions {
  /** Down the middle (left and right halves) or across it (top and bottom). */
  cut: "vertical" | "horizontal";
  /** For a vertical cut: which half is read first. */
  order: "ltr" | "rtl";
  /** Millimetres each half keeps of the other, so nothing at the gutter is lost. */
  overlap: number;
  /** Leave the first page (a cover) and the last whole. */
  keepFirst: boolean;
  keepLast: boolean;
}

/** The two halves of a w×h page, in reading order, in display space. */
export const spreadHalves = (
  w: number,
  h: number,
  o: SpreadOptions
): [Rect, Rect] => {
  const over = (o.overlap * POINTS_PER_MM) / 2;
  if (o.cut === "horizontal") {
    return [
      [0, 0, w, h / 2 + over],
      [0, h / 2 - over, w, h],
    ];
  }
  const left: Rect = [0, 0, w / 2 + over, h];
  const right: Rect = [w / 2 - over, 0, w, h];
  return o.order === "rtl" ? [right, left] : [left, right];
};

/**
 * Every page twice (qpdf copies a repeated page; MuPDF would share it),
 * each copy cropped to one half. Pages kept whole come through once.
 */
export const splitSpreads = (
  env: Env,
  bytes: Uint8Array,
  o: SpreadOptions
): Uint8Array => {
  const probe = openPdf(env, bytes);
  const count = probe.countPages();
  probe.destroy();
  const whole = (i: number) =>
    (o.keepFirst && i === 0) || (o.keepLast && i === count - 1 && count > 1);
  const order: number[] = [];
  for (let i = 0; i < count; i += 1) {
    order.push(i, ...(whole(i) ? [] : [i]));
  }
  const input = "/in/spreads.pdf";
  const out = "/out/spreads.pdf";
  const doubled = env.qpdf.produce(
    "Could not copy the pages",
    { [input]: bytes },
    [input, "--pages", input, order.map((i) => i + 1).join(","), "--", out],
    out
  ).bytes;
  const doc = openPdf(env, doubled);
  try {
    let at = 0;
    for (let i = 0; i < count; i += 1) {
      if (whole(i)) {
        at += 1;
        continue;
      }
      for (const half of [0, 1] as const) {
        const page = doc.loadPage(at);
        const [x0, y0, x1, y1] = page.getBounds();
        const halves = spreadHalves(x1 - x0, y1 - y0, o);
        page.setPageBox("CropBox", halves[half]);
        at += 1;
      }
    }
    return savePdf(doc);
  } finally {
    doc.destroy();
  }
};

/* ---------------- crop ---------------- */

export interface CropOptions {
  /**
   * "box": one rectangle, as fractions of the page (so pages of other sizes
   * get the same part); "margins": millimetres off each edge; "trim": down
   * to the content on each page, plus `padding`.
   */
  mode: "box" | "margins" | "trim";
  /** Fractions [x0, y0, x1, y1] of the display page, for "box". */
  box: Rect;
  /** Millimetres: top, right, bottom, left, for "margins". */
  margins: [number, number, number, number];
  /** Millimetres around the content, for "trim". */
  padding: number;
  /** For "trim": one box for every page (all their content), or each its own. */
  uniform: boolean;
  /** 0-based pages to crop; all when absent. */
  pages?: number[];
}

/** How dark a pixel must be, on any channel, to count as content. */
const INK = 245;

/** The bounding box of non-white pixels, in display space, or null for a blank page. */
export const contentBox = (env: Env, page: PDFPage): Rect | null => {
  const pix = page.toPixmap(
    [1, 0, 0, 1, 0, 0],
    env.mupdf.ColorSpace.DeviceRGB,
    false,
    true
  );
  try {
    const w = pix.getWidth();
    const h = pix.getHeight();
    const n = pix.getNumberOfComponents() + pix.getAlpha();
    const stride = pix.getStride();
    const px = pix.getPixels();
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const at = y * stride + x * n;
        if (
          (px[at] ?? 255) < INK ||
          (px[at + 1] ?? 255) < INK ||
          (px[at + 2] ?? 255) < INK
        ) {
          x0 = Math.min(x0, x);
          y0 = Math.min(y0, y);
          x1 = Math.max(x1, x);
          y1 = Math.max(y1, y);
        }
      }
    }
    if (x1 < 0) {
      return null;
    }
    const [bx, by] = page.getBounds();
    return [bx + x0, by + y0, bx + x1 + 1, by + y1 + 1];
  } finally {
    pix.destroy();
  }
};

const cropRect = (
  env: Env,
  page: PDFPage,
  o: CropOptions,
  uniform: Rect | null
): Rect | null => {
  const [bx0, by0, bx1, by1] = page.getBounds();
  const w = bx1 - bx0;
  const h = by1 - by0;
  if (o.mode === "box") {
    const [fx0, fy0, fx1, fy1] = o.box;
    return [bx0 + fx0 * w, by0 + fy0 * h, bx0 + fx1 * w, by0 + fy1 * h];
  }
  if (o.mode === "margins") {
    const [t, r, b, l] = o.margins.map((v) => v * POINTS_PER_MM);
    return [bx0 + (l ?? 0), by0 + (t ?? 0), bx1 - (r ?? 0), by1 - (b ?? 0)];
  }
  const content = uniform ?? contentBox(env, page);
  if (!content) {
    return null;
  }
  const p = o.padding * POINTS_PER_MM;
  return [content[0] - p, content[1] - p, content[2] + p, content[3] + p];
};

export const crop = (
  env: Env,
  bytes: Uint8Array,
  o: CropOptions
): Uint8Array => {
  const doc = openPdf(env, bytes);
  try {
    const only = o.pages ? new Set(o.pages) : undefined;
    const pages = pagesOf(doc, only);
    let uniform: Rect | null = null;
    if (o.mode === "trim" && o.uniform) {
      for (const { page } of pages) {
        const b = contentBox(env, page);
        if (b) {
          uniform = uniform
            ? [
                Math.min(uniform[0], b[0]),
                Math.min(uniform[1], b[1]),
                Math.max(uniform[2], b[2]),
                Math.max(uniform[3], b[3]),
              ]
            : b;
        }
      }
    }
    for (const { page } of pages) {
      const r = cropRect(env, page, o, uniform);
      // A crop never reaches past the page, and a page that would vanish keeps its box.
      const kept = r ? intersect(r, page.getBounds() as Rect) : null;
      if (kept && width(kept) >= 1 && height(kept) >= 1) {
        page.setPageBox("CropBox", kept);
      }
    }
    return savePdf(doc);
  } finally {
    doc.destroy();
  }
};
