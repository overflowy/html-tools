import "./tool.css";
import type * as Monaco from "monaco-editor";
import type { Tool, ToolContext } from "../../shell/types";
import { Checker } from "./checker";
import { configureJson, createEditor, defineTheme, LinterBinding, registerToml } from "./editor";
import { loadMonaco, loadPyodideAssets, loadPyrightWorkerUrl, loadTerminal, PYODIDE_VERSION, type LoadProgress, type MonacoApi } from "./engines";
import { renderPackages, renderTree, specName, type PackageRow } from "./explorer";
import * as I from "./icons";
import { Interpreter } from "./interpreter";
import {
  basename, defaultPyproject, isText, isTextPath, languageFor, looksLikeText, normalizePath,
  Project, PROJECT_FILE, updatePyproject, type ProjectFile,
} from "./project";
import type { RunResult } from "./py-worker";
import { Linter } from "./ruff";
import { clearWheels, getMirror, listProjects, putMirror, storageAvailable } from "./store";
import { IdeTerminal } from "./terminal";
import { readZip, writeZip } from "./zip";

const LAST_PROJECT_KEY = "html-tools:python-ide:project";
const WHEELS_KEY = "html-tools:python-ide:wheels-pyodide";
const EXPLORER_WIDTH_KEY = "html-tools:python-ide:explorer-width";
const PANEL_HEIGHT_KEY = "html-tools:python-ide:panel-height";
const PANEL_OPEN_KEY = "html-tools:python-ide:panel-open";

const isMac = /Mac|iPhone|iPad/.test(navigator.platform || "");
const MOD = isMac ? "⌘" : "Ctrl+";

/** Pyright's view of the `js` module Pyodide exposes: anything goes. */
const JS_STUB = "from typing import Any\n\ndef __getattr__(name: str) -> Any: ...\n";

type InterpState = "off" | "booting" | "ready" | "running" | "installing" | "rebooting";
type PanelTab = "terminal" | "problems";

interface Session {
  project: Project;
  interpreter: Interpreter | null;
  state: InterpState;
  python: string;
  jspi: boolean;
  checker: Checker | null;
  mirror: { lock: string; files: Record<string, string> } | null;
  models: Map<string, Monaco.editor.ITextModel>;
  viewStates: Map<string, Monaco.editor.ICodeEditorViewState | null>;
  tabs: string[];
  active: string | null;
  expanded: Set<string>;
  /** Folders created but still empty: only files persist, so these live until reload. */
  extraFolders: Set<string>;
  /** Paths edited since the interpreter last saw them. */
  dirty: Set<string>;
  pendingInput: number | null;
  figures: string[];
  /** Bumped when the session closes, so async work for it stops. */
  generation: number;
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable: the visit still works
  }
}

