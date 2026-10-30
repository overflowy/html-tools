// The Engines the Python IDE fetches: the editor (Monaco, as the chunks of
// its AMD build plus its stylesheet and worker), the Interpreter (Pyodide's
// five core files), the Checker (basedpyright's browser worker), the Linter
// (Ruff's wasm and glue), and the Terminal (xterm.js with its fit addon).
// Every one goes through the Engine cache, so a second visit fetches nothing:
// Monaco is assembled from cached chunks by amd.ts, and Pyodide boots from
// bytes handed to its worker.

import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import type * as Monaco from "monaco-editor";

import { getEngine } from "../../shared/engines";
import type { EngineAsset, Progress } from "../../shared/engines";
import {
  base64,
  blobModuleWorkersWork,
  scriptBlobUrl,
  scriptDataUrl,
} from "../../shared/script-url";
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

/* ---------------- helpers ---------------- */

/** Bytes loaded so far across everything one Engine needs, for the Status Bar. */
export type LoadProgress = (loaded: number, total: number) => void;

const combined = (onProgress?: LoadProgress) => {
  const seen = new Map<string, Progress>();
  return (p: Progress) => {
    seen.set(p.asset.id, p);
    let loaded = 0;
    let total = 0;
    for (const q of seen.values()) {
      loaded += q.loaded;
      total += q.total;
    }
    onProgress?.(loaded, total);
  };
};

const importModule = async <T>(bytes: ArrayBuffer): Promise<T> => {
  const url = URL.createObjectURL(
    new Blob([bytes], { type: "text/javascript" })
  );
  try {
    return (await import(url)) as T;
  } finally {
    URL.revokeObjectURL(url);
  }
};

/* ---------------- Pyodide ---------------- */

const pyodideAsset = (
  file: string,
  label: string,
  approxBytes: number
): EngineAsset => ({
  approxBytes,
  id: `pyodide-${file}`,
  label,
  url: PYODIDE_BASE + file,
  version: PYODIDE_VERSION,
});

export const PYODIDE = {
  factory: pyodideAsset("pyodide.asm.mjs", "Pyodide runtime", 1_250_000),
  loader: pyodideAsset("pyodide.mjs", "Pyodide loader", 18_000),
  lock: pyodideAsset("pyodide-lock.json", "Pyodide package catalog", 115_000),
  stdlib: pyodideAsset(
    "python_stdlib.zip",
    "Python standard library",
    2_550_000
  ),
  wasm: pyodideAsset("pyodide.asm.wasm", "Python interpreter", 9_600_000),
};

export interface PyodideAssets {
  loader: ArrayBuffer;
  factory: ArrayBuffer;
  wasm: ArrayBuffer;
  stdlib: ArrayBuffer;
  lock: string;
}

export const loadPyodideAssets = async (
  onProgress?: LoadProgress
): Promise<PyodideAssets> => {
  const report = combined(onProgress);
  const [loader, factory, wasm, stdlib, lock] = await Promise.all([
    getEngine(PYODIDE.loader, report),
    getEngine(PYODIDE.factory, report),
    getEngine(PYODIDE.wasm, report),
    getEngine(PYODIDE.stdlib, report),
    getEngine(PYODIDE.lock, report),
  ]);
  return {
    factory,
    loader,
    lock: new TextDecoder().decode(lock),
    stdlib,
    wasm,
  };
};

/* ---------------- Monaco ---------------- */

/**
 * The AMD chunks `vs/editor/editor.main` pulls in eagerly, by module id, plus
 * the Python tokenizer and the few small ones a Python project's other files
 * tend to need. Anything else Monaco asks for lazily (another language's
 * tokenizer) comes straight from the CDN, uncached.
 */
