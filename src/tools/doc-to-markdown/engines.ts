// The Engines Document to Markdown fetches: the converter, the PDF inspector,
// the PDF renderer, the OCR recognizer, and one model per Language. The cache
// and the download are shared with every Tool that has Engines.

import type { EngineAsset } from "../../shared/engines";
import { TESSERACT_ENGINES } from "../../shared/tesseract";

export {
  cacheAvailable,
  cachedFamilies,
  clearCached,
  getEngine,
  listCached,
  type CachedEngine,
  type EngineAsset,
  type OnProgress,
  type Progress,
} from "../../shared/engines";
export {
  TESSERACT_CORE_VERSION,
  TESSERACT_VERSION,
  TESSDATA_VERSION,
  languageAsset,
} from "../../shared/tesseract";

export const ANYDOC_VERSION = "0.2.4";
export const PDF_INSPECTOR_VERSION = "1.17.0";
export const PDFJS_VERSION = "6.3.289";

const NPM = "https://cdn.jsdelivr.net/npm/";
const PDFJS = `${NPM}pdfjs-dist@${PDFJS_VERSION}/`;

export const ENGINES = {
  anydocJs: {
    approxBytes: 14_000,
    id: "anydoc-js",
    label: "anydoc glue",
    url: `${NPM}@firecrawl/anydoc-wasm@${ANYDOC_VERSION}/anydoc_wasm.js`,
    version: ANYDOC_VERSION,
  },
  anydocWasm: {
    approxBytes: 6_700_000,
    id: "anydoc-wasm",
    label: "anydoc",
    url: `${NPM}@firecrawl/anydoc-wasm@${ANYDOC_VERSION}/anydoc_wasm_bg.wasm`,
    version: ANYDOC_VERSION,
  },
  pdfInspectorJs: {
    approxBytes: 23_000,
    id: "pdf-inspector-js",
    label: "pdf-inspector glue",
    url: `${NPM}@firecrawl/pdf-inspector-wasm@${PDF_INSPECTOR_VERSION}/pdf_inspector_wasm.js`,
    version: PDF_INSPECTOR_VERSION,
  },
  pdfInspectorWasm: {
    approxBytes: 5_300_000,
    id: "pdf-inspector-wasm",
    label: "pdf-inspector",
    url: `${NPM}@firecrawl/pdf-inspector-wasm@${PDF_INSPECTOR_VERSION}/pdf_inspector_wasm_bg.wasm`,
    version: PDF_INSPECTOR_VERSION,
  },
  // The legacy build polyfills what the modern one assumes (Uint8Array.toHex,
  // Float16Array, ...), and is what pdf.js itself recommends for the public web.
  pdfjs: {
    approxBytes: 520_000,
    id: "pdfjs",
    label: "pdf.js",
    url: `${PDFJS}legacy/build/pdf.min.mjs`,
    version: PDFJS_VERSION,
  },
  pdfjsWorker: {
    approxBytes: 1_320_000,
    id: "pdfjs-worker",
    label: "pdf.js worker",
    url: `${PDFJS}legacy/build/pdf.worker.min.mjs`,
    version: PDFJS_VERSION,
  },
  tesseractCore: TESSERACT_ENGINES.core,
  tesseractCoreNoSimd: TESSERACT_ENGINES.coreNoSimd,
  tesseractWorker: TESSERACT_ENGINES.worker,
} satisfies Record<string, EngineAsset>;

/** Where each kind of file lives in the pdf.js package. */
const PDFJS_DIRS = new Map([
  ["wasmUrl", "wasm"],
  ["cMapUrl", "cmaps"],
  ["standardFontDataUrl", "standard_fonts"],
]);

const PDFJS_LABELS = new Map([
  ["jbig2.wasm", "pdf.js JBIG2 decoder"],
  ["openjpeg.wasm", "pdf.js JPEG 2000 decoder"],
]);

/**
 * A file pdf.js asks for by name while rendering: the JBIG2 and JPEG 2000
 * decoders (scans are very often one of those), a CMap, or a standard font.
 * Fetched through the cache like any other engine, only when a PDF needs it.
 */
export const pdfjsAsset = (
  kind: string,
  filename: string
): EngineAsset | null => {
  const dir = PDFJS_DIRS.get(kind);
  if (!dir || !/^[\w.-]+$/u.test(filename)) {
    return null;
  }
  return {
    approxBytes: 250_000,
    id: `pdfjs-${dir}-${filename}`,
    label: PDFJS_LABELS.get(filename) ?? `pdf.js ${filename}`,
    url: `${PDFJS}${dir}/${filename}`,
    version: PDFJS_VERSION,
  };
};
