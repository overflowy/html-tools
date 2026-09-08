// The Engines the Python IDE fetches: the editor (Monaco, as the chunks of
// its AMD build plus its stylesheet and worker), the Interpreter (Pyodide's
// five core files), the Checker (basedpyright's browser worker), the Linter
// (Ruff's wasm and glue), and the Terminal (xterm.js with its fit addon).
// Every one goes through the Engine cache, so a second visit fetches nothing:
// Monaco is assembled from cached chunks by amd.ts, and Pyodide boots from
// bytes handed to its worker.

import { getEngine, type EngineAsset, type Progress } from "../../shared/engines";
import { AmdLoader } from "./amd";

export const PYODIDE_VERSION = "314.0.6";
export const MONACO_VERSION = "0.56.0";
export const PYRIGHT_VERSION = "1.40.0";
export const RUFF_VERSION = "0.16.6";
export const XTERM_VERSION = "6.0.0";
export const XTERM_FIT_VERSION = "0.11.0";

const NPM = "https://cdn.jsdelivr.net/npm/";
export const PYODIDE_BASE = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
const MONACO_BASE = `${NPM}monaco-editor@${MONACO_VERSION}/min/`;

/* ---------------- Pyodide ---------------- */

function pyodideAsset(file: string, label: string, approxBytes: number): EngineAsset {
  return { id: "pyodide-" + file, label, version: PYODIDE_VERSION, url: PYODIDE_BASE + file, approxBytes };
}

export const PYODIDE = {
  loader: pyodideAsset("pyodide.mjs", "Pyodide loader", 18_000),
  factory: pyodideAsset("pyodide.asm.mjs", "Pyodide runtime", 1_250_000),
  wasm: pyodideAsset("pyodide.asm.wasm", "Python interpreter", 9_600_000),
  stdlib: pyodideAsset("python_stdlib.zip", "Python standard library", 2_550_000),
  lock: pyodideAsset("pyodide-lock.json", "Pyodide package catalog", 115_000),
};

export interface PyodideAssets {
  loader: ArrayBuffer;
  factory: ArrayBuffer;
  wasm: ArrayBuffer;
  stdlib: ArrayBuffer;
  lock: string;
}

export async function loadPyodideAssets(onProgress?: LoadProgress): Promise<PyodideAssets> {
  const report = combined(onProgress);
  const [loader, factory, wasm, stdlib, lock] = await Promise.all([
    getEngine(PYODIDE.loader, report),
    getEngine(PYODIDE.factory, report),
    getEngine(PYODIDE.wasm, report),
    getEngine(PYODIDE.stdlib, report),
    getEngine(PYODIDE.lock, report),
  ]);
  return { loader, factory, wasm, stdlib, lock: new TextDecoder().decode(lock) };
}

/* ---------------- Monaco ---------------- */

/**
 * The AMD chunks `vs/editor/editor.main` pulls in eagerly, by module id, plus
 * the Python tokenizer and the few small ones a Python project's other files
 * tend to need. Anything else Monaco asks for lazily (another language's
 * tokenizer) comes straight from the CDN, uncached.
 */
const MONACO_MODULES: Record<string, number> = {
  "vs/editor/editor.main": 2_800,
  "vs/index-CBVt3dzv": 77_000,
  "vs/editor-KLE6jdfb": 2_390_000,
  "vs/editorWorkerHost-fVE1cjcC": 358_000,
  "vs/toggleHighContrast-qGX7E9o7": 1_264_000,
  "vs/basic-languages/monaco.contribution": 15_000,
  "vs/monaco.contribution-9cKT3C7t": 2_200,
  "vs/monaco.contribution-BE88ZNGY": 4_800,
  "vs/monaco.contribution-BPhsneLd": 1_600,
  "vs/monaco.contribution-BgRy6xDf": 2_200,
  "vs/json.worker-BizpAl9O": 210,
  "vs/css.worker-CyhWkhHo": 210,
  "vs/html.worker-CA3iAimZ": 210,
  "vs/ts.worker-2QLmBukE": 210,
  "vs/nls.messages-loader": 270,
  "vs/python-CqWUUgfu": 3_900,
  "vs/markdown-C_rD0bIw": 3_800,
  "vs/yaml-A1fOIdH6": 3_700,
  "vs/ini-CsNwO04R": 1_100,
  "vs/shell-ClXCKCEW": 3_100,
  "vs/restructuredtext-C7UUFKFD": 3_900,
};

