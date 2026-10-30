// The Engine the Archive Manager fetches: 7-Zip as WebAssembly, JS7z's
// single-threaded build. Nothing else serves that build to a browser, so it
// is vendored in this repository (vendor/js7z, with its provenance) and
// fetched through jsDelivr pinned to the commit that added it, so a later
// commit never changes what a visitor runs. The cache and the download are
// shared with every Tool that has Engines.

import type { EngineAsset } from "../../shared/engines";

export {
  cacheAvailable,
  cachedFamilies,
  clearCached,
  getEngine,
  listCached,
  type OnProgress,
  type Progress,
} from "../../shared/engines";

/** The commit of this repository whose vendor/js7z is used. */
export const JS7Z_COMMIT = "671132e4800c3f5f53826513b9d3c839004f5d1c";
/** 7-Zip's version, then JS7z's. */
export const JS7Z_VERSION = "25.01-2.5.0";

const BASE = `https://cdn.jsdelivr.net/gh/overflowy/html-tools@${JS7Z_COMMIT}/vendor/js7z/`;

export const ENGINES = {
  js7zJs: {
    approxBytes: 100_606,
    id: "js7z-js",
    label: "7-Zip glue",
    url: `${BASE}js7z.js`,
    version: JS7Z_VERSION,
  },
  js7zWasm: {
    approxBytes: 1_496_009,
    id: "js7z-wasm",
    label: "7-Zip",
    url: `${BASE}js7z.wasm`,
    version: JS7Z_VERSION,
  },
} satisfies Record<string, EngineAsset>;
