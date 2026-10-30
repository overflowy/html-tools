// The Viewer: pages as a grid of thumbnails (where the Page List is
// organized: selected, dragged, turned, deleted) or as a column of pages
// at a zoom (where the user reads, searches, and places things). Pages are
// rendered by the worker as they scroll into view, the visible ones first.
//
// Over each page in the column sits an SVG in the page's display space,
// in points: what is drawn there (search hits, boxes, notes, strokes) is
// in the same coordinates the Operations take, so nothing is converted on
// the way.

import { NOTE_ICON, TEXT_BASELINE, TEXT_LINE } from "../pdf/annotate";
import type { MarkupKind } from "../pdf/annotate";
import type { Point, Rect } from "../pdf/geometry";
import type { Quad } from "../pdf/text";
import type { Rendered } from "../worker";
import { el } from "./dom";

export interface ViewPage {
  /** Stable across re-renders of the list: a Page List entry's key. */
  key: string;
  doc: string;
  index: number;
  /** Degrees clockwise to turn the rendering by. */
  rotate: number;
  /** Display size in points, turned. */
  w: number;
  h: number;
  label: string;
  /** Which Source it is from, for a coloured mark when there are several. */
  tag: number | null;
}

export type Mark =
  | {
      kind: "rect";
      rect: Rect;
      style: "redact" | "crop" | "field" | "stamp";
      label?: string;
    }
  | {
      kind: "quads";
      quads: Quad[];
      style: "hit" | "current" | "select";
    }
  /** Text marked up, drawn as its annotation draws it. */
  | {
      kind: "markup";
      markup: MarkupKind;
      quads: Quad[];
      color: string;
      opacity: number;
    }
  | {
      kind: "ink";
      strokes: Point[][];
      color: string;
      width: number;
      opacity: number;
    }
  | {
      kind: "line";
      a: Point;
      b: Point;
      color: string;
      width: number;
      opacity: number;
      arrow: boolean;
    }
  /** A rectangle or an ellipse in `rect`, its line centred on the edge. */
  | {
      kind: "shape";
      shape: "rect" | "ellipse";
      rect: Rect;
      color: string;
      width: number;
      opacity: number;
    }
  /** A note's icon, its top left at `at`; its text shows on hover. */
  | { kind: "note"; at: Point; color: string; opacity: number; text: string }
  /** Text written on the page from `at`, set as a text box sets it. */
  | {
      kind: "written";
      at: Point;
      text: string;
      size: number;
      color: string;
      opacity: number;
    };

/** How the pointer draws: a box, across text, freehand, a line, a click, or a click to type at. */
export type DrawTool = "rect" | "text" | "ink" | "line" | "point" | "write";

export interface Gesture {
  /** Position of the page in the list shown. */
  page: number;
  tool: DrawTool;
  from: Point;
  to: Point;
  /** Every point of a stroke. */
  points: Point[];
  done: boolean;
}

export interface ViewerHost {
  render: (doc: string, index: number, scale: number) => Promise<Rendered>;
  marks: (page: number) => Mark[];
  gesture: (g: Gesture) => void;
  /** The grid's edits; absent for a list that cannot be edited (a Result). */
  edit: {
    selectionChanged: (keys: Set<string>) => void;
    move: (keys: string[], before: number) => void;
    rotate: (key: string) => void;
    remove: (keys: string[]) => void;
  } | null;
  currentChanged: (page: number) => void;
}

/** CSS pixels per point at 100%: a PDF point is 1/72 inch, a CSS pixel 1/96. */
const PX_PER_PT = 96 / 72;
const THUMB_W = 132;
const THUMB_H = 170;
const ZOOM_STEPS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4,
];
const GAP = 16;
const DRAG_TYPE = "application/x-pdf-toolkit-page";
const SVG = "http://www.w3.org/2000/svg";
/** Renderings kept: plenty of thumbnails, fewer full pages. */
const CACHE_LIMIT = 160;

interface Slot {
  page: ViewPage;
  at: number;
  root: HTMLElement;
  canvas: HTMLCanvasElement;
  svg: SVGSVGElement | null;
  /** Under the overlay, multiplied onto the rendering as MuPDF does it: highlights. */
  blend: SVGSVGElement | null;
  /** Scale the canvas holds now, 0 for none. */
  drawn: number;
  visible: boolean;
}

const svgEl = <K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>
) => {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) {
    node.setAttribute(k, String(v));
  }
  return node;
};

const quadPoints = (q: Quad) =>
  `${q[0]},${q[1]} ${q[2]},${q[3]} ${q[6]},${q[7]} ${q[4]},${q[5]}`;

/** A note being written: the box's width, and the space between it and the note's icon, in CSS pixels. */
const NOTE_WIDTH = 220;
const NOTE_GAP = 6;

/** The face text written on a page is shown in while it is typed and after: a text box's Helvetica, or its metric twin. */
const WRITING_FONT = "Helvetica, Arial, sans-serif";

