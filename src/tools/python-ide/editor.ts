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

export const defineTheme = (monaco: typeof Monaco) => {
  const style = getComputedStyle(document.documentElement);
  const v = (name: string) => style.getPropertyValue(name).trim();
  monaco.editor.defineTheme("pyide", {
    base: "vs-dark",
    colors: {
      "editor.background": v("--bg") || "#1a1a1a",
      "editor.foreground": v("--text") || "#f5f4ee",
      "editor.inactiveSelectionBackground": "#c9644230",
      "editor.lineHighlightBackground": "#ffffff08",
      "editor.lineHighlightBorder": "#00000000",
      "editor.selectionBackground": "#c9644255",
      "editorCursor.foreground": v("--accent") || "#c96442",
      "editorError.foreground": "#f28b82",
      "editorGutter.background": v("--bg") || "#1a1a1a",
      "editorHoverWidget.background": v("--surface") || "#262625",
      "editorIndentGuide.activeBackground1": "#ffffff28",
      "editorIndentGuide.background1": "#ffffff10",
      "editorInfo.foreground": "#8ab4f8",
      "editorLineNumber.activeForeground": "#a0a09a",
      "editorLineNumber.foreground": "#5f5f5a",
      "editorSuggestWidget.background": v("--surface") || "#262625",
      "editorSuggestWidget.selectedBackground": "#c9644240",
      "editorWarning.foreground": "#e3c17a",
      "editorWidget.background": v("--surface") || "#262625",
      "editorWidget.border": "#ffffff20",
      focusBorder: v("--accent") || "#c96442",
      "input.background": v("--surface-2") || "#2d2d2c",
      "list.activeSelectionBackground": "#c9644240",
      "list.hoverBackground": "#ffffff0a",
      "minimap.background": v("--bg") || "#1a1a1a",
      "scrollbarSlider.background": "#ffffff18",
      "scrollbarSlider.hoverBackground": "#ffffff28",
    },
    inherit: true,
    rules: [
      { fontStyle: "italic", foreground: "7f7f79", token: "comment" },
      { foreground: "d9a066", token: "keyword" },
      { foreground: "9fbf7f", token: "string" },
      { foreground: "e3c17a", token: "number" },
      { foreground: "8ab4f8", token: "type" },
      { foreground: "c96442", token: "tag" },
      { foreground: "a0a09a", token: "delimiter" },
    ],
  });
};

/** A TOML tokenizer good enough for pyproject.toml. */
export const registerToml = (monaco: typeof Monaco) => {
  if (monaco.languages.getLanguages().some((l) => l.id === "toml")) {
    return;
  }
  monaco.languages.register({
    aliases: ["TOML"],
    extensions: [".toml"],
    id: "toml",
  });
  monaco.languages.setLanguageConfiguration("toml", {
    autoClosingPairs: [
      { close: "]", open: "[" },
      { close: "}", open: "{" },
      { close: '"', open: '"' },
      { close: "'", open: "'" },
    ],
    brackets: [
      ["[", "]"],
      ["{", "}"],
    ],
    comments: { lineComment: "#" },
  });
  // Monarch compiles each rule from its regex's source with flags of its
  // own, so a literal's flags do not reach the tokenizer. Its start state
  // is named, not left to whichever state comes first.
  monaco.languages.setMonarchTokensProvider("toml", {
    start: "root",
    tokenizer: {
      mstring: [
        [/"""/u, "string", "@pop"],
        [/./u, "string"],
      ],
      root: [
        [/#.*$/u, "comment"],
        [/^\s*\[\[?[^\]]*\]\]?/u, "type"],
        [/^\s*[A-Za-z0-9_.-]+(?=\s*=)/u, "tag"],
        [/"""/u, "string", "@mstring"],
        [/"(?:[^"\\]|\\.)*"/u, "string"],
        [/'[^']*'/u, "string"],
        [/\b(?:true|false)\b/u, "keyword"],
        [
          /\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?/u,
          "number",
        ],
        [/[+-]?(?:inf|nan)\b/u, "number"],
        [
          /[+-]?(?:0x[0-9a-fA-F_]+|0o[0-7_]+|0b[01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)/u,
          "number",
        ],
        [/[[\]{},=]/u, "delimiter"],
      ],
    },
  });
};

/** JSON keeps its tokenizer and drops the worker-backed services, which would want a second worker. */
export const configureJson = (monaco: typeof Monaco) => {
  monaco.json.jsonDefaults.setModeConfiguration({
    colors: false,
    completionItems: false,
    diagnostics: false,
    documentFormattingEdits: false,
    documentRangeFormattingEdits: false,
    documentSymbols: false,
    foldingRanges: false,
    hovers: false,
    selectionRanges: false,
    tokens: true,
  });
};

export const createEditor = (
  monaco: typeof Monaco,
  host: HTMLElement,
  tabSize: number
): Editor => {
  const style = getComputedStyle(document.documentElement);
  return monaco.editor.create(host, {
    automaticLayout: true,
    bracketPairColorization: { enabled: true },
    cursorBlinking: "smooth",
    fixedOverflowWidgets: true,
    fontFamily: style.getPropertyValue("--mono").trim() || "monospace",
    fontSize: 13,
    insertSpaces: true,
    lineHeight: 20,
    minimap: { enabled: false },
    model: null,
    padding: { top: 10 },
    renderLineHighlight: "line",
    scrollBeyondLastLine: false,
    "semanticHighlighting.enabled": true,
    smoothScrolling: true,
    stickyScroll: { enabled: false },
    tabSize,
    theme: "pyide",
  });
};

