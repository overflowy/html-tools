// The Interpreter worker: one Pyodide per Project, off the main thread. Built
// as its own bundle by build.ts and spawned from a data: URL, which works
// from file://. Pyodide's loader and runtime module are imported from data:
// URLs of their cached bytes; its wasm and standard library are served to it
// by a fetch shim from bytes the main thread hands over, and every Wheel it
// asks for is routed to the main thread, which owns the Wheel Cache. The
// worker itself never touches the network except for PyPI's package index,
// which micropip queries when resolving a Dependency.

import type { PyodideAPI, loadPyodide as LoadPyodide } from "pyodide";
import type { PyProxy } from "pyodide/ffi";
import { scriptDataUrl } from "../../shared/script-url";
import RUNTIME_PY from "./runtime.py";
import MPL_BACKEND_PY from "./mpl_backend.py";

type PyodideConfig = NonNullable<Parameters<typeof LoadPyodide>[0]>;

/** The Emscripten filesystem calls used here; Pyodide's types leave FS undeclared. */
interface EmFS {
  mkdirTree(path: string): void;
  writeFile(path: string, data: string | Uint8Array, opts?: { canOwn?: boolean }): void;
  unlink(path: string): void;
  rmdir(path: string): void;
  readdir(path: string): string[];
}

export const PROJECT_ROOT = "/project";
const RUNTIME_DIR = "/pyide";

export interface BootOptions {
  cdnBase: string;
  loader: ArrayBuffer;
  factory: ArrayBuffer;
  wasm: ArrayBuffer;
  stdlib: ArrayBuffer;
  /** The Lock, or the release's catalog when the Project has none yet. */
  lock: string;
  /** Packages to have installed when boot completes. */
  packages: string[];
}

export interface FileEntry {
  /** Relative to the Project root. */
  path: string;
  data: ArrayBuffer | string;
}

export interface RunOptions {
  /** Relative to the Project root. */
  path: string;
  argv: string[];
  env: Record<string, string>;
  stdin: string;
  cols: number;
  rows: number;
}

export interface RunResult {
  exit: number;
  changed: { path: string; data: Uint8Array }[];
  removed: string[];
  skipped: string[];
}

export interface EnvironmentResult {
  lock: string;
  packages: { name: string; version: string; source: string }[];
}

export type ReplResult =
  | { status: "incomplete" }
  | { status: "ok"; text?: string }
  | { status: "error"; text: string }
  | { status: "exit"; text: string };

export type PyRequest =
  | ({ type: "boot"; id: number } & BootOptions)
  | { type: "files"; id: number; files: FileEntry[]; removed: string[]; folders: string[] }
  | ({ type: "run"; id: number } & RunOptions)
  | { type: "install"; id: number; specs: string[] }
  | { type: "uninstall"; id: number; names: string[] }
  | { type: "environment"; id: number }
  | { type: "mirror"; id: number }
  | { type: "repl"; id: number; line: string }
  | { type: "complete"; id: number; source: string }
  | { type: "resetRepl"; id: number }
  | { type: "resize"; cols: number; rows: number }
  /** The Terminal's answer to an input request: a line with its newline, or null at end of input. */
  | { type: "inputReply"; id: number; line: string | null }
  /** The main thread's answer to a fetch request. */
  | { type: "fetched"; id: number; ok: boolean; status?: number; bytes?: ArrayBuffer; error?: string };

export type PyResponse =
  | { type: "fetch"; id: number; url: string }
  | { type: "out"; stream: "stdout" | "stderr"; bytes: Uint8Array }
  | { type: "inputRequest"; id: number }
  | { type: "inputUnavailable" }
  | { type: "figure"; png: Uint8Array }
  | { type: "progress"; message: string }
  | { type: "done"; id: number; result: unknown }
  | { type: "fail"; id: number; message: string };

// A dedicated worker has no targetOrigin to give (and Bun's types disagree
// with the DOM's about Transferable).
const post = (msg: PyResponse, transfer: Transferable[] = []) =>
  (self as unknown as { postMessage(m: unknown, t: Transferable[]): void }).postMessage(msg, transfer);

let pyodide: PyodideAPI | null = null;
let runtime: PyProxy | null = null;
let terminal = { cols: 80, rows: 24 };

/* ---------------- fetch shim ---------------- */