/**
 * Where CSS sets the first baseline of a line `TEXT_LINE` high in
 * WRITING_FONT, in font sizes from the line's top: the editor is moved by
 * the difference, so its text sits where the text box's will.
 */
const cssBaseline = (): number => {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) {
    return TEXT_BASELINE;
  }
  ctx.font = `100px ${WRITING_FONT}`;
  const m = ctx.measureText("Hg");
  const ascent = m.fontBoundingBoxAscent / 100;
  const descent = m.fontBoundingBoxDescent / 100;
  return (TEXT_LINE - ascent - descent) / 2 + ascent;
};

/** A pointer position as a point of the page, in display space. */
const toPage = (s: Slot, e: PointerEvent): Point => {
  const box = (s.svg ?? s.canvas).getBoundingClientRect();
  const x = ((e.clientX - box.left) / box.width) * s.page.w;
  const y = ((e.clientY - box.top) / box.height) * s.page.h;
  return [
    Math.max(0, Math.min(s.page.w, x)),
    Math.max(0, Math.min(s.page.h, y)),
  ];
};

type MarkOf<K extends Mark["kind"]> = Extract<Mark, { kind: K }>;

const pointList = (points: Point[]) => points.map((p) => p.join(",")).join(" ");

const rectNode = (m: MarkOf<"rect">) => {
  const [x0, y0, x1, y1] = m.rect;
  const g = svgEl("g", { class: `mark mark-${m.style}` });
  g.append(
    svgEl("rect", {
      height: Math.abs(y1 - y0),
      width: Math.abs(x1 - x0),
      x: Math.min(x0, x1),
      y: Math.min(y0, y1),
    })
  );
  if (m.label) {
    const t = svgEl("text", {
      x: Math.min(x0, x1) + 2,
      y: Math.min(y0, y1) - 3,
    });
    t.textContent = m.label;
    g.append(t);
  }
  return g;
};

const quadsNode = (m: MarkOf<"quads">) => {
  const g = svgEl("g", { class: `mark mark-${m.style}` });
  for (const q of m.quads) {
    g.append(svgEl("polygon", { points: quadPoints(q) }));
  }
  return g;
};

/**
 * A quad as a frame to draw text markup in: `at(d, u)` is the point `d`
 * along its bottom edge from the start and `u` up from it, toward its top.
 * Text set at an angle gets its markup at that angle.
 */
const quadFrame = (q: Quad) => {
  const { 0: ulx, 1: uly, 4: llx, 5: lly, 6: lrx, 7: lry } = q;
  const length = Math.hypot(lrx - llx, lry - lly) || 1;
  const height = Math.hypot(ulx - llx, uly - lly) || 1;
  const along: Point = [(lrx - llx) / length, (lry - lly) / length];
  const up: Point = [(ulx - llx) / height, (uly - lly) / height];
  const at = (d: number, u: number): Point => [
    llx + along[0] * d + up[0] * u,
    lly + along[1] * d + up[1] * u,
  ];
  return { at, height, length };
};

/**
 * The path of one quad's markup, as MuPDF draws it for the annotation
 * (fitted to its renderings): a highlight's ends are curves bulging out,
 * their control points a third of the height from the corners at 45
 * degrees; a line a sixteenth of the height thick sits a seventh of it up
 * for an underline, three sevenths for a strike out, or zigzags between the
 * bottom and a seventh up for a squiggle, a seventh of the height a stroke.
 */
const markupPath = (kind: MarkupKind, q: Quad): string => {
  const { at, height: h, length } = quadFrame(q);
  const p = (d: number, u: number) => at(d, u).join(",");
  if (kind === "highlight") {
    const k = h / 3 / Math.SQRT2;
    return [
      `M${p(0, h)}`,
      `C${p(-k, h - k)} ${p(-k, k)} ${p(0, 0)}`,
      `L${p(length, 0)}`,
      `C${p(length + k, k)} ${p(length + k, h - k)} ${p(length, h)}Z`,
    ].join("");
  }
  if (kind !== "squiggly") {
    const u = kind === "underline" ? h / 7 : (3 * h) / 7;
    return `M${p(0, u)}L${p(length, u)}`;
  }
  const step = h / 7;
  // MuPDF finishes the last stroke, cut a line's width past the text.
  const end = Math.min(Math.ceil(length / step) * step, length + h / 16);
  const corners: string[] = [];
  for (let i = 0; i * step < end; i += 1) {
    corners.push(p(i * step, i % 2 === 0 ? 0 : step));
  }
  const strokes = end / step;
  const rest = strokes - Math.floor(strokes);
  const rising = Math.floor(strokes) % 2 === 0;
  corners.push(p(end, (rising ? rest : 1 - rest) * step));
  return `M${corners.join("L")}`;
};

