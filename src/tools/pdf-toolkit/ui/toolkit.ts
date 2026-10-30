// The PDF Toolkit on screen: the Workspace (its Sources and Page List, with
// Undo), the worker that holds and changes the documents, the Viewer, the
// panel of the Operation chosen, search, and the Deep Link.

import ICON_NEXT from "lucide-static/icons/chevron-down.svg";
import ICON_PREV from "lucide-static/icons/chevron-up.svg";
import ICON_MINUS from "lucide-static/icons/minus.svg";
import ICON_PLUS from "lucide-static/icons/plus.svg";
import ICON_REDO from "lucide-static/icons/redo-2.svg";
import ICON_UNDO from "lucide-static/icons/undo-2.svg";

import { readDrop, readInput } from "../../../shared/dropped-files";
import type { ToolContext } from "../../../shell/types";
import {
  ENGINES,
  cacheAvailable,
  cachedFamilies,
  clearCached,
  getEngine,
  listCached,
} from "../engines";
import type { Progress } from "../engines";
import type { OpName, OpOptions } from "../ops";
import type { OutFile } from "../pdf/doc";
import type { Quad } from "../pdf/text";
import type { OpenResult, Original, PageSize, RunResult } from "../worker";
import { CANCELLED, PdfWorker } from "../worker-client";
import type {
  Api,
  Current,
  PageEntry,
  PanelDef,
  PanelInstance,
  Ran,
} from "./api";
import {
  count,
  download,
  el,
  formatBytes,
  iconButton,
  message,
  pdfBlob,
  quietly,
  stem,
} from "./dom";
import { decodeValues, encodeValues, unshareable } from "./form";
import type { Values } from "./form";
import { kindOf, mupdfImage } from "./intake";
import { MARKUP, grab } from "./markup";
import type { Elements } from "./markup";
import { COMPARE_PANELS } from "./panels/compare";
import { FORM_PANELS } from "./panels/forms";
import { INSPECT_PANELS } from "./panels/inspect";
import { LAYOUT_PANELS } from "./panels/layout";
import { OCR_PANELS } from "./panels/ocr";
import { PAGE_PANELS, imageOptions } from "./panels/pages";
import { SECURITY_PANELS } from "./panels/security";
import { STAMP_PANELS } from "./panels/stamp";
import { Viewer } from "./viewer";
import type { DrawTool, Gesture, Mark, ViewPage } from "./viewer";
import { zip } from "./zip";

const PANELS: PanelDef[] = [
  ...PAGE_PANELS,
  ...LAYOUT_PANELS,
  ...STAMP_PANELS,
  ...FORM_PANELS,
  ...SECURITY_PANELS,
  ...INSPECT_PANELS,
  ...COMPARE_PANELS,
  ...OCR_PANELS,
];
const DEFAULT_PANEL = "organize";
/** Steps of the Page List kept for Undo. */
const HISTORY = 50;

interface Source {
  key: string;
  name: string;
  /** What the worker holds: decrypted, converted. Kept to hand a restarted worker. */
  bytes: Uint8Array;
  /** The file as opened, when it was encrypted: its signatures are checked against it. */
  original: Original | null;
  pages: PageSize[];
  /** Its id in the worker; "" when the worker that runs now does not have it. */
  workerId: string;
}

interface Phase {
  text: string;
  fraction: number | null;
}

interface RunOptions {
  quiet?: boolean;
  /** A run of the panel's own supersedes its last; a search runs beside them. */
  own?: boolean;
}

const panelById = (id: string): PanelDef | undefined =>
  PANELS.find((p) => p.id === id) ?? PANELS.find((p) => p.id === DEFAULT_PANEL);

/** One file as it is; several in a zip named `zipName`. */
const downloadFiles = async (files: OutFile[], zipName: string) => {
  const [only] = files;
  if (files.length === 1 && only) {
    download(
      new Blob([only.bytes as Uint8Array<ArrayBuffer>], { type: only.mime }),
      only.name
    );
    return;
  }
  const blob = await zip(
    files.map((f) => ({
      bytes: f.bytes as Uint8Array<ArrayBuffer>,
      name: f.name,
    }))
  );
  download(blob, zipName.endsWith(".zip") ? zipName : `${zipName}.zip`);
};

export class Toolkit {
  private readonly root: HTMLElement;
  private readonly ctx: ToolContext;
  private readonly ui: Elements;
  private readonly viewer: Viewer;
  private readonly api: Api;
  private readonly undoBtn: HTMLButtonElement;
  private readonly redoBtn: HTMLButtonElement;

  private readonly sources = new Map<string, Source>();
  private pages: PageEntry[] = [];
  private past: PageEntry[][] = [];
  private future: PageEntry[][] = [];
  private seq = 0;
  /** The Result on screen, if any, and whether it or the Workspace is shown. */
  private result: RunResult | null = null;
  private showing: "workspace" | "result" = "workspace";
  /** Result documents the worker holds that nobody has applied: closed when replaced. */
  private readonly unapplied = new Set<string>();
  private current: { sig: string; doc: Current } | null = null;
  private worker: PdfWorker | null = null;
  private starting: Promise<PdfWorker> | null = null;
  /** The worker being started, for Cancel to stop. */
  private spawning: PdfWorker | null = null;
  /** Workers started: each names its documents apart from the last one's. */
  private generation = 0;
  /** Cancels so far: a worker still starting when one comes is not used. */
  private cancels = 0;
  private busy = false;
  /** Files being opened (a password prompt lets the user work meanwhile): their Sources are not in the Page List yet. */
  private opening = 0;
  /** What Cancel stops besides the worker: OCR in the main thread. */
  private readonly cancelHooks = new Set<() => void>();
  private runSeq = 0;

