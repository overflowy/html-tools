// Monaco, set up for the Python IDE: the Theme's colours, a TOML tokenizer
// (Monaco has none), JSON without its worker, and the Linter wired in as
// markers, quick fixes, and the document formatter. One editor instance
// shows one model at a time; models are kept per Project file so the
// Checker always sees live text.

import type * as Monaco from "monaco-editor";
import type { Linter, RuffDiagnostic } from "./ruff";

type Editor = Monaco.editor.IStandaloneCodeEditor;
type Model = Monaco.editor.ITextModel;

const RUFF_OWNER = "ruff";

export function defineTheme(monaco: typeof Monaco) {
  const style = getComputedStyle(document.documentElement);
  const v = (name: string) => style.getPropertyValue(name).trim();
  monaco.editor.defineTheme("pyide", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "7f7f79", fontStyle: "italic" },
      { token: "keyword", foreground: "d9a066" },
      { token: "string", foreground: "9fbf7f" },
      { token: "number", foreground: "e3c17a" },
      { token: "type", foreground: "8ab4f8" },
      { token: "tag", foreground: "c96442" },
      { token: "delimiter", foreground: "a0a09a" },
    ],
    colors: {
      "editor.background": v("--bg") || "#1a1a1a",
      "editor.foreground": v("--text") || "#f5f4ee",
      "editor.lineHighlightBackground": "#ffffff08",
      "editor.lineHighlightBorder": "#00000000",
      "editorLineNumber.foreground": "#5f5f5a",
      "editorLineNumber.activeForeground": "#a0a09a",
      "editor.selectionBackground": "#c9644255",
      "editor.inactiveSelectionBackground": "#c9644230",
      "editorCursor.foreground": v("--accent") || "#c96442",
      "editorIndentGuide.background1": "#ffffff10",
      "editorIndentGuide.activeBackground1": "#ffffff28",
      "editorWidget.background": v("--surface") || "#262625",
      "editorWidget.border": "#ffffff20",
      "editorSuggestWidget.background": v("--surface") || "#262625",
      "editorSuggestWidget.selectedBackground": "#c9644240",
      "editorHoverWidget.background": v("--surface") || "#262625",
      "input.background": v("--surface-2") || "#2d2d2c",
      "focusBorder": v("--accent") || "#c96442",
      "list.activeSelectionBackground": "#c9644240",
      "list.hoverBackground": "#ffffff0a",
      "minimap.background": v("--bg") || "#1a1a1a",
      "scrollbarSlider.background": "#ffffff18",
      "scrollbarSlider.hoverBackground": "#ffffff28",
      "editorGutter.background": v("--bg") || "#1a1a1a",
      "editorError.foreground": "#f28b82",
      "editorWarning.foreground": "#e3c17a",
      "editorInfo.foreground": "#8ab4f8",
    },
  });
}

/** A TOML tokenizer good enough for pyproject.toml. */
export function registerToml(monaco: typeof Monaco) {
  if (monaco.languages.getLanguages().some((l) => l.id === "toml")) return;
  monaco.languages.register({ id: "toml", extensions: [".toml"], aliases: ["TOML"] });
  monaco.languages.setLanguageConfiguration("toml", {
    comments: { lineComment: "#" },
    brackets: [["[", "]"], ["{", "}"]],
    autoClosingPairs: [{ open: "[", close: "]" }, { open: "{", close: "}" }, { open: '"', close: '"' }, { open: "'", close: "'" }],
  });
  monaco.languages.setMonarchTokensProvider("toml", {
    tokenizer: {
      root: [
        [/#.*$/, "comment"],
        [/^\s*\[\[?[^\]]*\]\]?/, "type"],
        [/^\s*[A-Za-z0-9_.-]+(?=\s*=)/, "tag"],
        [/"""/, "string", "@mstring"],
        [/"([^"\\]|\\.)*"/, "string"],
        [/'[^']*'/, "string"],
        [/\b(true|false)\b/, "keyword"],
        [/\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?/, "number"],
        [/[+-]?(inf|nan)\b/, "number"],
        [/[+-]?(0x[0-9a-fA-F_]+|0o[0-7_]+|0b[01_]+|\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d+)?)/, "number"],
        [/[[\]{},=]/, "delimiter"],
      ],
      mstring: [
        [/"""/, "string", "@pop"],
        [/./, "string"],
      ],
    },
  });
}

/** JSON keeps its tokenizer and drops the worker-backed services, which would want a second worker. */
export function configureJson(monaco: typeof Monaco) {
  monaco.json.jsonDefaults.setModeConfiguration({
    documentFormattingEdits: false,
    documentRangeFormattingEdits: false,
    completionItems: false,
    hovers: false,
    documentSymbols: false,
    tokens: true,
    colors: false,
    foldingRanges: false,
    diagnostics: false,
    selectionRanges: false,
  });
}

