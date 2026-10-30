// Drawing onto pages and pages onto pages. Every operation that adds marks
// (a watermark, a page number, a stamp) or lays pages out anew (N-up, a
// booklet, a poster) comes down to the same few moves: give a page its own
// resources, name a font, an image, or a graphics state in them, and add a
// content stream before or after the page's own, in a q/Q pair so the
// page's leftover state never leaks into ours, nor ours into it.
//
// A Painter draws in the page's display space (see geometry.ts), the space
// the user placed things in: one matrix at the start of its content stream
// takes that to the page's user space, whatever the page's /Rotate and boxes.

import type { PDFDocument, PDFObject, PDFPage } from "mupdf";

import { encodeText } from "./fonts";
import type { FontFamily, Fonts } from "./fonts";
import {
  chain,
  fmtMatrix,
  intersect,
  invert,
  normalize,
  num,
  rotate,
  scale,
  translate,
} from "./geometry";
import type { Matrix, Rect } from "./geometry";
import { addResource, itemsOf, rectObject, rectOf } from "./objects";

/** The page's content streams, as they are listed (one, several, or none). */
const contentStreams = (page: PDFObject): PDFObject[] => {
  const contents = page.get("Contents");
  if (contents.isArray()) {
    return itemsOf(contents);
  }
  return contents.isStream() ? [contents] : [];
};

/** The page's content streams, decoded and joined: what a Form XObject of the page draws. */
export const pageContents = (page: PDFObject): Uint8Array => {
  const parts = contentStreams(page)
    .filter((s) => s.isStream())
    .map((s) => s.readStream().asUint8Array());
  let length = 0;
  for (const p of parts) {
    length += p.length + 1;
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
    // A newline between streams: one may end mid-token without it.
    out[at] = 10;
    at += 1;
  }
  return out;
};

/**
 * Add content before (`under`) and after (`over`) the page's own, each in
 * its own q/Q pair, and the page's own in another, so its graphics state
 * starts and ends clean whatever it leaves behind.
 */
export const wrapPage = (
  doc: PDFDocument,
  page: PDFObject,
  layers: { under?: string; over?: string }
) => {
  const head = `${layers.under ? `q\n${layers.under}\nQ\n` : ""}q\n`;
  const tail = `\nQ\n${layers.over ? `q\n${layers.over}\nQ\n` : ""}`;
  const arr = doc.newArray();
  arr.push(doc.addStream(head, {}));
  for (const s of contentStreams(page)) {
    arr.push(s);
  }
  arr.push(doc.addStream(tail, {}));
  page.put("Contents", arr);
};

/** Replace the page's content with `content`, in a single stream. */
export const setContent = (
  doc: PDFDocument,
  page: PDFObject,
  content: string
) => {
  page.put("Contents", doc.addStream(content, {}));
};

/** The visible area in user space: the crop box, within the media box. */
export const visibleBox = (page: PDFObject): Rect => {
  const media = rectOf(page.getInheritable("MediaBox")) ?? [0, 0, 612, 792];
  const crop = rectOf(page.getInheritable("CropBox"));
  if (!crop) {
    return media;
  }
  return intersect(media, crop) ?? media;
};

/** A page as something to draw elsewhere: its Form XObject, and how its user space maps to its display space. */
export interface PageForm {
  ref: PDFObject;
  /** Maps the page's user space (the form's space) to its display space. */
  toDisplay: Matrix;
  /** Display size in points. */
  w: number;
  h: number;
}

/**
 * The page's contents as a Form XObject in `dst`, clipped to its visible
 * box. Resources come along through `graft` when the page is from another
 * document. Annotations are not part of a page's contents: bake them first
 * where they must come along. A `group` form composites as one transparency
 * group, which a blend mode applied to the whole page needs.
 */
export const pageForm = (
  dst: PDFDocument,
  page: PDFPage,
  graft: (obj: PDFObject) => PDFObject,
  group = false
): PageForm => {
  const obj = page.getObject();
  const dict = dst.newDictionary();
  dict.put("Type", dst.newName("XObject"));
  dict.put("Subtype", dst.newName("Form"));
  dict.put("BBox", rectObject(dst, visibleBox(obj)));
  const resources = obj.getInheritable("Resources");
  if (!resources.isNull()) {
    dict.put("Resources", graft(resources));
  }
  if (group) {
    const g = dst.newDictionary();
    g.put("S", dst.newName("Transparency"));
    g.put("I", dst.newBoolean(true));
    dict.put("Group", g);
  }
  const ref = dst.addStream(pageContents(obj), dict);
  const [x0, y0, x1, y1] = page.getBounds();
  return {
    h: y1 - y0,
    ref,
    toDisplay: page.getTransform() as Matrix,
    w: x1 - x0,
  };
};

/* ---------------- colour ---------------- */

