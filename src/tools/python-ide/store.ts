// Where Projects live: one IndexedDB database with a store each for Project
// records, their files, the Wheel Cache, and the Mirrors. Engines are in the
// Collection's own cache (shared/engines.ts), which is a separate database.
// Every call resolves to something usable when IndexedDB is missing (a
// private window, a browser that refuses it on file://): the Tool then works
// for the visit and forgets everything after. But it never fails quietly:
// every refused write is reported through `onStorageError`, so the Tool can
// say what was not saved.

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
  /** Folders with no file in them yet; folders holding files are implied by the files. Absent in older records. */
  folders?: string[];
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
  /** The Environment the Mirror was taken from (Project.environmentKey); another means a stale Mirror. */
  key: string;
  files: Record<string, string>;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;
let openError = "";

type StorageErrorHandler = (what: string, reason: string) => void;
let storageErrorHandler: StorageErrorHandler = (what, reason) =>
  console.error(`Storage: ${what}: ${reason}`);

/** Registers the one handler told about every write that did not happen. */
export const onStorageError = (fn: StorageErrorHandler) => {
  storageErrorHandler = fn;
};

const describe = (e: unknown): string => {
  if (e instanceof Error || (e && typeof e === "object" && "name" in e)) {
    const { name, message } = e as { name?: string; message?: string };
    return [name, message].filter(Boolean).join(": ") || "unknown error";
  }
  return String(e);
};

const openDb = (): Promise<IDBDatabase | null> => {
  if (dbPromise) {
    return dbPromise;
  }
  const { promise, resolve } = Promise.withResolvers<IDBDatabase | null>();
  dbPromise = promise;
  let req: IDBOpenDBRequest;
  try {
    if (typeof indexedDB === "undefined") {
      openError = "this browser has no IndexedDB";
      resolve(null);
      return promise;
    }
    req = indexedDB.open(DB_NAME, DB_VERSION);
  } catch (error) {
    openError = describe(error);
    resolve(null);
    return promise;
  }
  req.onupgradeneeded = () => {
    const db = req.result;
    if (!db.objectStoreNames.contains("projects")) {
      db.createObjectStore("projects", { keyPath: "id" });
    }
    if (!db.objectStoreNames.contains("files")) {
      const files = db.createObjectStore("files", {
        keyPath: ["projectId", "path"],
      });
      files.createIndex("project", "projectId", { unique: false });
    }
    if (!db.objectStoreNames.contains("wheels")) {
      db.createObjectStore("wheels", { keyPath: "url" });
    }
    if (!db.objectStoreNames.contains("mirrors")) {
      db.createObjectStore("mirrors", { keyPath: "projectId" });
    }
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => {
    openError = describe(req.error);
    resolve(null);
  };
  req.onblocked = () => {
    openError = "the database is open in another tab at an older version";
    resolve(null);
  };
  return promise;
};

const request = <T>(r: IDBRequest<T>): Promise<T> => {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  return promise;
};

const done = (tx: IDBTransaction): Promise<undefined> => {
  const { promise, resolve, reject } = Promise.withResolvers<undefined>();
  tx.oncomplete = () => resolve(undefined);
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error);
  return promise;
};

type StoreName = "projects" | "files" | "wheels" | "mirrors";

const read = async <T>(
  store: StoreName,
  run: (s: IDBObjectStore) => IDBRequest<T>
): Promise<T | undefined> => {
  const db = await openDb();
  if (!db) {
    return undefined;
  }
  try {
    return await request(
      run(db.transaction(store, "readonly").objectStore(store))
    );
  } catch {
    return undefined;
  }
};

/** A write, named by `what` (a file path, "the project record") for the error report. */
const write = async (
  what: string,
  stores: StoreName[],
  run: (tx: IDBTransaction) => void
): Promise<boolean> => {
  const db = await openDb();
  if (!db) {
    storageErrorHandler(what, `IndexedDB could not be opened: ${openError}`);
    return false;
  }
  try {
    const tx = db.transaction(stores, "readwrite");
    run(tx);
    await done(tx);
    return true;
  } catch (error) {
    storageErrorHandler(what, describe(error));
    return false;
  }
};

/** The reason the database could not be opened, once `storageAvailable` said so. */
export const storageError = (): string => openError;

export const storageAvailable = (): Promise<boolean> =>
  openDb().then((db) => db !== null);

/* ---------------- projects ---------------- */

export const listProjects = async (): Promise<ProjectRecord[]> => {
  const rows =
    (await read<ProjectRecord[]>("projects", (s) => s.getAll())) ?? [];
  return rows.toSorted((a, b) => b.updatedAt - a.updatedAt);
};

export const getProject = (id: string): Promise<ProjectRecord | undefined> =>
  read<ProjectRecord | undefined>("projects", (s) => s.get(id));

export const putProject = (p: ProjectRecord): Promise<boolean> =>
  write(`the project "${p.name}"`, ["projects"], (tx) =>
    tx.objectStore("projects").put(p)
  );

/** Removes a Project with its files and Mirror. The Wheel Cache is shared and stays. */
export const deleteProject = (id: string): Promise<boolean> =>
  write("deleting the project", ["projects", "files", "mirrors"], (tx) => {
    tx.objectStore("projects").delete(id);
    tx.objectStore("mirrors").delete(id);
    const files = tx.objectStore("files").index("project");
    files.openKeyCursor(IDBKeyRange.only(id)).onsuccess = (ev) => {
      const cursor = (ev.target as IDBRequest<IDBCursor | null>).result;
      if (!cursor) {
        return;
      }
      tx.objectStore("files").delete(cursor.primaryKey);
      cursor.continue();
    };
  });

/* ---------------- files ---------------- */

export const listFiles = async (projectId: string): Promise<FileRecord[]> =>
  (await read<FileRecord[]>("files", (s) =>
    s.index("project").getAll(IDBKeyRange.only(projectId))
  )) ?? [];

export const putFiles = (files: FileRecord[]): Promise<boolean> =>
  write(files.map((f) => f.path).join(", "), ["files"], (tx) => {
    const s = tx.objectStore("files");
    for (const f of files) {
      s.put(f);
    }
  });

export const deleteFiles = (
  projectId: string,
  paths: string[]
): Promise<boolean> =>
  write(`deleting ${paths.join(", ")}`, ["files"], (tx) => {
    const s = tx.objectStore("files");
    for (const p of paths) {
      s.delete([projectId, p]);
    }
  });

/* ---------------- wheels ---------------- */

export const getWheel = (url: string): Promise<WheelRecord | undefined> =>
  read<WheelRecord | undefined>("wheels", (s) => s.get(url));

export const putWheel = (w: WheelRecord): Promise<boolean> =>
  write(
    `the wheel ${w.url.slice(w.url.lastIndexOf("/") + 1)}`,
    ["wheels"],
    (tx) => tx.objectStore("wheels").put(w)
  );

/** Drops Wheels of other Pyodide releases: the catalog ones name their release in the URL. */
export const clearWheels = (): Promise<boolean> =>
  write("clearing the wheel cache", ["wheels"], (tx) =>
    tx.objectStore("wheels").clear()
  );

/* ---------------- mirrors ---------------- */

export const getMirror = (
  projectId: string
): Promise<MirrorRecord | undefined> =>
  read<MirrorRecord | undefined>("mirrors", (s) => s.get(projectId));

export const putMirror = (m: MirrorRecord): Promise<boolean> =>
  write("the package sources for Pyright", ["mirrors"], (tx) =>
    tx.objectStore("mirrors").put(m)
  );