  private panel: PanelInstance | null = null;
  private panelDef: PanelDef | null = null;
  private panelValues: Values = {};
  /** What Compare shows in place of the pages. */
  private takenOver: HTMLElement | null = null;
  private panelMarks: ((page: number) => Mark[]) | null = null;
  private onGesture: ((g: Gesture) => void) | null = null;
  private hits: { page: number; quads: Quad[] }[] = [];
  private hitAt = -1;
  private dragDepth = 0;

  /** The Toolkit, built into `root`: it lives as long as the page, as the Shell mounts a Tool once. */
  static mount(root: HTMLElement, ctx: ToolContext): Toolkit {
    return new Toolkit(root, ctx);
  }

  private constructor(root: HTMLElement, ctx: ToolContext) {
    this.root = root;
    this.ctx = ctx;
    root.innerHTML = MARKUP;
    this.ui = grab(root);
    this.undoBtn = iconButton(ICON_UNDO, "Undo", () => this.undo());
    this.redoBtn = iconButton(ICON_REDO, "Redo", () => this.redo());
    this.ui.undoSlot.replaceWith(this.undoBtn, this.redoBtn);
    this.viewer = new Viewer({
      currentChanged: (page) => {
        this.ui.pageNo.value = String(page + 1);
      },
      edit: {
        move: (keys, before) => this.move(keys, before),
        remove: (keys) => {
          const gone = new Set(keys);
          this.commit(
            this.pages.filter((p) => !gone.has(p.key)),
            `Deleted ${count(gone.size, "page", "pages")}. Undo brings ${gone.size === 1 ? "it" : "them"} back.`
          );
        },
        rotate: (key) => {
          this.commit(
            this.pages.map((p) =>
              p.key === key ? { ...p, rotate: (p.rotate + 90) % 360 } : p
            ),
            ""
          );
        },
        selectionChanged: () => this.panel?.selectionChanged?.(),
      },
      gesture: (g) => this.onGesture?.(g),
      marks: (page) =>
        this.showing === "result"
          ? []
          : [...this.searchMarks(page), ...(this.panelMarks?.(page) ?? [])],
      render: async (doc, index, scale) => {
        const w = await this.ensureWorker();
        return w.call("render", [doc, index, scale]);
      },
    });
    this.ui.viewerSlot.replaceWith(this.viewer.root);
    this.api = this.makeApi();
    this.wireToolbar();
    this.wireViewer();
    this.wireSearch();
    this.wirePanels();
    this.wireDrops();
    this.wireKeys();
    ctx.onRestore((payload) => this.restore(payload));
    this.panelDef = panelById(DEFAULT_PANEL) ?? null;
    this.ui.panelSelect.value = DEFAULT_PANEL;
    this.panelValues = { ...this.panelDef?.defaults };
    this.syncToolbar();
    this.refreshView();
    void this.renderEngines();
  }

  /* ---------------- messages and progress ---------------- */

  private setPhase(p: Phase) {
    this.ui.phase.textContent = p.text;
    this.ui.bar.classList.toggle("busy", p.fraction === null);
    this.ui.fill.style.width =
      p.fraction === null
        ? ""
        : `${Math.round(Math.max(0, Math.min(1, p.fraction)) * 100)}%`;
  }

  private showNote(text: string) {
    this.ui.noteText.textContent = text;
    this.ui.note.classList.toggle("on", text !== "");
  }

  private showError(text: string) {
    this.ui.errorBox.textContent = text;
    this.ui.errorBox.classList.toggle("on", text !== "");
  }

  private clearMessages() {
    this.showNote("");
    this.showError("");
  }

  private setBusy(on: boolean, text = "") {
    this.busy = on;
    this.root.classList.toggle("busy", on);
    this.ui.progress.classList.toggle("on", on);
    if (on) {
      this.setPhase({ fraction: null, text });
    } else {
      void this.renderEngines();
    }
  }

  /* ---------------- engines ---------------- */

  private async renderEngines() {
    const { enginesText, enginesClear } = this.ui;
    if (!(await cacheAvailable())) {
      enginesText.textContent =
        "Engines cannot be kept here (no IndexedDB); they download on every visit.";
      enginesClear.hidden = true;
      return;
    }
    const rows = await listCached();
    if (rows.length === 0) {
      enginesText.textContent = "No engines cached";
      enginesClear.hidden = true;
      return;
    }
    let total = 0;
    for (const r of rows) {
      total += r.bytes;
    }
    enginesText.textContent = `Engines cached: ${formatBytes(total)}`;
    enginesText.title = cachedFamilies(rows)
      .map((f) => `${f.label} ${formatBytes(f.bytes)}`)
      .join("\n");
    enginesClear.hidden = false;
  }

  /** Progress of the engines' download, all files as one. */
  private downloadReporter() {
    const seen = new Map<string, Progress>();
    return (p: Progress) => {
      seen.set(p.asset.id, p);
      const fetching = [...seen.values()].filter((x) => !x.fromCache);
      if (!fetching.length || !this.busy) {
        return;
      }
      let loaded = 0;
      let total = 0;
      for (const x of fetching) {
        loaded += x.loaded;
        total += x.total;
      }
      this.setPhase({
        fraction: total ? loaded / total : null,
        text: `Downloading MuPDF and qpdf (${formatBytes(loaded)} of ${formatBytes(total)})`,
      });
    };
  }