const markupNode = (m: MarkOf<"markup">) => {
  const g = svgEl("g", {
    class: `mark mark-markup mark-${m.markup}`,
    opacity: m.opacity,
  });
  for (const q of m.quads) {
    const path = svgEl("path", { d: markupPath(m.markup, q) });
    if (m.markup === "highlight") {
      path.setAttribute("fill", m.color);
    } else {
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", m.color);
      path.setAttribute("stroke-width", String(quadFrame(q).height / 16));
    }
    g.append(path);
  }
  return g;
};

const inkNode = (m: MarkOf<"ink">) => {
  const g = svgEl("g", { class: "mark mark-ink", opacity: m.opacity });
  for (const stroke of m.strokes) {
    g.append(
      svgEl("polyline", {
        fill: "none",
        points: pointList(stroke),
        stroke: m.color,
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
        "stroke-width": m.width,
      })
    );
  }
  return g;
};

const lineNode = (m: MarkOf<"line">) => {
  const g = svgEl("g", { class: "mark mark-line", opacity: m.opacity });
  g.append(
    svgEl("line", {
      stroke: m.color,
      "stroke-width": m.width,
      x1: m.a[0],
      x2: m.b[0],
      y1: m.a[1],
      y2: m.b[1],
    })
  );
  if (m.arrow) {
    const ang = Math.atan2(m.b[1] - m.a[1], m.b[0] - m.a[0]);
    const len = 6 + m.width * 2;
    const wing = (d: number): Point => [
      m.b[0] - len * Math.cos(ang + d),
      m.b[1] - len * Math.sin(ang + d),
    ];
    g.append(
      svgEl("polyline", {
        fill: "none",
        points: pointList([wing(0.5), m.b, wing(-0.5)]),
        stroke: m.color,
        "stroke-width": m.width,
      })
    );
  }
  return g;
};

const shapeNode = (m: MarkOf<"shape">) => {
  const [x0, y0, x1, y1] = m.rect;
  const g = svgEl("g", {
    class: `mark mark-shape mark-${m.shape}`,
    opacity: m.opacity,
  });
  const line = { fill: "none", stroke: m.color, "stroke-width": m.width };
  g.append(
    m.shape === "ellipse"
      ? svgEl("ellipse", {
          ...line,
          cx: (x0 + x1) / 2,
          cy: (y0 + y1) / 2,
          rx: Math.abs(x1 - x0) / 2,
          ry: Math.abs(y1 - y0) / 2,
        })
      : svgEl("rect", {
          ...line,
          height: Math.abs(y1 - y0),
          width: Math.abs(x1 - x0),
          x: Math.min(x0, x1),
          y: Math.min(y0, y1),
        })
  );
  return g;
};

const writtenNode = (m: MarkOf<"written">) => {
  const t = svgEl("text", { class: "written" });
  // Inline, over the marks' own small type: the size is in points, which are the overlay's units.
  t.style.font = `400 ${m.size}px ${WRITING_FONT}`;
  t.style.fill = m.color;
  t.style.opacity = String(m.opacity);
  for (const [i, line] of m.text.split("\n").entries()) {
    const span = svgEl("tspan", {
      x: m.at[0],
      y: m.at[1] + (TEXT_BASELINE + i * TEXT_LINE) * m.size,
    });
    span.textContent = line;
    t.append(span);
  }
  const g = svgEl("g", { class: "mark mark-written" });
  g.append(t);
  return g;
};

/** A note's icon as MuPDF draws "Comment": a square in its colour, outlined, with a speech bubble in it. */
const noteNode = (m: MarkOf<"note">) => {
  const [x, y] = m.at;
  const k = NOTE_ICON / 16;
  const g = svgEl("g", {
    class: "mark mark-note",
    opacity: m.opacity,
    transform: `translate(${x} ${y}) scale(${k})`,
  });
  const title = svgEl("title", {});
  title.textContent = m.text;
  g.append(
    title,
    svgEl("rect", {
      fill: m.color,
      height: 15,
      stroke: "#000",
      "stroke-width": 1,
      width: 15,
      x: 0.5,
      y: 0.5,
    }),
    svgEl("path", { d: "M4 4h8v8l-2-2H4z", fill: "#000" })
  );
  return g;
};

/** The SVG for one mark. */
const markNode = (m: Mark): SVGElement => {
  switch (m.kind) {
    case "rect": {
      return rectNode(m);
    }
    case "quads": {
      return quadsNode(m);
    }
    case "markup": {
      return markupNode(m);
    }
    case "ink": {
      return inkNode(m);
    }
    case "line": {
      return lineNode(m);
    }
    case "shape": {
      return shapeNode(m);
    }
    case "written": {
      return writtenNode(m);
    }
    default: {
      return noteNode(m);
    }
  }
};

