// The toolbar's icons: a half-filled disc (the light toggle, mirrored while
// on), a page with an arrow leaving it, sparkles for Format, and heading
// lines of uneven length, the way Contents reads.
import ICON_CONTRAST from "lucide-static/icons/contrast.svg";
import ICON_EXPORT from "lucide-static/icons/file-down.svg";
import ICON_SPARKLE from "lucide-static/icons/sparkles.svg";
import ICON_CONTENTS from "lucide-static/icons/text-align-start.svg";

import "./tool.css";
import LZString from "lz-string";

import type { Tool } from "../../shell/types";
import { loadDiagrams, loadFormatter, loadMath } from "./engines";
import { escapeHtml, headings, renderMarkdown } from "./render";
import type { Heading } from "./render";
import { welcome } from "./welcome";

const DRAFT_KEY = "html-tools:markdown-editor:draft";
const VIEW_KEY = "html-tools:markdown-editor:view";
const TOC_KEY = "html-tools:markdown-editor:contents";
const LIGHT_KEY = "html-tools:markdown-editor:light";

/** Longest compressed Draft the Deep Link carries; past it the link only selects the Tool. */
const STATE_CAP = 30_000;
/** Tool widths below which Contents is a drawer, and below which Split stacks. */
const DRAWER_WIDTH = 900;
const STACK_WIDTH = 700;

const DEFAULT_NAME = "untitled.md";
const ACCEPT = ".md,.markdown,.mdown,.mkd,.txt,text/markdown,text/plain";
const INDENT = "  ";

type View = "edit" | "split" | "preview";
type EngineKind = "math" | "diagrams";

// Extensions compare case-insensitively in ASCII only. The u flag would make
// an i flag fold the Kelvin sign to k, so letters are lowercased by hand.
const MARKDOWN_EXT_RE = /\.(?:md|markdown|mdown|mkd|txt)$/u;
const asciiLower = (s: string) =>
  s.replaceAll(/[A-Z]/gu, (c) => c.toLowerCase());

const isMac = /Mac|iPhone|iPad/u.test(navigator.platform || "");
const MOD = isMac ? "⌘" : "Ctrl+";

// The File System Access API, which TypeScript's DOM library does not declare.
interface FileHandle {
  readonly name: string;
  getFile: () => Promise<File>;
  createWritable: () => Promise<{
    write: (data: string) => Promise<void>;
    close: () => Promise<void>;
  }>;
  queryPermission?: (o: { mode: "readwrite" }) => Promise<string>;
  requestPermission?: (o: { mode: "readwrite" }) => Promise<string>;
}
interface PickerWindow {
  showOpenFilePicker?: (o: object) => Promise<FileHandle[]>;
  showSaveFilePicker?: (o: object) => Promise<FileHandle>;
}
interface HandleItem extends DataTransferItem {
  getAsFileSystemHandle?: () => Promise<{ kind: string } & FileHandle>;
}

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const write = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, value);
    }
  } catch {
    // storage unavailable: the visit still works
  }
};

const saveBlob = (blob: Blob, name: string) => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};