const MONACO_CSS: EngineAsset = {
  id: "monaco-css", label: "Monaco styles", version: MONACO_VERSION,
  url: MONACO_BASE + "vs/editor/editor.main.css", approxBytes: 350_000,
};
const MONACO_WORKER: EngineAsset = {
  id: "monaco-worker", label: "Monaco editor worker", version: MONACO_VERSION,
  url: MONACO_BASE + "vs/assets/editor.worker-lj3bdIIn.js", approxBytes: 273_000,
};

function monacoModule(id: string): EngineAsset {
  return {
    id: "monaco-" + id.replaceAll("/", "-"), label: "Monaco " + id.slice(3), version: MONACO_VERSION,
    url: MONACO_BASE + id + ".js", approxBytes: MONACO_MODULES[id] ?? 4_000,
  };
}

export type MonacoApi = typeof import("monaco-editor");

let monacoLoading: Promise<MonacoApi> | null = null;

/** A blob: URL holding the editor worker's script, for MonacoEnvironment.getWorker. */
let monacoWorkerUrl = "";

/**
 * Monaco, assembled from its cached AMD chunks. Its stylesheet is handed to
 * it as a data: URL (it appends a <link> itself), and its editor worker is
 * spawned from a blob: URL of the cached worker script, since a worker's own
 * script may be a blob from file:// while importScripts of one may not.
 */
export function loadMonaco(onProgress?: LoadProgress): Promise<MonacoApi> {
  if (monacoLoading) return monacoLoading;
  const report = combined(onProgress);
  monacoLoading = (async () => {
    const ids = Object.keys(MONACO_MODULES);
    const [sources, css, worker] = await Promise.all([
      Promise.all(ids.map((id) => getEngine(monacoModule(id), report))),
      getEngine(MONACO_CSS, report),
      getEngine(MONACO_WORKER, report),
    ]);
    monacoWorkerUrl = URL.createObjectURL(new Blob([worker], { type: "text/javascript" }));
    const cssUrl = "data:text/css;base64," + base64(new Uint8Array(css));
    const amd = new AmdLoader({
      cdnBase: MONACO_BASE,
      toUrl: (path) => (path === "vs/editor/editor.main.css" ? cssUrl : MONACO_BASE + path),
    });
    const decoder = new TextDecoder();
    amd.defineFrom(sources.map((s) => decoder.decode(s)));
    const [main] = await amd.require(["vs/editor/editor.main"]);
    const monaco = main as MonacoApi;
    // editor.main installs a getWorker that wraps the worker in an importScripts
    // blob; from file:// that is refused, so hand it the worker directly.
    (globalThis as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
      getWorker: () => new Worker(monacoWorkerUrl, { name: "monaco-editor-worker" }),
    };
    return monaco;
  })();
  monacoLoading.catch(() => (monacoLoading = null));
  return monacoLoading;
}

/* ---------------- basedpyright ---------------- */

const PYRIGHT: EngineAsset = {
  id: "basedpyright", label: "basedpyright", version: PYRIGHT_VERSION,
  url: `${NPM}browser-basedpyright@${PYRIGHT_VERSION}/dist/pyright.worker.js`, approxBytes: 17_834_000,
};

let pyrightUrl: Promise<string> | null = null;

/** A blob: URL of the Checker's worker script. Both of its workers are spawned from it. */
export function loadPyrightWorkerUrl(onProgress?: LoadProgress): Promise<string> {
  if (pyrightUrl) return pyrightUrl;
  pyrightUrl = getEngine(PYRIGHT, combined(onProgress)).then((bytes) => URL.createObjectURL(new Blob([bytes], { type: "text/javascript" })));
  pyrightUrl.catch(() => (pyrightUrl = null));
  return pyrightUrl;
}