export class Viewer {
  readonly root: HTMLElement;
  private readonly host: ViewerHost;
  private pages: ViewPage[] = [];
  private slots: Slot[] = [];
  private mode: "grid" | "pages" = "grid";
  private zoom = 1;
  private fit: "width" | "page" | null = "width";
  private tool: DrawTool | null = null;
  private selected = new Set<string>();
  private anchor: string | null = null;
  private readonly cache = new Map<string, ImageBitmap>();
  private queue: Slot[] = [];
  private busy = false;
  private observer: IntersectionObserver;
  private generation = 0;
  private current = 0;
  /** Ends the typing going on over a page, if any. */
  private writing: (() => void) | null = null;

  constructor(host: ViewerHost) {
    this.host = host;
    this.root = el("div", { attrs: { tabindex: "-1" }, class: "viewer-body" });
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const slot = this.slots.find((s) => s.root === e.target);
          if (slot) {
            slot.visible = e.isIntersecting;
            if (e.isIntersecting) {
              this.want(slot);
            }
          }
        }
      },
      { root: this.root, rootMargin: "600px 0px" }
    );
    this.root.addEventListener("scroll", () => this.trackCurrent(), {
      passive: true,
    });
    this.root.addEventListener("keydown", (e) => this.key(e));
    new ResizeObserver(() => {
      if (this.mode === "pages" && this.fit) {
        this.applyZoom(this.fitZoom(this.fit));
      }
    }).observe(this.root);
  }

  get viewMode() {
    return this.mode;
  }

  get zoomLevel() {
    return this.zoom;
  }

  get currentPage() {
    return this.current;
  }

  get selection(): Set<string> {
    return new Set(this.selected);
  }

  /* ---------------- what is shown ---------------- */

  /** Show `pages`, keeping the scroll position when the list is the same length. */
  show(pages: ViewPage[], selected = new Set<string>()) {
    this.pages = pages;
    this.selected = new Set(
      [...selected].filter((k) => pages.some((p) => p.key === k))
    );
    this.build();
  }

  setMode(mode: "grid" | "pages") {
    if (mode === this.mode) {
      return;
    }
    const keep = this.current;
    this.mode = mode;
    this.build();
    this.scrollTo(keep);
  }

  setTool(tool: DrawTool | null) {
    if (tool !== this.tool) {
      this.finishWriting();
    }
    this.tool = tool;
    this.root.classList.toggle("drawing", tool !== null);
    this.root.dataset.tool = tool ?? "";
  }

  /** Zoom to a level, or to fit the width or the whole page. */
  setZoom(z: number | "width" | "page") {
    this.fit = typeof z === "number" ? null : z;
    this.applyZoom(typeof z === "number" ? z : this.fitZoom(z));
  }

  zoomBy(direction: 1 | -1) {
    const next =
      direction > 0
        ? ZOOM_STEPS.find((s) => s > this.zoom + 0.001)
        : ZOOM_STEPS.toReversed().find((s) => s < this.zoom - 0.001);
    this.setZoom(next ?? this.zoom);
  }

  private fitZoom(fit: "width" | "page"): number {
    const width = Math.max(1, this.root.clientWidth - 2 * GAP);
    const heightAvail = Math.max(1, this.root.clientHeight - 2 * GAP);
    const widest = Math.max(1, ...this.pages.map((p) => p.w));
    const page = this.pages[this.current] ?? this.pages[0];
    const byWidth = width / (widest * PX_PER_PT);
    if (fit === "width") {
      return Math.min(4, byWidth);
    }
    return Math.min(4, byWidth, heightAvail / ((page?.h ?? 1) * PX_PER_PT));
  }

  private applyZoom(z: number) {
    const keep = this.current;
    this.zoom = Math.max(0.1, Math.min(6, z));
    if (this.mode === "pages") {
      for (const s of this.slots) {
        this.sizeSlot(s);
      }
      this.scrollTo(keep);
      this.refreshVisible();
    }
    this.root.dispatchEvent(new CustomEvent("zoomchange"));
  }

  /** Drop every rendering kept: the documents they were made from are gone (the worker was restarted). */
  forget() {
    for (const bitmap of this.cache.values()) {
      bitmap.close();
    }
    this.cache.clear();
  }

  /**
   * Let the user type on page `page` from `at` (where the text's top left
   * goes, in display space), in `color` at `size` points. Resolves with
   * what was typed ("" for nothing) once they click away, press Escape or
   * Mod+Enter, or the pages are shown anew. Enter starts a new line.
   */
  write(
    page: number,
    at: Point,
    style: { color: string; size: number; opacity: number }
  ): Promise<string> {
    this.finishWriting();
    const s = this.slots[page];
    const sheet = s?.canvas.parentElement;
    if (!(s?.svg && sheet)) {
      return Promise.resolve("");
    }
    const field = el("textarea", {
      attrs: {
        "aria-label": `Text on page ${s.page.label}`,
        rows: "1",
        wrap: "off",
      },
      class: "writing",
    });
    Object.assign(field.style, {
      color: style.color,
      font: `400 calc(${style.size} * var(--pt)) / ${TEXT_LINE} ${WRITING_FONT}`,
      left: `${(at[0] / s.page.w) * 100}%`,
      marginTop: `${TEXT_BASELINE - cssBaseline()}em`,
      opacity: String(style.opacity),
      top: `${(at[1] / s.page.h) * 100}%`,
    });
    // As big as what is typed, in ems: the page shows around it, and it follows the zoom.
    const fit = () => {
      field.style.width = "0";
      field.style.height = "0";
      const em = style.size * this.zoom * PX_PER_PT;
      field.style.width = `${(field.scrollWidth + 2) / em}em`;
      field.style.height = `${field.scrollHeight / em}em`;
    };
    return this.typeIn(sheet, field, fit);
  }

  /**
   * Let the user write a note on page `page`, its icon's top left at `at`:
   * a box beside the icon, in a tint of `color`, holding `text` to start
   * with. Resolves with what it says once they are done, as `write` does.
   */
  note(page: number, at: Point, style: { color: string; text: string }) {
    this.finishWriting();
    const s = this.slots[page];
    const sheet = s?.canvas.parentElement;
    if (!(s?.svg && sheet)) {
      return Promise.resolve("");
    }
    const field = el("textarea", {
      attrs: {
        "aria-label": `Note on page ${s.page.label}`,
        placeholder: "Write the note",
        rows: "1",
      },
      class: "note-writing",
    });
    field.value = style.text;
    // Beside the icon, or before it when there is no room after it; in % of the page, so it follows the zoom.
    const k = this.zoom * PX_PER_PT;
    const iconEnd = ((at[0] + NOTE_ICON) / s.page.w) * 100;
    const roomAfter =
      (at[0] + NOTE_ICON) * k + NOTE_GAP + NOTE_WIDTH <= s.page.w * k;
    Object.assign(field.style, {
      background: `color-mix(in srgb, ${style.color} 22%, #fff)`,
      left: roomAfter
        ? `calc(${iconEnd}% + ${NOTE_GAP}px)`
        : `max(0px, calc(${(at[0] / s.page.w) * 100}% - ${NOTE_GAP + NOTE_WIDTH}px))`,
      top: `${(at[1] / s.page.h) * 100}%`,
      width: `${NOTE_WIDTH}px`,
    });
    const fit = () => {
      field.style.height = "0";
      field.style.height = `${field.scrollHeight + 2}px`;
    };
    const typed = this.typeIn(sheet, field, fit);
    field.setSelectionRange(field.value.length, field.value.length);
    return typed;
  }

  /**
   * Put `field` over a page for the user to type in, and focus it. Resolves
   * with what they typed once they click away, press Escape or Mod+Enter,
   * or the pages are shown anew; Enter starts a new line.
   */
  private typeIn(
    sheet: HTMLElement,
    field: HTMLTextAreaElement,
    fit: () => void
  ): Promise<string> {
    const { promise, resolve } = Promise.withResolvers<string>();
    const done = () => {
      if (this.writing !== done) {
        return;
      }
      this.writing = null;
      const typing = document.activeElement === field;
      field.remove();
      // Focus back in the Viewer, where the Tool's keys are heard.
      if (typing) {
        this.root.focus({ preventScroll: true });
      }
      resolve(field.value.trimEnd());
    };
    field.addEventListener("input", fit);
    field.addEventListener("blur", done);
    field.addEventListener("keydown", (e) => {
      const finish =
        e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey));
      if (finish) {
        e.preventDefault();
        e.stopPropagation();
        done();
      }
    });
    this.writing = done;
    sheet.append(field);
    fit();
    field.focus({ preventScroll: true });
    return promise;
  }

  /** End the typing going on, keeping what was typed. */
  finishWriting() {
    this.writing?.();
  }

  /** Redraw the overlays only: marks changed. */
  refreshMarks() {
    for (const s of this.slots) {
      if (s.svg) {
        this.drawMarks(s);
      }
    }
  }

  scrollTo(page: number) {
    const s = this.slots[page];
    if (!s) {
      return;
    }
    this.current = page;
    this.root.scrollTop = s.root.offsetTop - GAP;
  }

  /** Bring a point of a page into view, for a search hit. */
  reveal(page: number, y: number) {
    const s = this.slots[page];
    if (!s || this.mode !== "pages") {
      this.scrollTo(page);
      return;
    }
    const k = this.zoom * PX_PER_PT;
    const top = s.root.offsetTop + y * k - this.root.clientHeight / 3;
    this.root.scrollTop = Math.max(0, top);
  }

  /* ---------------- building ---------------- */

  private build() {
    this.finishWriting();
    // A rebuild must not drop the keyboard focus out of the Tool (where Undo listens).
    const hadFocus = this.root.contains(document.activeElement);
    this.generation += 1;
    this.observer.disconnect();
    this.queue = [];
    this.root.replaceChildren();
    this.root.className = `viewer-body mode-${this.mode}`;
    this.setTool(this.tool);
    if (this.mode === "pages" && this.fit) {
      this.zoom = this.fitZoom(this.fit);
    }
    const list = el("div", {
      attrs:
        this.mode === "grid"
          ? {
              "aria-label": "Pages",
              "aria-multiselectable": "true",
              role: "listbox",
            }
          : {},
      class: this.mode === "grid" ? "grid" : "column",
    });
    this.slots = this.pages.map((page, at) =>
      this.mode === "grid" ? this.thumb(page, at) : this.pageSlot(page, at)
    );
    list.append(...this.slots.map((s) => s.root));
    this.root.append(list);
    for (const s of this.slots) {
      this.observer.observe(s.root);
    }
    this.syncSelection();
    if (hadFocus) {
      if (this.mode === "grid" && this.slots.length) {
        this.focusThumb(Math.min(this.current, this.slots.length - 1));
      } else {
        this.root.focus({ preventScroll: true });
      }
    }
  }

  private thumb(page: ViewPage, at: number): Slot {
    const canvas = el("canvas");
    const frame = el("div", { class: "frame" }, canvas);
    const s = Math.min(THUMB_W / page.w, THUMB_H / page.h);
    canvas.style.width = `${Math.round(page.w * s)}px`;
    canvas.style.height = `${Math.round(page.h * s)}px`;
    const cap = el(
      "div",
      { class: "cap" },
      el("span", { class: "num", text: page.label })
    );
    if (page.tag !== null) {
      cap.prepend(
        el("span", {
          attrs: { "aria-hidden": "true" },
          class: `tag tag-${page.tag % 6}`,
        })
      );
    }
    const root = el(
      "div",
      {
        attrs: {
          "aria-label": `Page ${page.label}`,
          "aria-selected": "false",
          "data-key": page.key,
          role: "option",
          tabindex: at === 0 ? "0" : "-1",
        },
        class: "thumb",
      },
      frame,
      cap
    );
    const { edit } = this.host;
    if (edit) {
      root.draggable = true;
      const actions = el("div", { class: "thumb-actions" });
      const rot = el("button", {
        attrs: {
          "aria-label": `Turn page ${page.label}`,
          tabindex: "-1",
          type: "button",
        },
        class: "inline",
        text: "↻",
        title: "Turn clockwise",
      });
      rot.addEventListener("click", (e) => {
        e.stopPropagation();
        edit.rotate(page.key);
      });
      const del = el("button", {
        attrs: {
          "aria-label": `Delete page ${page.label}`,
          tabindex: "-1",
          type: "button",
        },
        class: "inline",
        text: "×",
        title: "Delete",
      });
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        edit.remove([page.key]);
      });
      actions.append(rot, del);
      root.append(actions);
      this.dragHandlers(root, page, at);
    }
    root.addEventListener("click", (e) => this.click(page, at, e));
    root.addEventListener("dblclick", () => {
      this.current = at;
      this.setMode("pages");
      this.root.dispatchEvent(new CustomEvent("modechange"));
    });
    return {
      at,
      blend: null,
      canvas,
      drawn: 0,
      page,
      root,
      svg: null,
      visible: false,
    };
  }

  private pageSlot(page: ViewPage, at: number): Slot {
    const canvas = el("canvas");
    const layer = (className: string) =>
      svgEl("svg", {
        "aria-hidden": "true",
        class: className,
        preserveAspectRatio: "none",
        viewBox: `0 0 ${page.w} ${page.h}`,
      });
    const blend = layer("blend");
    const svg = layer("overlay");
    const sheet = el("div", { class: "sheet" }, canvas);
    sheet.append(blend, svg);
    const root = el(
      "div",
      { attrs: { "data-key": page.key }, class: "page" },
      sheet,
      el("div", { class: "page-label", text: page.label })
    );
    const slot: Slot = {
      at,
      blend,
      canvas,
      drawn: 0,
      page,
      root,
      svg,
      visible: false,
    };
    this.sizeSlot(slot);
    this.pointerHandlers(slot);
    this.drawMarks(slot);
    return slot;
  }

  private sizeSlot(s: Slot) {
    if (!s.svg) {
      return;
    }
    const k = this.zoom * PX_PER_PT;
    const sheet = s.canvas.parentElement;
    if (sheet) {
      sheet.style.width = `${Math.round(s.page.w * k)}px`;
      sheet.style.height = `${Math.round(s.page.h * k)}px`;
      // A point, on screen: what is typed on the page is sized by it.
      sheet.style.setProperty("--pt", `${k}px`);
    }
  }

  /* ---------------- rendering ---------------- */

  private scaleFor(s: Slot): number {
    const dpr = window.devicePixelRatio || 1;
    if (!s.svg) {
      return Math.min(THUMB_W / s.page.w, THUMB_H / s.page.h) * dpr;
    }
    // Rendered at a step at least the zoom, so small zoom changes reuse the rendering.
    return Math.ceil(this.zoom * PX_PER_PT * dpr * 4) / 4;
  }

  private want(s: Slot) {
    if (s.drawn === this.scaleFor(s) || this.queue.includes(s)) {
      return;
    }
    this.queue.push(s);
    void this.pump();
  }

  private refreshVisible() {
    for (const s of this.slots) {
      if (s.visible) {
        this.want(s);
      }
    }
  }

  private async pump() {
    if (this.busy) {
      return;
    }
    this.busy = true;
    const gen = this.generation;
    try {
      while (this.queue.length && gen === this.generation) {
        // Pages on screen first, nearest the current page first.
        this.queue.sort(
          (a, b) =>
            Number(b.visible) - Number(a.visible) ||
            Math.abs(a.at - this.current) - Math.abs(b.at - this.current)
        );
        const s = this.queue.shift();
        if (!s?.visible) {
          continue;
        }
        await this.draw(s);
      }
    } finally {
      this.busy = false;
    }
    if (gen !== this.generation && this.queue.length) {
      void this.pump();
    }
  }

  private async draw(s: Slot) {
    const scale = this.scaleFor(s);
    const { page } = s;
    // The rendering is of the unturned page: its size before `rotate`.
    const turned = page.rotate % 180 !== 0;
    const key = `${page.doc}:${page.index}:${scale}`;
    let bitmap = this.cache.get(key);
    if (!bitmap) {
      let r: Rendered;
      try {
        r = await this.host.render(page.doc, page.index, scale);
      } catch {
        return;
      }
      bitmap = await createImageBitmap(
        new ImageData(r.pixels, r.width, r.height)
      );
      this.cache.set(key, bitmap);
      while (this.cache.size > CACHE_LIMIT) {
        const [oldest] = this.cache.keys();
        if (oldest === undefined) {
          break;
        }
        this.cache.get(oldest)?.close();
        this.cache.delete(oldest);
      }
    }
    const w = turned ? bitmap.height : bitmap.width;
    const h = turned ? bitmap.width : bitmap.height;
    s.canvas.width = w;
    s.canvas.height = h;
    const ctx = s.canvas.getContext("2d");
    if (!ctx) {
      return;
    }
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.rotate((page.rotate * Math.PI) / 180);
    ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
    ctx.restore();
    s.drawn = scale;
  }

  /* ---------------- the grid's selection and moves ---------------- */

  private syncSelection() {
    for (const s of this.slots) {
      const on = this.selected.has(s.page.key);
      s.root.classList.toggle("selected", on);
      if (this.mode === "grid") {
        s.root.setAttribute("aria-selected", String(on));
      }
    }
  }

  select(keys: Set<string>) {
    this.selected = new Set(keys);
    this.syncSelection();
    this.host.edit?.selectionChanged(this.selection);
  }

  private click(page: ViewPage, at: number, e: MouseEvent) {
    this.current = at;
    this.host.currentChanged(at);
    if (!this.host.edit) {
      return;
    }
    const next = new Set(this.selected);
    if (e.shiftKey && this.anchor) {
      const from = this.pages.findIndex((p) => p.key === this.anchor);
      const [lo, hi] = from < at ? [from, at] : [at, from];
      for (let i = lo; i <= hi; i += 1) {
        next.add(this.pages[i]?.key ?? "");
      }
    } else if (e.metaKey || e.ctrlKey) {
      if (next.has(page.key)) {
        next.delete(page.key);
      } else {
        next.add(page.key);
      }
      this.anchor = page.key;
    } else {
      next.clear();
      next.add(page.key);
      this.anchor = page.key;
    }
    this.select(next);
    this.focusThumb(at);
  }

  private focusThumb(at: number) {
    for (const [i, s] of this.slots.entries()) {
      s.root.tabIndex = i === at ? 0 : -1;
    }
    this.slots[at]?.root.focus({ preventScroll: false });
  }

  private dragHandlers(root: HTMLElement, page: ViewPage, at: number) {
    root.addEventListener("dragstart", (e) => {
      const keys = this.selected.has(page.key)
        ? this.pages.filter((p) => this.selected.has(p.key)).map((p) => p.key)
        : [page.key];
      e.dataTransfer?.setData(DRAG_TYPE, JSON.stringify(keys));
      // Firefox starts a drag only with some data set.
      e.dataTransfer?.setData("text/plain", keys.join(","));
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
      }
      root.classList.add("dragging");
    });
    root.addEventListener("dragend", () => {
      root.classList.remove("dragging");
      this.clearDropMarks();
    });
    root.addEventListener("dragover", (e) => {
      if (!e.dataTransfer?.types.includes(DRAG_TYPE)) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const box = root.getBoundingClientRect();
      const after = e.clientX > box.left + box.width / 2;
      this.clearDropMarks();
      root.classList.add(after ? "drop-after" : "drop-before");
    });
    root.addEventListener("drop", (e) => {
      const raw = e.dataTransfer?.getData(DRAG_TYPE);
      if (!raw) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const box = root.getBoundingClientRect();
      const after = e.clientX > box.left + box.width / 2;
      this.clearDropMarks();
      this.host.edit?.move(JSON.parse(raw) as string[], after ? at + 1 : at);
    });
  }

  private clearDropMarks() {
    for (const s of this.slots) {
      s.root.classList.remove("drop-before", "drop-after");
    }
  }

  /** Thumbnails per row, for moving by row with the arrow keys. */
  private columns(): number {
    const [first] = this.slots;
    if (!first) {
      return 1;
    }
    const top = first.root.offsetTop;
    let n = 0;
    while (this.slots[n] && this.slots[n]?.root.offsetTop === top) {
      n += 1;
    }
    return Math.max(1, n);
  }

  private key(e: KeyboardEvent) {
    if (
      this.mode !== "grid" ||
      !this.host.edit ||
      !(e.target as HTMLElement).classList.contains("thumb")
    ) {
      return;
    }
    const at = this.slots.findIndex((s) => s.root === e.target);
    const page = this.pages[at];
    if (!page) {
      return;
    }
    const cols = this.columns();
    const step: Record<string, number> = {
      ArrowDown: cols,
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -cols,
      End: this.slots.length,
      Home: -this.slots.length,
    };
    const delta = step[e.key];
    if (delta !== undefined) {
      e.preventDefault();
      const to = Math.max(0, Math.min(this.slots.length - 1, at + delta));
      if (e.altKey) {
        // Move the selection (or this page) by one place.
        const keys = this.selected.has(page.key)
          ? [...this.selected]
          : [page.key];
        this.host.edit.move(keys, delta > 0 ? to + 1 : to);
        return;
      }
      if (e.shiftKey) {
        this.click(
          this.pages[to] ?? page,
          to,
          new MouseEvent("click", { shiftKey: true })
        );
      } else {
        this.current = to;
        this.focusThumb(to);
      }
      return;
    }
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      this.click(page, at, new MouseEvent("click", { ctrlKey: true }));
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      this.host.edit.remove(
        this.selected.size ? [...this.selected] : [page.key]
      );
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      this.select(new Set(this.pages.map((p) => p.key)));
    }
  }

  /** Put focus back in the grid at the current page, after a move rebuilt it. */
  focusCurrent() {
    if (this.mode === "grid") {
      this.focusThumb(Math.min(this.current, this.slots.length - 1));
    }
  }

  /* ---------------- the column: current page and drawing ---------------- */

  private trackCurrent() {
    if (this.mode !== "pages") {
      return;
    }
    const mid = this.root.scrollTop + this.root.clientHeight / 3;
    let best = 0;
    for (const s of this.slots) {
      if (s.root.offsetTop <= mid) {
        best = s.at;
      }
    }
    if (best !== this.current) {
      this.current = best;
      this.host.currentChanged(best);
    }
  }

  private pointerHandlers(s: Slot) {
    const { svg } = s;
    if (!svg) {
      return;
    }
    let drag: { from: Point; points: Point[] } | null = null;
    const emit = (to: Point, done: boolean) => {
      if (!drag || !this.tool) {
        return;
      }
      this.host.gesture({
        done,
        from: drag.from,
        page: s.at,
        points: drag.points,
        to,
        tool: this.tool,
      });
    };
    svg.addEventListener("pointerdown", (e) => {
      if (!this.tool || e.button !== 0) {
        return;
      }
      e.preventDefault();
      // A click away from what is being typed ends it, and starts nothing.
      if (this.writing) {
        this.finishWriting();
        return;
      }
      svg.setPointerCapture(e.pointerId);
      const p = toPage(s, e);
      drag = { from: p, points: [p] };
      if (this.tool === "point" || this.tool === "write") {
        emit(p, true);
        drag = null;
      }
    });
    svg.addEventListener("pointermove", (e) => {
      if (!drag) {
        return;
      }
      const p = toPage(s, e);
      drag.points.push(p);
      emit(p, false);
    });
    const finish = (e: PointerEvent) => {
      if (!drag) {
        return;
      }
      const p = toPage(s, e);
      drag.points.push(p);
      emit(p, true);
      drag = null;
    };
    svg.addEventListener("pointerup", finish);
    svg.addEventListener("pointercancel", () => {
      drag = null;
      this.drawMarks(s);
    });
  }

  private drawMarks(s: Slot) {
    const { blend, svg } = s;
    if (!(svg && blend)) {
      return;
    }
    svg.replaceChildren();
    blend.replaceChildren();
    for (const m of this.host.marks(s.at)) {
      const blended = m.kind === "markup" && m.markup === "highlight";
      (blended ? blend : svg).append(markNode(m));
    }
  }

  /** Redraw one page's overlay: a drag in progress, or a hit moved. */
  redrawPage(page: number) {
    const s = this.slots[page];
    if (s) {
      this.drawMarks(s);
    }
  }
}