  private async startWorker(): Promise<PdfWorker> {
    const { cancels } = this;
    const report = this.downloadReporter();
    const [lib, glue, wasm, qGlue, qWasm] = await Promise.all([
      getEngine(ENGINES.mupdfLib, report),
      getEngine(ENGINES.mupdfGlue, report),
      getEngine(ENGINES.mupdfWasm, report),
      getEngine(ENGINES.qpdfGlue, report),
      getEngine(ENGINES.qpdfWasm, report),
    ]);
    // Cancelled while downloading: the files stay cached, but nothing starts.
    if (cancels !== this.cancels) {
      throw new Error(CANCELLED);
    }
    if (this.busy) {
      this.setPhase({ fraction: null, text: "Starting MuPDF and qpdf" });
    }
    this.generation += 1;
    const w = new PdfWorker();
    this.spawning = w;
    const text = (b: ArrayBuffer) => new TextDecoder().decode(b);
    // Copies: the cache's buffers must survive for the next worker.
    const mupdfWasm = structuredClone(wasm);
    const qpdfWasm = structuredClone(qWasm);
    try {
      await w.call(
        "load",
        [
          {
            mupdfGlue: text(glue),
            mupdfLib: text(lib),
            mupdfWasm,
            qpdfGlue: text(qGlue),
            qpdfWasm,
          },
          this.generation,
        ],
        [mupdfWasm, qpdfWasm]
      );
      // A worker started again (after Cancel, or a crash) gets every Source back, under new ids.
      for (const s of this.sources.values()) {
        const copy = new Uint8Array(s.bytes);
        const info = await w.call(
          "adopt",
          [copy, s.name, s.original],
          [copy.buffer]
        );
        s.workerId = info.id;
      }
    } catch (error) {
      w.terminate();
      throw error;
    } finally {
      if (this.spawning === w) {
        this.spawning = null;
      }
    }
    this.current = null;
    this.worker = w;
    if (this.generation > 1) {
      // Whatever named the last worker's documents went with it.
      this.unapplied.clear();
      this.viewer.forget();
      if (this.result) {
        this.result = null;
        this.showing = "workspace";
      }
      // The pages on screen name the old ids: shown again, they render from the new ones.
      queueMicrotask(() => this.refreshView());
    }
    return w;
  }

  /** The worker, with both engines started and every Source handed to it. */
  private async ensureWorker(): Promise<PdfWorker> {
    if (this.worker?.alive) {
      return this.worker;
    }
    this.starting ??= this.startWorker();
    const { starting } = this;
    try {
      return await starting;
    } finally {
      // Cancel may have dropped it and another start begun since.
      if (this.starting === starting) {
        this.starting = null;
      }
    }
  }

  /** Stop whatever runs: the worker is thrown away (or not started) and a fresh one gets the Sources back. */
  private cancel() {
    for (const hook of this.cancelHooks) {
      hook();
    }
    this.cancels += 1;
    this.runSeq += 1;
    this.spawning?.terminate();
    this.starting = null;
    this.worker?.terminate();
    this.worker = null;
    this.current = null;
    this.unapplied.clear();
    if (this.result) {
      this.result = null;
      this.showing = "workspace";
      this.refreshView();
    }
    this.setBusy(false);
    this.showNote("Cancelled.");
  }

  /* ---------------- the Page List ---------------- */

  private newKey() {
    this.seq += 1;
    return `k${this.seq}`;
  }

  private sourceOf(key: string): Source {
    const s = this.sources.get(key);
    if (!s) {
      throw new Error(`No Source ${key}.`);
    }
    return s;
  }

  private sizeOf(p: PageEntry): PageSize {
    const size = this.sourceOf(p.src).pages[p.index] ?? { h: 842, w: 595 };
    return p.rotate % 180 === 0 ? size : { h: size.w, w: size.h };
  }

  private firstName() {
    const [first] = this.pages;
    return first ? stem(this.sourceOf(first.src).name) : "document";
  }

  private signature() {
    return JSON.stringify(
      this.pages.map((p) => [this.sourceOf(p.src).workerId, p.index, p.rotate])
    );
  }

  private isSourceId(id: string) {
    return [...this.sources.values()].some((s) => s.workerId === id);
  }

  /** The Page List as one PDF in the worker, made again only when the list changed. */
  private async currentDoc(): Promise<Current> {
    const w = await this.ensureWorker();
    const sig = this.signature();
    if (this.current?.sig === sig) {
      return this.current.doc;
    }
    const refs = this.pages.map((p) => ({
      index: p.index,
      rotate: p.rotate,
      src: this.sourceOf(p.src).workerId,
    }));
    const doc = await w.call("assemble", [refs]);
    // The last assembly goes once a new one replaces it, unless it is a Source itself.
    const old = this.current?.doc.id;
    if (old && old !== doc.id && !this.isSourceId(old)) {
      void quietly(w.call("close", [old]));
    }
    this.current = { doc, sig };
    return doc;
  }

  private syncToolbar() {
    const has = this.pages.length > 0;
    this.undoBtn.disabled = this.past.length === 0;
    this.redoBtn.disabled = this.future.length === 0;
    this.ui.downloadBtn.disabled = !has;
    this.ui.emptyHint.style.display = has ? "none" : "block";
    this.ui.workspace.classList.toggle("on", has);
    if (!has) {
      this.ui.status.textContent = "";
      return;
    }
    const n = new Set(this.pages.map((p) => p.src)).size;
    this.ui.status.textContent = `${this.firstName()}${n > 1 ? ` + ${count(n - 1, "file", "files")}` : ""} · ${count(this.pages.length, "page", "pages")}`;
  }