/* ---------------- the Linter in the editor ---------------- */

interface Loc {
  row: number;
  column: number;
}

const toRange = (start: Loc, end: Loc): Monaco.IRange => ({
  endColumn: end.column,
  endLineNumber: end.row,
  startColumn: start.column,
  startLineNumber: start.row,
});

export class LinterBinding {
  /** The Linter's latest findings per model, for quick fixes. */
  private findings = new Map<string, RuffDiagnostic[]>();
  private timers = new Map<string, number>();
  private disposables: Monaco.IDisposable[] = [];
  private generation = 0;

  private monaco: typeof Monaco;
  private linter: Linter;
  private onError: (message: string) => void;

  constructor(
    monaco: typeof Monaco,
    linter: Linter,
    onError: (message: string) => void
  ) {
    this.monaco = monaco;
    this.linter = linter;
    this.onError = onError;
    this.disposables.push(
      monaco.languages.registerCodeActionProvider("python", {
        provideCodeActions: (model, range, context) =>
          this.codeActions(model, range, context),
      }),
      monaco.languages.registerDocumentFormattingEditProvider("python", {
        provideDocumentFormattingEdits: (model) => this.formatEdits(model),
      })
    );
  }

  /** Re-lints every model: the Project's Ruff settings changed. */
  invalidate(models: Iterable<Model>) {
    this.generation += 1;
    for (const m of models) {
      this.schedule(m, 0);
    }
  }

  schedule(model: Model, delay = 250) {
    if (model.getLanguageId() !== "python") {
      return;
    }
    const key = model.uri.toString();
    const t = this.timers.get(key);
    if (t) {
      clearTimeout(t);
    }
    this.timers.set(
      key,
      window.setTimeout(() => this.lint(model), delay)
    );
  }

  forget(model: Model) {
    const key = model.uri.toString();
    const t = this.timers.get(key);
    if (t) {
      clearTimeout(t);
    }
    this.timers.delete(key);
    this.findings.delete(key);
  }

  private async lint(model: Model) {
    if (model.isDisposed()) {
      return;
    }
    const version = model.getVersionId();
    const { generation } = this;
    let diagnostics: RuffDiagnostic[];
    try {
      diagnostics = await this.linter.check(model.getValue());
    } catch (error) {
      this.onError(error instanceof Error ? error.message : String(error));
      return;
    }
    if (
      model.isDisposed() ||
      model.getVersionId() !== version ||
      generation !== this.generation
    ) {
      return;
    }
    this.findings.set(model.uri.toString(), diagnostics);
    const { MarkerSeverity, MarkerTag } = this.monaco;
    const markers: Monaco.editor.IMarkerData[] = diagnostics.map((d) =>
      Object.assign(toRange(d.start_location, d.end_location), {
        code: d.code ?? undefined,
        message: d.code ? `${d.message} (${d.code})` : d.message,
        severity:
          d.code === null ? MarkerSeverity.Error : MarkerSeverity.Warning,
        source: "ruff",
        tags: d.tags.map((t) =>
          t === "unnecessary" ? MarkerTag.Unnecessary : MarkerTag.Deprecated
        ),
      })
    );
    this.monaco.editor.setModelMarkers(model, RUFF_OWNER, markers);
  }

  private codeActions(
    model: Model,
    range: Monaco.Range,
    context: Monaco.languages.CodeActionContext
  ): Monaco.languages.CodeActionList {
    const findings = this.findings.get(model.uri.toString()) ?? [];
    const actions: Monaco.languages.CodeAction[] = [];
    for (const marker of context.markers) {
      if (marker.source !== "ruff") {
        continue;
      }
      const d = findings.find(
        (f) =>
          f.fix &&
          f.start_location.row === marker.startLineNumber &&
          f.start_location.column === marker.startColumn &&
          (f.code ?? undefined) === marker.code
      );
      if (!d?.fix) {
        continue;
      }
      actions.push({
        diagnostics: [marker],
        edit: {
          edits: d.fix.edits.map((e) => ({
            resource: model.uri,
            textEdit: {
              range: toRange(e.location, e.end_location),
              text: e.content ?? "",
            },
            versionId: model.getVersionId(),
          })),
        },
        isPreferred: true,
        kind: "quickfix",
        title: d.fix.message ?? `Fix ${d.code ?? ""}`.trim(),
      });
    }
    void range;
    return {
      actions,
      dispose() {
        // Nothing was registered that needs releasing.
      },
    };
  }

  private async formatEdits(
    model: Model
  ): Promise<Monaco.languages.TextEdit[]> {
    const source = model.getValue();
    let formatted: string;
    try {
      formatted = await this.linter.format(source);
    } catch (error) {
      this.onError(
        `Format: ${error instanceof Error ? error.message : String(error)}`
      );
      return [];
    }
    if (formatted === source) {
      return [];
    }
    return [{ range: model.getFullModelRange(), text: formatted }];
  }

  dispose() {
    for (const d of this.disposables) {
      d.dispose();
    }
    for (const t of this.timers.values()) {
      clearTimeout(t);
    }
    this.timers.clear();
  }
}