export function createEditor(monaco: typeof Monaco, host: HTMLElement, tabSize: number): Editor {
  const style = getComputedStyle(document.documentElement);
  return monaco.editor.create(host, {
    model: null,
    theme: "pyide",
    automaticLayout: true,
    fontFamily: style.getPropertyValue("--mono").trim() || "monospace",
    fontSize: 13,
    lineHeight: 20,
    tabSize,
    insertSpaces: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    renderLineHighlight: "line",
    padding: { top: 10 },
    smoothScrolling: true,
    cursorBlinking: "smooth",
    bracketPairColorization: { enabled: true },
    stickyScroll: { enabled: false },
    fixedOverflowWidgets: true,
    "semanticHighlighting.enabled": true,
  });
}

/* ---------------- the Linter in the editor ---------------- */

type Loc = { row: number; column: number };

function toRange(start: Loc, end: Loc): Monaco.IRange {
  return { startLineNumber: start.row, startColumn: start.column, endLineNumber: end.row, endColumn: end.column };
}

export class LinterBinding {
  /** The Linter's latest findings per model, for quick fixes. */
  private findings = new Map<string, RuffDiagnostic[]>();
  private timers = new Map<string, number>();
  private disposables: Monaco.IDisposable[] = [];
  private generation = 0;

  constructor(private monaco: typeof Monaco, private linter: Linter, private onError: (message: string) => void) {
    this.disposables.push(
      monaco.languages.registerCodeActionProvider("python", {
        provideCodeActions: (model, range, context) => this.codeActions(model, range, context),
      }),
      monaco.languages.registerDocumentFormattingEditProvider("python", {
        provideDocumentFormattingEdits: (model) => this.formatEdits(model),
      }),
    );
  }

  /** Re-lints every model: the Project's Ruff settings changed. */
  invalidate(models: Iterable<Model>) {
    this.generation++;
    for (const m of models) this.schedule(m, 0);
  }

  schedule(model: Model, delay = 250) {
    if (model.getLanguageId() !== "python") return;
    const key = model.uri.toString();
    const t = this.timers.get(key);
    if (t) clearTimeout(t);
    this.timers.set(key, window.setTimeout(() => this.lint(model), delay));
  }

  forget(model: Model) {
    const key = model.uri.toString();
    const t = this.timers.get(key);
    if (t) clearTimeout(t);
    this.timers.delete(key);
    this.findings.delete(key);
  }

  private async lint(model: Model) {
    if (model.isDisposed()) return;
    const version = model.getVersionId();
    const generation = this.generation;
    let diagnostics: RuffDiagnostic[];
    try {
      diagnostics = await this.linter.check(model.getValue());
    } catch (e) {
      this.onError(e instanceof Error ? e.message : String(e));
      return;
    }
    if (model.isDisposed() || model.getVersionId() !== version || generation !== this.generation) return;
    this.findings.set(model.uri.toString(), diagnostics);
    const { MarkerSeverity, MarkerTag } = this.monaco;
    const markers: Monaco.editor.IMarkerData[] = diagnostics.map((d) => Object.assign(toRange(d.start_location, d.end_location), {
      message: d.code ? `${d.message} (${d.code})` : d.message,
      severity: d.code === null ? MarkerSeverity.Error : MarkerSeverity.Warning,
      code: d.code ?? undefined,
      source: "ruff",
      tags: d.tags.map((t) => (t === "unnecessary" ? MarkerTag.Unnecessary : MarkerTag.Deprecated)),
    }));
    this.monaco.editor.setModelMarkers(model, RUFF_OWNER, markers);
  }

  private codeActions(model: Model, range: Monaco.Range, context: Monaco.languages.CodeActionContext): Monaco.languages.CodeActionList {
    const findings = this.findings.get(model.uri.toString()) ?? [];
    const actions: Monaco.languages.CodeAction[] = [];
    for (const marker of context.markers) {
      if (marker.source !== "ruff") continue;
      const d = findings.find((f) => f.fix && f.start_location.row === marker.startLineNumber && f.start_location.column === marker.startColumn && (f.code ?? undefined) === marker.code);
      if (!d?.fix) continue;
      actions.push({
        title: d.fix.message ?? `Fix ${d.code ?? ""}`.trim(),
        kind: "quickfix",
        diagnostics: [marker],
        isPreferred: true,
        edit: {
          edits: d.fix.edits.map((e) => ({
            resource: model.uri,
            versionId: model.getVersionId(),
            textEdit: { range: toRange(e.location, e.end_location), text: e.content ?? "" },
          })),
        },
      });
    }
    void range;
    return { actions, dispose() {} };
  }

  private async formatEdits(model: Model): Promise<Monaco.languages.TextEdit[]> {
    const source = model.getValue();
    let formatted: string;
    try {
      formatted = await this.linter.format(source);
    } catch (e) {
      this.onError("Format: " + (e instanceof Error ? e.message : String(e)));
      return [];
    }
    if (formatted === source) return [];
    return [{ range: model.getFullModelRange(), text: formatted }];
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