function saveBlob(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function formatBytes(n: number): string {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

const tool: Tool = {
  id: "python-ide",
  name: "Python IDE",
  subtitle: "Edit and run Python projects in the browser: Pyodide, Pyright, Ruff, and a terminal, with packages per project.",
  keywords: ["python", "ide", "pyodide", "pyright", "ruff", "editor", "repl", "terminal", "pip", "notebook", "matplotlib"],
  fullHeight: true,
  mount(el, ctx) {
    el.innerHTML = `
      <div class="ide">
        <div class="ide-body">
          <aside class="explorer">
            <div class="explorer-head">
              <select class="project-select" aria-label="Project"></select>
              <button type="button" class="icon project-menu-btn" title="Project actions" aria-label="Project actions">${I.ICON_MORE}</button>
            </div>
            <div class="section files">
              <div class="section-head">
                <span>Files</span>
                <span class="spacer"></span>
                <button type="button" class="icon new-file-btn" title="New file">${I.ICON_NEW_FILE}</button>
                <button type="button" class="icon new-folder-btn" title="New folder">${I.ICON_NEW_FOLDER}</button>
                <button type="button" class="icon upload-btn" title="Upload files">${I.ICON_UPLOAD}</button>
              </div>
              <div class="tree" role="tree"></div>
            </div>
            <div class="section packages">
              <div class="section-head"><span>Packages</span></div>
              <form class="install-row">
                <input class="install-input" placeholder="Add a package" title="A name, or a pinned spec like requests==2.33" spellcheck="false" autocomplete="off" aria-label="Package to install" role="combobox" aria-expanded="false" aria-autocomplete="list">
                <button type="submit" class="install-btn">Add</button>
                <div class="catalog-list" role="listbox" hidden></div>
              </form>
              <div class="pkg-direct"></div>
              <details class="pkg-transitive-wrap"><summary>Dependencies of dependencies</summary><div class="pkg-transitive"></div></details>
            </div>
          </aside>
          <div class="explorer-resizer" role="separator" aria-orientation="vertical"></div>
          <div class="workbench">
            <div class="runbar">
              <button type="button" class="run-btn primary" title="Run the current file (${MOD}Enter)">${I.ICON_RUN}<span>Run</span></button>
              <button type="button" class="stop-btn" title="Stop the program" hidden>${I.ICON_STOP}<span>Stop</span></button>
              <button type="button" class="icon restart-btn" title="Restart the interpreter">${I.ICON_RESTART}</button>
              <button type="button" class="icon format-btn" title="Format with Ruff (Shift+Alt+F)">${I.ICON_FORMAT}</button>
              <button type="button" class="icon stdin-btn" title="Stdin: text for input() to read first" aria-pressed="false">${I.ICON_STDIN}</button>
              <span class="spacer"></span>
              <button type="button" class="icon figures-btn" title="Figures" aria-pressed="false" hidden>${I.ICON_FIGURE}<span class="badge"></span></button>
              <button type="button" class="icon sidebar-btn" title="Show or hide the tool list" aria-label="Tool list" aria-pressed="true">${I.ICON_SIDEBAR}</button>
              <button type="button" class="icon panel-btn" title="Terminal and Problems (${MOD}J)" aria-pressed="true">${I.ICON_PANEL}</button>
              <button type="button" class="icon quickopen-btn" title="Open a file by name (${MOD}P)">${I.ICON_SEARCH}</button>
              <button type="button" class="icon settings-btn" title="Project settings">${I.ICON_SETTINGS}</button>
            </div>
            <div class="stdin-row" hidden>
              <textarea class="stdin" rows="3" placeholder="Lines for input() to read before it asks the terminal" spellcheck="false" aria-label="Stdin"></textarea>
            </div>
            <div class="tabs" role="tablist"></div>
            <div class="editor-host"></div>
            <div class="editor-empty">No file open. Pick one in the Explorer, or press ${MOD}P.</div>
            <div class="panel-resizer" role="separator" aria-orientation="horizontal"></div>
            <div class="panel">
              <div class="panel-head" role="tablist">
                <button type="button" class="panel-tab" role="tab" data-panel="terminal" aria-selected="true">Terminal</button>
                <button type="button" class="panel-tab" role="tab" data-panel="problems" aria-selected="false">Problems<span class="badge problems-count" hidden></span></button>
                <span class="spacer"></span>
                <button type="button" class="icon terminal-copy" title="Copy the terminal's output">${I.ICON_COPY}</button>
                <button type="button" class="icon terminal-clear" title="Clear the terminal">${I.ICON_CLEAR}</button>
                <button type="button" class="icon terminal-close" title="Close the panel (${MOD}J)">${I.ICON_CLOSE}</button>
              </div>
              <div class="panel-body" data-panel="terminal">
                <div class="terminal-host"></div>
                <div class="figures" hidden>
                  <div class="figures-head"><span>Figures</span><span class="spacer"></span><button type="button" class="icon figures-clear" title="Clear figures">${I.ICON_CLOSE}</button></div>
                  <div class="figures-list"></div>
                </div>
                <div class="problems" role="list"></div>
              </div>
            </div>
          </div>
        </div>
        <div class="statusbar">
          <span class="st-python">Python</span>
          <span class="st-interp">starting</span>
          <span class="st-checker">Pyright</span>
          <span class="st-engine"></span>
          <span class="spacer"></span>
          <span class="st-message"></span>
          <span class="st-cursor"></span>
          <span class="st-lang"></span>
        </div>
        <div class="context-menu" hidden></div>
        <div class="quickopen" hidden><input class="quickopen-input" placeholder="Open file" spellcheck="false" autocomplete="off" aria-label="Open file"><div class="quickopen-list"></div></div>
      </div>
      <div class="narrow-message">The Python IDE needs a wider window: at least 768px.</div>
      <div class="drop-overlay"><div class="card">Drop files into the project<div class="sub">Files and folders. Nothing leaves your browser.</div></div></div>
      <input type="file" class="file-input" multiple hidden>
      <input type="file" class="zip-input" accept=".zip,application/zip" hidden>
      <dialog class="settings-dialog"></dialog>
      <dialog class="prompt-dialog"><form method="dialog"><label class="prompt-label"></label><input class="prompt-input" spellcheck="false" autocomplete="off"><div class="prompt-actions"><button type="button" class="prompt-cancel">Cancel</button><button type="submit" class="primary prompt-ok">OK</button></div></form></dialog>`;
    // The instance lives on through the listeners it binds to `el`.
    void new Ide(el, ctx);
  },
};

export default tool;

class Ide {
  private $: (sel: string) => HTMLElement;
  private monaco!: MonacoApi;
  private editor!: Monaco.editor.IStandaloneCodeEditor;
  private linter = new Linter();
  private linterBinding: LinterBinding | null = null;
  private terminal: IdeTerminal | null = null;
  private pyrightUrl: string | null = null;
  private session: Session | null = null;
  private projects: { id: string; name: string }[] = [];
  private catalog: { name: string; version: string }[] = [];
  private saveTimers = new Map<string, number>();
  private engineProgress = new Map<string, [number, number]>();
  private editorReady: Promise<void>;
  private terminalReady: Promise<void>;
  private pendingRestore: { id: string; path: string } | null = null;

  constructor(private el: HTMLElement, private ctx: ToolContext) {
    this.$ = (sel) => el.querySelector(sel) as HTMLElement;
    this.bindUi();
    this.editorReady = this.setupEditor();
    this.terminalReady = this.setupTerminal();
    void this.linter.load(this.progress("Ruff")).then(() => this.message("Ruff " + this.linter.version + " ready")).catch((e) => this.message("Ruff failed: " + e.message));
    void loadPyrightWorkerUrl(this.progress("Pyright")).then((url) => {
      this.pyrightUrl = url;
      if (this.session && !this.session.checker) this.restartChecker();
    }).catch((e) => this.message("Pyright failed: " + e.message));
    void loadPyodideAssets(this.progress("Pyodide")).then((assets) => this.readCatalog(assets.lock)).catch(() => {});
    ctx.onRestore((payload) => this.restore(payload));
    void this.start();
  }

  /* ---------------- startup ---------------- */

  private async start() {
    if (!(await storageAvailable())) this.message("Storage is unavailable here: projects will not survive a reload.");
    // Wheels of another Pyodide release are useless; the catalog names its release in every URL.
    if (read(WHEELS_KEY) !== PYODIDE_VERSION) {
      await clearWheels();
      write(WHEELS_KEY, PYODIDE_VERSION);
    }
    await this.refreshProjects();
    const wanted = this.pendingRestore;
    this.pendingRestore = null;
    let id = wanted?.id ?? read(LAST_PROJECT_KEY);
    if (!id || !this.projects.some((p) => p.id === id)) id = this.projects[0]?.id ?? null;
    if (!id) {
      const p = await Project.create("hello");
      await this.refreshProjects();
      id = p.id;
    }
    await this.openProject(id, wanted?.path);
  }

  private async setupEditor() {
    const monaco = await loadMonaco(this.progress("Monaco"));
    this.monaco = monaco;
    defineTheme(monaco);
    registerToml(monaco);
    configureJson(monaco);
    this.editor = createEditor(monaco, this.$(".editor-host"), 4);
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => void this.run());
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP, () => this.openQuickOpen());
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyJ, () => this.togglePanel());
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyM, () => this.showPanelTab("problems"));
    monaco.editor.onDidChangeMarkers(() => this.scheduleProblems());
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => this.message("Saved as you type."));
    this.editor.onDidChangeCursorPosition((e) => {
      this.$(".st-cursor").textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`;
    });
    monaco.editor.registerEditorOpener({
      openCodeEditor: (_source, resource, selection) => this.openResource(resource, selection),
    });
    this.linterBinding = new LinterBinding(monaco, this.linter, (m) => this.message(m));
    this.message("Editor ready");
  }

  private async setupTerminal() {
    const api = await loadTerminal(this.progress("xterm"));
    this.terminal = new IdeTerminal(api, this.$(".terminal-host"), {
      onLine: (line, mode) => this.onTerminalLine(line, mode),
      onInterrupt: () => void this.stop(),
      onComplete: (source) => this.session?.interpreter && this.session.state === "ready" ? this.session.interpreter.complete(source) : Promise.resolve({ completions: [], start: 0 }),
      onResize: (cols, rows) => this.session?.interpreter?.resize(cols, rows),
    });
  }

  private readCatalog(lockJson: string) {
    try {
      const lock = JSON.parse(lockJson) as { packages: Record<string, { name: string; version: string; package_type: string }> };
      this.catalog = Object.values(lock.packages).filter((p) => p.package_type === "package").map((p) => ({ name: p.name, version: p.version })).toSorted((a, b) => a.name.localeCompare(b.name));
    } catch {
      // the catalog is a convenience
    }
  }

  /**
   * Catalog suggestions under the install field, in the quick open's style:
   * the native datalist cannot be styled. Names starting with the typed text
   * come first, then names containing it; up to eight.
   */
  private bindCatalog() {
    const input = this.$(".install-input") as HTMLInputElement;
    const list = this.$(".catalog-list");
    let cursor = -1;
    let matches: { name: string; version: string }[] = [];
    const render = () => {
      const q = specName(input.value.trim());
      const raw = input.value.trim().toLowerCase();
      if (!raw) {
        // Nothing typed yet: say what the field takes, where the suggestions will appear.
        list.replaceChildren();
        const hint = document.createElement("div");
        hint.className = "catalog-hint";
        hint.innerHTML = 'A name, like <code>numpy</code>, or a pinned spec, like <code>requests==2.33</code> or <code>pydantic>=2</code>. Prebuilt packages are suggested as you type; anything else comes from PyPI.';
        list.appendChild(hint);
        list.hidden = false;
        matches = [];
        return;
      }
      if (/[=<>!~\s]/.test(raw)) return this.hideCatalog();
      const starts = this.catalog.filter((p) => p.name.toLowerCase().startsWith(q));
      const contains = this.catalog.filter((p) => !p.name.toLowerCase().startsWith(q) && p.name.toLowerCase().includes(q));
      matches = [...starts, ...contains].slice(0, 8);
      if (matches.length === 0) return this.hideCatalog();
      cursor = Math.min(cursor, matches.length - 1);
      list.replaceChildren();
      matches.forEach((p, i) => {
        const row = document.createElement("div");
        row.className = "catalog-row" + (i === cursor ? " cursor" : "");
        row.setAttribute("role", "option");
        row.innerHTML = `<span class="catalog-name"></span><span class="catalog-version"></span>`;
        row.querySelector(".catalog-name")!.textContent = p.name;
        row.querySelector(".catalog-version")!.textContent = p.version;
        row.addEventListener("mousedown", (e) => {
          e.preventDefault();
          choose(p.name);
        });
        list.appendChild(row);
      });
      list.hidden = false;
      input.setAttribute("aria-expanded", "true");
    };
    const choose = (name: string) => {
      input.value = name;
      this.hideCatalog();
      input.focus();
    };
    input.addEventListener("input", () => {
      cursor = -1;
      render();
    });
    input.addEventListener("focus", render);
    input.addEventListener("blur", () => this.hideCatalog());
    input.addEventListener("keydown", (e) => {
      if (list.hidden) {
        if (e.key === "ArrowDown") {
          cursor = 0;
          render();
          e.preventDefault();
        }
        return;
      }
      if (e.key === "ArrowDown") {
        cursor = Math.min(cursor + 1, matches.length - 1);
        render();
        e.preventDefault();
      } else if (e.key === "ArrowUp") {
        cursor = Math.max(cursor - 1, -1);
        render();
        e.preventDefault();
      } else if (e.key === "Enter" && cursor >= 0) {
        choose(matches[cursor]!.name);
        e.preventDefault();
      } else if (e.key === "Escape") {
        this.hideCatalog();
        e.stopPropagation();
      }
    });
  }

  private hideCatalog() {
    this.$(".catalog-list").hidden = true;
    this.$(".install-input").setAttribute("aria-expanded", "false");
  }

  /* ---------------- status ---------------- */

  private progress(label: string): LoadProgress {
    return (loaded, total) => {
      this.engineProgress.set(label, [loaded, total]);
      let l = 0, t = 0, active = 0;
      for (const [a, b] of this.engineProgress.values()) {
        if (a < b) {
          active++;
          l += a;
          t += b;
        }
      }
      const el = this.$(".st-engine");
      if (active === 0) {
        el.textContent = "";
        el.removeAttribute("style");
        return;
      }
      const names = [...this.engineProgress.entries()].filter(([, [a, b]]) => a < b).map(([n]) => n).join(", ");
      el.textContent = `Loading ${names}: ${formatBytes(l)} / ${formatBytes(t)}`;
      el.style.setProperty("--p", String(t ? l / t : 0));
    };
  }

  private message(text: string) {
    const el = this.$(".st-message");
    el.textContent = text;
    el.title = text;
  }

  private setState(state: InterpState) {
    const s = this.session;
    if (!s) return;
    s.state = state;
    const labels: Record<InterpState, string> = {
      off: "interpreter off", booting: "booting", ready: "ready", running: "running", installing: "installing", rebooting: "restarting",
    };
    this.$(".st-interp").textContent = labels[state];
    this.$(".st-interp").dataset.state = state;
    this.$(".st-python").textContent = s.python ? `Python ${s.python}` : "Python";
    const running = state === "running";
    (this.$(".run-btn") as HTMLButtonElement).hidden = running;
    (this.$(".stop-btn") as HTMLButtonElement).hidden = !running;
    (this.$(".run-btn") as HTMLButtonElement).disabled = state !== "ready" || !this.isPython(s.active);
    (this.$(".restart-btn") as HTMLButtonElement).disabled = state === "booting" || state === "rebooting";
    (this.$(".install-btn") as HTMLButtonElement).disabled = state !== "ready";
    this.el.classList.toggle("running", running);
  }

  private setCheckerStatus(text: string) {
    this.$(".st-checker").textContent = text;
  }

  private isPython(path: string | null): boolean {
    return !!path && /\.py$/i.test(path);
  }

  /* ---------------- projects ---------------- */

  private async refreshProjects() {
    this.projects = (await listProjects()).map((p) => ({ id: p.id, name: p.name }));
    const select = this.$(".project-select") as HTMLSelectElement;
    select.replaceChildren();
    for (const p of this.projects) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name;
      select.appendChild(opt);
    }
    if (this.session) select.value = this.session.project.id;
  }

  private opening: Promise<void> = Promise.resolve();

  /** Opens a Project, after any open already in progress: two at once would race for the editor. */
  private openProject(id: string, path?: string): Promise<void> {
    this.opening = this.opening.then(() => this.doOpenProject(id, path)).catch((e) => this.message("Could not open the project: " + (e instanceof Error ? e.message : String(e))));
    return this.opening;
  }

  private async doOpenProject(id: string, path?: string) {
    if (this.session?.project.id === id) {
      if (path) this.openFile(path);
      return;
    }
    this.closeProject();
    const project = await Project.open(id);
    if (!project) return;
    const session: Session = {
      project,
      interpreter: null,
      state: "off",
      python: "",
      jspi: false,
      checker: null,
      mirror: null,
      models: new Map(),
      viewStates: new Map(),
      tabs: [],
      active: null,
      expanded: new Set(project.folders()),
      extraFolders: new Set(),
      dirty: new Set(),
      pendingInput: null,
      figures: [],
      generation: 0,
    };
    this.session = session;
    write(LAST_PROJECT_KEY, id);
    (this.$(".project-select") as HTMLSelectElement).value = id;
    this.$(".stdin").textContent = "";
    (this.$(".stdin") as HTMLTextAreaElement).value = "";
    this.clearFigures();
    this.renderTree();
    this.renderPackages();
    this.setState("off");
    this.setCheckerStatus("Pyright: starting");
    await this.editorReady;
    if (this.session !== session) return;
    for (const f of project.files.values()) if (isText(f)) this.ensureModel(f.path, f.text);
    this.applyEditorOptions();
    for (const t of project.record.openTabs) if (project.files.has(t)) session.tabs.push(t);
    const first = path && project.files.has(path) ? path : project.record.activeFile && project.files.has(project.record.activeFile) ? project.record.activeFile : session.tabs[0] ?? null;
    if (first) this.openFile(first);
    else this.showActive();
    this.updateDeepLink();
    await this.linter.configure(project.settings.ruff).catch((e) => this.message("Ruff settings: " + e.message));
    this.linterBinding?.invalidate(session.models.values());
    if (project.record.lock) {
      const stored = await getMirror(project.id);
      if (stored && stored.lock === project.record.lock) session.mirror = { lock: stored.lock, files: stored.files };
    }
    if (this.session !== session) return;
    this.restartChecker();
    await this.terminalReady;
    if (this.session !== session) return;
    this.terminal?.reset();
    void this.bootInterpreter();
  }

  private closeProject() {
    const s = this.session;
    if (!s) return;
    s.generation++;
    this.flushSaves();
    s.interpreter?.terminate();
    s.checker?.dispose();
    this.editor?.setModel(null);
    for (const m of s.models.values()) {
      this.linterBinding?.forget(m);
      m.dispose();
    }
    // Models the Checker made for Mirror files.
    if (this.monaco) for (const m of this.monaco.editor.getModels()) if (!m.uri.path.startsWith("/project/")) m.dispose();
    this.terminal?.stopLine();
    this.session = null;
    this.scheduleProblems();
  }

  private async newProject() {
    const name = await this.ask("New project name", "");
    if (!name) return;
    const p = await Project.create(name.trim());
    await this.refreshProjects();
    await this.openProject(p.id);
  }

  private async renameProject() {
    const s = this.session;
    if (!s) return;
    const name = await this.ask("Rename project", s.project.name);
    if (!name || name.trim() === s.project.name) return;
    await s.project.saveRecord({ name: name.trim() });
    const file = s.project.files.get(PROJECT_FILE);
    if (file && isText(file)) {
      await this.writeText(PROJECT_FILE, updatePyproject(file.text, (doc) => {
        const project = (doc.project ??= {}) as Record<string, unknown>;
        project.name = name.trim();
      }));
    }
    await this.refreshProjects();
  }

  private async duplicateProject() {
    const s = this.session;
    if (!s) return;
    const name = await this.ask("Name for the copy", s.project.name + " copy");
    if (!name) return;
    this.flushSaves();
    const files: ProjectFile[] = [...s.project.files.values()].map((f) => Object.assign({}, f, { bytes: f.bytes?.slice(0) }));
    const p = await Project.create(name.trim(), files);
    await p.saveRecord({ lock: s.project.record.lock, lockPyodide: s.project.record.lockPyodide, packages: s.project.record.packages.slice() });
    if (s.mirror) await putMirror({ projectId: p.id, lock: s.mirror.lock, files: s.mirror.files });
    await this.refreshProjects();
    await this.openProject(p.id);
  }

  private async deleteProject() {
    const s = this.session;
    if (!s) return;
    if (!confirm(`Delete the project "${s.project.name}" and all its files? This cannot be undone.`)) return;
    const id = s.project.id;
    this.closeProject();
    await Project.delete(id);
    await this.refreshProjects();
    const next = this.projects[0]?.id;
    if (next) await this.openProject(next);
    else await this.start();
  }

  private async exportProject() {
    const s = this.session;
    if (!s) return;
    this.flushSaves();
    const encoder = new TextEncoder();
    const prefix = s.project.name.replaceAll(/[^\w.-]+/g, "_") + "/";
    const entries = [...s.project.files.values()].map((f) => ({ path: prefix + f.path, data: f.text !== undefined ? encoder.encode(f.text) : new Uint8Array(f.bytes ?? new ArrayBuffer(0)) }));
    saveBlob(writeZip(entries), prefix.slice(0, -1) + ".zip");
  }

  private async importZip(file: File) {
    let entries;
    try {
      entries = await readZip(await file.arrayBuffer());
    } catch (e) {
      this.message("Import failed: " + (e instanceof Error ? e.message : String(e)));
      return;
    }
    // A zip made of one top-level folder is that folder.
    const tops = new Set(entries.map((e) => e.path.split("/")[0]));
    const strip = tops.size === 1 && entries.every((e) => e.path.includes("/")) ? [...tops][0]!.length + 1 : 0;
    const now = Date.now();
    const files: ProjectFile[] = [];
    for (const e of entries) {
      const path = normalizePath(e.path.slice(strip));
      if (!path || path.split("/").some((seg) => seg === "__pycache__" || seg === ".git")) continue;
      if (isTextPath(path) && looksLikeText(e.data)) files.push({ path, text: new TextDecoder().decode(e.data), mtime: now });
      else files.push({ path, bytes: e.data.buffer.slice(e.data.byteOffset, e.data.byteOffset + e.data.byteLength) as ArrayBuffer, mtime: now });
    }
    if (files.length === 0) {
      this.message("The zip holds no files.");
      return;
    }
    const name = (strip ? [...tops][0]! : file.name.replace(/\.zip$/i, "")) || "imported";
    const p = await Project.create(name, files);
    await this.refreshProjects();
    await this.openProject(p.id);
  }

  /* ---------------- files and models ---------------- */

  private uriFor(path: string): Monaco.Uri {
    return this.monaco.Uri.file("/project/" + path);
  }

  private ensureModel(path: string, text: string): Monaco.editor.ITextModel {
    const s = this.session!;
    let model = s.models.get(path);
    if (model) return model;
    const existing = this.monaco.editor.getModel(this.uriFor(path));
    if (existing) existing.dispose();
    model = this.monaco.editor.createModel(text, languageFor(path), this.uriFor(path));
    model.updateOptions({ tabSize: s.project.settings.ide.tabSize, insertSpaces: true });
    s.models.set(path, model);
    model.onDidChangeContent(() => this.onModelChange(path));
    this.linterBinding?.schedule(model, 600);
    return model;
  }

  private onModelChange(path: string) {
    const s = this.session;
    if (!s) return;
    s.dirty.add(path);
    const t = this.saveTimers.get(path);
    if (t) clearTimeout(t);
    this.saveTimers.set(path, window.setTimeout(() => void this.saveModel(path), 300));
    const model = s.models.get(path);
    if (model) this.linterBinding?.schedule(model);
  }

  private async saveModel(path: string) {
    const s = this.session;
    this.saveTimers.delete(path);
    if (!s) return;
    const model = s.models.get(path);
    if (!model || model.isDisposed()) return;
    const text = model.getValue();
    const file = s.project.files.get(path);
    if (file && isText(file) && file.text === text) return;
    const settingsChanged = await s.project.write(path, text);
    if (s.interpreter?.alive && s.state !== "booting") {
      s.dirty.delete(path);
      s.interpreter.writeFiles([{ path, data: text }]).catch(() => s.dirty.add(path));
    }
    if (settingsChanged) this.applySettings();
    if (path === PROJECT_FILE) this.showSettingsState();
  }

  /** Writes every pending edit now, before something reads the files. */
  private flushSaves() {
    for (const [path, t] of this.saveTimers) {
      clearTimeout(t);
      void this.saveModel(path);
    }
    this.saveTimers.clear();
  }

  /** Sends the interpreter every file it has not seen since its boot, or since its edit. */
  private async syncDirty() {
    const s = this.session;
    if (!s?.interpreter?.alive) return;
    const files = [];
    for (const path of s.dirty) {
      const f = s.project.files.get(path);
      if (!f) continue;
      files.push({ path, data: f.text !== undefined ? f.text : f.bytes!.slice(0) });
    }
    s.dirty.clear();
    if (files.length) await s.interpreter.writeFiles(files);
  }

  /** Sets a text file's content from the Tool (settings, a run's output), through its model when it has one. */
  private async writeText(path: string, text: string) {
    const s = this.session;
    if (!s) return;
    const model = s.models.get(path);
    if (model) {
      if (model.getValue() !== text) model.setValue(text);
      // setValue queued a save; make it now so callers see the new settings.
      const t = this.saveTimers.get(path);
      if (t) clearTimeout(t);
      this.saveTimers.delete(path);
      await this.saveModel(path);
      return;
    }
    const isNew = !s.project.files.has(path);
    const settingsChanged = await s.project.write(path, text);
    this.ensureModel(path, text);
    if (isNew) this.fileAdded(path);
    s.dirty.add(path);
    void this.syncDirty();
    if (settingsChanged) this.applySettings();
  }

  private fileAdded(path: string) {
    const s = this.session!;
    if (/\.pyi?$/i.test(path)) s.checker?.fileCreated("/project/" + path);
    this.renderTree();
  }

  private openFile(path: string) {
    const s = this.session;
    if (!s) return;
    const file = s.project.files.get(path);
    if (!file) return;
    if (!isText(file)) {
      this.message(`${basename(path)} is a binary file (${formatBytes(file.bytes?.byteLength ?? 0)}).`);
      return;
    }
    if (!s.tabs.includes(path)) s.tabs.push(path);
    this.activate(path);
  }

  private activate(path: string | null) {
    const s = this.session;
    if (!s) return;
    if (s.active && s.active !== path) s.viewStates.set(s.active, this.editor.saveViewState());
    s.active = path;
    this.showActive();
    void s.project.saveRecord({ openTabs: s.tabs.slice(), activeFile: path });
    this.updateDeepLink();
  }

  private showActive() {
    const s = this.session;
    if (!s || !this.editor) return;
    const path = s.active;
    const model = path ? s.models.get(path) ?? null : null;
    this.editor.setModel(model);
    // Files of the Mirror (absolute paths) are the Checker's copies: read-only.
    this.editor.updateOptions({ readOnly: !!path && path.startsWith("/") });
    if (path && model) {
      const vs = s.viewStates.get(path);
      if (vs) this.editor.restoreViewState(vs);
      this.editor.focus();
    }
    this.$(".editor-host").hidden = !model;
    this.$(".editor-empty").hidden = !!model;
    this.$(".st-lang").textContent = model ? model.getLanguageId() : "";
    this.renderTabs();
    this.renderTree();
    this.setState(s.state);
  }

  private closeTab(path: string) {
    const s = this.session;
    if (!s) return;
    const i = s.tabs.indexOf(path);
    if (i === -1) return;
    s.tabs.splice(i, 1);
    if (s.active === path) this.activate(s.tabs[Math.min(i, s.tabs.length - 1)] ?? null);
    else {
      this.renderTabs();
      void s.project.saveRecord({ openTabs: s.tabs.slice() });
    }
  }

  private renderTabs() {
    const s = this.session;
    const tabs = this.$(".tabs");
    tabs.replaceChildren();
    if (!s) return;
    for (const path of s.tabs) {
      const tab = document.createElement("div");
      tab.className = "tab" + (path === s.active ? " active" : "");
      tab.setAttribute("role", "tab");
      tab.title = path;
      tab.innerHTML = `<span class="tab-name"></span><button type="button" class="tab-close" title="Close">${I.ICON_CLOSE}</button>`;
      tab.querySelector(".tab-name")!.textContent = basename(path);
      tab.addEventListener("click", () => this.activate(path));
      tab.addEventListener("auxclick", (e) => {
        if (e.button === 1) this.closeTab(path);
      });
      tab.querySelector(".tab-close")!.addEventListener("click", (e) => {
        e.stopPropagation();
        this.closeTab(path);
      });
      tabs.appendChild(tab);
    }
  }

  private renderTree() {
    const s = this.session;
    const tree = this.$(".tree");
    if (!s) {
      tree.replaceChildren();
      return;
    }
    const folders = new Set([...s.project.folders(), ...s.extraFolders]);
    renderTree(tree, s.project.files.keys(), folders, s.expanded, s.active, {
      onOpen: (path) => this.openFile(path),
      onToggle: (folder) => {
        if (s.expanded.has(folder)) s.expanded.delete(folder);
        else s.expanded.add(folder);
        this.renderTree();
      },
      onMenu: (path, isFolder, x, y) => this.showMenu(path, isFolder, x, y),
      onDrop: (paths, into) => {
        for (const p of paths) {
          const target = (into ? into + "/" : "") + basename(p);
          if (target !== p && !(into + "/").startsWith(p + "/")) void this.movePath(p, target);
        }
      },
    });
  }

  private openResource(resource: Monaco.Uri, selection: unknown): boolean {
    const s = this.session;
    if (!s) return false;
    const model = this.monaco.editor.getModel(resource);
    if (!model) return false;
    if (resource.path.startsWith("/project/")) {
      this.openFile(resource.path.slice("/project/".length));
    } else {
      // A file of the Mirror: shown read-only on a tab of its own.
      const path = resource.path;
      if (!s.models.has(path)) s.models.set(path, model);
      if (!s.tabs.includes(path)) s.tabs.push(path);
      this.activate(path);
    }
    const sel = selection as Monaco.IRange | Monaco.IPosition | undefined;
    if (sel) {
      if ("startLineNumber" in sel) {
        this.editor.setSelection(sel);
        this.editor.revealRangeInCenter(sel);
      } else {
        this.editor.setPosition(sel);
        this.editor.revealPositionInCenter(sel);
      }
    }
    return true;
  }

  /* ---------------- file operations ---------------- */

  private async ask(label: string, initial: string): Promise<string | null> {
    const dialog = this.$(".prompt-dialog") as HTMLDialogElement;
    const input = dialog.querySelector(".prompt-input") as HTMLInputElement;
    dialog.querySelector(".prompt-label")!.textContent = label;
    input.value = initial;
    return new Promise((resolve) => {
      const finish = (value: string | null) => {
        dialog.removeEventListener("close", onClose);
        cancel.removeEventListener("click", onCancel);
        if (dialog.open) dialog.close();
        resolve(value);
      };
      const onClose = () => finish(dialog.returnValue === "ok" ? input.value : null);
      const onCancel = () => finish(null);
      const cancel = dialog.querySelector(".prompt-cancel") as HTMLButtonElement;
      dialog.addEventListener("close", onClose);
      cancel.addEventListener("click", onCancel);
      (dialog.querySelector("form") as HTMLFormElement).onsubmit = () => {
        dialog.returnValue = "ok";
      };
      dialog.showModal();
      input.focus();
      const dot = initial.lastIndexOf(".");
      input.setSelectionRange(0, dot > 0 ? dot : initial.length);
    });
  }

  private async newFile(folder = "") {
    const s = this.session;
    if (!s) return;
    const name = await this.ask("New file (a path creates folders)", folder ? folder + "/" : "");
    if (!name) return;
    const path = normalizePath(name);
    if (!path) return;
    if (s.project.files.has(path)) {
      this.openFile(path);
      return;
    }
    let dir = path;
    while ((dir = dir.slice(0, dir.lastIndexOf("/"))) !== "") s.expanded.add(dir);
    await this.writeText(path, "");
    this.openFile(path);
  }

  private async newFolder(folder = "") {
    const s = this.session;
    if (!s) return;
    const name = await this.ask("New folder", folder ? folder + "/" : "");
    if (!name) return;
    const path = normalizePath(name);
    if (!path) return;
    s.extraFolders.add(path);
    s.expanded.add(path);
    this.renderTree();
  }

  private async renamePath(path: string, isFolder: boolean) {
    const s = this.session;
    if (!s) return;
    const name = await this.ask(isFolder ? "Rename folder" : "Rename file", path);
    if (!name) return;
    const to = normalizePath(name);
    if (!to || to === path) return;
    await this.movePath(path, to);
  }

  private async movePath(from: string, to: string) {
    const s = this.session;
    if (!s) return;
    const isFolder = !s.project.files.has(from);
    if (isFolder) {
      if (s.extraFolders.delete(from)) s.extraFolders.add(to);
      if (s.expanded.delete(from)) s.expanded.add(to);
    }
    this.flushSaves();
    const pairs = await s.project.move(from, to);
    for (const [a, b] of pairs) {
      const model = s.models.get(a);
      const text = model?.getValue();
      if (model) {
        this.linterBinding?.forget(model);
        model.dispose();
        s.models.delete(a);
      }
      if (text !== undefined) this.ensureModel(b, text);
      const i = s.tabs.indexOf(a);
      if (i !== -1) s.tabs[i] = b;
      if (s.active === a) s.active = b;
      if (/\.pyi?$/i.test(a)) s.checker?.fileDeleted("/project/" + a);
      if (/\.pyi?$/i.test(b)) s.checker?.fileCreated("/project/" + b);
      s.dirty.add(b);
    }
    if (s.interpreter?.alive) {
      const files = pairs.map(([, b]) => {
        const f = s.project.files.get(b)!;
        return { path: b, data: f.text !== undefined ? f.text : f.bytes!.slice(0) };
      });
      for (const [, b] of pairs) s.dirty.delete(b);
      s.interpreter.writeFiles(files, pairs.map(([a]) => a)).catch(() => {});
    }
    this.showActive();
    void s.project.saveRecord({ openTabs: s.tabs.slice(), activeFile: s.active });
  }

  private async deletePath(path: string, isFolder: boolean) {
    const s = this.session;
    if (!s) return;
    const paths = isFolder ? [...s.project.files.keys()].filter((p) => p.startsWith(path + "/")) : [path];
    if (!confirm(isFolder ? `Delete the folder "${path}" and its ${paths.length} file(s)?` : `Delete "${path}"?`)) return;
    if (isFolder) {
      s.extraFolders.delete(path);
      for (const f of Array.from(s.extraFolders)) if (f.startsWith(path + "/")) s.extraFolders.delete(f);
    }
    for (const p of paths) {
      const t = this.saveTimers.get(p);
      if (t) clearTimeout(t);
      this.saveTimers.delete(p);
      const model = s.models.get(p);
      if (model) {
        this.linterBinding?.forget(model);
        model.dispose();
        s.models.delete(p);
      }
      const i = s.tabs.indexOf(p);
      if (i !== -1) s.tabs.splice(i, 1);
      if (/\.pyi?$/i.test(p)) s.checker?.fileDeleted("/project/" + p);
      s.dirty.delete(p);
    }
    await s.project.remove(paths);
    if (s.active && paths.includes(s.active)) s.active = s.tabs[0] ?? null;
    if (s.interpreter?.alive) s.interpreter.writeFiles([], paths).catch(() => {});
    this.showActive();
    void s.project.saveRecord({ openTabs: s.tabs.slice(), activeFile: s.active });
  }

  private downloadPath(path: string) {
    const f = this.session?.project.files.get(path);
    if (!f) return;
    const blob = f.text !== undefined ? new Blob([f.text], { type: "text/plain" }) : new Blob([f.bytes!]);
    saveBlob(blob, basename(path));
  }

  /** Adds files from the user's machine under `folder`. */
  private async addFiles(items: { path: string; file: File }[], folder = "") {
    const s = this.session;
    if (!s || items.length === 0) return;
    const now = Date.now();
    const files: ProjectFile[] = [];
    for (const { path, file } of items) {
      const full = normalizePath((folder ? folder + "/" : "") + path);
      if (!full) continue;
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (isTextPath(full) && looksLikeText(bytes)) files.push({ path: full, text: new TextDecoder().decode(bytes), mtime: now });
      else files.push({ path: full, bytes: bytes.buffer as ArrayBuffer, mtime: now });
    }
    for (const f of files) {
      const old = s.models.get(f.path);
      if (old) {
        this.linterBinding?.forget(old);
        old.dispose();
        s.models.delete(f.path);
      }
    }
    await s.project.writeMany(files);
    for (const f of files) {
      if (f.text !== undefined) this.ensureModel(f.path, f.text);
      s.dirty.add(f.path);
      if (/\.pyi?$/i.test(f.path)) s.checker?.fileCreated("/project/" + f.path);
      let dir = f.path;
      while ((dir = dir.slice(0, dir.lastIndexOf("/"))) !== "") s.expanded.add(dir);
    }
    if (files.some((f) => f.path === PROJECT_FILE)) this.applySettings();
    void this.syncDirty();
    this.showActive();
    this.message(`Added ${files.length} file(s).`);
  }

  private showMenu(path: string, isFolder: boolean, x: number, y: number) {
    const items: [string, () => void][] = isFolder
      ? [["New file here", () => void this.newFile(path)], ["New folder here", () => void this.newFolder(path)], ["Rename", () => void this.renamePath(path, true)], ["Delete", () => void this.deletePath(path, true)]]
      : [["Open", () => this.openFile(path)], ["Rename", () => void this.renamePath(path, false)], ["Download", () => this.downloadPath(path)], ["Delete", () => void this.deletePath(path, false)]];
    this.popupMenu(items, x, y);
  }

  /** The one context menu, at a viewport position; closes on a click outside or Escape. */
  private popupMenu(items: [string, () => void][], x: number, y: number) {
    const menu = this.$(".context-menu");
    menu.replaceChildren();
    for (const [label, action] of items) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.addEventListener("click", () => {
        menu.hidden = true;
        action();
      });
      menu.appendChild(b);
    }
    const rect = this.el.getBoundingClientRect();
    menu.style.left = x - rect.left + "px";
    menu.style.top = y - rect.top + "px";
    menu.hidden = false;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e instanceof MouseEvent && menu.contains(e.target as Node)) return;
      menu.hidden = true;
      document.removeEventListener("mousedown", close, true);
      document.removeEventListener("keydown", close, true);
    };
    setTimeout(() => {
      document.addEventListener("mousedown", close, true);
      document.addEventListener("keydown", close, true);
    });
  }

  /* ---------------- quick open ---------------- */

  private openQuickOpen() {
    const s = this.session;
    if (!s) return;
    const box = this.$(".quickopen");
    const input = box.querySelector("input") as HTMLInputElement;
    const list = box.querySelector(".quickopen-list") as HTMLElement;
    let cursor = 0;
    const paths = [...s.project.files.keys()].filter((p) => isText(s.project.files.get(p)!)).toSorted();
    const render = () => {
      const q = input.value.trim().toLowerCase();
      const matches = paths.filter((p) => q.split(/\s+/).every((w) => p.toLowerCase().includes(w))).slice(0, 50);
      cursor = Math.min(cursor, Math.max(0, matches.length - 1));
      list.replaceChildren();
      matches.forEach((p, i) => {
        const row = document.createElement("div");
        row.className = "quickopen-row" + (i === cursor ? " cursor" : "");
        row.textContent = p;
        row.addEventListener("mousedown", (e) => {
          e.preventDefault();
          choose(p);
        });
        list.appendChild(row);
      });
      list.dataset.matches = String(matches.length);
      return matches;
    };
    const close = () => {
      box.hidden = true;
      input.removeEventListener("input", onInput);
      input.removeEventListener("keydown", onKey);
      input.removeEventListener("blur", close);
    };
    const choose = (p: string) => {
      close();
      this.openFile(p);
    };
    const onInput = () => {
      cursor = 0;
      render();
    };
    const onKey = (e: KeyboardEvent) => {
      const matches = render();
      if (e.key === "ArrowDown") {
        cursor = Math.min(cursor + 1, matches.length - 1);
        render();
        e.preventDefault();
      } else if (e.key === "ArrowUp") {
        cursor = Math.max(cursor - 1, 0);
        render();
        e.preventDefault();
      } else if (e.key === "Enter") {
        if (matches[cursor]) choose(matches[cursor]);
        e.preventDefault();
      } else if (e.key === "Escape") {
        close();
        this.editor?.focus();
      }
    };
    input.value = "";
    box.hidden = false;
    render();
    input.addEventListener("input", onInput);
    input.addEventListener("keydown", onKey);
    input.addEventListener("blur", close);
    input.focus();
  }

  /* ---------------- settings ---------------- */

  private applySettings() {
    const s = this.session;
    if (!s) return;
    this.applyEditorOptions();
    void this.linter.configure(s.project.settings.ruff).then(() => this.linterBinding?.invalidate(s.models.values())).catch((e) => this.message("Ruff settings: " + e.message));
    this.restartChecker();
    this.renderPackages();
  }

  private applyEditorOptions() {
    const s = this.session;
    if (!s || !this.editor) return;
    const ide = s.project.settings.ide;
    this.editor.updateOptions({ minimap: { enabled: ide.minimap }, wordWrap: ide.wordWrap ? "on" : "off" });
    for (const m of s.models.values()) m.updateOptions({ tabSize: ide.tabSize, insertSpaces: true });
  }

  private showSettingsState() {
    const s = this.session;
    if (!s) return;
    if (s.project.settingsError) this.message(`pyproject.toml: ${s.project.settingsError} (keeping the last good settings)`);
  }

  private openSettings() {
    const s = this.session;
    if (!s) return;
    const st = s.project.settings;
    const ruff = st.ruff as { "line-length"?: number; lint?: { select?: string[]; ignore?: string[] }; format?: { "quote-style"?: string } };
    const dialog = this.$(".settings-dialog") as HTMLDialogElement;
    const esc = (v: unknown) => String(v ?? "").replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
    dialog.innerHTML = `
      <form method="dialog" class="settings-form">
        <h2>Project settings</h2>
        <p class="settings-note">Stored in <code>pyproject.toml</code>; edit it directly for anything not displayed here.</p>
        <div class="settings-scroll" tabindex="-1">
        <div class="settings-grid">
        <fieldset><legend>Editor</legend>
          <label>Tab size <input name="tabSize" type="number" min="1" max="8" value="${st.ide.tabSize}"></label>
          <label class="check"><input name="formatOnRun" type="checkbox"${st.ide.formatOnRun ? " checked" : ""}> Format on Run</label>
          <label class="check"><input name="minimap" type="checkbox"${st.ide.minimap ? " checked" : ""}> Minimap</label>
          <label class="check"><input name="wordWrap" type="checkbox"${st.ide.wordWrap ? " checked" : ""}> Word wrap</label>
        </fieldset>
        <fieldset><legend>Run</legend>
          <label>Arguments (sys.argv[1:]) <input name="args" value="${esc(st.ide.args.join(" "))}" placeholder="--verbose input.txt"></label>
          <label><span>Environment (<code>KEY=VALUE</code> per line)</span> <textarea name="env" rows="3">${esc(Object.entries(st.ide.env).map(([k, v]) => `${k}=${v}`).join("\n"))}</textarea></label>
        </fieldset>
        <fieldset><legend>Pyright</legend>
          <label>Type checking mode <select name="typeCheckingMode">${["off", "basic", "standard", "strict"].map((m) => `<option value="${m}"${st.pyright.typeCheckingMode === m ? " selected" : ""}>${m}</option>`).join("")}</select></label>
        </fieldset>
        <fieldset><legend>Ruff</legend>
          <label>Line length <input name="lineLength" type="number" min="40" max="320" value="${esc(ruff["line-length"] ?? 88)}"></label>
          <label>Rules (select) <input name="select" value="${esc((ruff.lint?.select ?? []).join(", "))}" placeholder="E4, E7, E9, F, I"></label>
          <label>Rules (ignore) <input name="ignore" value="${esc((ruff.lint?.ignore ?? []).join(", "))}"></label>
          <label>Quote style <select name="quoteStyle">${["double", "single", "preserve"].map((q) => `<option value="${q}"${(ruff.format?.["quote-style"] ?? "double") === q ? " selected" : ""}>${q}</option>`).join("")}</select></label>
        </fieldset>
        </div>
        </div>
        <div class="prompt-actions"><button type="button" class="settings-cancel">Cancel</button><button type="submit" class="primary">Save</button></div>
      </form>`;
    const form = dialog.querySelector("form") as HTMLFormElement;
    dialog.querySelector(".settings-cancel")!.addEventListener("click", () => dialog.close());
    form.onsubmit = () => {
      const data = new FormData(form);
      const list = (v: FormDataEntryValue | null) => String(v ?? "").split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
      const file = s.project.files.get(PROJECT_FILE);
      const text = file && isText(file) ? file.text : defaultPyproject(s.project.name);
      const next = updatePyproject(text, (doc) => {
        const tables = (doc.tool ??= {}) as Record<string, unknown>;
        const pyright = (tables.basedpyright ??= {}) as Record<string, unknown>;
        pyright.typeCheckingMode = String(data.get("typeCheckingMode"));
        const r = (tables.ruff ??= {}) as Record<string, unknown>;
        r["line-length"] = Number(data.get("lineLength")) || 88;
        const lint = (r.lint ??= {}) as Record<string, unknown>;
        lint.select = list(data.get("select"));
        const ignore = list(data.get("ignore"));
        if (ignore.length) lint.ignore = ignore;
        else delete lint.ignore;
        const format = (r.format ??= {}) as Record<string, unknown>;
        format["quote-style"] = String(data.get("quoteStyle"));
        const ide = (tables["python-ide"] ??= {}) as Record<string, unknown>;
        ide["tab-size"] = Number(data.get("tabSize")) || 4;
        ide["format-on-run"] = data.get("formatOnRun") === "on";
        ide.minimap = data.get("minimap") === "on";
        ide["word-wrap"] = data.get("wordWrap") === "on";
        ide.args = String(data.get("args") ?? "").trim() ? String(data.get("args")).trim().split(/\s+/) : [];
        const env: Record<string, string> = {};
        for (const line of String(data.get("env") ?? "").split("\n")) {
          const eq = line.indexOf("=");
          if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
        }
        ide.env = env;
      });
      void this.writeText(PROJECT_FILE, next);
    };
    dialog.showModal();
    // showModal focuses the first field; nothing should look chosen until the user chooses.
    (dialog.querySelector(".settings-scroll") as HTMLElement).focus();
  }

  /* ---------------- the Checker ---------------- */

  private restartChecker() {
    const s = this.session;
    if (!s || !this.pyrightUrl || !this.monaco) return;
    s.checker?.dispose();
    const files: Record<string, string> = { ...s.mirror?.files, "/site-packages/js.pyi": JS_STUB, ...s.project.checkerFiles() };
    const config = {
      typeshedPath: "/typeshed",
      pythonVersion: "3.14",
      pythonPlatform: "Linux",
      extraPaths: ["/site-packages"],
      ...s.project.settings.pyright,
    };
    const checker = new Checker(this.monaco, this.pyrightUrl, { files, config });
    s.checker = checker;
    this.setCheckerStatus("Pyright: starting");
    checker.start();
    const gen = s.generation;
    void checker.ready.then(() => {
      if (this.session === s && s.checker === checker && s.generation === gen) this.setCheckerStatus(s.mirror ? "Pyright: ready" : "Pyright: ready (no packages)");
    });
  }

  private async refreshMirror() {
    const s = this.session;
    if (!s?.interpreter?.alive) return;
    const lock = s.project.record.lock;
    if (!lock) {
      s.mirror = null;
      return;
    }
    if (s.mirror?.lock === lock) return;
    const gen = s.generation;
    this.setCheckerStatus("Pyright: reading packages");
    const files = await s.interpreter.mirror();
    if (this.session !== s || s.generation !== gen) return;
    s.mirror = { lock, files };
    await putMirror({ projectId: s.project.id, lock, files });
    this.restartChecker();
  }

  /* ---------------- the Interpreter ---------------- */

  private async bootInterpreter() {
    const s = this.session;
    if (!s) return;
    const gen = s.generation;
    const interpreter = new Interpreter({
      onOutput: (stream, bytes) => this.terminal?.output(stream, bytes),
      onInputRequest: (id) => {
        s.pendingInput = id;
        this.terminal?.readLine("input");
        this.terminal?.focus();
      },
      onInputUnavailable: () => this.terminal?.writeDim("\n[input() reached the end of Stdin; interactive input needs a browser with JSPI (Chrome 137+, Firefox 153+)]\n"),
      onFigure: (png) => this.addFigure(png),
      onProgress: (m) => this.message(m),
      onCrash: (m) => {
        this.terminal?.writeError("\n" + m + "\n");
        if (this.session === s && s.interpreter === interpreter) void this.restartInterpreter();
      },
    });
    s.interpreter = interpreter;
    s.dirty.clear();
    this.setState("booting");
    this.terminal?.stopLine();
    this.terminal?.newLine();
    try {
      const current = s.project.lockCurrent;
      const record = s.project.record;
      const info = await interpreter.boot(current ? record.lock : null, current ? record.packages.map((p) => p.name) : ["micropip"], this.progress("Pyodide"));
      if (this.session !== s || s.generation !== gen || s.interpreter !== interpreter) return;
      s.python = info.python;
      s.jspi = info.jspi;
      this.flushSaves();
      const files = [...s.project.files.values()].map((f) => ({ path: f.path, data: f.text !== undefined ? f.text : f.bytes!.slice(0) }));
      await interpreter.writeFiles(files);
      if (this.session !== s || s.generation !== gen) return;
      this.terminal?.writeDim(`Python ${info.python} (Pyodide ${PYODIDE_VERSION})${info.jspi ? "" : ", input() reads Stdin only in this browser"}\n`);
      if (!current && s.project.settings.dependencies.length) {
        this.terminal?.writeDim(record.lock ? `Packages were locked for another Pyodide; resolving them again.\n` : `Installing the project's dependencies.\n`);
        await this.installSpecs(s.project.settings.dependencies, false);
        if (this.session !== s || s.generation !== gen) return;
      } else if (!current && record.lock) {
        await s.project.saveRecord({ lock: null, lockPyodide: null, packages: [] });
      }
      await this.refreshMirror();
      if (this.session !== s || s.generation !== gen) return;
      this.message("");
      this.setState("ready");
      this.prompt();
    } catch (e) {
      if (this.session !== s || s.generation !== gen) return;
      const message = e instanceof Error ? e.message : String(e);
      this.terminal?.writeError(`The interpreter could not start: ${message}\n`);
      this.message("Interpreter failed: " + message);
      this.setState("off");
    }
  }

  private async restartInterpreter() {
    const s = this.session;
    if (!s) return;
    s.interpreter?.terminate();
    s.interpreter = null;
    s.pendingInput = null;
    this.terminal?.stopLine();
    this.terminal?.flush();
    this.setState("rebooting");
    await this.bootInterpreter();
  }

  private prompt(continuation = false) {
    const s = this.session;
    if (!s || s.state !== "ready" || !this.terminal) return;
    if (!continuation) {
      this.terminal.readLine("repl", ">>> ");
      return;
    }
    // Like CPython's REPL: a continuation keeps the previous line's indentation, deeper after a colon.
    const last = this.terminal.lastLine;
    const indent = (/^\s*/.exec(last)?.[0] ?? "") + (last.trimEnd().endsWith(":") ? "    " : "");
    this.terminal.readLine("repl", "... ", indent);
  }

  private onTerminalLine(line: string | null, mode: "repl" | "input") {
    const s = this.session;
    if (!s) return;
    if (mode === "input") {
      if (s.pendingInput !== null && s.interpreter) s.interpreter.replyInput(s.pendingInput, line === null ? null : line + "\n");
      s.pendingInput = null;
      return;
    }
    if (line === null) {
      void s.interpreter?.resetRepl().finally(() => this.prompt());
      return;
    }
    void this.replSubmit(line);
  }

  private async replSubmit(line: string) {
    const s = this.session;
    if (!s?.interpreter || s.state !== "ready") return;
    const gen = s.generation;
    try {
      const result = await s.interpreter.repl(line);
      if (this.session !== s || s.generation !== gen) return;
      this.terminal?.flush();
      if (result.status === "incomplete") {
        this.prompt(true);
        return;
      }
      if (result.status === "error") this.terminal?.writeError(result.text.endsWith("\n") ? result.text : result.text + "\n");
      else if (result.status === "exit") this.terminal?.writeDim("[sys.exit called" + (result.text ? ": " + result.text : "") + "; the REPL carries on]\n");
      else if (result.text) this.terminal?.write(result.text + "\n");
      this.prompt();
    } catch (e) {
      if (this.session !== s || s.generation !== gen) return;
      this.terminal?.writeError((e instanceof Error ? e.message : String(e)) + "\n");
      if (s.state === "ready") this.prompt();
    }
  }

  private async run() {
    const s = this.session;
    if (!s?.interpreter || s.state !== "ready" || !this.isPython(s.active)) return;
    const path = s.active!;
    const gen = s.generation;
    if (s.project.settings.ide.formatOnRun) await this.editor.getAction("editor.action.formatDocument")?.run();
    this.flushSaves();
    await this.syncDirty();
    if (this.session !== s || s.generation !== gen || s.state !== "ready") return;
    this.togglePanel(true);
    this.terminal?.stopLine();
    this.terminal?.flush();
    this.terminal?.newLine();
    this.clearFigures();
    this.terminal?.writeDim(`$ python ${path}${s.project.settings.ide.args.length ? " " + s.project.settings.ide.args.join(" ") : ""}\n`);
    this.setState("running");
    this.terminal?.focus();
    const interpreter = s.interpreter;
    try {
      const result = await interpreter.run({
        path,
        argv: s.project.settings.ide.args,
        env: s.project.settings.ide.env,
        stdin: (this.$(".stdin") as HTMLTextAreaElement).value,
        cols: this.terminal?.term.cols ?? 80,
        rows: this.terminal?.term.rows ?? 24,
      });
      if (this.session !== s || s.generation !== gen || s.interpreter !== interpreter) return;
      this.terminal?.flush();
      if (result.exit !== 0) this.terminal?.writeDim(`[exit ${result.exit}]\n`);
      await this.applyRunChanges(result);
      if (this.session !== s || s.generation !== gen || s.interpreter !== interpreter) return;
      this.setState("ready");
      this.prompt();
    } catch (e) {
      if (this.session !== s || s.generation !== gen || s.interpreter !== interpreter) return;
      this.terminal?.flush();
      this.terminal?.writeError((e instanceof Error ? e.message : String(e)) + "\n");
      if (interpreter.alive) {
        this.setState("ready");
        this.prompt();
      }
    }
  }

  /** Files a Run wrote or removed become part of the Project. */
  private async applyRunChanges(result: RunResult) {
    const s = this.session;
    if (!s) return;
    const now = Date.now();
    const files: ProjectFile[] = [];
    for (const c of result.changed) {
      const bytes = c.data;
      if (isTextPath(c.path) && looksLikeText(bytes)) files.push({ path: c.path, text: new TextDecoder().decode(bytes), mtime: now });
      else files.push({ path: c.path, bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, mtime: now });
    }
    if (files.length) {
      await s.project.writeMany(files);
      for (const f of files) {
        const model = s.models.get(f.path);
        if (f.text !== undefined) {
          if (model) {
            if (model.getValue() !== f.text) model.setValue(f.text);
          } else {
            this.ensureModel(f.path, f.text);
            if (/\.pyi?$/i.test(f.path)) s.checker?.fileCreated("/project/" + f.path);
          }
        } else if (model) {
          this.linterBinding?.forget(model);
          model.dispose();
          s.models.delete(f.path);
          const i = s.tabs.indexOf(f.path);
          if (i !== -1) s.tabs.splice(i, 1);
          if (s.active === f.path) s.active = s.tabs[0] ?? null;
        }
      }
      // The models' own save would send the files back to the interpreter, which already has them.
      for (const f of files) {
        const t = this.saveTimers.get(f.path);
        if (t) clearTimeout(t);
        this.saveTimers.delete(f.path);
        s.dirty.delete(f.path);
      }
    }
    if (result.removed.length) {
      for (const p of result.removed) {
        const model = s.models.get(p);
        if (model) {
          this.linterBinding?.forget(model);
          model.dispose();
          s.models.delete(p);
        }
        const i = s.tabs.indexOf(p);
        if (i !== -1) s.tabs.splice(i, 1);
        if (s.active === p) s.active = s.tabs[0] ?? null;
        if (/\.pyi?$/i.test(p)) s.checker?.fileDeleted("/project/" + p);
      }
      await s.project.remove(result.removed);
    }
    for (const p of result.skipped) this.terminal?.writeDim(`[${p} is over 20 MB and was not kept in the project]\n`);
    if (files.length || result.removed.length) {
      this.showActive();
      const n = files.length + result.removed.length;
      this.message(`The run changed ${n} file(s) in the project.`);
      if (files.some((f) => f.path === PROJECT_FILE)) this.applySettings();
    }
  }

  private async stop() {
    const s = this.session;
    if (!s?.interpreter) return;
    if (s.state !== "running" && s.state !== "installing") return;
    this.terminal?.stopLine();
    this.terminal?.flush();
    this.terminal?.newLine();
    this.terminal?.writeDim("[stopped]\n");
    await this.restartInterpreter();
  }

  /* ---------------- packages ---------------- */

  private renderPackages() {
    const s = this.session;
    if (!s) return;
    const rows: PackageRow[] = s.project.record.packages.map((p) => ({
      name: p.name,
      version: p.version,
      origin: p.source === "pyodide" ? "catalog" : /wasm32|emscripten/.test(p.source) ? "wasm" : "pypi",
    }));
    renderPackages(this.$(".pkg-direct"), this.$(".pkg-transitive"), s.project.settings.dependencies, rows, {
      onRemove: (spec) => void this.removeSpec(spec),
      onMenu: (spec, x, y) => this.popupMenu([
        ["Copy name", () => void navigator.clipboard?.writeText(spec)],
        ["Remove from the project", () => void this.removeSpec(spec)],
      ], x, y),
    });
  }

  /**
   * Installs specs into the Environment, records the Lock, and (when `addToProject`)
   * writes them into the Project File as Dependencies.
   */
  private async installSpecs(specs: string[], addToProject: boolean) {
    const s = this.session;
    if (!s?.interpreter?.alive) return;
    const gen = s.generation;
    const interpreter = s.interpreter;
    this.togglePanel(true);
    this.terminal?.stopLine();
    this.terminal?.newLine();
    this.setState("installing");
    this.terminal?.writeDim(`$ pip install ${specs.join(" ")}\n`);
    try {
      const result = await interpreter.install(specs);
      if (this.session !== s || s.generation !== gen || s.interpreter !== interpreter) return;
      await s.project.saveRecord({ lock: result.lock, lockPyodide: PYODIDE_VERSION, packages: result.packages });
      if (addToProject) {
        const file = s.project.files.get(PROJECT_FILE);
        const text = file && isText(file) ? file.text : defaultPyproject(s.project.name);
        const next = updatePyproject(text, (doc) => {
          const project = (doc.project ??= {}) as Record<string, unknown>;
          const deps = Array.isArray(project.dependencies) ? (project.dependencies as string[]).slice() : [];
          for (const spec of specs) {
            const i = deps.findIndex((d) => specName(d) === specName(spec));
            if (i === -1) deps.push(spec);
            else deps[i] = spec;
          }
          project.dependencies = deps;
        });
        await this.writeText(PROJECT_FILE, next);
      }
      const installed = result.packages.filter((p) => specs.some((sp) => specName(sp) === specName(p.name)));
      this.terminal?.writeDim(`Installed ${installed.map((p) => `${p.name} ${p.version}`).join(", ") || specs.join(", ")}\n`);
      this.renderPackages();
      this.message("");
      this.setState("ready");
      await this.refreshMirror();
    } catch (e) {
      if (this.session !== s || s.generation !== gen || s.interpreter !== interpreter) return;
      this.terminal?.writeError((e instanceof Error ? e.message : String(e)).trim() + "\n");
      if (interpreter.alive) this.setState("ready");
    }
    if (this.session === s && s.generation === gen && s.state === "ready") this.prompt();
  }

  private async removeSpec(spec: string) {
    const s = this.session;
    if (!s) return;
    const file = s.project.files.get(PROJECT_FILE);
    const text = file && isText(file) ? file.text : defaultPyproject(s.project.name);
    await this.writeText(PROJECT_FILE, updatePyproject(text, (doc) => {
      const project = (doc.project ??= {}) as Record<string, unknown>;
      project.dependencies = (Array.isArray(project.dependencies) ? (project.dependencies as string[]) : []).filter((d) => specName(d) !== specName(spec));
    }));
    if (!s.interpreter?.alive || s.state !== "ready") return;
    const gen = s.generation;
    const interpreter = s.interpreter;
    const name = specName(spec);
    if (!s.project.record.packages.some((p) => specName(p.name) === name)) return;
    this.terminal?.stopLine();
    this.terminal?.newLine();
    this.setState("installing");
    this.terminal?.writeDim(`$ pip uninstall ${name}\n`);
    try {
      const result = await interpreter.uninstall([name]);
      if (this.session !== s || s.generation !== gen) return;
      await s.project.saveRecord({ lock: result.lock, lockPyodide: PYODIDE_VERSION, packages: result.packages });
      this.renderPackages();
      // Modules already imported stay in memory; a fresh interpreter is the honest state.
      await this.restartInterpreter();
    } catch (e) {
      if (this.session !== s || s.generation !== gen) return;
      this.terminal?.writeError((e instanceof Error ? e.message : String(e)).trim() + "\n");
      this.setState("ready");
      this.prompt();
    }
  }

  /* ---------------- figures ---------------- */

  private addFigure(png: Uint8Array) {
    const s = this.session;
    if (!s) return;
    const url = URL.createObjectURL(new Blob([png as BlobPart], { type: "image/png" }));
    s.figures.push(url);
    const list = this.$(".figures-list");
    const card = document.createElement("figure");
    card.className = "figure";
    card.innerHTML = `<img alt="Figure ${s.figures.length}"><figcaption><span>Figure ${s.figures.length}</span><span class="spacer"></span><a download="figure-${s.figures.length}.png" title="Download">${I.ICON_DOWNLOAD}</a></figcaption>`;
    (card.querySelector("img") as HTMLImageElement).src = url;
    (card.querySelector("a") as HTMLAnchorElement).href = url;
    list.appendChild(card);
    this.$(".figures").hidden = false;
    this.el.classList.add("has-figures");
    const btn = this.$(".figures-btn");
    btn.hidden = false;
    btn.querySelector(".badge")!.textContent = String(s.figures.length);
    btn.setAttribute("aria-pressed", "true");
    this.terminal?.layout();
  }

  private clearFigures() {
    const s = this.session;
    if (s) {
      for (const u of s.figures) URL.revokeObjectURL(u);
      s.figures = [];
    }
    this.$(".figures-list").replaceChildren();
    this.$(".figures").hidden = true;
    this.el.classList.remove("has-figures");
    this.$(".figures-btn").hidden = true;
    this.terminal?.layout();
  }

  /* ---------------- deep link ---------------- */

  private updateDeepLink() {
    const s = this.session;
    if (!s) return;
    this.ctx.setState(s.project.id + (s.active ? ":" + encodeURIComponent(s.active) : ""));
  }

  private restore(payload: string) {
    const colon = payload.indexOf(":");
    const id = colon === -1 ? payload : payload.slice(0, colon);
    let path = "";
    try {
      path = colon === -1 ? "" : decodeURIComponent(payload.slice(colon + 1));
    } catch {
      path = "";
    }
    if (!id) return;
    if (this.projects.length === 0 && !this.session) {
      this.pendingRestore = { id, path };
      return;
    }
    if (this.projects.some((p) => p.id === id)) void this.openProject(id, path || undefined);
    else this.message("That project is not on this machine.");
  }

  /* ---------------- UI wiring ---------------- */

  private bindUi() {
    const $ = this.$;
    $(".run-btn").addEventListener("click", () => void this.run());
    $(".stop-btn").addEventListener("click", () => void this.stop());
    $(".restart-btn").addEventListener("click", () => void this.restartInterpreter());
    $(".format-btn").addEventListener("click", () => void this.editor?.getAction("editor.action.formatDocument")?.run());
    $(".stdin-btn").addEventListener("click", () => {
      const row = $(".stdin-row");
      row.hidden = !row.hidden;
      $(".stdin-btn").setAttribute("aria-pressed", String(!row.hidden));
      if (!row.hidden) $(".stdin").focus();
    });
    $(".figures-btn").addEventListener("click", () => {
      const fig = $(".figures");
      fig.hidden = !fig.hidden;
      this.el.classList.toggle("has-figures", !fig.hidden);
      $(".figures-btn").setAttribute("aria-pressed", String(!fig.hidden));
      this.terminal?.layout();
    });
    $(".figures-clear").addEventListener("click", () => this.clearFigures());
    $(".panel-btn").addEventListener("click", () => this.togglePanel());
    const syncSidebar = (collapsed: boolean) => $(".sidebar-btn").setAttribute("aria-pressed", String(!collapsed));
    $(".sidebar-btn").addEventListener("click", () => this.ctx.sidebar.setCollapsed(!this.ctx.sidebar.collapsed));
    this.ctx.sidebar.onChange(syncSidebar);
    syncSidebar(this.ctx.sidebar.collapsed);
    for (const tab of this.el.querySelectorAll<HTMLElement>(".panel-tab")) tab.addEventListener("click", () => this.showPanelTab(tab.dataset.panel as PanelTab));
    $(".terminal-close").addEventListener("click", () => this.togglePanel(false));
    $(".terminal-copy").addEventListener("click", () => void this.copyTerminal());
    $(".terminal-clear").addEventListener("click", () => {
      this.terminal?.clearScreen();
      this.terminal?.focus();
    });
    this.togglePanel(read(PANEL_OPEN_KEY) !== "closed");
    $(".quickopen-btn").addEventListener("click", () => this.openQuickOpen());
    $(".settings-btn").addEventListener("click", () => this.openSettings());
    $(".new-file-btn").addEventListener("click", () => void this.newFile());
    $(".new-folder-btn").addEventListener("click", () => void this.newFolder());
    $(".upload-btn").addEventListener("click", () => ($(".file-input") as HTMLInputElement).click());
    $(".file-input").addEventListener("change", (e) => {
      const input = e.target as HTMLInputElement;
      const files = [...(input.files ?? [])].map((f) => ({ path: f.name, file: f }));
      input.value = "";
      void this.addFiles(files);
    });
    $(".zip-input").addEventListener("change", (e) => {
      const input = e.target as HTMLInputElement;
      const file = input.files?.[0];
      input.value = "";
      if (file) void this.importZip(file);
    });
    ($(".project-select") as HTMLSelectElement).addEventListener("change", (e) => void this.openProject((e.target as HTMLSelectElement).value));
    $(".project-menu-btn").addEventListener("click", (e) => {
      const btn = e.currentTarget as HTMLElement;
      const r = btn.getBoundingClientRect();
      this.showProjectMenu(r.left, r.bottom + 4);
    });
    $(".install-row").addEventListener("submit", (e) => {
      e.preventDefault();
      const input = $(".install-input") as HTMLInputElement;
      const spec = input.value.trim();
      if (!spec) return;
      input.value = "";
      this.hideCatalog();
      void this.installSpecs([spec], true);
    });
    this.bindCatalog();
    this.bindResizers();
    this.bindDrop();
    this.el.addEventListener("keydown", (e) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (mod && e.key === "Enter") {
        e.preventDefault();
        void this.run();
      } else if (mod && e.key.toLowerCase() === "p" && !e.shiftKey) {
        e.preventDefault();
        this.openQuickOpen();
      } else if (mod && e.key.toLowerCase() === "j") {
        e.preventDefault();
        this.togglePanel();
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "m") {
        e.preventDefault();
        this.showPanelTab("problems");
      }
    });
  }

  private showProjectMenu(x: number, y: number) {
    this.popupMenu([
      ["New project", () => void this.newProject()],
      ["Rename project", () => void this.renameProject()],
      ["Duplicate project", () => void this.duplicateProject()],
      ["Export as zip", () => void this.exportProject()],
      ["Import from zip", () => (this.$(".zip-input") as HTMLInputElement).click()],
      ["Delete project", () => void this.deleteProject()],
    ], x, y);
  }

  /** Shows or hides the panel (Terminal, Figures, Problems). A Preference. */
  private togglePanel(open = this.$(".panel").hidden, tab?: PanelTab) {
    this.$(".panel").hidden = !open;
    this.$(".panel-resizer").hidden = !open;
    this.$(".panel-btn").setAttribute("aria-pressed", String(open));
    write(PANEL_OPEN_KEY, open ? "open" : "closed");
    if (open) {
      if (tab) this.showPanelTab(tab);
      else if (this.panelTab === "terminal") {
        this.terminal?.layout();
        this.terminal?.focus();
      }
    } else this.editor?.focus();
  }

  private panelTab: PanelTab = "terminal";

  private showPanelTab(tab: PanelTab) {
    if (this.$(".panel").hidden) this.togglePanel(true);
    this.panelTab = tab;
    this.$(".panel-body").dataset.panel = tab;
    for (const t of this.el.querySelectorAll<HTMLElement>(".panel-tab")) t.setAttribute("aria-selected", String(t.dataset.panel === tab));
    (this.$(".terminal-clear") as HTMLButtonElement).hidden = tab !== "terminal";
    (this.$(".terminal-copy") as HTMLButtonElement).hidden = tab !== "terminal";
    if (tab === "terminal") {
      this.terminal?.layout();
      this.terminal?.focus();
    }
  }

  private async copyTerminal() {
    const text = this.terminal?.text() ?? "";
    const btn = this.$(".terminal-copy");
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      // the async clipboard needs a secure context; this keeps copy working from file://
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;left:-9999px;top:0";
      document.body.appendChild(ta);
      ta.select();
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      ta.remove();
    }
    btn.innerHTML = ok ? I.ICON_CHECK : I.ICON_CLOSE;
    this.message(ok ? `Copied ${text.split("\n").length} line(s) from the terminal.` : "Could not copy.");
    setTimeout(() => (btn.innerHTML = I.ICON_COPY), 1200);
  }

  /* ---------------- problems ---------------- */

  private problemsTimer = 0;

  private scheduleProblems() {
    clearTimeout(this.problemsTimer);
    this.problemsTimer = window.setTimeout(() => this.renderProblems(), 150);
  }

  /** Every marker on the Project's files, from the Checker and the Linter alike, grouped by file. */
  private renderProblems() {
    const list = this.$(".problems");
    const count = this.$(".problems-count");
    const s = this.session;
    if (!s || !this.monaco) {
      list.replaceChildren();
      count.hidden = true;
      return;
    }
    const { MarkerSeverity } = this.monaco;
    const markers = this.monaco.editor.getModelMarkers({}).filter((m) => m.resource.path.startsWith("/project/"));
    markers.sort((a, b) => a.resource.path.localeCompare(b.resource.path) || b.severity - a.severity || a.startLineNumber - b.startLineNumber || a.startColumn - b.startColumn);
    const errors = markers.filter((m) => m.severity === MarkerSeverity.Error).length;
    count.textContent = String(markers.length);
    count.hidden = markers.length === 0;
    count.classList.toggle("has-errors", errors > 0);
    list.replaceChildren();
    if (markers.length === 0) {
      const empty = document.createElement("div");
      empty.className = "problems-empty";
      empty.textContent = s.checker ? "No problems found." : "Pyright has not started yet.";
      list.appendChild(empty);
      return;
    }
    const names: Record<number, string> = { [MarkerSeverity.Error]: "error", [MarkerSeverity.Warning]: "warning", [MarkerSeverity.Info]: "info", [MarkerSeverity.Hint]: "hint" };
    let lastPath = "";
    for (const m of markers) {
      const path = m.resource.path.slice("/project/".length);
      if (path !== lastPath) {
        lastPath = path;
        const head = document.createElement("div");
        head.className = "problems-file";
        head.textContent = path;
        list.appendChild(head);
      }
      const row = document.createElement("button");
      row.type = "button";
      row.className = "problem " + (names[m.severity] ?? "hint");
      row.setAttribute("role", "listitem");
      const code = m.code ? (typeof m.code === "string" ? m.code : m.code.value) : "";
      // The Linter's markers carry their code in the message; here it has a column of its own.
      const message = (m.message.split("\n")[0] ?? m.message).replace(code ? ` (${code})` : "\u0000", "");
      row.innerHTML = `<span class="problem-dot"></span><span class="problem-text"></span><span class="problem-source"></span><span class="problem-pos"></span>`;
      row.querySelector(".problem-text")!.textContent = message;
      row.title = m.message;
      row.querySelector(".problem-source")!.textContent = (m.source === "lsp" || m.owner === "lsp" ? "pyright" : m.source ?? m.owner) + (code ? ` (${code})` : "");
      row.querySelector(".problem-pos")!.textContent = `${m.startLineNumber}:${m.startColumn}`;
      row.addEventListener("click", () => {
        this.openFile(path);
        this.editor.setPosition({ lineNumber: m.startLineNumber, column: m.startColumn });
        this.editor.revealRangeInCenterIfOutsideViewport(m);
        this.editor.focus();
      });
      list.appendChild(row);
    }
  }

  private bindResizers() {
    const ide = this.$(".ide");
    const explorerWidth = Number(read(EXPLORER_WIDTH_KEY)) || 240;
    const panelHeight = Number(read(PANEL_HEIGHT_KEY)) || 240;
    ide.style.setProperty("--explorer-width", explorerWidth + "px");
    ide.style.setProperty("--panel-height", panelHeight + "px");
    const drag = (handle: HTMLElement, axis: "x" | "y") => {
      handle.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        handle.setPointerCapture(e.pointerId);
        const start = axis === "x" ? e.clientX : e.clientY;
        const initial = axis === "x" ? this.$(".explorer").getBoundingClientRect().width : this.$(".panel").getBoundingClientRect().height;
        const move = (ev: PointerEvent) => {
          const delta = axis === "x" ? ev.clientX - start : start - ev.clientY;
          const value = Math.max(axis === "x" ? 160 : 80, Math.min(axis === "x" ? 520 : 800, initial + delta));
          ide.style.setProperty(axis === "x" ? "--explorer-width" : "--panel-height", value + "px");
          write(axis === "x" ? EXPLORER_WIDTH_KEY : PANEL_HEIGHT_KEY, String(value));
        };
        const up = () => {
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", up);
          this.terminal?.layout();
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", up);
      });
    };
    drag(this.$(".explorer-resizer"), "x");
    drag(this.$(".panel-resizer"), "y");
  }

  private bindDrop() {
    const el = this.el;
    let depth = 0;
    el.addEventListener("dragenter", (e) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      depth++;
      el.classList.add("dragging");
    });
    el.addEventListener("dragleave", () => {
      if (--depth <= 0) {
        depth = 0;
        el.classList.remove("dragging");
      }
    });
    el.addEventListener("dragover", (e) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    });
    el.addEventListener("drop", (e) => {
      depth = 0;
      el.classList.remove("dragging");
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      void this.dropped(e.dataTransfer);
    });
  }

  /** Files and folders dropped from the desktop, folders walked with the entries API. */
  private async dropped(dt: DataTransfer) {
    const items: { path: string; file: File }[] = [];
    const walk = async (entry: FileSystemEntry, prefix: string) => {
      if (entry.isFile) {
        const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
        items.push({ path: prefix + entry.name, file });
      } else if (entry.isDirectory) {
        const reader = (entry as FileSystemDirectoryEntry).createReader();
        for (;;) {
          const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
          if (batch.length === 0) break;
          for (const child of batch) await walk(child, prefix + entry.name + "/");
        }
      }
    };
    const entries = [...dt.items].map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null));
    if (entries.some((e) => e)) {
      for (const e of entries) if (e) await walk(e, "");
    } else {
      for (const f of dt.files) items.push({ path: f.name, file: f });
    }
    if (items.length === 1 && /\.zip$/i.test(items[0]!.path) && items[0]!.file.size > 0 && !this.session?.project.files.size) {
      await this.importZip(items[0]!.file);
      return;
    }
    await this.addFiles(items);
  }
}