const preloaded = new Map<string, ArrayBuffer>();
let nextFetchId = 1;
const fetches = new Map<number, { resolve: (r: Response) => void; reject: (e: Error) => void }>();
const realFetch = globalThis.fetch.bind(globalThis);

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function contentType(url: string): string {
  if (url.endsWith(".wasm")) return "application/wasm";
  if (url.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

/** Wheels go through the main thread's Wheel Cache; a miss there is fetched once and kept. */
function isWheel(url: string): boolean {
  return /\.whl($|\?)/.test(url);
}

function askMain(url: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const id = nextFetchId++;
    fetches.set(id, { resolve, reject });
    post({ type: "fetch", id, url });
  });
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = urlOf(input);
  const bytes = preloaded.get(url);
  if (bytes) return new Response(bytes, { headers: { "Content-Type": contentType(url) } });
  if (isWheel(url)) return askMain(url);
  return realFetch(input, init);
}) as typeof fetch;

function onFetched(msg: Extract<PyRequest, { type: "fetched" }>) {
  const p = fetches.get(msg.id);
  if (!p) return;
  fetches.delete(msg.id);
  if (msg.ok && msg.bytes) p.resolve(new Response(msg.bytes, { headers: { "Content-Type": "application/octet-stream" } }));
  else p.resolve(new Response(msg.error ?? "not available", { status: msg.status ?? 502 }));
}

/* ---------------- input ---------------- */

let nextInputId = 1;
const inputs = new Map<number, (line: string | null) => void>();

/** The JavaScript module Python imports as `pyide_host`. */
const host = {
  runArgs: {} as unknown,
  toObject: Object.fromEntries,
  requestInput(): Promise<string | null> {
    return new Promise((resolve) => {
      const id = nextInputId++;
      inputs.set(id, resolve);
      post({ type: "inputRequest", id });
    });
  },
  inputUnavailable() {
    post({ type: "inputUnavailable" });
  },
  emitFigure(png: Uint8Array) {
    const owned = png.slice();
    post({ type: "figure", png: owned }, [owned.buffer]);
  },
};

/* ---------------- boot ---------------- */

function writer(stream: "stdout" | "stderr") {
  return {
    write(bytes: Uint8Array): number {
      // Pyodide's own memory backs `bytes`; only a copy may be transferred.
      const owned = bytes.slice();
      post({ type: "out", stream, bytes: owned }, [owned.buffer]);
      return bytes.length;
    },
    isatty: true,
    getTerminalSize: () => ({ columns: terminal.cols, rows: terminal.rows }),
  };
}

async function boot(opts: BootOptions): Promise<{ python: string; jspi: boolean }> {
  preloaded.set(opts.cdnBase + "pyodide.asm.wasm", opts.wasm);
  preloaded.set(opts.cdnBase + "python_stdlib.zip", opts.stdlib);
  const loaderUrl = scriptDataUrl(opts.loader);
  const factoryUrl = scriptDataUrl(opts.factory);
  post({ type: "progress", message: "Starting Python" });
  const { loadPyodide } = (await import(loaderUrl)) as { loadPyodide: (c: PyodideConfig) => Promise<PyodideAPI> };
  const { default: createPyodideModule } = (await import(factoryUrl)) as { default: PyodideConfig["createPyodideModule"] };
  const py = await loadPyodide({
    indexURL: opts.cdnBase,
    createPyodideModule,
    lockFileContents: JSON.parse(opts.lock),
    packageBaseUrl: opts.cdnBase,
    packages: opts.packages,
    env: { HOME: "/home/pyodide", MPLBACKEND: "module://pyide_mpl", PYTHONUNBUFFERED: "1" },
  });
  preloaded.clear();
  pyodide = py;
  py.setStdout(writer("stdout"));
  py.setStderr(writer("stderr"));
  py.registerJsModule("pyide_host", host);
  const fs = FS(py);
  fs.mkdirTree(RUNTIME_DIR);
  fs.mkdirTree(PROJECT_ROOT);
  fs.writeFile(RUNTIME_DIR + "/pyide_runtime.py", RUNTIME_PY);
  fs.writeFile(RUNTIME_DIR + "/pyide_mpl.py", MPL_BACKEND_PY);
  py.runPython(`import sys; sys.path.append(${JSON.stringify(RUNTIME_DIR)})`);
  runtime = py.pyimport("pyide_runtime");
  const python = py.runPython("import platform; platform.python_version()") as string;
  // Whether run_sync, and with it interactive input, works: only inside a
  // runPythonAsync stack, which is where every Run and REPL line is entered.
  const jspi = (await py.runPythonAsync("from pyodide.ffi import can_run_sync; can_run_sync()")) as boolean;
  return { python, jspi };
}

/* ---------------- requests ---------------- */

function need(): { py: PyodideAPI; rt: PyProxy } {
  if (!pyodide || !runtime) throw new Error("The interpreter has not booted.");
  return { py: pyodide, rt: runtime };
}

