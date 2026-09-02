// Engines: the code and data this Tool needs but the Collection does not
// ship. Each is fetched from a pinned CDN URL the first time it is needed and
// kept in IndexedDB so the next visit fetches nothing. Fetching an engine
// sends nothing about the Document: the request is for a public file.

export interface EngineAsset {
  /** Stable id; with the version it forms the cache key. */
  id: string;
  /** What the status line calls it. */
  label: string;
  version: string;
  url: string;
  /** Rough size, for the download hint before the response arrives. */
  approxBytes: number;
}

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

/* ---------------- cache ---------------- */

const DB_NAME = "html-tools";
const STORE = "engines";

interface Row {
  key: string;
  id: string;
  version: string;
  label: string;
  bytes: ArrayBuffer;
  storedAt: number;
}

function keyOf(a: EngineAsset) {
  return a.id + "@" + a.version;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

/** Open the database once. Resolves to null where IndexedDB is unavailable, so callers just skip caching. */
function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      req = indexedDB.open(DB_NAME, 1);
    } catch {
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "key" });
        store.createIndex("id", "id", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function readRow(key: string): Promise<Row | undefined> {
  const db = await openDb();
  if (!db) return undefined;
  try {
    return await request(db.transaction(STORE, "readonly").objectStore(STORE).get(key) as IDBRequest<Row | undefined>);
  } catch {
    return undefined;
  }
}

async function writeRow(row: Row): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    // A new version replaces the old one: only the pinned version is ever useful.
    const stale = await request(store.index("id").getAllKeys(row.id));
    for (const k of stale) if (k !== row.key) store.delete(k);
    await request(store.put(row));
  } catch {
    // Quota or a private window: the engine still works for this visit.
  }
}

export interface CachedEngine {
  id: string;
  label: string;
  version: string;
  bytes: number;
}

export async function listCached(): Promise<CachedEngine[]> {
  const db = await openDb();
  if (!db) return [];
  try {
    const rows = await request(db.transaction(STORE, "readonly").objectStore(STORE).getAll() as IDBRequest<Row[]>);
    return rows.map((r) => ({ id: r.id, label: r.label, version: r.version, bytes: r.bytes.byteLength }));
  } catch {
    return [];
  }
}

export async function clearCached(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await request(db.transaction(STORE, "readwrite").objectStore(STORE).clear());
}

export function cacheAvailable(): Promise<boolean> {
  return openDb().then((db) => db !== null);
}

/* ---------------- fetching ---------------- */

export interface Progress {
  asset: EngineAsset;
  /** Bytes received so far. */
  loaded: number;
  /** Total if the server said, else the catalog's estimate. */
  total: number;
  fromCache: boolean;
}

export type OnProgress = (p: Progress) => void;

const inFlight = new Map<string, { promise: Promise<ArrayBuffer>; listeners: Set<OnProgress> }>();

/**
 * Bytes of an engine asset: from the cache when present, else downloaded with
 * progress and stored. Concurrent callers for the same asset share one
 * download, each with their own progress. A download is never aborted: a
 * cancelled conversion still leaves the engine cached for the next one.
 */
export function getEngine(asset: EngineAsset, onProgress?: OnProgress): Promise<ArrayBuffer> {
  const key = keyOf(asset);
  const existing = inFlight.get(key);
  if (existing) {
    if (onProgress) existing.listeners.add(onProgress);
    return existing.promise;
  }
  const listeners = new Set<OnProgress>(onProgress ? [onProgress] : []);
  const promise = fetchEngine(asset, key, (p) => {
    for (const l of listeners) l(p);
  });
  inFlight.set(key, { promise, listeners });
  promise.then(() => inFlight.delete(key), () => inFlight.delete(key));
  return promise;
}

async function fetchEngine(asset: EngineAsset, key: string, onProgress: OnProgress): Promise<ArrayBuffer> {
  const row = await readRow(key);
  if (row) {
    onProgress({ asset, loaded: row.bytes.byteLength, total: row.bytes.byteLength, fromCache: true });
    return row.bytes;
  }
  const bytes = await download(asset, onProgress);
  await writeRow({ key, id: asset.id, version: asset.version, label: asset.label, bytes, storedAt: Date.now() });
  return bytes;
}

async function download(asset: EngineAsset, onProgress: OnProgress): Promise<ArrayBuffer> {
  let res: Response;
  try {
    res = await fetch(asset.url);
  } catch (e) {
    throw new Error("Could not download " + asset.label + ": no network, or the CDN is blocked.", { cause: e });
  }
  if (!res.ok) throw new Error("Could not download " + asset.label + ": HTTP " + res.status + ".");
  const declared = Number(res.headers.get("content-length")) || 0;
  let total = declared || asset.approxBytes;
  onProgress({ asset, loaded: 0, total, fromCache: false });
  if (!res.body) return res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    // A gzip-encoded response declares its compressed length; do not let the bar run past the end.
    if (loaded > total) total = loaded;
    onProgress({ asset, loaded, total, fromCache: false });
  }
  const out = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out.buffer;
}
