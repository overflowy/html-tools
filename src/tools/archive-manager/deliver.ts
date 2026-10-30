// Getting files out of the browser. One file is a download. Several are
// written into a folder the user picks, where the browser can do that
// (Chromium's File System Access API); elsewhere (Firefox, Safari) a page
// cannot write a folder at all, and the Tool packs them into one zip.

/** The File System Access API, which TypeScript's DOM library does not declare. */
interface Writable {
  write: (data: Blob) => Promise<void>;
  close: () => Promise<void>;
}
interface FileHandle {
  createWritable: () => Promise<Writable>;
}
export interface DirHandle {
  readonly name: string;
  getDirectoryHandle: (
    name: string,
    o?: { create?: boolean }
  ) => Promise<DirHandle>;
  getFileHandle: (
    name: string,
    o?: { create?: boolean }
  ) => Promise<FileHandle>;
}
interface PickerWindow {
  showDirectoryPicker?: (o: {
    mode: "readwrite";
    id?: string;
  }) => Promise<DirHandle>;
}

export const canWriteFolders = (): boolean =>
  typeof (window as PickerWindow).showDirectoryPicker === "function";

/**
 * Ask for a folder to write into; null if the user backs out. Must run
 * while the click that asked for it still counts as a user gesture, so it
 * comes before the extraction, never after.
 */
export const pickFolder = async (): Promise<DirHandle | null> => {
  const pick = (window as PickerWindow).showDirectoryPicker;
  if (!pick) {
    return null;
  }
  try {
    return await pick({ id: "archive-manager", mode: "readwrite" });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return null;
    }
    throw error;
  }
};

const exists = async (dir: DirHandle, name: string): Promise<boolean> => {
  try {
    await dir.getDirectoryHandle(name);
    return true;
  } catch {
    try {
      await dir.getFileHandle(name);
      return true;
    } catch {
      return false;
    }
  }
};

/** `name`, or `name (2)`, `name (3)`... whichever is free in `dir`: nothing already there is overwritten. */
export const freeName = async (
  dir: DirHandle,
  name: string
): Promise<string> => {
  if (!(await exists(dir, name))) {
    return name;
  }
  for (let n = 2; ; n += 1) {
    const next = `${name} (${n})`;
    if (!(await exists(dir, next))) {
      return next;
    }
  }
};

export interface FileOut {
  path: string;
  blob?: Blob;
}

/**
 * Write files and folders into a new folder `name` inside `dir`. Paths are
 * written segment by segment, so a `..` in one could only ever name a
 * folder called `..`, which the API refuses: nothing lands outside.
 */
export const writeFolder = async (
  dir: DirHandle,
  name: string,
  items: FileOut[],
  onWritten?: (done: number) => void
): Promise<string> => {
  const folder = await freeName(dir, name);
  const root = await dir.getDirectoryHandle(folder, { create: true });
  const dirs = new Map<string, DirHandle>([["", root]]);
  const dirAt = async (path: string): Promise<DirHandle> => {
    const known = dirs.get(path);
    if (known) {
      return known;
    }
    const cut = path.lastIndexOf("/");
    const parent = await dirAt(cut === -1 ? "" : path.slice(0, cut));
    const handle = await parent.getDirectoryHandle(path.slice(cut + 1), {
      create: true,
    });
    dirs.set(path, handle);
    return handle;
  };
  let done = 0;
  for (const item of items) {
    if (!item.blob) {
      await dirAt(item.path);
      continue;
    }
    const cut = item.path.lastIndexOf("/");
    const parent = await dirAt(cut === -1 ? "" : item.path.slice(0, cut));
    const handle = await parent.getFileHandle(item.path.slice(cut + 1), {
      create: true,
    });
    const w = await handle.createWritable();
    await w.write(item.blob);
    await w.close();
    done += 1;
    onWritten?.(done);
  }
  return folder;
};

/** Save a Blob as a download named `name`. */
export const download = (blob: Blob, name: string) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  // Firefox reads the URL after click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
};
