// Where Projects live: one IndexedDB database with a store each for Project
// records, their files, the Wheel Cache, and the Mirrors. Engines are in the
// Collection's own cache (shared/engines.ts), which is a separate database.
// Every call resolves to something usable when IndexedDB is missing (a
// private window, a browser that refuses it on file://): the Tool then works
// for the visit and forgets everything after.

const DB_NAME = "html-tools-python-ide";
const DB_VERSION = 1;

export interface ProjectRecord {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** Paths of the files open in the editor, in tab order. */
  openTabs: string[];
  activeFile: string | null;
  /** micropip.freeze() of the Environment, or null before the first install. */
  lock: string | null;
  /** The Pyodide release the Lock was made under. */
  lockPyodide: string | null;
  /** Everything installed, direct and transitive, as micropip lists it. */
  packages: { name: string; version: string; source: string }[];
}

export interface FileRecord {
  projectId: string;
  /** Relative to the Project root, `/`-separated, no leading slash. */
  path: string;
  /** Text files are kept as strings, everything else as bytes. */
  text?: string;
  bytes?: ArrayBuffer;
  mtime: number;
}

export interface WheelRecord {
  url: string;
  bytes: ArrayBuffer;
  storedAt: number;
}

export interface MirrorRecord {
  projectId: string;
  /** The Lock the Mirror was taken from; a different Lock means a stale Mirror. */
  lock: string;
  files: Record<string, string>;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("projects")) db.createObjectStore("projects", { keyPath: "id" });
      if (!db.objectStoreNames.contains("files")) {
        const files = db.createObjectStore("files", { keyPath: ["projectId", "path"] });
        files.createIndex("project", "projectId", { unique: false });
      }
      if (!db.objectStoreNames.contains("wheels")) db.createObjectStore("wheels", { keyPath: "url" });
      if (!db.objectStoreNames.contains("mirrors")) db.createObjectStore("mirrors", { keyPath: "projectId" });
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

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

type StoreName = "projects" | "files" | "wheels" | "mirrors";

async function read<T>(store: StoreName, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  const db = await openDb();
  if (!db) return undefined;
  try {
    return await request(run(db.transaction(store, "readonly").objectStore(store)));
  } catch {
    return undefined;
  }
}

async function write(stores: StoreName[], run: (tx: IDBTransaction) => void): Promise<boolean> {
  const db = await openDb();
  if (!db) return false;
  try {
    const tx = db.transaction(stores, "readwrite");
    run(tx);
    await done(tx);
    return true;
  } catch {
    return false;
  }
}

export function storageAvailable(): Promise<boolean> {
  return openDb().then((db) => db !== null);
}

/* ---------------- projects ---------------- */

export async function listProjects(): Promise<ProjectRecord[]> {
  const rows = (await read<ProjectRecord[]>("projects", (s) => s.getAll())) ?? [];
  return rows.toSorted((a, b) => b.updatedAt - a.updatedAt);
}

export function getProject(id: string): Promise<ProjectRecord | undefined> {
  return read<ProjectRecord | undefined>("projects", (s) => s.get(id));
}

export function putProject(p: ProjectRecord): Promise<boolean> {
  return write(["projects"], (tx) => tx.objectStore("projects").put(p));
}

/** Removes a Project with its files and Mirror. The Wheel Cache is shared and stays. */
export function deleteProject(id: string): Promise<boolean> {
  return write(["projects", "files", "mirrors"], (tx) => {
    tx.objectStore("projects").delete(id);
    tx.objectStore("mirrors").delete(id);
    const files = tx.objectStore("files").index("project");
    files.openKeyCursor(IDBKeyRange.only(id)).onsuccess = (ev) => {
      const cursor = (ev.target as IDBRequest<IDBCursor | null>).result;
      if (!cursor) return;
      tx.objectStore("files").delete(cursor.primaryKey);
      cursor.continue();
    };
  });
}

/* ---------------- files ---------------- */

export async function listFiles(projectId: string): Promise<FileRecord[]> {
  return (await read<FileRecord[]>("files", (s) => s.index("project").getAll(IDBKeyRange.only(projectId)))) ?? [];
}

export function putFiles(files: FileRecord[]): Promise<boolean> {
  return write(["files"], (tx) => {
    const s = tx.objectStore("files");
    for (const f of files) s.put(f);
  });
}

export function deleteFiles(projectId: string, paths: string[]): Promise<boolean> {
  return write(["files"], (tx) => {
    const s = tx.objectStore("files");
    for (const p of paths) s.delete([projectId, p]);
  });
}

/* ---------------- wheels ---------------- */

export function getWheel(url: string): Promise<WheelRecord | undefined> {
  return read<WheelRecord | undefined>("wheels", (s) => s.get(url));
}

export function putWheel(w: WheelRecord): Promise<boolean> {
  return write(["wheels"], (tx) => tx.objectStore("wheels").put(w));
}


/** Drops Wheels of other Pyodide releases: the catalog ones name their release in the URL. */
export function clearWheels(): Promise<boolean> {
  return write(["wheels"], (tx) => tx.objectStore("wheels").clear());
}

/* ---------------- mirrors ---------------- */

export function getMirror(projectId: string): Promise<MirrorRecord | undefined> {
  return read<MirrorRecord | undefined>("mirrors", (s) => s.get(projectId));
}

export function putMirror(m: MirrorRecord): Promise<boolean> {
  return write(["mirrors"], (tx) => tx.objectStore("mirrors").put(m));
}