function FS(py: PyodideAPI = need().py): EmFS {
  return py.FS as unknown as EmFS;
}

function writeFiles(msg: Extract<PyRequest, { type: "files" }>) {
  const fs = FS();
  for (const rel of msg.removed) {
    const full = PROJECT_ROOT + "/" + rel;
    try {
      fs.unlink(full);
    } catch {
      // already gone
    }
    pruneEmptyDirs(fs, full);
  }
  for (const dir of msg.folders) fs.mkdirTree(PROJECT_ROOT + "/" + dir);
  for (const f of msg.files) {
    const full = PROJECT_ROOT + "/" + f.path;
    const dir = full.slice(0, full.lastIndexOf("/"));
    if (dir) fs.mkdirTree(dir);
    if (typeof f.data === "string") fs.writeFile(full, f.data);
    else fs.writeFile(full, new Uint8Array(f.data), { canOwn: true });
  }
}

function pruneEmptyDirs(fs: EmFS, full: string) {
  let dir = full.slice(0, full.lastIndexOf("/"));
  while (dir.length > PROJECT_ROOT.length) {
    try {
      if (fs.readdir(dir).filter((n) => n !== "." && n !== "..").length) return;
      fs.rmdir(dir);
    } catch {
      return;
    }
    dir = dir.slice(0, dir.lastIndexOf("/"));
  }
}

async function run(msg: Extract<PyRequest, { type: "run" }>): Promise<RunResult> {
  const { py } = need();
  terminal = { cols: msg.cols, rows: msg.rows };
  host.runArgs = { path: PROJECT_ROOT + "/" + msg.path, argv: msg.argv, env: msg.env, stdin: msg.stdin };
  // Entered through runPythonAsync so that run_sync (and with it interactive
  // input) is available to everything the file calls.
  const result = (await py.runPythonAsync("import pyide_runtime; pyide_runtime.run_file()")) as RunResult;
  // to_js may hand back views into Pyodide's memory; only copies can be transferred.
  for (const c of result.changed) c.data = c.data.slice();
  return result;
}

async function pythonJson<T>(code: string): Promise<T> {
  const { py } = need();
  const text = (await py.runPythonAsync(code)) as string;
  return JSON.parse(text) as T;
}

/** A JavaScript value as a Python literal, to pass arguments in the code itself. */
function lit(value: unknown): string {
  return "__import__('json').loads(" + JSON.stringify(JSON.stringify(value)) + ")";
}

async function handle(msg: PyRequest): Promise<unknown> {
  switch (msg.type) {
    case "boot":
      return boot(msg);
    case "files":
      writeFiles(msg);
      return null;
    case "run":
      return run(msg);
    case "install":
      return pythonJson<EnvironmentResult>(`import pyide_runtime; await pyide_runtime.install(${lit(msg.specs)})`);
    case "uninstall":
      return pythonJson<EnvironmentResult>(`import pyide_runtime; await pyide_runtime.uninstall(${lit(msg.names)})`);
    case "environment":
      return pythonJson<EnvironmentResult>("import pyide_runtime; pyide_runtime.environment()");
    case "mirror": {
      const { rt } = need();
      return (rt.mirror as () => Record<string, string>)();
    }
    case "repl":
      return pythonJson<ReplResult>(`import pyide_runtime; await pyide_runtime.repl(${lit(msg.line)})`);
    case "complete":
      return pythonJson<{ completions: string[]; start: number }>(`import pyide_runtime; pyide_runtime.complete(${lit(msg.source)})`);
    case "resetRepl": {
      const { rt } = need();
      (rt.reset_repl as () => void)();
      return null;
    }
    default:
      throw new Error("Unknown request " + (msg as { type: string }).type);
  }
}

self.onmessage = async (ev: MessageEvent<PyRequest>) => {
  const msg = ev.data;
  if (msg.type === "fetched") return onFetched(msg);
  if (msg.type === "inputReply") {
    const resolve = inputs.get(msg.id);
    inputs.delete(msg.id);
    resolve?.(msg.line);
    return;
  }
  if (msg.type === "resize") {
    terminal = { cols: msg.cols, rows: msg.rows };
    return;
  }
  try {
    const result = await handle(msg);
    const transfer: Transferable[] = [];
    if (msg.type === "run") for (const c of (result as RunResult).changed) transfer.push(c.data.buffer as ArrayBuffer);
    post({ type: "done", id: msg.id, result }, transfer);
  } catch (e) {
    post({ type: "fail", id: msg.id, message: describe(e) });
  }
};

function describe(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
