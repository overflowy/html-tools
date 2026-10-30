// The Viewer: pages as a grid of thumbnails (where the Page List is
// organized: selected, dragged, turned, deleted) or as a column of pages
// at a zoom (where the user reads, searches, and places things). Pages are
// rendered by the worker as they scroll into view, the visible ones first.
//
// Over each page in the column sits an SVG in the page's display space,
// in points: what is drawn there (search hits, boxes, notes, strokes) is
// in the same coordinates the Operations take, so nothing is converted on
// the way.

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
      style: "redact" | "crop" | "field" | "box" | "stamp";
      label?: string;
    }
  | {
      kind: "quads";
      quads: Quad[];
      style: "hit" | "current" | "select" | "markup";
      color?: string;
    }
  | { kind: "ink"; strokes: Point[][]; color: string; width: number }
  | {
      kind: "line";
      a: Point;
      b: Point;
      color: string;
      width: number;
      arrow: boolean;
    }
  | { kind: "note"; at: Point; color: string };

export type DrawTool = "rect" | "text" | "ink" | "line" | "point";

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

/** The SVG for one mark. */
const markNode = (m: Mark): SVGElement => {
  switch (m.kind) {
    case "rect": {
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
    }
    case "quads": {
      const g = svgEl("g", { class: `mark mark-${m.style}` });
      for (const q of m.quads) {
        const poly = svgEl("polygon", { points: quadPoints(q) });
        if (m.color) {
          poly.style.fill = m.color;
        }
        g.append(poly);
      }
      return g;
    }
    case "ink": {
      const g = svgEl("g", { class: "mark mark-ink" });
      for (const stroke of m.strokes) {
        g.append(
          svgEl("polyline", {
            fill: "none",
            points: stroke.map((p) => p.join(",")).join(" "),
            stroke: m.color,
            "stroke-linecap": "round",
            "stroke-linejoin": "round",
            "stroke-width": m.width,
          })
        );
      }
      return g;
    }
    case "line": {
      const g = svgEl("g", { class: "mark mark-line" });
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
            points: [wing(0.5), m.b, wing(-0.5)]
              .map((p) => p.join(","))
              .join(" "),
            stroke: m.color,
            "stroke-width": m.width,
          })
        );
      }
      return g;
    }
    default: {
      const g = svgEl("g", { class: "mark mark-note" });
      g.append(
        svgEl("rect", {
          fill: m.color,
          height: 18,
          rx: 2,
          width: 18,
          x: m.at[0],
          y: m.at[1],
        })
      );
      return g;
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
    return { at, canvas, drawn: 0, page, root, svg: null, visible: false };
  }

  private pageSlot(page: ViewPage, at: number): Slot {
    const canvas = el("canvas");
    const svg = svgEl("svg", {
      "aria-hidden": "true",
      class: "overlay",
      preserveAspectRatio: "none",
      viewBox: `0 0 ${page.w} ${page.h}`,
    });
    const sheet = el("div", { class: "sheet" }, canvas);
    sheet.append(svg);
    const root = el(
      "div",
      { attrs: { "data-key": page.key }, class: "page" },
      sheet,
      el("div", { class: "page-label", text: page.label })
    );
    const slot: Slot = {
      at,
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
      svg.setPointerCapture(e.pointerId);
      const p = toPage(s, e);
      drag = { from: p, points: [p] };
      if (this.tool === "point") {
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
    const { svg } = s;
    if (!svg) {
      return;
    }
    svg.replaceChildren();
    for (const m of this.host.marks(s.at)) {
      svg.append(markNode(m));
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
