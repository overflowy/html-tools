// The Engines Document to Markdown fetches: the converter, the PDF inspector,
// the PDF renderer, the OCR recognizer, and one model per Language. The cache
// and the download are shared with every Tool that has Engines.

import type { EngineAsset } from "../../shared/engines";

export { cacheAvailable, clearCached, getEngine, listCached, type CachedEngine, type EngineAsset, type OnProgress, type Progress } from "../../shared/engines";

export const ANYDOC_VERSION = "0.2.4";
export const PDF_INSPECTOR_VERSION = "1.17.0";
export const PDFJS_VERSION = "6.3.289";
export const TESSERACT_VERSION = "7.0.0";
// npm's `latest` tag points at 6.1.2 by a publish-order quirk; tesseract.js 7.0.0 depends on ^7.0.0.
export const TESSERACT_CORE_VERSION = "7.0.0";
export const TESSDATA_VERSION = "4.1.0";

const NPM = "https://cdn.jsdelivr.net/npm/";
const GH = "https://cdn.jsdelivr.net/gh/";
const PDFJS = `${NPM}pdfjs-dist@${PDFJS_VERSION}/`;

export const ENGINES = {
  anydocJs: {
    id: "anydoc-js", label: "anydoc glue", version: ANYDOC_VERSION,
    url: `${NPM}@firecrawl/anydoc-wasm@${ANYDOC_VERSION}/anydoc_wasm.js`, approxBytes: 14_000,
  },
  anydocWasm: {
    id: "anydoc-wasm", label: "anydoc", version: ANYDOC_VERSION,
    url: `${NPM}@firecrawl/anydoc-wasm@${ANYDOC_VERSION}/anydoc_wasm_bg.wasm`, approxBytes: 6_700_000,
  },
  pdfInspectorJs: {
    id: "pdf-inspector-js", label: "pdf-inspector glue", version: PDF_INSPECTOR_VERSION,
    url: `${NPM}@firecrawl/pdf-inspector-wasm@${PDF_INSPECTOR_VERSION}/pdf_inspector_wasm.js`, approxBytes: 23_000,
  },
  pdfInspectorWasm: {
    id: "pdf-inspector-wasm", label: "pdf-inspector", version: PDF_INSPECTOR_VERSION,
    url: `${NPM}@firecrawl/pdf-inspector-wasm@${PDF_INSPECTOR_VERSION}/pdf_inspector_wasm_bg.wasm`, approxBytes: 5_300_000,
  },
  // The legacy build polyfills what the modern one assumes (Uint8Array.toHex,
  // Float16Array, ...), and is what pdf.js itself recommends for the public web.
  pdfjs: {
    id: "pdfjs", label: "pdf.js", version: PDFJS_VERSION,
    url: `${PDFJS}legacy/build/pdf.min.mjs`, approxBytes: 520_000,
  },
  pdfjsWorker: {
    id: "pdfjs-worker", label: "pdf.js worker", version: PDFJS_VERSION,
    url: `${PDFJS}legacy/build/pdf.worker.min.mjs`, approxBytes: 1_320_000,
  },
  tesseractWorker: {
    id: "tesseract-worker", label: "tesseract.js worker", version: TESSERACT_VERSION,
    url: `${NPM}tesseract.js@${TESSERACT_VERSION}/dist/worker.min.js`, approxBytes: 111_000,
  },
  tesseractCore: {
    id: "tesseract-core", label: "tesseract core", version: TESSERACT_CORE_VERSION,
    url: `${NPM}tesseract.js-core@${TESSERACT_CORE_VERSION}/tesseract-core-simd-lstm.wasm.js`, approxBytes: 3_900_000,
  },
  tesseractCoreNoSimd: {
    id: "tesseract-core-nosimd", label: "tesseract core (no SIMD)", version: TESSERACT_CORE_VERSION,
    url: `${NPM}tesseract.js-core@${TESSERACT_CORE_VERSION}/tesseract-core-lstm.wasm.js`, approxBytes: 3_900_000,
  },
} satisfies Record<string, EngineAsset>;

/**
 * A file pdf.js asks for by name while rendering: the JBIG2 and JPEG 2000
 * decoders (scans are very often one of those), a CMap, or a standard font.
 * Fetched through the cache like any other engine, only when a PDF needs it.
 */
export function pdfjsAsset(kind: string, filename: string): EngineAsset | null {
  const dir = kind === "wasmUrl" ? "wasm" : kind === "cMapUrl" ? "cmaps" : kind === "standardFontDataUrl" ? "standard_fonts" : null;
  if (!dir || !/^[\w.-]+$/.test(filename)) return null;
  const label = filename === "jbig2.wasm" ? "pdf.js JBIG2 decoder" : filename === "openjpeg.wasm" ? "pdf.js JPEG 2000 decoder" : "pdf.js " + filename;
  return { id: "pdfjs-" + dir + "-" + filename, label, version: PDFJS_VERSION, url: `${PDFJS}${dir}/${filename}`, approxBytes: 250_000 };
}

/** The recognition model for one Language. */
export function languageAsset(code: string): EngineAsset {
  return {
    id: "tessdata-" + code, label: "tesseract " + code, version: TESSDATA_VERSION,
    url: `${GH}tesseract-ocr/tessdata_fast@${TESSDATA_VERSION}/${code}.traineddata`, approxBytes: 4_000_000,
  };
}