/* ---------------- Ruff ---------------- */

const RUFF_GLUE: EngineAsset = {
  id: "ruff-glue", label: "Ruff bindings", version: RUFF_VERSION,
  url: `${NPM}@astral-sh/ruff-wasm-web@${RUFF_VERSION}/ruff_wasm.js`, approxBytes: 27_000,
};
const RUFF_WASM: EngineAsset = {
  id: "ruff-wasm", label: "Ruff", version: RUFF_VERSION,
  url: `${NPM}@astral-sh/ruff-wasm-web@${RUFF_VERSION}/ruff_wasm_bg.wasm`, approxBytes: 10_872_000,
};

export interface RuffAssets {
  glue: string;
  wasm: ArrayBuffer;
}

export async function loadRuffAssets(onProgress?: LoadProgress): Promise<RuffAssets> {
  const report = combined(onProgress);
  const [glue, wasm] = await Promise.all([getEngine(RUFF_GLUE, report), getEngine(RUFF_WASM, report)]);
  return { glue: new TextDecoder().decode(glue), wasm };
}

/* ---------------- xterm ---------------- */

const XTERM: EngineAsset = {
  id: "xterm", label: "xterm.js", version: XTERM_VERSION,
  url: `${NPM}@xterm/xterm@${XTERM_VERSION}/lib/xterm.mjs`, approxBytes: 345_000,
};
const XTERM_CSS: EngineAsset = {
  id: "xterm-css", label: "xterm.js styles", version: XTERM_VERSION,
  url: `${NPM}@xterm/xterm@${XTERM_VERSION}/css/xterm.css`, approxBytes: 7_200,
};
const XTERM_FIT: EngineAsset = {
  id: "xterm-fit", label: "xterm.js fit addon", version: XTERM_FIT_VERSION,
  url: `${NPM}@xterm/addon-fit@${XTERM_FIT_VERSION}/lib/addon-fit.mjs`, approxBytes: 2_000,
};

export interface TerminalApi {
  Terminal: typeof import("@xterm/xterm").Terminal;
  FitAddon: typeof import("@xterm/addon-fit").FitAddon;
}

let terminalLoading: Promise<TerminalApi> | null = null;

export function loadTerminal(onProgress?: LoadProgress): Promise<TerminalApi> {
  if (terminalLoading) return terminalLoading;
  const report = combined(onProgress);
  terminalLoading = (async () => {
    const [js, css, fit] = await Promise.all([getEngine(XTERM, report), getEngine(XTERM_CSS, report), getEngine(XTERM_FIT, report)]);
    const style = document.createElement("style");
    style.dataset.engine = "xterm";
    style.textContent = new TextDecoder().decode(css);
    document.head.appendChild(style);
    const [xterm, addon] = await Promise.all([importModule<TerminalApi>(js), importModule<{ FitAddon: TerminalApi["FitAddon"] }>(fit)]);
    return { Terminal: xterm.Terminal, FitAddon: addon.FitAddon };
  })();
  terminalLoading.catch(() => (terminalLoading = null));
  return terminalLoading;
}

/* ---------------- helpers ---------------- */

/** Bytes loaded so far across everything one Engine needs, for the Status Bar. */
export type LoadProgress = (loaded: number, total: number) => void;

function combined(onProgress?: LoadProgress) {
  const seen = new Map<string, Progress>();
  return (p: Progress) => {
    seen.set(p.asset.id, p);
    let loaded = 0, total = 0;
    for (const q of seen.values()) {
      loaded += q.loaded;
      total += q.total;
    }
    onProgress?.(loaded, total);
  };
}

async function importModule<T>(bytes: ArrayBuffer): Promise<T> {
  const url = URL.createObjectURL(new Blob([bytes], { type: "text/javascript" }));
  try {
    return (await import(url)) as T;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const CHUNK = 0x8000;

function base64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  return btoa(bin);
}