  /** Make `next` the Page List, as one step Undo can take back. */
  private commit(next: PageEntry[], label: string) {
    if (next.length === 0) {
      this.showNote(
        "A document needs at least one page; that would leave none."
      );
      return;
    }
    this.past = [...this.past, this.pages].slice(-HISTORY);
    this.future = [];
    this.pages = next;
    this.afterPagesChanged();
    if (label) {
      this.showNote(label);
    }
  }

  private undo() {
    const prev = this.past.at(-1);
    if (!prev || this.busy) {
      return;
    }
    this.past = this.past.slice(0, -1);
    this.future = [this.pages, ...this.future];
    this.pages = prev;
    this.afterPagesChanged();
  }

  private redo() {
    const [next, ...rest] = this.future;
    if (!next || this.busy) {
      return;
    }
    this.future = rest;
    this.past = [...this.past, this.pages];
    this.pages = next;
    this.afterPagesChanged();
  }

  /** Move pages (the selection, or the one dragged) to stand before position `before` of the whole list. */
  private move(keys: string[], before: number) {
    const moving = new Set(keys);
    const kept = this.pages.filter((p) => !moving.has(p.key));
    const moved = this.pages.filter((p) => moving.has(p.key));
    const at = this.pages
      .slice(0, before)
      .filter((p) => !moving.has(p.key)).length;
    this.commit([...kept.slice(0, at), ...moved, ...kept.slice(at)], "");
    this.viewer.select(moving);
    this.viewer.focusCurrent();
  }

  /** Let go of Sources no step of the Page List, nor of Undo and Redo, still uses. */
  private releaseSources() {
    if (this.opening > 0) {
      return;
    }
    const used = new Set<string>();
    for (const list of [this.pages, ...this.past, ...this.future]) {
      for (const p of list) {
        used.add(p.src);
      }
    }
    for (const [key, s] of this.sources) {
      if (!used.has(key)) {
        this.sources.delete(key);
        if (s.workerId) {
          void quietly(this.worker?.call("close", [s.workerId]));
        }
      }
    }
  }

  private afterPagesChanged() {
    this.releaseSources();
    this.current = null;
    this.hits = [];
    this.hitAt = -1;
    this.ui.searchCount.textContent = "";
    this.syncToolbar();
    if (this.result) {
      this.showResult(null);
    } else {
      this.refreshView();
    }
    if (this.pages.length > 0 && !this.panel && this.panelDef) {
      this.panel = this.panelDef.mount(this.api, this.panelValues);
    } else {
      this.panel?.docChanged?.();
    }
  }

  /* ---------------- the Viewer ---------------- */

  private searchMarks(page: number): Mark[] {
    const out: Mark[] = [];
    for (const [i, h] of this.hits.entries()) {
      if (h.page === page) {
        out.push({
          kind: "quads",
          quads: h.quads,
          style: i === this.hitAt ? "current" : "hit",
        });
      }
    }
    return out;
  }

  private workspaceView(): ViewPage[] {
    const tags = new Map<string, number>();
    for (const p of this.pages) {
      if (!tags.has(p.src)) {
        tags.set(p.src, tags.size);
      }
    }
    return this.pages.map((p, i) => {
      const { w, h } = this.sizeOf(p);
      return {
        doc: this.sourceOf(p.src).workerId,
        h,
        index: p.index,
        key: p.key,
        label: String(i + 1),
        rotate: p.rotate,
        tag: tags.size > 1 ? (tags.get(p.src) ?? null) : null,
        w,
      };
    });
  }

  private static resultView(r: RunResult): ViewPage[] {
    return (r.doc?.pages ?? []).map((size, i) => ({
      doc: r.doc?.id ?? "",
      h: size.h,
      index: i,
      key: `r${i}`,
      label: String(i + 1),
      rotate: 0,
      tag: null,
      w: size.w,
    }));
  }

  private refreshView() {
    const showResult = this.showing === "result" && this.result?.doc;
    this.root.classList.toggle("showing-result", Boolean(showResult));
    this.ui.resultSeg.classList.toggle("on", Boolean(this.result?.doc));
    for (const b of this.ui.resultSeg.querySelectorAll<HTMLButtonElement>(
      "button"
    )) {
      b.classList.toggle("active", b.dataset.show === this.showing);
    }
    const list =
      showResult && this.result
        ? Toolkit.resultView(this.result)
        : this.workspaceView();
    this.viewer.show(list, this.viewer.selection);
    this.ui.pageCount.textContent = `of ${list.length}`;
    this.ui.pageNo.value = String(
      Math.min(this.viewer.currentPage, list.length - 1) + 1
    );
  }

  private setView(mode: "grid" | "pages") {
    this.viewer.setMode(mode);
    for (const b of this.root.querySelectorAll<HTMLButtonElement>(
      ".view-seg button"
    )) {
      b.classList.toggle("active", b.dataset.view === mode);
    }
    this.root.classList.toggle("view-pages", mode === "pages");
  }

