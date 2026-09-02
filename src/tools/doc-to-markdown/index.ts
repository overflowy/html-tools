import "./tool.css";
import type { Tool } from "../../shell/types";
import { ACCEPT } from "./detect";
import { cacheAvailable, clearCached, listCached } from "./engines";
import { LANGUAGES, languageName } from "./languages";
import { cancelConversion, convertDocument, type Phase } from "./convert";

const LANG_KEY = "html-tools:doc-to-markdown:langs";
const DEFAULT_LANGS = ["eng"];

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatBytes(n: number) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

function baseName(name: string) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name || "document";
}

function downloadText(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function flash(btn: HTMLButtonElement, label: string) {
  const prev = btn.textContent;
  btn.textContent = label;
  setTimeout(() => (btn.textContent = prev), 1200);
}

/** Only codes the picker knows; order as picked, English first if present. */
function normalizeLangs(codes: string[]): string[] {
  const known = new Set(LANGUAGES.map((l) => l.code));
  const out: string[] = [];
  for (const c of codes) if (known.has(c) && !out.includes(c)) out.push(c);
  return out.length ? out : DEFAULT_LANGS.slice();
}

const tool: Tool = {
  id: "doc-to-markdown",
  name: "Document to Markdown",
  subtitle: "Convert Word, Excel, PowerPoint, PDF and more to Markdown; scanned pages and images go through OCR.",
  keywords: ["ocr", "pdf", "docx", "word", "xlsx", "excel", "pptx", "powerpoint", "odt", "epub", "rtf", "csv", "markdown", "scan", "tesseract", "convert", "image", "text", "extract"],
  mount(el, ctx) {
    el.innerHTML = `
      <div class="toolbar">
        <button type="button" class="choose-btn">Choose file</button>
        <details class="langs">
          <summary title="Languages used when a page or image goes through OCR"></summary>
          <div class="lang-panel">
            <input type="search" class="lang-filter" placeholder="Filter languages" aria-label="Filter languages">
            <div class="lang-list"></div>
          </div>
        </details>
        <button type="button" class="clear-btn">Clear</button>
        <span class="status"></span>
      </div>
      <input type="file" class="file-input" accept="${ACCEPT}" hidden>
      <div class="empty-hint">
        <strong>Drop a document anywhere here</strong>, choose a file, or paste an image with &#8984;V.
        <span>Word, PowerPoint, Excel, OpenDocument, RTF, EPUB, CSV, PDF, or an image.</span>
        <span>Pages without a text layer and images go through OCR.</span>
        <span>Nothing you drop leaves the browser. The converters are downloaded on first use and kept locally.</span>
      </div>
      <div class="progress">
        <span class="phase"></span>
        <div class="bar"><div class="fill"></div></div>
        <button type="button" class="cancel-btn">Cancel</button>
      </div>
      <div class="note"></div>
      <div class="result">
        <div class="pane-head">
          markdown
          <span class="meta"></span>
          <span class="spacer"></span>
          <button type="button" class="copy-btn">Copy</button>
          <button type="button" class="download-btn">Download<span class="wide-only"> .md</span></button>
        </div>
        <textarea class="output" readonly spellcheck="false" aria-label="Markdown output"></textarea>
      </div>
      <div class="error-box"></div>
      <div class="engines">
        <span class="engines-text"></span>
        <button type="button" class="engines-clear" hidden>Clear cached engines</button>
      </div>`;

    const $ = (sel: string) => el.querySelector(sel) as HTMLElement;
    const fileInput = $(".file-input") as HTMLInputElement;
    const status = $(".status");
    const emptyHint = $(".empty-hint");
    const progress = $(".progress");
    const phase = $(".phase");
    const bar = $(".bar");
    const fill = $(".fill");
    const note = $(".note");
    const result = $(".result");
    const meta = $(".meta");
    const output = $(".output") as HTMLTextAreaElement;
    const errorBox = $(".error-box");
    const enginesText = $(".engines-text");
    const enginesClear = $(".engines-clear") as HTMLButtonElement;
    const langs = $(".langs") as HTMLDetailsElement;
    const langSummary = $(".langs summary");
    const langFilter = $(".lang-filter") as HTMLInputElement;
    const langList = $(".lang-list");

    let selected = normalizeLangs((localStorage.getItem(LANG_KEY) ?? "").split("+"));
    let currentName = "";
    let currentMarkdown = "";
    let running = false;
    /** Which load() owns the screen; a superseded one must not touch it. */
    let runId = 0;

    /* ---- languages ---- */

    langList.innerHTML = LANGUAGES.map((l) =>
      `<label><input type="checkbox" value="${l.code}"> <span class="name">${esc(l.name)}</span><span class="code">${l.code}</span></label>`,
    ).join("");
    const boxes = Array.from(langList.querySelectorAll("input")) as HTMLInputElement[];

    function renderLangs() {
      for (const b of boxes) b.checked = selected.includes(b.value);
      const names = selected.map(languageName);
      const shown = names.length > 2 ? names.slice(0, 2).join(", ") + " +" + (names.length - 2) : names.join(", ");
      langSummary.innerHTML = `<span class="dim">OCR:</span> ${esc(shown)}`;
    }

    function publishState() {
      localStorage.setItem(LANG_KEY, selected.join("+"));
      ctx.setState(selected.join("+") === DEFAULT_LANGS.join("+") ? "" : selected.join("+"));
    }

    langList.addEventListener("change", () => {
      const picked = boxes.filter((b) => b.checked).map((b) => b.value);
      // Keep at least one language: OCR without a model is not a choice.
      selected = picked.length ? picked : selected.slice(0, 1);
      renderLangs();
      publishState();
    });

    langFilter.addEventListener("input", () => {
      const q = langFilter.value.trim().toLowerCase();
      let any = false;
      for (const label of Array.from(langList.querySelectorAll("label"))) {
        const hit = !q || label.textContent!.toLowerCase().includes(q);
        label.hidden = !hit;
        any = any || hit;
      }
      let none = langList.querySelector(".lang-none") as HTMLElement | null;
      if (!any && !none) {
        none = document.createElement("div");
        none.className = "lang-none";
        none.textContent = "No language matches.";
        langList.appendChild(none);
      } else if (any && none) none.remove();
    });

    // The filter is reset on close, not open: toggle fires a task after the
    // click, and a quick typist has letters in the box by then.
    langs.addEventListener("toggle", () => {
      if (langs.open) {
        langFilter.focus();
      } else if (langFilter.value) {
        langFilter.value = "";
        langFilter.dispatchEvent(new Event("input"));
      }
    });
    // Click outside or Escape closes the panel.
    document.addEventListener("pointerdown", (e) => {
      if (langs.open && !langs.contains(e.target as Node)) langs.open = false;
    });
    langs.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && langs.open) {
        langs.open = false;
        langSummary.focus();
      }
    });

    ctx.onRestore((payload) => {
      if (payload) selected = normalizeLangs(payload.split("+"));
      renderLangs();
      publishState();
    });
    renderLangs();

    /* ---- engines footer ---- */

    async function renderEngines() {
      const ok = await cacheAvailable();
      if (!ok) {
        enginesText.textContent = "Engines cannot be kept here (no IndexedDB); they download on every conversion.";
        enginesClear.hidden = true;
        return;
      }
      const rows = await listCached();
      if (rows.length === 0) {
        enginesText.textContent = "No engines cached yet. They download on first use and stay here for next time.";
        enginesClear.hidden = true;
        return;
      }
      const total = rows.reduce((n, r) => n + r.bytes, 0);
      const parts = rows.map((r) => r.label + " " + formatBytes(r.bytes));
      enginesText.textContent = "Engines cached (" + formatBytes(total) + "): " + parts.join(", ");
      enginesClear.hidden = false;
    }
    enginesClear.addEventListener("click", async () => {
      if (running) return;
      enginesClear.disabled = true;
      try {
        await clearCached();
      } finally {
        enginesClear.disabled = false;
      }
      renderEngines();
    });
    renderEngines();

    /* ---- conversion ---- */

    function showError(msg: string) {
      errorBox.textContent = msg;
      errorBox.classList.add("on");
    }

    function setPhase(p: Phase) {
      phase.textContent = p.text;
      if (p.fraction === null) {
        bar.classList.add("busy");
        fill.style.width = "";
      } else {
        bar.classList.remove("busy");
        fill.style.width = Math.round(Math.max(0, Math.min(1, p.fraction)) * 100) + "%";
      }
    }

    function reset() {
      if (running) cancelConversion();
      runId++;
      running = false;
      currentName = "";
      currentMarkdown = "";
      output.value = "";
      status.textContent = "";
      errorBox.classList.remove("on");
      note.classList.remove("on");
      result.classList.remove("on");
      progress.classList.remove("on");
      emptyHint.style.display = "block";
    }

    async function load(blob: Blob, name: string) {
      if (running) cancelConversion();
      const id = ++runId;
      running = true;
      currentName = name;
      currentMarkdown = "";
      status.textContent = name || "pasted image";
      errorBox.classList.remove("on");
      note.classList.remove("on");
      result.classList.remove("on");
      emptyHint.style.display = "none";
      progress.classList.add("on");
      setPhase({ text: "Reading file", fraction: null });
      try {
        const bytes = await blob.arrayBuffer();
        if (id !== runId) return;
        const out = await convertDocument(bytes, name, { languages: selected.slice(), onPhase: (p) => id === runId && setPhase(p) });
        if (id !== runId) return;
        currentMarkdown = out.markdown;
        output.value = out.markdown;
        meta.textContent = out.summary;
        result.classList.add("on");
      } catch (e) {
        if (id !== runId) return;
        const msg = e instanceof Error ? e.message : String(e);
        if (msg !== "The conversion was cancelled.") showError(msg);
        else emptyHint.style.display = "block";
      } finally {
        if (id === runId) {
          running = false;
          progress.classList.remove("on");
          renderEngines();
        }
      }
    }

    $(".cancel-btn").addEventListener("click", () => {
      if (running) cancelConversion();
    });

    $(".copy-btn").addEventListener("click", async () => {
      if (!currentMarkdown) return;
      try {
        await navigator.clipboard.writeText(currentMarkdown);
        flash($(".copy-btn") as HTMLButtonElement, "Copied");
      } catch {
        output.select();
        document.execCommand("copy");
        flash($(".copy-btn") as HTMLButtonElement, "Copied");
      }
    });

    $(".download-btn").addEventListener("click", () => {
      if (!currentMarkdown) return;
      downloadText(currentMarkdown, baseName(currentName) + ".md");
    });

    $(".choose-btn").addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      if (file) load(file, file.name);
      fileInput.value = "";
    });

    $(".clear-btn").addEventListener("click", reset);

    // Drop a document anywhere on the tool
    let dragDepth = 0;
    el.addEventListener("dragenter", (e) => {
      e.preventDefault();
      dragDepth++;
      el.classList.add("dragging");
    });
    el.addEventListener("dragover", (e) => e.preventDefault());
    el.addEventListener("dragleave", () => {
      if (--dragDepth <= 0) {
        dragDepth = 0;
        el.classList.remove("dragging");
      }
    });
    el.addEventListener("drop", (e) => {
      e.preventDefault();
      dragDepth = 0;
      el.classList.remove("dragging");
      const files = e.dataTransfer?.files;
      const file = files?.[0];
      if (!file) return;
      load(file, file.name);
      if (files && files.length > 1) {
        note.textContent = "One Document at a time: converting " + file.name + ", the other " + (files.length - 1) + " ignored.";
        note.classList.add("on");
      }
    });

    // Cmd+V anywhere in the tool with an image on the clipboard
    document.addEventListener("paste", (e) => {
      if (el.hidden) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.kind === "file") {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            load(file, file.name || "");
            return;
          }
        }
      }
    });
  },
};

export default tool;