export type Rgb = [number, number, number];

/** `#rrggbb` (or `#rgb`) as 0..1 components; black for anything else. */
export const parseColor = (hex: string): Rgb => {
  const m = /^#?(?<body>[\da-f]{3}|[\da-f]{6})$/iu.exec(hex.trim());
  const body = m?.groups?.body;
  if (!body) {
    return [0, 0, 0];
  }
  const full =
    body.length === 3 ? [...body].map((c) => `${c}${c}`).join("") : body;
  return [0, 2, 4].map(
    (i) => Number.parseInt(full.slice(i, i + 2), 16) / 255
  ) as Rgb;
};

const rgbOps = (c: Rgb, op: "rg" | "RG") => `${c.map(num).join(" ")} ${op}`;

/* ---------------- the painter ---------------- */

export type Anchor = "start" | "middle" | "end";

export interface TextStyle {
  family: FontFamily;
  bold?: boolean;
  /** Font size in points. */
  size: number;
  color: Rgb;
  /** 0..1. */
  opacity?: number;
  /** Degrees counter-clockwise, as the eye sees it. */
  angle?: number;
  /** Which part of the text sits on x. */
  anchor?: Anchor;
  /** Whether y is the text's baseline or its visual middle. */
  middle?: boolean;
}

export type BlendMode =
  | "Normal"
  | "Multiply"
  | "Screen"
  | "Difference"
  | "Lighten"
  | "Hue"
  | "Saturation"
  | "Color"
  | "Luminosity";

/**
 * Draws on one page, in its display space: its visible area as the user
 * sees it, (0, 0) at the top left, y down. Collect what to draw, then
 * `apply` puts it over or under the page's own content.
 */
export class Painter {
  readonly w: number;
  readonly h: number;
  private readonly doc: PDFDocument;
  private readonly page: PDFObject;
  readonly fonts: Fonts;
  private readonly toUser: Matrix;
  private readonly parts: string[] = [];
  private readonly states = new Map<string, string>();
  /** Resource names already given out on this page, by kind and object number. */
  private readonly names = new Map<string, string>();

  constructor(doc: PDFDocument, page: PDFPage, fonts: Fonts) {
    this.doc = doc;
    this.page = page.getObject();
    this.fonts = fonts;
    this.toUser = invert(page.getTransform() as Matrix);
    const [x0, y0, x1, y1] = page.getBounds();
    this.w = x1 - x0;
    this.h = y1 - y0;
  }

  get empty(): boolean {
    return this.parts.length === 0;
  }

  /** The page's name for an indirect object, added to its resources the first time. */
  private named(kind: "Font" | "XObject", prefix: string, ref: PDFObject) {
    const key = ref.isIndirect() ? `${kind}:${ref.asIndirect()}` : null;
    const known = key ? this.names.get(key) : undefined;
    if (known) {
      return known;
    }
    const name = addResource(this.doc, this.page, kind, prefix, ref);
    if (key) {
      this.names.set(key, name);
    }
    return name;
  }

  /** The name of a graphics state with this opacity and blend mode. */
  state(opacity: number, blend: BlendMode = "Normal"): string {
    const key = `${num(opacity)}/${blend}`;
    let name = this.states.get(key);
    if (!name) {
      const gs = this.doc.newDictionary();
      gs.put("Type", this.doc.newName("ExtGState"));
      gs.put("ca", this.doc.newReal(opacity));
      gs.put("CA", this.doc.newReal(opacity));
      if (blend !== "Normal") {
        gs.put("BM", this.doc.newName(blend));
      }
      name = addResource(
        this.doc,
        this.page,
        "ExtGState",
        "PtkGS",
        this.doc.addObject(gs)
      );
      this.states.set(key, name);
    }
    return name;
  }

  /** Content in display space, as is. */
  raw(ops: string) {
    this.parts.push(ops);
  }

  /** Width of `text` in points at `size`, in the font it would be drawn in. */
  measure(text: string, style: Pick<TextStyle, "family" | "bold" | "size">) {
    const { font } = this.fonts.pick(style.family, style.bold ?? false, text);
    return encodeText(font, text).advance * style.size;
  }

  text(text: string, x: number, y: number, style: TextStyle) {
    if (!text) {
      return;
    }
    const picked = this.fonts.pick(style.family, style.bold ?? false, text);
    const name = this.named("Font", "PtkF", picked.ref);
    const { hex, advance } = encodeText(picked.font, text);
    const w = advance * style.size;
    const shift = { end: 1, middle: 0.5, start: 0 }[style.anchor ?? "start"];
    // About a cap height's half below the middle sits the baseline.
    const drop = style.middle ? style.size * 0.35 : 0;
    const tm = chain(
      scale(style.size, -style.size),
      translate(-w * shift, drop),
      rotate(-(style.angle ?? 0)),
      translate(x, y)
    );
    const gs =
      style.opacity !== undefined && style.opacity < 1
        ? `/${this.state(style.opacity)} gs `
        : "";
    this.parts.push(
      `q ${gs}${rgbOps(style.color, "rg")} BT /${name} 1 Tf ${fmtMatrix(tm)} Tm <${hex}> Tj ET Q`
    );
  }