  private wireViewer() {
    for (const b of this.root.querySelectorAll<HTMLButtonElement>(
      ".view-seg button"
    )) {
      b.addEventListener("click", () =>
        this.setView(b.dataset.view === "pages" ? "pages" : "grid")
      );
    }
    this.viewer.root.addEventListener("modechange", () =>
      this.setView(this.viewer.viewMode)
    );
    for (const b of this.ui.resultSeg.querySelectorAll<HTMLButtonElement>(
      "button"
    )) {
      b.addEventListener("click", () => {
        this.showing = b.dataset.show === "result" ? "result" : "workspace";
        this.refreshView();
      });
    }
    const { zoomSelect, pageNo } = this.ui;
    zoomSelect.addEventListener("change", () => {
      const v = zoomSelect.value;
      this.viewer.setZoom(v === "width" || v === "page" ? v : Number(v));
      this.setView("pages");
    });
    const zoom = (direction: 1 | -1) => () => {
      this.setView("pages");
      this.viewer.zoomBy(direction);
    };
    this.ui.zoomOut.replaceWith(iconButton(ICON_MINUS, "Zoom out", zoom(-1)));
    this.ui.zoomIn.replaceWith(iconButton(ICON_PLUS, "Zoom in", zoom(1)));
    this.viewer.root.addEventListener("zoomchange", () => {
      const z = this.viewer.zoomLevel;
      const match = [...zoomSelect.options].find(
        (o) => Math.abs(Number(o.value) - z) < 0.005
      );
      if (match) {
        zoomSelect.value = match.value;
      } else if (zoomSelect.value !== "width" && zoomSelect.value !== "page") {
        zoomSelect.value = "width";
      }
    });
    pageNo.addEventListener("change", () => {
      const n = Number(pageNo.value);
      if (Number.isInteger(n) && n >= 1) {
        this.viewer.scrollTo(n - 1);
      }
    });
  }

  /* ---------------- search ---------------- */

  private showHit(i: number) {
    const h = this.hits[i];
    if (!h) {
      return;
    }
    const prev = this.hits[this.hitAt]?.page;
    this.hitAt = i;
    this.ui.searchCount.textContent = `${i + 1} of ${this.hits.length}`;
    this.setView("pages");
    const [q] = h.quads;
    // The quad's top, whichever of its corners that is on a turned page.
    this.viewer.reveal(h.page, q ? Math.min(q[1], q[3], q[5], q[7]) : 0);
    if (prev !== undefined) {
      this.viewer.redrawPage(prev);
    }
    this.viewer.redrawPage(h.page);
  }

  private async runSearch() {
    const { searchInput, searchCount, searchCase, searchWords } = this.ui;
    const query = searchInput.value;
    this.hits = [];
    this.hitAt = -1;
    this.viewer.refreshMarks();
    if (!query.trim() || this.pages.length === 0) {
      searchCount.textContent = "";
      return;
    }
    searchCount.textContent = "Searching…";
    const r = await this.run(
      "search",
      {
        options: {
          caseSensitive: searchCase.checked,
          regex: false,
          wholeWords: searchWords.checked,
        },
        query,
      },
      "Searching",
      { own: false, quiet: true }
    );
    if (!r || r.report.error) {
      searchCount.textContent = r?.report.error ?? "";
      return;
    }
    this.hits = r.report.hits;
    if (this.hits.length === 0) {
      searchCount.textContent = "No matches";
      this.viewer.refreshMarks();
      return;
    }
    if (this.showing === "result") {
      this.showing = "workspace";
      this.refreshView();
    }
    this.viewer.refreshMarks();
    this.showHit(0);
  }

  private step(by: 1 | -1) {
    if (this.hits.length) {
      this.showHit((this.hitAt + by + this.hits.length) % this.hits.length);
    }
  }

