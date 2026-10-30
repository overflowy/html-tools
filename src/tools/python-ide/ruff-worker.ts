// The Linter's worker: Ruff's wasm, which formats and lints synchronously and
// would otherwise stall the editor on a large file. Built as its own bundle
// by build.ts and spawned from a data: URL. The main thread posts the glue
// and wasm bytes in; the worker never touches the network.
//
// A format sorts the imports first, as `ruff check --select I --fix` and
// then `ruff format` would. Ruff's wasm build has no fix call, so the sort
// is the fixes its import rules report, applied here, from a second
// Workspace that selects those rules alone: the Project's isort settings
// and line length hold, whatever rules it lints with.

import { scriptDataUrl } from "../../shared/script-url";

/** A Ruff diagnostic as the wasm build reports it (rows and columns 1-based, UTF-16 columns). */
export interface RuffLocation {
  row: number;
  column: number;
}

export interface RuffDiagnostic {
  code: string | null;
  message: string;
  tags: ("unnecessary" | "deprecated")[];
  start_location: RuffLocation;
  end_location: RuffLocation;
  fix: {
    message: string | null;
    edits: {
      content: string | null;
      location: RuffLocation;
      end_location: RuffLocation;
    }[];
  } | null;
}

export type RuffRequest =
  | { type: "load"; glue: string; wasm: ArrayBuffer }
  /** Ruff's own settings shape, as pyproject.toml's [tool.ruff] table would give it. */
  | { type: "configure"; id: number; options: unknown }
  | { type: "format"; id: number; source: string }
  | { type: "check"; id: number; source: string };

export type RuffResponse =
  | { type: "loaded"; version: string }
  | { type: "configured"; id: number }
  | { type: "format"; id: number; formatted: string }
  | { type: "check"; id: number; diagnostics: RuffDiagnostic[] }
  | { type: "error"; id: number | null; message: string };

interface Workspace {
  format: (source: string) => string;
  check: (source: string) => RuffDiagnostic[];
  free: () => void;
}

interface RuffModule {
  default: (init: { module_or_path: ArrayBuffer }) => Promise<unknown>;
  Workspace: {
    new (options: unknown, encoding: number): Workspace;
    version: () => string;
    defaultSettings: () => unknown;
  };
  PositionEncoding: { Utf16: number };
}

let ruff: RuffModule | null = null;
let workspace: Workspace | null = null;
/** The Project's settings with only the import rules selected, for the sort a format starts with. */
let sorter: Workspace | null = null;

/** Keys that choose which rules run, at the top level (Ruff's older shape) and under lint. */
const RULE_CHOICE = new Set([
  "select",
  "extend-select",
  "ignore",
  "extend-ignore",
  "fixable",
  "extend-fixable",
  "unfixable",
  "per-file-ignores",
  "extend-per-file-ignores",
]);

const isTable = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const withoutRuleChoice = (
  table: Record<string, unknown>
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(table).filter(([key]) => !RULE_CHOICE.has(key))
  );

/** The Project's settings, rule choices dropped, selecting the import rules alone. */
const sortOptions = (options: unknown): Record<string, unknown> => {
  const top = isTable(options) ? withoutRuleChoice(options) : {};
  const lint = isTable(top.lint) ? withoutRuleChoice(top.lint) : {};
  return { ...top, lint: { ...lint, select: ["I"] } };
};

/** Where each line starts, as Ruff counts lines (LF, CRLF, or CR). */
const lineStarts = (source: string): number[] => {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    if (c === "\r" && source[i + 1] === "\n") {
      i += 1;
    }
    if (c === "\r" || c === "\n") {
      starts.push(i + 1);
    }
  }
  return starts;
};

/** The source with its imports sorted; as it was when it does not parse. */
const sortImports = (source: string, ws: Workspace): string => {
  const diagnostics = ws.check(source);
  // A syntax error (no code) leaves the source to the formatter, which says where.
  if (diagnostics.some((d) => d.code === null)) {
    return source;
  }
  const starts = lineStarts(source);
  const offset = (at: RuffLocation): number =>
    Math.min(
      (starts[at.row - 1] ?? source.length) + at.column - 1,
      source.length
    );
  const edits = diagnostics
    .flatMap((d) => d.fix?.edits ?? [])
    .map((e) => ({
      end: offset(e.end_location),
      start: offset(e.location),
      text: e.content ?? "",
    }))
    .toSorted((a, b) => b.start - a.start);
  let sorted = source;
  let bound = source.length;
  for (const e of edits) {
    // Each import block is its own finding; one that overlaps another is left for the next format.
    if (e.end > bound) {
      continue;
    }
    sorted = sorted.slice(0, e.start) + e.text + sorted.slice(e.end);
    bound = e.start;
  }
  return sorted;
};

const post = (msg: RuffResponse) => self.postMessage(msg, { transfer: [] });

const describe = (e: unknown): string => {
  if (e instanceof Error) {
    return e.message;
  }
  // Ruff raises plain strings for settings and syntax problems.
  return String(e);
};

self.onmessage = async (ev: MessageEvent<RuffRequest>) => {
  const msg = ev.data;
  try {
    if (msg.type === "load") {
      const mod = (await import(
        scriptDataUrl(msg.glue, "ruff_wasm.js")
      )) as RuffModule;
      await mod.default({ module_or_path: msg.wasm });
      ruff = mod;
      post({ type: "loaded", version: mod.Workspace.version() });
      return;
    }
    if (!ruff) {
      throw new Error("Ruff has not loaded.");
    }
    if (msg.type === "configure") {
      const next = new ruff.Workspace(msg.options, ruff.PositionEncoding.Utf16);
      const nextSorter = new ruff.Workspace(
        sortOptions(msg.options),
        ruff.PositionEncoding.Utf16
      );
      workspace?.free();
      sorter?.free();
      workspace = next;
      sorter = nextSorter;
      post({ id: msg.id, type: "configured" });
      return;
    }
    if (!(workspace && sorter)) {
      throw new Error("Ruff has no settings yet.");
    }
    if (msg.type === "format") {
      post({
        formatted: workspace.format(sortImports(msg.source, sorter)),
        id: msg.id,
        type: "format",
      });
    } else if (msg.type === "check") {
      post({
        diagnostics: workspace.check(msg.source),
        id: msg.id,
        type: "check",
      });
    }
  } catch (error) {
    const id = "id" in msg ? msg.id : null;
    post({ id, message: describe(error), type: "error" });
  }
};