const tool: Tool = {
  id: "markdown-editor",
  keywords: [
    "markdown",
    "md",
    "preview",
    "editor",
    "viewer",
    "render",
    "mermaid",
    "katex",
    "latex",
    "math",
    "toc",
    "pdf",
  ],
  mount(el, ctx) {
    el.innerHTML = `
      <div class="toolbar">
        <button type="button" class="new-btn" title="New document">New</button>
        <button type="button" class="open-btn" title="Open a markdown file (${MOD}O)">Open</button>
        <span class="filename-wrap">
          <input class="filename" value="${DEFAULT_NAME}" spellcheck="false" autocomplete="off" aria-label="File name" title="File name (click to rename)">
        </span>
        <span class="spacer"></span>
        <div class="seg" role="tablist" aria-label="View mode">
          <button type="button" role="tab" data-mode="edit">Edit</button>
          <button type="button" role="tab" data-mode="split">Split</button>
          <button type="button" role="tab" data-mode="preview">Preview</button>
        </div>
        <button type="button" class="toc-btn icon" title="Contents" aria-label="Contents" aria-pressed="false">${ICON_CONTENTS}</button>
        <button type="button" class="light-btn icon" title="Light document" aria-label="Light document" aria-pressed="false">${ICON_CONTRAST}</button>
        <button type="button" class="format-btn icon" title="Format Markdown" aria-label="Format Markdown">${ICON_SPARKLE}</button>
        <button type="button" class="pdf-btn" title="Print the rendered document, or save it as a PDF">${ICON_EXPORT}<span class="wide-only">Export PDF</span></button>
        <button type="button" class="save-btn primary" title="Save (${MOD}S)">Save</button>
      </div>
      <div class="pane">
        <div class="body">
          <nav class="toc" aria-label="Contents"></nav>
          <div class="toc-backdrop"></div>
          <div class="editor-pane">
            <div class="find-bar">
              <input class="find-input" placeholder="Find" spellcheck="false" autocomplete="off" aria-label="Find">
              <input class="replace-input" placeholder="Replace with" spellcheck="false" autocomplete="off" aria-label="Replace with">
              <span class="find-count"></span>
              <button type="button" class="find-prev" title="Previous match (Shift+Enter)">&#8593;</button>
              <button type="button" class="find-next" title="Next match (Enter)">&#8595;</button>
              <button type="button" class="find-replace" title="Replace this match">Replace</button>
              <button type="button" class="find-all" title="Replace every match">All</button>
              <button type="button" class="find-close" title="Close (Esc)">&#10005;</button>
            </div>
            <div class="editor-wrap">
              <div class="editor-marks" aria-hidden="true"></div>
              <textarea class="editor" spellcheck="false" placeholder="Type markdown here, or drop a .md file anywhere…" aria-label="Markdown source"></textarea>
            </div>
          </div>
          <div class="preview-pane"><article class="doc"></article></div>
        </div>
        <div class="footer">
          <span class="stat-words">0 words</span>
          <span class="stat-chars">0 chars</span>
          <span class="stat-lines wide-only">1 line</span>
          <span class="spacer"></span>
          <span class="status"></span>
        </div>
        <div class="drop-overlay"><div class="card">Drop your markdown file<div class="sub">.md, .markdown or any text file. It never leaves your browser.</div></div></div>
      </div>
      <input type="file" class="file-input" accept="${ACCEPT}" hidden>`;

    const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => {
      const found = el.querySelector<T>(sel);
      if (!found) {
        throw new Error(`Markdown Editor markup has no ${sel}`);
      }
      return found;
    };
    const editor = $<HTMLTextAreaElement>(".editor");
    const marks = $(".editor-marks");
    const doc = $(".doc");
    const previewPane = $(".preview-pane");
    const tocEl = $(".toc");
    const filenameEl = $<HTMLInputElement>(".filename");
    const statusEl = $(".status");
    const fileInput = $<HTMLInputElement>(".file-input");
    const tocBtn = $<HTMLButtonElement>(".toc-btn");
    const lightBtn = $<HTMLButtonElement>(".light-btn");
    const findBar = $(".find-bar");
    const findInput = $<HTMLInputElement>(".find-input");
    const replaceInput = $<HTMLInputElement>(".replace-input");
    const findCount = $(".find-count");

    let fileHandle: FileHandle | null = null;
    let light = read(LIGHT_KEY) === "1";
    let view: View = "preview";
    let tocOpen = false;
    let tocHeadings: Heading[] = [];
    let statusTimer = 0;
    let renderTimer = 0;
    let draftTimer = 0;
    let linkFits = true;
    let booted = false;
    let pendingDiagrams: Promise<void> = Promise.resolve();
    const engines: Record<EngineKind, "idle" | "loading" | "ready" | "failed"> =
      {
        diagrams: "idle",
        math: "idle",
      };

    /* ---- status and stats ---- */

    const setStatus = (msg: string, sticky = false) => {
      statusEl.textContent = msg;
      clearTimeout(statusTimer);
      if (!sticky) {
        statusTimer = window.setTimeout(
          () => (statusEl.textContent = ""),
          4000
        );
      }
    };

    const updateStats = () => {
      const text = editor.value;
      const words = (text.trim().match(/\S+/gu) ?? []).length;
      $(".stat-words").textContent = `${words} word${words === 1 ? "" : "s"}`;
      $(".stat-chars").textContent = `${text.length} chars`;
      const lines = text.length ? text.split("\n").length : 1;
      $(".stat-lines").textContent = `${lines} line${lines === 1 ? "" : "s"}`;
    };

    /* ---- Draft and Deep Link ---- */

    const saveDraft = () => {
      clearTimeout(draftTimer);
      draftTimer = window.setTimeout(() => {
        write(
          DRAFT_KEY,
          JSON.stringify({ name: filenameEl.value, text: editor.value })
        );
      }, 400);
    };

    const loadDraft = (): boolean => {
      try {
        const raw = read(DRAFT_KEY);
        if (!raw) {
          return false;
        }
        const d = JSON.parse(raw) as { name?: string; text?: string };
        if (typeof d.text !== "string" || !d.text.trim()) {
          return false;
        }
        editor.value = d.text;
        filenameEl.value = d.name || DEFAULT_NAME;
        return true;
      } catch {
        return false;
      }
    };

    /** State layout: `<encoded filename>.<compressed text>`; the compressed part never contains a dot. */
    const publishState = () => {
      const text = editor.value;
      if (!text.trim()) {
        ctx.setState("");
        return;
      }
      const packed = LZString.compressToEncodedURIComponent(text);
      const fits = packed.length <= STATE_CAP;
      if (!fits && linkFits) {
        setStatus(
          "Too large to keep in the URL; the draft stays in this browser."
        );
      }
      linkFits = fits;
      ctx.setState(
        fits ? `${encodeURIComponent(filenameEl.value)}.${packed}` : ""
      );
    };

    /* ---- Contents ---- */

    const isDrawer = () => el.classList.contains("toc-drawer");

    const buildToc = () => {
      let html = '<div class="toc-title">Contents</div>';
      for (const h of tocHeadings) {
        html += `<button type="button" class="toc-link d${h.level}" data-id="${
          h.id
        }" title="${escapeHtml(h.text)}">${escapeHtml(h.text)}</button>`;
      }
      if (!tocHeadings.length) {
        html += '<div class="toc-empty">No headings yet</div>';
      }
      tocEl.innerHTML = html;
    };

    const setToc = (on: boolean) => {
      tocOpen = on;
      el.classList.toggle("toc-open", on);
      tocBtn.classList.toggle("toggled", on);
      tocBtn.setAttribute("aria-pressed", String(on));
    };

    tocBtn.addEventListener("click", () => {
      setToc(!tocOpen);
      write(TOC_KEY, tocOpen ? "1" : "0");
    });
    $(".toc-backdrop").addEventListener("click", () => setToc(false));

    const scrollDocTo = (target: HTMLElement, offset: number) => {
      // In a stacked Split the preview pane may itself be scrolled out of sight.
      if (isDrawer() && view === "split") {
        target.scrollIntoView({ block: "start" });
      } else {
        previewPane.scrollTop =
          target.getBoundingClientRect().top -
          previewPane.getBoundingClientRect().top +
          previewPane.scrollTop -
          offset;
      }
    };

    tocEl.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>(
        "button[data-id]"
      );
      if (!b) {
        return;
      }
      const { id } = b.dataset;
      const h = id
        ? document.querySelector<HTMLElement>(`#${CSS.escape(id)}`)
        : null;
      if (h) {
        scrollDocTo(h, 20);
      }
      if (isDrawer()) {
        setToc(false);
      }
    });

    const copyCode = async (btn: HTMLButtonElement) => {
      const text = btn.parentElement?.querySelector("pre")?.textContent ?? "";
      let ok = false;
      try {
        await navigator.clipboard.writeText(text);
        ok = true;
      } catch {
        // the async clipboard needs a secure context; this keeps copy working from file://
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.cssText = "position:fixed;left:-9999px;top:0";
        document.body.append(ta);
        ta.select();
        try {
          ok = document.execCommand("copy");
        } catch {
          ok = false;
        }
        ta.remove();
      }
      btn.textContent = ok ? "Copied" : "Failed";
      setTimeout(() => (btn.textContent = "Copy"), 1200);
    };

    // Links within the document jump within it, without touching the Deep Link.
    doc.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(
        ".copy-btn"
      );
      if (btn) {
        copyCode(btn);
        return;
      }
      const a = (e.target as HTMLElement).closest<HTMLAnchorElement>(
        'a[href^="#"]'
      );
      if (!a) {
        return;
      }
      e.preventDefault();
      const href = a.getAttribute("href");
      if (href === null) {
        return;
      }
      const target = doc.querySelector<HTMLElement>(
        `#${CSS.escape(href.slice(1))}`
      );
      if (target) {
        scrollDocTo(target, 40);
      }
    });

    // The entry for the heading at the top of the preview is highlighted as it scrolls.
    let spyPending = false;
    const spy = () => {
      if (spyPending) {
        return;
      }
      spyPending = true;
      requestAnimationFrame(() => {
        spyPending = false;
        const [first] = tocHeadings;
        if (!first) {
          return;
        }
        const top = previewPane.getBoundingClientRect().top + 24;
        let current = first;
        for (const h of tocHeadings) {
          const node = document.querySelector(`#${CSS.escape(h.id)}`);
          if (node && node.getBoundingClientRect().top <= top) {
            current = h;
          } else {
            break;
          }
        }
        const atEnd =
          previewPane.scrollTop + previewPane.clientHeight >=
          previewPane.scrollHeight - 2;
        const last = tocHeadings.at(-1);
        if (atEnd && last) {
          current = last;
        }
        for (const b of tocEl.querySelectorAll<HTMLElement>(".toc-link")) {
          const active = b.dataset.id === current.id;
          b.classList.toggle("active", active);
          if (active) {
            b.scrollIntoView({ block: "nearest" });
          }
        }
      });
    };

    /* ---- Engines: fetched the first time a Draft needs one ---- */

    /** Fetches an Engine once, and calls `onLoad` when it arrives. */
    const ensureEngine = async (kind: EngineKind, onLoad: () => void) => {
      if (engines[kind] !== "idle") {
        return;
      }
      engines[kind] = "loading";
      const label = kind === "math" ? "math typesetter" : "diagram renderer";
      // Quietly: the document reads fine meanwhile, and the result speaks for itself.
      try {
        await (kind === "math" ? loadMath() : loadDiagrams());
      } catch (error) {
        engines[kind] = "failed";
        setStatus(
          `Could not load the ${label}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        return;
      }
      engines[kind] = "ready";
      onLoad();
    };

    /* ---- rendering ---- */

    const render = () => {
      const res = renderMarkdown(editor.value, doc, { light });
      pendingDiagrams = res.diagrams;
      tocHeadings = headings(doc);
      buildToc();
      updateStats();
      spy();
      if (res.needsMath) {
        ensureEngine("math", render);
      }
      if (res.needsDiagrams) {
        ensureEngine("diagrams", render);
      }
      // Publishing before the Shell has delivered the Deep Link's payload would replace it with the draft's.
      if (booted) {
        publishState();
      }
    };

    const scheduleRender = () => {
      clearTimeout(renderTimer);
      renderTimer = window.setTimeout(render, 120);
    };

    /* ---- Scroll Sync: either pane drives the other, proportionally ---- */

    const expected = new Map<HTMLElement, number>();
    const follow = (from: HTMLElement, to: HTMLElement) => {
      const fromMax = from.scrollHeight - from.clientHeight;
      const toMax = to.scrollHeight - to.clientHeight;
      if (fromMax <= 0 || toMax <= 0) {
        return;
      }
      const target = Math.round((from.scrollTop / fromMax) * toMax);
      if (Math.abs(to.scrollTop - target) < 1) {
        return;
      }
      // the scroll event this causes is not the user's
      expected.set(to, target);
      to.scrollTop = target;
    };
    const onScroll = (pane: HTMLElement, other: HTMLElement) => {
      const e = expected.get(pane);
      if (e !== undefined) {
        expected.delete(pane);
        if (Math.abs(pane.scrollTop - e) < 1) {
          return;
        }
      }
      if (view === "split") {
        follow(pane, other);
      }
    };
    editor.addEventListener("scroll", () => {
      marks.scrollTop = editor.scrollTop;
      onScroll(editor, previewPane);
    });
    previewPane.addEventListener("scroll", () => {
      onScroll(previewPane, editor);
      spy();
    });

    /* ---- View Mode ---- */

    // A pane hidden with display: none forgets its scroll position, so each
    // pane's position is kept across the modes that hide it.
    const kept = { editor: 0, preview: 0 };
    const setView = (mode: View) => {
      if (view !== "preview") {
        kept.editor = editor.scrollTop;
      }
      if (view !== "edit") {
        kept.preview = previewPane.scrollTop;
      }
      view = mode;
      el.dataset.view = mode;
      for (const b of el.querySelectorAll<HTMLElement>(".seg button")) {
        const on = b.dataset.mode === mode;
        b.classList.toggle("active", on);
        b.setAttribute("aria-selected", String(on));
      }
      if (mode !== "preview") {
        expected.set(editor, kept.editor);
        editor.scrollTop = kept.editor;
        marks.scrollTop = kept.editor;
      }
      if (mode !== "edit") {
        expected.set(previewPane, kept.preview);
        previewPane.scrollTop = kept.preview;
      }
      spy();
    };
    const chooseView = (btn: HTMLElement) => {
      setView(btn.dataset.mode as View);
      write(VIEW_KEY, view);
      if (view !== "preview") {
        editor.focus();
      }
    };
    for (const btn of el.querySelectorAll<HTMLElement>(".seg button")) {
      btn.addEventListener("click", () => chooseView(btn));
    }

    /* ---- Light Document ---- */

    const applyLight = (on: boolean) => {
      light = on;
      previewPane.classList.toggle("light", on);
      lightBtn.classList.toggle("toggled", on);
      lightBtn.setAttribute("aria-pressed", String(on));
      lightBtn.title = on ? "Dark document" : "Light document";
      render();
    };
    lightBtn.addEventListener("click", () => {
      applyLight(!light);
      write(LIGHT_KEY, light ? "1" : "0");
    });

    /* ---- opening and saving ---- */

    const loadContent = (
      text: string,
      name: string,
      handle: FileHandle | null
    ) => {
      editor.value = text.replaceAll("\r\n", "\n");
      filenameEl.value = name || DEFAULT_NAME;
      fileHandle = handle;
      render();
      saveDraft();
      editor.setSelectionRange(0, 0);
      editor.scrollTop = 0;
      previewPane.scrollTop = 0;
    };

    const openFromFile = async (file: File, handle: FileHandle | null) => {
      loadContent(await file.text(), file.name, handle);
      setStatus(
        `Opened ${filenameEl.value}${handle ? "; Save writes back to it" : ""}`
      );
    };

    ctx.onRestore((payload) => {
      const dot = payload.lastIndexOf(".");
      if (dot === -1) {
        return;
      }
      let name = DEFAULT_NAME;
      try {
        name = decodeURIComponent(payload.slice(0, dot)) || DEFAULT_NAME;
      } catch {
        // an unreadable name still leaves the text worth opening
      }
      const text = LZString.decompressFromEncodedURIComponent(
        payload.slice(dot + 1)
      );
      if (!text) {
        return;
      }
      loadContent(text, name, null);
      setStatus(`Opened ${name} from the link`);
    });

    const openPicker = async () => {
      const w = window as unknown as PickerWindow;
      if (w.showOpenFilePicker) {
        try {
          const [handle] = await w.showOpenFilePicker({
            excludeAcceptAllOption: false,
            types: [
              {
                accept: {
                  "text/markdown": [".md", ".markdown", ".mdown", ".mkd"],
                  "text/plain": [".txt"],
                },
                description: "Markdown",
              },
            ],
          });
          if (handle) {
            await openFromFile(await handle.getFile(), handle);
          }
        } catch {
          // cancelled
        }
      } else {
        fileInput.click();
      }
    };

    fileInput.addEventListener("change", () => {
      const f = fileInput.files?.[0];
      if (f) {
        openFromFile(f, null);
      }
      fileInput.value = "";
    });

    const writeToHandle = async (handle: FileHandle) => {
      const writable = await handle.createWritable();
      await writable.write(editor.value);
      await writable.close();
    };

    const saveAs = async () => {
      const w = window as unknown as PickerWindow;
      if (w.showSaveFilePicker) {
        try {
          const handle = await w.showSaveFilePicker({
            suggestedName: filenameEl.value || DEFAULT_NAME,
            types: [
              { accept: { "text/markdown": [".md"] }, description: "Markdown" },
            ],
          });
          await writeToHandle(handle);
          fileHandle = handle;
          filenameEl.value = handle.name;
          saveDraft();
          setStatus(`Saved to ${handle.name}`);
        } catch {
          // cancelled
        }
      } else {
        const name = filenameEl.value || DEFAULT_NAME;
        saveBlob(
          new Blob([editor.value], { type: "text/markdown;charset=utf-8" }),
          name
        );
        setStatus(`Downloaded ${name}`);
      }
    };

    const save = async () => {
      if (fileHandle) {
        try {
          if (
            fileHandle.queryPermission &&
            (await fileHandle.queryPermission({ mode: "readwrite" })) !==
              "granted" &&
            (await fileHandle.requestPermission?.({ mode: "readwrite" })) !==
              "granted"
          ) {
            throw new Error("denied");
          }
          await writeToHandle(fileHandle);
          setStatus(`Saved to ${filenameEl.value}`);
          return;
        } catch {
          setStatus(
            "Could not write to the original file; choose where to save it"
          );
        }
      }
      await saveAs();
    };

    const newDoc = () => {
      fileHandle = null;
      editor.value = "";
      filenameEl.value = DEFAULT_NAME;
      render();
      write(DRAFT_KEY, null);
      editor.focus();
    };

    // New on a document that has text asks first: the button itself turns
    // into the confirmation, and a second click within a few seconds discards.
    const newBtn = $<HTMLButtonElement>(".new-btn");
    let newArmed = 0;
    const disarmNew = () => {
      clearTimeout(newArmed);
      newArmed = 0;
      newBtn.textContent = "New";
      newBtn.classList.remove("confirm");
      newBtn.title = "New document";
    };
    newBtn.addEventListener("click", (e) => {
      // the document-wide click handler would disarm it
      e.stopPropagation();
      if (newArmed || !editor.value.trim()) {
        disarmNew();
        newDoc();
        return;
      }
      newBtn.textContent = "Discard?";
      newBtn.classList.add("confirm");
      newBtn.title = "Click again to discard this document and start a new one";
      newArmed = window.setTimeout(disarmNew, 4000);
    });
    document.addEventListener("click", () => {
      if (newArmed) {
        disarmNew();
      }
    });

    filenameEl.addEventListener("change", () => {
      let name = filenameEl.value.trim() || DEFAULT_NAME;
      if (!MARKDOWN_EXT_RE.test(asciiLower(name))) {
        name += ".md";
      }
      filenameEl.value = name;
      // renamed: the next Save asks where to put it
      fileHandle = null;
      saveDraft();
      publishState();
    });
    filenameEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        filenameEl.blur();
      }
    });

    /* ---- Export PDF: the browser's print dialog, always on a light page.
       Diagrams bake their palette into the SVG, so they are redrawn light first. ---- */

    const exportPdf = async () => {
      const wasDark = !light;
      if (wasDark) {
        applyLight(true);
        await pendingDiagrams;
      }
      document.body.classList.add("md-print");
      setStatus(
        'Choose "Save as PDF" as the destination in the print dialog',
        true
      );
      window.addEventListener(
        "afterprint",
        () => {
          document.body.classList.remove("md-print");
          if (wasDark) {
            applyLight(false);
          }
          setStatus("");
        },
        { once: true }
      );
      window.print();
    };

    // Printing from the browser's own menu while the Tool is on screen prints the document too.
    window.addEventListener("beforeprint", () => {
      if (!el.hidden) {
        document.body.classList.add("md-print");
      }
    });
    window.addEventListener("afterprint", () =>
      document.body.classList.remove("md-print")
    );

    /* ---- drag and drop ---- */

    let dragDepth = 0;
    el.addEventListener("dragenter", (e) => {
      if (e.dataTransfer && [...e.dataTransfer.types].includes("Files")) {
        dragDepth += 1;
        el.classList.add("dragging");
      }
    });
    el.addEventListener("dragover", (e) => e.preventDefault());
    el.addEventListener("dragleave", () => {
      dragDepth -= 1;
      if (dragDepth <= 0) {
        dragDepth = 0;
        el.classList.remove("dragging");
      }
    });
    el.addEventListener("drop", async (e) => {
      e.preventDefault();
      dragDepth = 0;
      el.classList.remove("dragging");
      const item = e.dataTransfer?.items[0] as HandleItem | undefined;
      if (!item || item.kind !== "file") {
        return;
      }
      // A real file handle lets Save write back to the dropped file.
      if (item.getAsFileSystemHandle) {
        try {
          const handle = await item.getAsFileSystemHandle();
          if (handle && handle.kind === "file") {
            await openFromFile(await handle.getFile(), handle);
            return;
          }
        } catch {
          // fall through to a plain File
        }
      }
      const file = item.getAsFile();
      if (file) {
        await openFromFile(file, null);
      }
    });

    /* ---- editing ---- */

    // Edits go through execCommand("insertText"): deprecated, but the only way
    // to write into a textarea that lands on the browser's own undo stack.
    const replaceRange = (start: number, end: number, text: string) => {
      // execCommand writes into the focused element
      editor.focus();
      editor.setSelectionRange(start, end);
      let ok = false;
      try {
        ok = document.execCommand("insertText", false, text);
      } catch {
        ok = false;
      }
      if (!ok) {
        editor.setRangeText(text, start, end, "end");
        editor.dispatchEvent(new Event("input", { bubbles: true }));
      }
    };

    const selectedLines = () => {
      const v = editor.value;
      const start = v.lastIndexOf("\n", editor.selectionStart - 1) + 1;
      let end = v.indexOf("\n", editor.selectionEnd);
      if (end === -1) {
        end = v.length;
      }
      return { end, start, text: v.slice(start, end) };
    };

    const shiftLines = (outdent: boolean) => {
      const { start, end, text } = selectedLines();
      const from = editor.selectionStart;
      const to = editor.selectionEnd;
      let firstDelta = 0;
      let totalDelta = 0;
      const out = text
        .split("\n")
        .map((line, i) => {
          let delta: number;
          let shifted = line;
          if (outdent) {
            const lead = /^(?:\t| {1,2})/u.exec(line)?.[0] ?? "";
            delta = -lead.length;
            shifted = line.slice(lead.length);
          } else {
            // blank lines stay blank
            delta = line.length ? INDENT.length : 0;
            if (delta) {
              shifted = INDENT + line;
            }
          }
          if (i === 0) {
            firstDelta = delta;
          }
          totalDelta += delta;
          return shifted;
        })
        .join("\n");
      if (out === text) {
        return;
      }
      replaceRange(start, end, out);
      editor.setSelectionRange(
        Math.max(start, from + firstDelta),
        Math.max(start, to + totalDelta)
      );
    };

    /* ---- find and replace ----
       The browser's own find searches the rendered preview, never the source;
       replacements go through replaceRange so they land on the undo stack. */

    let matches: number[] = [];
    let matchIdx = -1;

    // A textarea shows no selection while another field has focus, so the
    // matches are painted on a mirror of the text behind it: same font,
    // padding, and wrapping, transparent text, a mark around each match.
    const paintMarks = () => {
      marks.replaceChildren();
      if (!matches.length || !el.classList.contains("find-open")) {
        return;
      }
      const text = editor.value;
      const len = findInput.value.length;
      const frag = document.createDocumentFragment();
      let last = 0;
      for (const [i, m] of matches.entries()) {
        frag.append(document.createTextNode(text.slice(last, m)));
        const mark = document.createElement("mark");
        if (i === matchIdx) {
          mark.className = "current";
        }
        mark.textContent = text.slice(m, m + len);
        frag.append(mark);
        last = m + len;
      }
      // a trailing newline would collapse without something after it
      frag.append(document.createTextNode(`${text.slice(last)}\u200B`));
      marks.append(frag);
      marks.scrollTop = editor.scrollTop;
    };
    const paintCount = () => {
      let count = "";
      if (findInput.value) {
        count = matches.length ? `${matchIdx + 1}/${matches.length}` : "0/0";
      }
      findCount.textContent = count;
      findCount.classList.toggle("none", !!findInput.value && !matches.length);
      for (const [i, m] of marks.querySelectorAll("mark").entries()) {
        m.classList.toggle("current", i === matchIdx);
      }
    };
    const runFind = (keepIndex: boolean) => {
      const q = findInput.value;
      matches = [];
      if (q) {
        const hay = editor.value.toLowerCase();
        const needle = q.toLowerCase();
        let i = hay.indexOf(needle);
        while (i !== -1) {
          matches.push(i);
          i = hay.indexOf(needle, i + needle.length);
        }
      }
      if (!keepIndex || matchIdx >= matches.length) {
        matchIdx = matches.length ? 0 : -1;
      }
      paintCount();
      paintMarks();
    };
    // Selects the current match and scrolls it into view. Focus stays in the
    // find bar while the user is typing or stepping; the editor takes it, with
    // the match selected, when the bar closes.
    const revealMatch = () => {
      const start = matches[matchIdx];
      if (start === undefined) {
        return;
      }
      const end = start + findInput.value.length;
      editor.setSelectionRange(start, end);
      // approximate, but enough to bring a match on screen in a wrapped textarea
      const line = editor.value.slice(0, start).split("\n").length - 1;
      // the computed line height is "normal" or a length in px
      const lh =
        Number(getComputedStyle(editor).lineHeight.replace(/px$/u, "")) || 20;
      const top = line * lh;
      if (
        top < editor.scrollTop ||
        top > editor.scrollTop + editor.clientHeight - lh * 2
      ) {
        editor.scrollTop = Math.max(0, top - editor.clientHeight / 3);
      }
      paintCount();
    };
    const stepMatch = (dir: number) => {
      if (!matches.length) {
        return;
      }
      matchIdx = (matchIdx + dir + matches.length) % matches.length;
      revealMatch();
    };
    const afterEdit = () => {
      scheduleRender();
      saveDraft();
    };
    // replaceRange has to focus the editor for execCommand; hand focus back afterwards.
    const keepingFocus = (fn: () => void) => {
      const active = document.activeElement as HTMLElement | null;
      fn();
      if (active && findBar.contains(active)) {
        active.focus();
      }
    };
    const replaceCurrent = () => {
      const start = matches[matchIdx];
      if (start === undefined) {
        return;
      }
      keepingFocus(() =>
        replaceRange(start, start + findInput.value.length, replaceInput.value)
      );
      afterEdit();
      runFind(true);
      revealMatch();
    };
    const replaceAll = () => {
      if (!matches.length) {
        return;
      }
      const q = findInput.value;
      const r = replaceInput.value;
      const n = matches.length;
      let out = "";
      let last = 0;
      for (const m of matches) {
        out += editor.value.slice(last, m) + r;
        last = m + q.length;
      }
      out += editor.value.slice(last);
      // one undo step for the lot
      keepingFocus(() => replaceRange(0, editor.value.length, out));
      afterEdit();
      runFind(false);
      setStatus(`Replaced ${n} occurrence${n === 1 ? "" : "s"}`);
    };
    const openFind = () => {
      if (view === "preview") {
        setView("split");
        write(VIEW_KEY, view);
      }
      el.classList.add("find-open");
      const sel = editor.value.slice(
        editor.selectionStart,
        editor.selectionEnd
      );
      if (sel && !sel.includes("\n")) {
        findInput.value = sel;
      }
      findInput.focus();
      findInput.select();
      runFind(false);
    };
    const closeFind = () => {
      el.classList.remove("find-open");
      marks.replaceChildren();
      editor.focus();
      revealMatch();
    };

    findInput.addEventListener("input", () => {
      runFind(false);
      revealMatch();
    });
    findInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        stepMatch(e.shiftKey ? -1 : 1);
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeFind();
      }
    });
    replaceInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        replaceCurrent();
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeFind();
      }
    });
    $(".find-next").addEventListener("click", () => stepMatch(1));
    $(".find-prev").addEventListener("click", () => stepMatch(-1));
    $(".find-replace").addEventListener("click", replaceCurrent);
    $(".find-all").addEventListener("click", replaceAll);
    $(".find-close").addEventListener("click", closeFind);

    /* ---- the editor's own input and keys, which reach into find ---- */

    editor.addEventListener("input", () => {
      scheduleRender();
      saveDraft();
      if (el.classList.contains("find-open")) {
        runFind(true);
      }
    });

    editor.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && el.classList.contains("find-open")) {
        closeFind();
        return;
      }
      if (e.key !== "Tab" || e.altKey || e.ctrlKey || e.metaKey) {
        return;
      }
      e.preventDefault();
      const spansLines = editor.value
        .slice(editor.selectionStart, editor.selectionEnd)
        .includes("\n");
      if (e.shiftKey) {
        shiftLines(true);
      } else if (spansLines) {
        shiftLines(false);
      } else {
        replaceRange(editor.selectionStart, editor.selectionEnd, INDENT);
      }
    });

    /* ---- buttons and shortcuts ---- */

    $(".open-btn").addEventListener("click", openPicker);
    $(".save-btn").addEventListener("click", save);
    $(".pdf-btn").addEventListener("click", exportPdf);

    /* ---- Format: the Draft rewritten in one canonical style, as one undo step ---- */

    const formatBtn = $<HTMLButtonElement>(".format-btn");
    const formatDraft = async () => {
      if (formatBtn.disabled || !editor.value.trim()) {
        return;
      }
      formatBtn.disabled = true;
      formatBtn.setAttribute("aria-busy", "true");
      try {
        const format = await loadFormatter();
        const before = editor.value;
        const after = await format(before);
        // edited meanwhile: leave it
        if (before !== editor.value) {
          return;
        }
        if (after === before) {
          setStatus("Already formatted");
          return;
        }
        const top = editor.scrollTop;
        keepingFocus(() => replaceRange(0, before.length, after));
        editor.scrollTop = top;
        afterEdit();
        setStatus("Formatted");
      } catch (error) {
        setStatus(
          `Could not format: ${error instanceof Error ? error.message : String(error)}`
        );
      } finally {
        formatBtn.disabled = false;
        formatBtn.removeAttribute("aria-busy");
      }
    };
    formatBtn.addEventListener("click", formatDraft);

    window.addEventListener("keydown", (e) => {
      if (el.hidden) {
        return;
      }
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod) {
        return;
      }
      const k = e.key.toLowerCase();
      if (k === "s") {
        e.preventDefault();
        if (e.shiftKey) {
          saveAs();
        } else {
          save();
        }
      } else if (k === "o") {
        e.preventDefault();
        openPicker();
      } else if (k === "f" && view !== "preview") {
        e.preventDefault();
        openFind();
      } else if (k === "e") {
        // Edit and Preview trade places; Split counts as editing.
        e.preventDefault();
        setView(view === "preview" ? "edit" : "preview");
        write(VIEW_KEY, view);
        if (view === "edit") {
          editor.focus();
        }
      }
    });

    /* ---- layout: Contents becomes a drawer, and Split stacks, by the Tool's own width ---- */

    const narrowViewport = window.matchMedia("(max-width: 767px)");
    const layout = (width: number) => {
      // hidden: nothing to judge
      if (!width) {
        return;
      }
      const wasDrawer = isDrawer();
      el.classList.toggle("toc-drawer", width < DRAWER_WIDTH);
      el.classList.toggle("stacked", width < STACK_WIDTH);
      // A column that turns into a drawer would cover the page: close it, and
      // bring the column back from the Preference once there is room again.
      if (isDrawer() && !wasDrawer && tocOpen) {
        setToc(false);
      } else if (!isDrawer() && wasDrawer) {
        setToc(read(TOC_KEY) !== "0");
      }
    };
    layout(el.getBoundingClientRect().width);
    new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      layout(w);
      if (w) {
        spy();
      }
    }).observe(el);

    /* ---- boot ---- */

    const storedView = read(VIEW_KEY);
    const startView: View =
      storedView === "edit" || storedView === "split" ? storedView : "preview";
    setView(narrowViewport.matches ? "preview" : startView);
    // A drawer opened on load would cover the page; start closed there.
    setToc(read(TOC_KEY) !== "0" && !isDrawer());
    previewPane.classList.toggle("light", light);
    lightBtn.classList.toggle("toggled", light);
    lightBtn.setAttribute("aria-pressed", String(light));
    if (!loadDraft()) {
      editor.value = welcome(MOD);
    }
    render();
    // Focusing a textarea lands the caret at the end and scrolls there; start at the top.
    editor.setSelectionRange(0, 0);
    editor.scrollTop = 0;
    previewPane.scrollTop = 0;
    booted = true;
    queueMicrotask(publishState);
  },
  name: "Markdown Editor",
  subtitle: "Edit Markdown beside a live preview, with math and diagrams.",
};

export default tool;