  private wireSearch() {
    const { searchInput, searchCase, searchWords } = this.ui;
    searchInput.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") {
        return;
      }
      e.preventDefault();
      if (this.hits.length && searchInput.dataset.query === searchInput.value) {
        this.step(e.shiftKey ? -1 : 1);
        return;
      }
      searchInput.dataset.query = searchInput.value;
      void this.runSearch();
    });
    searchInput.addEventListener("search", () => {
      if (searchInput.value === "") {
        searchInput.dataset.query = "";
        void this.runSearch();
      }
    });
    for (const box of [searchCase, searchWords]) {
      box.addEventListener("change", () => {
        searchInput.dataset.query = searchInput.value;
        void this.runSearch();
      });
    }
    this.ui.searchNav.replaceWith(
      iconButton(ICON_PREV, "Previous match", () => this.step(-1)),
      iconButton(ICON_NEXT, "Next match", () => this.step(1))
    );
  }

  /* ---------------- running Operations ---------------- */

  private closeUnapplied(keep: string | null) {
    for (const id of this.unapplied) {
      if (id !== keep) {
        this.unapplied.delete(id);
        void quietly(this.worker?.call("close", [id]));
      }
    }
  }

  private async run<K extends OpName>(
    op: K,
    options: OpOptions<K>,
    what: string,
    opts: RunOptions = {}
  ): Promise<Ran<K> | null> {
    const own = opts.own !== false;
    if (own) {
      this.runSeq += 1;
    }
    const mine = this.runSeq;
    if (!opts.quiet) {
      this.clearMessages();
      this.setBusy(true, what);
    }
    try {
      const doc = await this.currentDoc();
      const w = await this.ensureWorker();
      if (!opts.quiet) {
        this.setPhase({ fraction: null, text: what });
      }
      const r = await w.run(op, doc.id, options);
      if (own && mine !== this.runSeq) {
        if (r.doc) {
          void quietly(w.call("close", [r.doc.id]));
        }
        return null;
      }
      if (r.doc) {
        this.unapplied.add(r.doc.id);
      }
      return r;
    } catch (error) {
      if (message(error) !== CANCELLED) {
        this.showError(message(error));
      }
      return null;
    } finally {
      if (!opts.quiet) {
        this.setBusy(false);
      }
    }
  }

  private showResult(r: RunResult | null) {
    this.closeUnapplied(r?.doc?.id ?? null);
    this.result = r?.doc ? r : null;
    this.showing = this.result ? "result" : "workspace";
    this.refreshView();
  }

  /** A Result made the Workspace: one new Source, all its pages. */
  private apply(r: RunResult, label: string) {
    if (!r.doc) {
      return;
    }
    // Made by a worker since thrown away (Cancel, a crash): the next one is handed it with the rest.
    const held = this.unapplied.delete(r.doc.id);
    if (!held) {
      this.worker?.terminate();
      this.worker = null;
    }
    const key = this.newKey();
    this.sources.set(key, {
      bytes: r.doc.bytes,
      key,
      name: `${this.firstName()}.pdf`,
      original: null,
      pages: r.doc.pages,
      workerId: held ? r.doc.id : "",
    });
    this.result = null;
    this.showing = "workspace";
    this.commit(
      r.doc.pages.map((_, index) => ({
        index,
        key: this.newKey(),
        rotate: 0,
        src: key,
      })),
      `Applied ${label}. Undo takes it back.`
    );
    // The work is done: back to the pages.
    this.openPanel(DEFAULT_PANEL);
  }

  private async blank(w: number, h: number): Promise<string> {
    const existing = [...this.sources.values()].find(
      (s) => s.name === "blank" && s.pages[0]?.w === w && s.pages[0]?.h === h
    );
    if (existing) {
      return existing.key;
    }
    const wk = await this.ensureWorker();
    const info = await wk.call("blank", [w, h]);
    const bytes = await wk.call("read", [info.id]);
    const key = this.newKey();
    this.sources.set(key, {
      bytes,
      key,
      name: "blank",
      original: null,
      pages: info.pages,
      workerId: info.id,
    });
    return key;
  }

  /* ---------------- panels ---------------- */

  private makeApi(): Api {
    return {
      addFiles: (files) => {
        void this.openFiles(files, true);
      },
      apply: (r, label) => this.apply(r, label),
      blank: (w, h) => this.blank(w, h),
      body: this.ui.panelBody,
      clearMessages: () => this.clearMessages(),
      current: () => this.currentDoc(),
      currentPage: () => this.viewer.currentPage,
      download,
      downloadFiles,
      error: (text) => this.showError(text),
      foot: this.ui.panelFoot,
      goTo: (page, y) => {
        this.setView("pages");
        if (y === undefined) {
          this.viewer.scrollTo(page);
        } else {
          this.viewer.reveal(page, y);
        }
      },
      name: () => this.firstName(),
      newKey: () => this.newKey(),
      note: (text) => this.showNote(text),
      onCancel: (hook) => {
        this.cancelHooks.add(hook);
        return () => this.cancelHooks.delete(hook);
      },
      open: (id, handoff) => this.openPanel(id, handoff),
      pageCount: () => this.pages.length,
      pages: () => this.pages,
      persist: () => this.persist(),
      progress: (text, fraction) => this.progress(text, fraction),
      redrawMarks: (page) => {
        if (page === undefined) {
          this.viewer.refreshMarks();
        } else {
          this.viewer.redrawPage(page);
        }
      },
      run: (op, options, what, opts) => this.run(op, options, what, opts),
      select: (keys) => this.viewer.select(new Set(keys)),
      selection: () => {
        const sel = this.viewer.selection;
        return this.pages.filter((p) => sel.has(p.key)).map((p) => p.key);
      },
      setMarks: (fn) => {
        this.panelMarks = fn;
        this.viewer.refreshMarks();
      },
      setPages: (next, label) => this.commit(next, label),
      setTool: (tool, handler) => this.setTool(tool, handler),
      showResult: (r) => this.showResult(r),
      sizes: () => this.pages.map((p) => this.sizeOf(p)),
      sources: () =>
        [...this.sources.values()]
          .filter((s) => s.name !== "blank")
          .map((s) => ({ key: s.key, name: s.name, pages: s.pages })),
      takeOver: (view) => this.takeOver(view),
      view: (mode) => this.setView(mode),
      worker: () => this.ensureWorker(),
    };
  }

  /** Progress of work outside the worker (OCR); a fraction of 1 or no text ends it. */
  private progress(text: string, fraction: number | null) {
    if (!this.busy) {
      this.setBusy(true, text);
    }
    this.setPhase({ fraction, text });
    if (fraction === 1 || text === "") {
      this.setBusy(false);
    }
  }

  private setTool(tool: DrawTool | null, handler?: (g: Gesture) => void) {
    this.viewer.setTool(tool);
    this.onGesture = handler ?? null;
    if (!tool) {
      return;
    }
    this.setView("pages");
    if (this.showing === "result") {
      this.showing = "workspace";
      this.refreshView();
    }
  }

  private takeOver(view: HTMLElement | null) {
    this.root.classList.toggle("taken-over", view !== null);
    this.takenOver?.remove();
    this.takenOver = view;
    if (view) {
      this.viewer.root.after(view);
    }
  }

  private persist() {
    if (!this.panelDef) {
      return;
    }
    const query = encodeValues(
      this.panelValues,
      this.panelDef.defaults ?? {},
      unshareable(this.panelDef.fields ?? [])
    );
    const id =
      this.panelDef.id === DEFAULT_PANEL && !query ? "" : this.panelDef.id;
    this.ctx.setState(query ? `${id}?${query}` : id);
  }

  private openPanel(id: string, handoff?: unknown, values?: Values) {
    const def = panelById(id);
    if (!def) {
      return;
    }
    this.panel?.destroy?.();
    this.panel = null;
    this.takeOver(null);
    this.runSeq += 1;
    this.viewer.setTool(null);
    this.onGesture = null;
    this.panelMarks = null;
    if (this.result) {
      this.showResult(null);
    }
    this.viewer.refreshMarks();
    this.panelDef = def;
    this.panelValues = { ...(values ?? def.defaults) };
    this.ui.panelSelect.value = def.id;
    this.ui.panelBody.replaceChildren();
    this.ui.panelFoot.replaceChildren();
    this.root.dataset.panel = def.id;
    this.persist();
    if (this.pages.length > 0 || def.id === "images") {
      this.panel = def.mount(this.api, this.panelValues, handoff);
    }
  }

  private wirePanels() {
    const byGroup = new Map<string, PanelDef[]>();
    for (const p of PANELS) {
      byGroup.set(p.group, [...(byGroup.get(p.group) ?? []), p]);
    }
    for (const [group, defs] of byGroup) {
      const og = el("optgroup", { attrs: { label: group } });
      for (const d of defs) {
        og.append(el("option", { attrs: { value: d.id }, text: d.name }));
      }
      this.ui.panelSelect.append(og);
    }
    this.ui.panelSelect.addEventListener("change", () =>
      this.openPanel(this.ui.panelSelect.value)
    );
  }

  /* ---------------- opening files ---------------- */

  /** Ask for a file's password in the bar above the pages; null when skipped. */
  private askPassword(name: string, wrong: boolean): Promise<string | null> {
    const { locked, lockedText, unlockPw, unlockBtn, skipBtn } = this.ui;
    const { promise, resolve } = Promise.withResolvers<string | null>();
    lockedText.textContent = wrong
      ? `Wrong password for ${name}. Try again:`
      : `${name} is password protected.`;
    unlockPw.value = "";
    locked.classList.add("on");
    unlockPw.focus();
    const controller = new AbortController();
    const done = (value: string | null) => {
      locked.classList.remove("on");
      controller.abort();
      resolve(value);
    };
    const { signal } = controller;
    unlockBtn.addEventListener("click", () => done(unlockPw.value), { signal });
    skipBtn.addEventListener("click", () => done(null), { signal });
    unlockPw.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Enter") {
          done(unlockPw.value);
        } else if (e.key === "Escape") {
          done(null);
        }
      },
      { signal }
    );
    return promise;
  }

  private addSource(
    name: string,
    r: Extract<OpenResult, { status: "ok" }>,
    original: Original | null = null
  ): string {
    const key = this.newKey();
    this.sources.set(key, {
      bytes: r.bytes,
      key,
      name,
      original,
      pages: r.doc.pages,
      workerId: r.doc.id,
    });
    return key;
  }

  /** Open one PDF, asking for its password as often as it takes; null when skipped. */
  private async openPdfFile(
    w: PdfWorker,
    file: File,
    notes: string[]
  ): Promise<string | null> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let password: string | null = null;
    let wrong = false;
    for (;;) {
      const copy = new Uint8Array(bytes);
      const r = await w.call(
        "open",
        [copy, password, file.name],
        [copy.buffer]
      );
      if (r.status === "ok") {
        if (r.encrypted) {
          const what = r.restrictions.length
            ? ` and did not allow ${r.restrictions.join(", ")}`
            : "";
          notes.push(
            `${file.name} was encrypted${what}; the copy here is not, and nor will downloads be unless you protect them again.`
          );
        }
        if (r.repaired) {
          notes.push(`${file.name} was damaged; MuPDF repaired what it could.`);
        }
        return this.addSource(
          file.name,
          r,
          r.encrypted ? { bytes, password: password ?? "" } : null
        );
      }
      this.setBusy(false);
      password = await this.askPassword(
        file.name,
        wrong || r.status === "wrong-password"
      );
      if (password === null) {
        return null;
      }
      wrong = true;
      this.setBusy(true, `Opening ${file.name}`);
    }
  }

  /** Images, in the order given, made into one Source of a page each. */
  private async openImages(
    w: PdfWorker,
    batch: File[]
  ): Promise<string | null> {
    this.setPhase({
      fraction: null,
      text: `Making ${count(batch.length, "image", "images")} into pages`,
    });
    const data: Uint8Array[] = [];
    for (const f of batch) {
      data.push(await mupdfImage(f));
    }
    const name =
      batch.length === 1
        ? `${stem(batch[0]?.name ?? "image")}.pdf`
        : "images.pdf";
    const r = await w.call(
      "images",
      [data, imageOptions(), name],
      data.map((d) => d.buffer as ArrayBuffer)
    );
    return r.status === "ok" ? this.addSource(name, r) : null;
  }

  private async openConverted(
    w: PdfWorker,
    file: File,
    notes: string[]
  ): Promise<string | null> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const ext = file.name.slice(file.name.lastIndexOf(".") + 1).toLowerCase();
    const name = `${stem(file.name)}.pdf`;
    const r = await w.call("convert", [bytes, ext, name], [bytes.buffer]);
    if (r.status !== "ok") {
      return null;
    }
    notes.push(`${file.name} was laid out as a PDF by MuPDF.`);
    return this.addSource(name, r);
  }

  /** Each file opened as a Source, in order; runs of images become one Source. */
  private async openEach(files: File[], notes: string[]): Promise<string[]> {
    const w = await this.ensureWorker();
    const added: string[] = [];
    let images: File[] = [];
    const flush = async () => {
      if (images.length) {
        const key = await this.openImages(w, images);
        images = [];
        if (key) {
          added.push(key);
        }
      }
    };
    for (const file of files) {
      const kind = await kindOf(file);
      if (kind === "image") {
        images.push(file);
        continue;
      }
      await flush();
      this.setPhase({ fraction: null, text: `Opening ${file.name}` });
      let key: string | null = null;
      if (kind === "pdf") {
        key = await this.openPdfFile(w, file, notes);
      } else if (kind === "convertible") {
        key = await this.openConverted(w, file, notes);
      } else {
        notes.push(
          `${file.name} is not a PDF, an image, or an e-book; skipped.`
        );
      }
      if (key) {
        added.push(key);
      }
    }
    await flush();
    return added;
  }

  private async openFiles(files: File[], append: boolean) {
    if (files.length === 0 || this.busy) {
      return;
    }
    this.clearMessages();
    this.setBusy(
      true,
      `Opening ${files.length === 1 ? files[0]?.name : count(files.length, "file", "files")}`
    );
    const notes: string[] = [];
    let added: string[] = [];
    this.opening += 1;
    try {
      added = await this.openEach(files, notes);
    } catch (error) {
      if (message(error) !== CANCELLED) {
        this.showError(message(error));
      }
    } finally {
      this.opening -= 1;
      this.setBusy(false);
    }
    if (added.length > 0) {
      const entries = added.flatMap((key) =>
        this.sourceOf(key).pages.map((_, index) => ({
          index,
          key: this.newKey(),
          rotate: 0,
          src: key,
        }))
      );
      if (append && this.pages.length > 0) {
        this.commit(
          [...this.pages, ...entries],
          `Added ${count(entries.length, "page", "pages")}.`
        );
      } else {
        this.past = this.pages.length
          ? [...this.past, this.pages].slice(-HISTORY)
          : this.past;
        this.future = [];
        this.pages = entries;
        this.afterPagesChanged();
      }
    }
    if (notes.length) {
      this.showNote(notes.join(" "));
    }
  }

  private async downloadCurrent() {
    try {
      const doc = await this.currentDoc();
      const w = await this.ensureWorker();
      const bytes = await w.call("read", [doc.id]);
      download(pdfBlob(bytes), `${this.firstName()}.pdf`);
    } catch (error) {
      this.showError(message(error));
    }
  }

  private wireToolbar() {
    const {
      openBtn,
      addBtn,
      openInput,
      addInput,
      downloadBtn,
      enginesClear,
      cancelBtn,
    } = this.ui;
    openBtn.addEventListener("click", () => openInput.click());
    addBtn.addEventListener("click", () => addInput.click());
    for (const [input, append] of [
      [openInput, false],
      [addInput, true],
    ] as const) {
      input.addEventListener("change", () => {
        const files = readInput(input.files).flatMap((p) =>
          p.file ? [p.file] : []
        );
        input.value = "";
        void this.openFiles(files, append);
      });
    }
    downloadBtn.addEventListener("click", () => {
      void this.downloadCurrent();
    });
    enginesClear.addEventListener("click", async () => {
      if (!this.busy) {
        await clearCached();
        void this.renderEngines();
      }
    });
    cancelBtn.addEventListener("click", () => this.cancel());
  }

  /* ---------------- drops and keys ---------------- */

  private wireDrops() {
    const isFileDrag = (e: DragEvent) =>
      e.dataTransfer?.types.includes("Files") ?? false;
    this.root.addEventListener("dragenter", (e) => {
      if (isFileDrag(e)) {
        e.preventDefault();
        this.dragDepth += 1;
        this.root.classList.add("dragging");
      }
    });
    this.root.addEventListener("dragover", (e) => {
      if (isFileDrag(e)) {
        e.preventDefault();
      }
    });
    this.root.addEventListener("dragleave", (e) => {
      if (!isFileDrag(e)) {
        return;
      }
      this.dragDepth -= 1;
      if (this.dragDepth <= 0) {
        this.dragDepth = 0;
        this.root.classList.remove("dragging");
      }
    });
    this.root.addEventListener("drop", async (e) => {
      if (!e.dataTransfer || !isFileDrag(e)) {
        return;
      }
      e.preventDefault();
      this.dragDepth = 0;
      this.root.classList.remove("dragging");
      const { items } = await readDrop(e.dataTransfer);
      // Dropped onto a document, files join it; onto nothing, they start one.
      void this.openFiles(
        items.flatMap((i) => (i.file ? [i.file] : [])),
        this.pages.length > 0
      );
    });
  }

  private wireKeys() {
    this.root.addEventListener("keydown", (e) => {
      const typing =
        (e.target as HTMLElement).closest("input, textarea, select") !== null;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (mod && key === "z" && !typing) {
        e.preventDefault();
        if (e.shiftKey) {
          this.redo();
        } else {
          this.undo();
        }
      } else if (mod && key === "f" && this.pages.length > 0) {
        e.preventDefault();
        this.ui.searchInput.focus();
        this.ui.searchInput.select();
      }
    });
  }

  /* ---------------- the Deep Link ---------------- */

  private restore(payload: string) {
    const [id = "", query = ""] = payload.split("?", 2);
    const def = panelById(id);
    if (def) {
      this.openPanel(
        def.id,
        undefined,
        decodeValues(query, def.defaults ?? {}, unshareable(def.fields ?? []))
      );
    }
  }
}