  rect(
    r: Rect,
    paint: { fill?: Rgb; stroke?: Rgb; lineWidth?: number; dash?: number[] },
    opacity = 1,
    blend: BlendMode = "Normal"
  ) {
    const ops: string[] = ["q"];
    if (opacity < 1 || blend !== "Normal") {
      ops.push(`/${this.state(opacity, blend)} gs`);
    }
    if (paint.fill) {
      ops.push(rgbOps(paint.fill, "rg"));
    }
    if (paint.stroke) {
      ops.push(rgbOps(paint.stroke, "RG"), `${num(paint.lineWidth ?? 1)} w`);
      if (paint.dash) {
        ops.push(`[${paint.dash.map(num).join(" ")}] 0 d`);
      }
    }
    const [x0, y0, x1, y1] = normalize(r);
    ops.push(`${num(x0)} ${num(y0)} ${num(x1 - x0)} ${num(y1 - y0)} re`);
    if (paint.fill && paint.stroke) {
      ops.push("B");
    } else {
      ops.push(paint.fill ? "f" : "S");
    }
    ops.push("Q");
    this.parts.push(ops.join(" "));
  }

  line(
    a: [number, number],
    b: [number, number],
    color: Rgb,
    lineWidth: number,
    dash?: number[]
  ) {
    const d = dash ? `[${dash.map(num).join(" ")}] 0 d ` : "";
    this.parts.push(
      `q ${rgbOps(color, "RG")} ${num(lineWidth)} w ${d}${num(a[0])} ${num(a[1])} m ${num(b[0])} ${num(b[1])} l S Q`
    );
  }

  /**
   * Draw an XObject (an image, whose space is the unit square, or a form in
   * its own space) through `m` into display space, optionally clipped to a
   * display-space rectangle.
   */
  xobject(
    ref: PDFObject,
    m: Matrix,
    opts: { opacity?: number; blend?: BlendMode; clip?: Rect } = {}
  ) {
    const name = this.named("XObject", "PtkX", ref);
    const ops: string[] = ["q"];
    if (opts.clip) {
      const [x0, y0, x1, y1] = normalize(opts.clip);
      ops.push(`${num(x0)} ${num(y0)} ${num(x1 - x0)} ${num(y1 - y0)} re W n`);
    }
    const opacity = opts.opacity ?? 1;
    const blend = opts.blend ?? "Normal";
    if (opacity < 1 || blend !== "Normal") {
      ops.push(`/${this.state(opacity, blend)} gs`);
    }
    ops.push(`${fmtMatrix(m)} cm /${name} Do Q`);
    this.parts.push(ops.join(" "));
  }

  /** Draw an image into a display-space rectangle, upright. */
  image(ref: PDFObject, r: Rect, opacity = 1) {
    const [x0, y0, x1, y1] = normalize(r);
    // The image's unit square has y up; display space has y down.
    this.xobject(ref, [x1 - x0, 0, 0, -(y1 - y0), x0, y1], { opacity });
  }

  /** The collected drawing as one content stream in the page's user space. */
  content(): string {
    return `${fmtMatrix(this.toUser)} cm\n${this.parts.join("\n")}`;
  }

  /** Put the drawing over (or under) the page's own content. Nothing drawn, nothing changes. */
  apply(where: "over" | "under" = "over") {
    if (this.empty) {
      return;
    }
    wrapPage(this.doc, this.page, { [where]: this.content() });
  }
}

/* ---------------- new pages ---------------- */

/** Append an empty page of `w`×`h` points to `doc` and return it, loaded. */
export const newPage = (doc: PDFDocument, w: number, h: number): PDFPage => {
  const obj = doc.addPage([0, 0, w, h], 0, {}, "");
  doc.insertPage(-1, obj);
  return doc.loadPage(doc.countPages() - 1);
};

/** A grafting function for pages from `src` into `dst` that shares resources between calls. */
export const grafter = (
  dst: PDFDocument,
  src: PDFDocument
): ((obj: PDFObject) => PDFObject) => {
  if (src === dst) {
    return (obj) => obj;
  }
  const map = dst.newGraftMap();
  return (obj) => map.graftObject(obj);
};

/** Matrix taking a placed page's user space to a rectangle of the target's display space. */
export const placeInto = (
  form: PageForm,
  target: Rect,
  fit: (w: number, h: number, r: Rect) => Matrix
): Matrix => chain(form.toDisplay, fit(form.w, form.h, target));