const MONACO_MODULES = new Map<string, number>([
  ["vs/editor/editor.main", 2800],
  ["vs/index-CBVt3dzv", 77_000],
  ["vs/editor-KLE6jdfb", 2_390_000],
  ["vs/editorWorkerHost-fVE1cjcC", 358_000],
  ["vs/toggleHighContrast-qGX7E9o7", 1_264_000],
  ["vs/basic-languages/monaco.contribution", 15_000],
  ["vs/monaco.contribution-9cKT3C7t", 2200],
  ["vs/monaco.contribution-BE88ZNGY", 4800],
  ["vs/monaco.contribution-BPhsneLd", 1600],
  ["vs/monaco.contribution-BgRy6xDf", 2200],
  ["vs/json.worker-BizpAl9O", 210],
  ["vs/css.worker-CyhWkhHo", 210],
  ["vs/html.worker-CA3iAimZ", 210],
  ["vs/ts.worker-2QLmBukE", 210],
  ["vs/nls.messages-loader", 270],
  ["vs/python-CqWUUgfu", 3900],
  ["vs/markdown-C_rD0bIw", 3800],
  ["vs/yaml-A1fOIdH6", 3700],
  ["vs/ini-CsNwO04R", 1100],
  ["vs/shell-ClXCKCEW", 3100],
  ["vs/restructuredtext-C7UUFKFD", 3900],
]);

const MONACO_CSS: EngineAsset = {
  approxBytes: 350_000,
  id: "monaco-css",
  label: "Monaco styles",
  url: `${MONACO_BASE}vs/editor/editor.main.css`,
  version: MONACO_VERSION,
};
const MONACO_WORKER: EngineAsset = {
  approxBytes: 273_000,
  id: "monaco-worker",
  label: "Monaco editor worker",
  url: `${MONACO_BASE}vs/assets/editor.worker-lj3bdIIn.js`,
  version: MONACO_VERSION,
};

const monacoModule = (id: string): EngineAsset => ({
  approxBytes: MONACO_MODULES.get(id) ?? 4000,
  id: `monaco-${id.replaceAll("/", "-")}`,
  label: `Monaco ${id.slice(3)}`,
  url: `${MONACO_BASE + id}.js`,
  version: MONACO_VERSION,
});

export type MonacoApi = typeof Monaco;

let monacoLoading: Promise<MonacoApi> | null = null;

/** A blob: URL holding the editor worker's script, for MonacoEnvironment.getWorker. */
let monacoWorkerUrl = "";

/**
 * Monaco, assembled from its cached AMD chunks. Its stylesheet is handed to
 * it as a data: URL (it appends a <link> itself), and its editor worker is
 * spawned from a blob: URL of the cached worker script, since a worker's own
 * script may be a blob from file:// while importScripts of one may not.
 */
export const loadMonaco = (onProgress?: LoadProgress): Promise<MonacoApi> => {
  if (monacoLoading) {
    return monacoLoading;
  }
  const report = combined(onProgress);
  monacoLoading = (async () => {
    const ids = [...MONACO_MODULES.keys()];
    const [sources, css, worker] = await Promise.all([
      Promise.all(ids.map((id) => getEngine(monacoModule(id), report))),
      getEngine(MONACO_CSS, report),
      getEngine(MONACO_WORKER, report),
    ]);
    monacoWorkerUrl = URL.createObjectURL(
      new Blob([worker], { type: "text/javascript" })
    );
    const cssUrl = `data:text/css;base64,${base64(new Uint8Array(css))}`;
    const amd = new AmdLoader({
      cdnBase: MONACO_BASE,
      toUrl: (path) =>
        path === "vs/editor/editor.main.css" ? cssUrl : MONACO_BASE + path,
    });
    const decoder = new TextDecoder();
    amd.defineFrom(sources.map((s) => decoder.decode(s)));
    const [main] = await amd.require(["vs/editor/editor.main"]);
    const monaco = main as MonacoApi;
    // editor.main installs a getWorker that wraps the worker in an importScripts
    // blob; from file:// that is refused, so hand it the worker directly.
    (
      globalThis as unknown as { MonacoEnvironment: unknown }
    ).MonacoEnvironment = {
      getWorker: () =>
        new Worker(monacoWorkerUrl, { name: "monaco-editor-worker" }),
    };
    return monaco;
  })();
  monacoLoading.catch(() => (monacoLoading = null));
  return monacoLoading;
};

/* ---------------- basedpyright ---------------- */

const PYRIGHT: EngineAsset = {
  approxBytes: 17_834_000,
  id: "basedpyright",
  label: "basedpyright",
  url: `${NPM}browser-basedpyright@${PYRIGHT_VERSION}/dist/pyright.worker.js`,
  version: PYRIGHT_VERSION,
};

