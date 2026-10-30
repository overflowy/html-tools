// The Engines PDF Toolkit fetches: MuPDF, which reads, renders, and edits
// PDFs, and qpdf, which assembles pages from several files, encrypts,
// linearizes, and checks structure. The OCR engines are the shared ones. The
// cache and the download are shared with every Tool that has Engines.

import type { EngineAsset } from "../../shared/engines";

export {
  cacheAvailable,
  cachedFamilies,
  clearCached,
  getEngine,
  listCached,
  type EngineAsset,
  type Progress,
} from "../../shared/engines";

export const MUPDF_VERSION = "1.28.1";
export const QPDF_WASM_VERSION = "0.3.0";

const NPM = "https://cdn.jsdelivr.net/npm/";
const MUPDF = `${NPM}mupdf@${MUPDF_VERSION}/dist/`;
const QPDF = `${NPM}@neslinesli93/qpdf-wasm@${QPDF_WASM_VERSION}/dist/`;

export const ENGINES = {
  mupdfGlue: {
    approxBytes: 29_000,
    id: "mupdf-glue",
    label: "MuPDF glue",
    url: `${MUPDF}mupdf-wasm.js`,
    version: MUPDF_VERSION,
  },
  mupdfLib: {
    approxBytes: 103_000,
    id: "mupdf-lib",
    label: "MuPDF library",
    url: `${MUPDF}mupdf.js`,
    version: MUPDF_VERSION,
  },
  mupdfWasm: {
    approxBytes: 10_400_000,
    id: "mupdf-wasm",
    label: "MuPDF",
    url: `${MUPDF}mupdf-wasm.wasm`,
    version: MUPDF_VERSION,
  },
  qpdfGlue: {
    approxBytes: 43_000,
    id: "qpdf-glue",
    label: "qpdf glue",
    url: `${QPDF}qpdf.js`,
    version: QPDF_WASM_VERSION,
  },
  qpdfWasm: {
    approxBytes: 1_330_000,
    id: "qpdf-wasm",
    label: "qpdf",
    url: `${QPDF}qpdf.wasm`,
    version: QPDF_WASM_VERSION,
  },
} satisfies Record<string, EngineAsset>;
