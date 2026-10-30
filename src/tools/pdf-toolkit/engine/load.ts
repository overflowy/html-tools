// Starting the two engines from their source text and wasm bytes, which is
// how the worker has them (from the engine cache) and how the unit tests
// have them (from node_modules). Neither package is written to be loaded that
// way, so each is adjusted here, by exact text, for its pinned version: a
// release that changes the text fails loudly here rather than half working.

import type * as Mupdf from "mupdf";

export type MupdfModule = typeof Mupdf;

/** Turns script text into a URL `import()` can load; the worker passes a data: URL maker. */
export type ScriptUrl = (source: string, name: string) => string;

/* ---------------- MuPDF ---------------- */

const MUPDF_GLUE_IMPORT = 'import libmupdf_wasm from "./mupdf-wasm.js";';

/**
 * MuPDF's library imports its glue by relative path, which means nothing
 * from a data: URL, and reads the glue's options from a global. The import
 * is pointed at the glue's own URL, and the options hand over the wasm
 * bytes, so the glue never fetches anything. They also name the wasm file
 * outright: the glue would otherwise resolve its name against its own URL,
 * and a data: URL is no base to resolve against.
 */
export const loadMupdf = async (
  lib: string,
  glue: string,
  wasm: ArrayBuffer,
  toUrl: ScriptUrl
): Promise<MupdfModule> => {
  if (!lib.includes(MUPDF_GLUE_IMPORT)) {
    throw new Error(
      "This MuPDF release imports its glue differently; the loader needs updating."
    );
  }
  Object.assign(globalThis, {
    $libmupdf_wasm_Module: {
      locateFile: (name: string) => name,
      wasmBinary: wasm,
    },
  });
  const source = lib.replace(
    MUPDF_GLUE_IMPORT,
    `import libmupdf_wasm from ${JSON.stringify(toUrl(glue, "mupdf-wasm.js"))};`
  );
  return (await import(toUrl(source, "mupdf.js"))) as MupdfModule;
};

/* ---------------- qpdf ---------------- */

/** What the Emscripten build of qpdf offers once started. */
export interface QpdfInstance {
  callMain: (args: string[]) => number;
  FS: {
    mkdir: (path: string) => void;
    writeFile: (path: string, data: Uint8Array) => void;
    readFile: (path: string) => Uint8Array;
    unlink: (path: string) => void;
    /** Throws for a path that does not exist. */
    stat: (path: string) => unknown;
  };
}

interface QpdfOptions {
  noInitialRun: boolean;
  wasmBinary: ArrayBuffer;
  print: (line: string) => void;
  printErr: (line: string) => void;
}

type QpdfFactory = (options: QpdfOptions) => Promise<QpdfInstance>;

const QPDF_EXPORTS =
  "if (typeof exports === 'object' && typeof module === 'object') {";
const QPDF_INSTANTIATE = "var b=await Fa(a);";

/**
 * The qpdf build is a classic script that declares `Module` and fetches its
 * wasm by URL, with no way to hand it bytes. As a module it exports `Module`
 * instead of assigning it to CommonJS, and it instantiates the bytes it is
 * given in `wasmBinary` where it would have fetched.
 */
export const qpdfModuleSource = (glue: string): string => {
  const cut = glue.indexOf(QPDF_EXPORTS);
  if (cut === -1 || !glue.includes(QPDF_INSTANTIATE)) {
    throw new Error(
      "This qpdf build is laid out differently; the loader needs updating."
    );
  }
  return `${glue
    .slice(0, cut)
    .replace(
      QPDF_INSTANTIATE,
      "var b=await WebAssembly.instantiate(f.wasmBinary,a);"
    )}\nexport default Module;\n`;
};

/** Lines qpdf prints, routed to whoever runs the current command. */
export interface QpdfOutput {
  out: (line: string) => void;
  err: (line: string) => void;
}

export const loadQpdf = async (
  glue: string,
  wasm: ArrayBuffer,
  toUrl: ScriptUrl,
  output: QpdfOutput
): Promise<QpdfInstance> => {
  const mod = (await import(toUrl(qpdfModuleSource(glue), "qpdf.js"))) as {
    default: QpdfFactory;
  };
  return mod.default({
    noInitialRun: true,
    print: (line) => output.out(line),
    printErr: (line) => output.err(line),
    wasmBinary: wasm,
  });
};