let pyrightUrl: Promise<string> | null = null;

/**
 * The Checker's worker script as a URL for its workers to import once they
 * are running: a blob: URL where a module worker may import one (Firefox),
 * a data: URL elsewhere (Chromium); the Checker spawns its bootstrap to
 * match. Never the worker's own script: Firefox crashes its content process
 * when such a worker is terminated (or the page unloaded) while the 18 MB
 * script is still being compiled, and a dynamic import of the same script
 * can be cut short safely.
 */
export const loadPyrightScript = (
  onProgress?: LoadProgress
): Promise<string> => {
  if (pyrightUrl) {
    return pyrightUrl;
  }
  pyrightUrl = Promise.all([
    getEngine(PYRIGHT, combined(onProgress)),
    blobModuleWorkersWork(),
  ]).then(([bytes, blob]) =>
    blob ? scriptBlobUrl(bytes) : scriptDataUrl(bytes, "pyright.worker.js")
  );
  pyrightUrl.catch(() => (pyrightUrl = null));
  return pyrightUrl;
};

/* ---------------- Ruff ---------------- */

const RUFF_GLUE: EngineAsset = {
  approxBytes: 27_000,
  id: "ruff-glue",
  label: "Ruff bindings",
  url: `${NPM}@astral-sh/ruff-wasm-web@${RUFF_VERSION}/ruff_wasm.js`,
  version: RUFF_VERSION,
};
const RUFF_WASM: EngineAsset = {
  approxBytes: 10_872_000,
  id: "ruff-wasm",
  label: "Ruff",
  url: `${NPM}@astral-sh/ruff-wasm-web@${RUFF_VERSION}/ruff_wasm_bg.wasm`,
  version: RUFF_VERSION,
};

export interface RuffAssets {
  glue: string;
  wasm: ArrayBuffer;
}

export const loadRuffAssets = async (
  onProgress?: LoadProgress
): Promise<RuffAssets> => {
  const report = combined(onProgress);
  const [glue, wasm] = await Promise.all([
    getEngine(RUFF_GLUE, report),
    getEngine(RUFF_WASM, report),
  ]);
  return { glue: new TextDecoder().decode(glue), wasm };
};

/* ---------------- xterm ---------------- */

const XTERM: EngineAsset = {
  approxBytes: 345_000,
  id: "xterm",
  label: "xterm.js",
  url: `${NPM}@xterm/xterm@${XTERM_VERSION}/lib/xterm.mjs`,
  version: XTERM_VERSION,
};
const XTERM_CSS: EngineAsset = {
  approxBytes: 7200,
  id: "xterm-css",
  label: "xterm.js styles",
  url: `${NPM}@xterm/xterm@${XTERM_VERSION}/css/xterm.css`,
  version: XTERM_VERSION,
};
const XTERM_FIT: EngineAsset = {
  approxBytes: 2000,
  id: "xterm-fit",
  label: "xterm.js fit addon",
  url: `${NPM}@xterm/addon-fit@${XTERM_FIT_VERSION}/lib/addon-fit.mjs`,
  version: XTERM_FIT_VERSION,
};

export interface TerminalApi {
  Terminal: typeof Terminal;
  FitAddon: typeof FitAddon;
}

let terminalLoading: Promise<TerminalApi> | null = null;

export const loadTerminal = (
  onProgress?: LoadProgress
): Promise<TerminalApi> => {
  if (terminalLoading) {
    return terminalLoading;
  }
  const report = combined(onProgress);
  terminalLoading = (async () => {
    const [js, css, fit] = await Promise.all([
      getEngine(XTERM, report),
      getEngine(XTERM_CSS, report),
      getEngine(XTERM_FIT, report),
    ]);
    const style = document.createElement("style");
    style.dataset.engine = "xterm";
    style.textContent = new TextDecoder().decode(css);
    document.head.append(style);
    const [xterm, addon] = await Promise.all([
      importModule<TerminalApi>(js),
      importModule<{ FitAddon: TerminalApi["FitAddon"] }>(fit),
    ]);
    return { FitAddon: addon.FitAddon, Terminal: xterm.Terminal };
  })();
  terminalLoading.catch(() => (terminalLoading = null));
  return terminalLoading;
};
