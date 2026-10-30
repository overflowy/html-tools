// Tesseract, the OCR engine, for every Tool that reads text off images: the
// Engines it is made of, and starting it from file:// with them. Each Tool
// fetches the files (through the engine cache, with its own progress) and
// hands them here.

import { createWorker } from "tesseract.js";
import type { Worker as TessWorker } from "tesseract.js";

import type { EngineAsset } from "./engines";
import { scriptBlobUrl, scriptDataUrl } from "./script-url";

export const TESSERACT_VERSION = "7.0.0";
// npm's `latest` tag points at 6.1.2 by a publish-order quirk; tesseract.js 7.0.0 depends on ^7.0.0.
export const TESSERACT_CORE_VERSION = "7.0.0";
export const TESSDATA_VERSION = "4.1.0";

const NPM = "https://cdn.jsdelivr.net/npm/";
const GH = "https://cdn.jsdelivr.net/gh/";

export const TESSERACT_ENGINES = {
  core: {
    approxBytes: 3_900_000,
    id: "tesseract-core",
    label: "tesseract core",
    url: `${NPM}tesseract.js-core@${TESSERACT_CORE_VERSION}/tesseract-core-simd-lstm.wasm.js`,
    version: TESSERACT_CORE_VERSION,
  },
  coreNoSimd: {
    approxBytes: 3_900_000,
    id: "tesseract-core-nosimd",
    label: "tesseract core (no SIMD)",
    url: `${NPM}tesseract.js-core@${TESSERACT_CORE_VERSION}/tesseract-core-lstm.wasm.js`,
    version: TESSERACT_CORE_VERSION,
  },
  worker: {
    approxBytes: 111_000,
    id: "tesseract-worker",
    label: "tesseract.js worker",
    url: `${NPM}tesseract.js@${TESSERACT_VERSION}/dist/worker.min.js`,
    version: TESSERACT_VERSION,
  },
} satisfies Record<string, EngineAsset>;

/** The recognition model for one Language. */
export const languageAsset = (code: string): EngineAsset => ({
  approxBytes: 4_000_000,
  id: `tessdata-${code}`,
  label: `tesseract ${code}`,
  url: `${GH}tesseract-ocr/tessdata_fast@${TESSDATA_VERSION}/${code}.traineddata`,
  version: TESSDATA_VERSION,
});

const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8,
  0, 65, 0, 253, 15, 253, 98, 11,
]);

/** Whether this browser's WebAssembly has SIMD, which the faster core build needs. */
export const hasSimd = (() => {
  try {
    return WebAssembly.validate(SIMD_PROBE);
  } catch {
    return false;
  }
})();

/** The core build this browser runs. */
export const tesseractCore = (): EngineAsset =>
  hasSimd ? TESSERACT_ENGINES.core : TESSERACT_ENGINES.coreNoSimd;

/**
 * tesseract.js 7.0.0 reads `l.data` where it means `l.code` when languages are
 * given as bytes (upstream PR #1052). The worker script is ours to patch; a
 * release that has fixed it simply has nothing to replace.
 */
const patchTesseractWorker = (src: string): string =>
  src.replace('"string"==typeof t?t:t.data', '"string"==typeof t?t:t.code');

export interface TesseractFiles {
  /** The tesseract.js worker script. */
  workerSrc: string;
  /** The single-file core build (`tesseractCore()`). */
  coreSrc: string;
  models: { code: string; data: Uint8Array }[];
}

/**
 * A Tesseract worker for these models. One classic worker that first defines
 * TesseractCore from the single-file core build, then runs the worker
 * script; with the core global already present, the script never consults
 * corePath. tesseract.js spawns the worker itself and messages it at once,
 * so the bootstrap must import synchronously with both URLs embedded: a
 * blob: URL (see script-url.ts). The core writes its complaints about
 * unreadable input ("Line cannot be recognized!!") to stderr, which
 * Emscripten maps to console.error; on a figure page that is expected, not
 * an error, so it is routed to a warning.
 */
export const startTesseract = async (
  files: TesseractFiles
): Promise<TessWorker> => {
  const workerSrc = patchTesseractWorker(files.workerSrc);
  const bootUrl = scriptBlobUrl(
    `importScripts(${JSON.stringify(scriptDataUrl(files.coreSrc, "tesseract-core.js"))}, ${JSON.stringify(scriptDataUrl(workerSrc, "tesseract-worker.js"))});
    const core = TesseractCore;
    TesseractCore = (m = {}) => core({ printErr: (s) => console.warn("tesseract: " + s), ...m });`
  );
  const failure = Promise.withResolvers<never>();
  try {
    return await Promise.race([
      createWorker(files.models as unknown as string[], 1, {
        cacheMethod: "none",
        errorHandler: (e: unknown) =>
          failure.reject(
            new Error(
              `OCR could not start: ${e instanceof Error ? e.message : String(e)}`
            )
          ),
        workerBlobURL: false,
        workerPath: bootUrl,
      }),
      failure.promise,
    ]);
  } finally {
    URL.revokeObjectURL(bootUrl);
  }
};
