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

const keyOf = (a: EngineAsset) => `${a.id}@${a.version}`;

let dbPromise: Promise<IDBDatabase | null> | null = null;

/** Open the database once. Resolves to null where IndexedDB is unavailable, so callers just skip caching. */
const openDb = (): Promise<IDBDatabase | null> => {
  if (dbPromise) {
    return dbPromise;
  }
  const { promise, resolve } = Promise.withResolvers<IDBDatabase | null>();
  dbPromise = promise;
  let req: IDBOpenDBRequest;
  try {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return promise;
    }
    req = indexedDB.open(DB_NAME, 1);
  } catch {
    resolve(null);
    return promise;
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
  return promise;
};

const request = <T>(r: IDBRequest<T>): Promise<T> => {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  return promise;
};

const readRow = async (key: string): Promise<Row | undefined> => {
  const db = await openDb();
  if (!db) {
    return undefined;
  }
  try {
    return await request(
      db
        .transaction(STORE, "readonly")
        .objectStore(STORE)
        .get(key) as IDBRequest<Row | undefined>
    );
  } catch {
    return undefined;
  }
};

const writeRow = async (row: Row): Promise<void> => {
  const db = await openDb();
  if (!db) {
    return;
  }
  try {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    // A new version replaces the old one: only the pinned version is ever useful.
    const stale = await request(store.index("id").getAllKeys(row.id));
    for (const k of stale) {
      if (k !== row.key) {
        store.delete(k);
      }
    }
    await request(store.put(row));
  } catch {
    // Quota or a private window: the engine still works for this visit.
  }
};

export interface CachedEngine {
  id: string;
  label: string;
  version: string;
  bytes: number;
}

export const listCached = async (): Promise<CachedEngine[]> => {
  const db = await openDb();
  if (!db) {
    return [];
  }
  try {
    const rows = await request(
      db
        .transaction(STORE, "readonly")
        .objectStore(STORE)
        .getAll() as IDBRequest<Row[]>
    );
    return rows.map((r) => ({
      bytes: r.bytes.byteLength,
      id: r.id,
      label: r.label,
      version: r.version,
    }));
  } catch {
    return [];
  }
};

/**
 * The cached Engines grouped by what they are part of, for a tooltip. An
 * engine split into many files (Monaco into its chunks, KaTeX into its fonts)
 * names every file after itself, so the first word of a label is its family;
 * a family of one keeps its whole label.
 */
export const cachedFamilies = (
  rows: CachedEngine[]
): { label: string; bytes: number }[] => {
  const families = new Map<string, CachedEngine[]>();
  for (const r of rows) {
    const [family = r.label] = r.label.split(" ");
    families.set(family, [...(families.get(family) ?? []), r]);
  }
  return [...families].map(([family, members]) => {
    const [only] = members;
    return {
      bytes: members.reduce((n, m) => n + m.bytes, 0),
      label: members.length === 1 && only ? only.label : family,
    };
  });
};

export const clearCached = async (): Promise<void> => {
  const db = await openDb();
  if (!db) {
    return;
  }
  await request(db.transaction(STORE, "readwrite").objectStore(STORE).clear());
};

/** Drop one Engine from the cache: what was kept turned out unusable, so the next use fetches it again. */
export const forgetEngine = async (asset: EngineAsset): Promise<void> => {
  const db = await openDb();
  if (!db) {
    return;
  }
  try {
    await request(
      db.transaction(STORE, "readwrite").objectStore(STORE).delete(keyOf(asset))
    );
  } catch {
    // A private window or a closed database: nothing was kept to drop.
  }
};

export const cacheAvailable = (): Promise<boolean> =>
  openDb().then((db) => db !== null);

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

const inFlight = new Map<
  string,
  { promise: Promise<ArrayBuffer>; listeners: Set<OnProgress> }
>();

const download = async (
  asset: EngineAsset,
  onProgress: OnProgress
): Promise<ArrayBuffer> => {
  let res: Response;
  try {
    res = await fetch(asset.url);
  } catch (error) {
    throw new Error(
      `Could not download ${asset.label}: no network, or the CDN is blocked.`,
      { cause: error }
    );
  }
  if (!res.ok) {
    throw new Error(`Could not download ${asset.label}: HTTP ${res.status}.`);
  }
  const declared = Number(res.headers.get("content-length")) || 0;
  let total = declared || asset.approxBytes;
  onProgress({ asset, fromCache: false, loaded: 0, total });
  if (!res.body) {
    return res.arrayBuffer();
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    loaded += value.byteLength;
    // A gzip-encoded response declares its compressed length; do not let the bar run past the end.
    if (loaded > total) {
      total = loaded;
    }
    onProgress({ asset, fromCache: false, loaded, total });
  }
  const out = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out.buffer;
};

const fetchEngine = async (
  asset: EngineAsset,
  key: string,
  onProgress: OnProgress
): Promise<ArrayBuffer> => {
  const row = await readRow(key);
  if (row) {
    onProgress({
      asset,
      fromCache: true,
      loaded: row.bytes.byteLength,
      total: row.bytes.byteLength,
    });
    return row.bytes;
  }
  const bytes = await download(asset, onProgress);
  await writeRow({
    bytes,
    id: asset.id,
    key,
    label: asset.label,
    storedAt: Date.now(),
    version: asset.version,
  });
  return bytes;
};

/**
 * Bytes of an engine asset: from the cache when present, else downloaded with
 * progress and stored. Concurrent callers for the same asset share one
 * download, each with their own progress. A download is never aborted: a
 * cancelled conversion still leaves the engine cached for the next one.
 */
export const getEngine = (
  asset: EngineAsset,
  onProgress?: OnProgress
): Promise<ArrayBuffer> => {
  const key = keyOf(asset);
  const existing = inFlight.get(key);
  if (existing) {
    if (onProgress) {
      existing.listeners.add(onProgress);
    }
    return existing.promise;
  }
  const listeners = new Set<OnProgress>(onProgress ? [onProgress] : []);
  const promise = fetchEngine(asset, key, (p) => {
    for (const l of listeners) {
      l(p);
    }
  });
  inFlight.set(key, { listeners, promise });
  promise.then(() => inFlight.delete(key)).catch(() => inFlight.delete(key));
  return promise;
};
