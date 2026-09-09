// The Linter's worker: Ruff's wasm, which formats and lints synchronously and
// would otherwise stall the editor on a large file. Built as its own bundle
// by build.ts and spawned from a data: URL. The main thread posts the glue
// and wasm bytes in; the worker never touches the network.

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
    edits: { content: string | null; location: RuffLocation; end_location: RuffLocation }[];
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
  format(source: string): string;
  check(source: string): RuffDiagnostic[];
  free(): void;
}

interface RuffModule {
  default(init: { module_or_path: ArrayBuffer }): Promise<unknown>;
  Workspace: { new (options: unknown, encoding: number): Workspace; version(): string; defaultSettings(): unknown };
  PositionEncoding: { Utf16: number };
}

let ruff: RuffModule | null = null;
let workspace: Workspace | null = null;

// oxlint-disable-next-line unicorn/require-post-message-target-origin
const post = (msg: RuffResponse) => self.postMessage(msg);

self.onmessage = async (ev: MessageEvent<RuffRequest>) => {
  const msg = ev.data;
  try {
    if (msg.type === "load") {
      const mod = (await import(scriptDataUrl(msg.glue, "ruff_wasm.js"))) as RuffModule;
      await mod.default({ module_or_path: msg.wasm });
      ruff = mod;
      post({ type: "loaded", version: mod.Workspace.version() });
      return;
    }
    if (!ruff) throw new Error("Ruff has not loaded.");
    if (msg.type === "configure") {
      workspace?.free();
      workspace = new ruff.Workspace(msg.options, ruff.PositionEncoding.Utf16);
      post({ type: "configured", id: msg.id });
      return;
    }
    if (!workspace) throw new Error("Ruff has no settings yet.");
    if (msg.type === "format") post({ type: "format", id: msg.id, formatted: workspace.format(msg.source) });
    else if (msg.type === "check") post({ type: "check", id: msg.id, diagnostics: workspace.check(msg.source) });
  } catch (e) {
    const id = "id" in msg ? msg.id : null;
    post({ type: "error", id, message: describe(e) });
  }
};

function describe(e: unknown): string {
  if (e instanceof Error) return e.message;
  // Ruff raises plain strings for settings and syntax problems.
  return String(e);
}
