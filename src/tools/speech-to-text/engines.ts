// The Engines Speech to Text fetches: the Needle runtime (its Emscripten glue
// and its wasm) and the Whistle model it runs. Both come from Cactus Compute's
// Hugging Face repositories, pinned to a commit so a new upload never changes
// what a visitor runs. The cache and the download are shared with every Tool
// that has Engines.

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

/** Cactus-Compute/needle3, the commit whose wasm/ folder is used. */
export const NEEDLE_REVISION = "d6c7d6a2e9655505e0f8e23339356dd1705900eb";
/** Cactus-Compute/whistle, the commit whose whistle.cact is used. */
export const WHISTLE_REVISION = "741118687e1f008f06d1351a402a731274789790";

const HF = "https://huggingface.co/Cactus-Compute/";

export const ENGINES = {
  needleJs: {
    approxBytes: 62_000,
    id: "needle-js",
    label: "Needle glue",
    url: `${HF}needle3/resolve/${NEEDLE_REVISION}/wasm/needle.js`,
    version: NEEDLE_REVISION.slice(0, 12),
  },
  needleWasm: {
    approxBytes: 930_000,
    id: "needle-wasm",
    label: "Needle runtime",
    url: `${HF}needle3/resolve/${NEEDLE_REVISION}/wasm/needle.wasm`,
    version: NEEDLE_REVISION.slice(0, 12),
  },
  whistle: {
    approxBytes: 16_919_407,
    id: "whistle",
    label: "Whistle model",
    url: `${HF}whistle/resolve/${WHISTLE_REVISION}/whistle.cact`,
    version: WHISTLE_REVISION.slice(0, 12),
  },
} satisfies Record<string, EngineAsset>;
