// Engines: code and data a Tool needs but the Collection does not ship. Each
// is fetched from a pinned CDN URL the first time it is needed and kept in
// IndexedDB so the next visit fetches nothing. Fetching an engine sends
// nothing about the user's content: the request is for a public file.
//
// The catalog of what each Tool fetches lives with that Tool; this module is
// the cache and the download.

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
