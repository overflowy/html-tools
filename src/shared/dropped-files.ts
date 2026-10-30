// Files and folders a user drops or picks, with their paths. A drop of a
// folder carries only the folder's entry; its files are read from it here,
// through the entries API (`webkitGetAsEntry`), which Chromium, Firefox, and
// Safari all have, despite the prefix. A folder picked with an input's
// `webkitdirectory` arrives as files whose `webkitRelativePath` holds the
// path. Either way the result is one list of Picked items, folders with
// nothing in them included, since an archive keeps those too.

export interface Picked {
  /** Path relative to what was dropped or picked, `/`-separated. */
  path: string;
  /** The file; absent for a folder with nothing in it. */
  file?: File;
}

/** Every entry a folder reader yields: it hands them out in batches until an empty one. */
const readAll = async (
  dir: FileSystemDirectoryEntry
): Promise<FileSystemEntry[]> => {
  const reader = dir.createReader();
  const all: FileSystemEntry[] = [];
  for (;;) {
    const { promise, resolve, reject } =
      Promise.withResolvers<FileSystemEntry[]>();
    reader.readEntries(resolve, reject);
    const batch = await promise;
    if (batch.length === 0) {
      return all;
    }
    all.push(...batch);
  }
};

const fileOf = (entry: FileSystemFileEntry): Promise<File> => {
  const { promise, resolve, reject } = Promise.withResolvers<File>();
  entry.file(resolve, reject);
  return promise;
};

const isDirEntry = (e: FileSystemEntry): e is FileSystemDirectoryEntry =>
  e.isDirectory;
const isFileEntry = (e: FileSystemEntry): e is FileSystemFileEntry => e.isFile;

const walk = async (
  entry: FileSystemEntry,
  prefix: string,
  out: Picked[]
): Promise<void> => {
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (isFileEntry(entry)) {
    out.push({ file: await fileOf(entry), path });
    return;
  }
  if (!isDirEntry(entry)) {
    return;
  }
  const children = await readAll(entry);
  if (children.length === 0) {
    out.push({ path });
  }
  for (const c of children) {
    await walk(c, path, out);
  }
};

export interface Dropped {
  items: Picked[];
  /** Whether any folder was dropped, as opposed to files only. */
  folders: boolean;
}

/**
 * What a drop carries. Entries are taken from the items synchronously,
 * before the first await: the browser empties the DataTransfer once the
 * drop handler returns. Where entries are not available, the plain file
 * list is used, and folders are lost.
 */
export const readDrop = async (dt: DataTransfer): Promise<Dropped> => {
  const entries: FileSystemEntry[] = [];
  for (const item of dt.items) {
    const entry = item.kind === "file" ? item.webkitGetAsEntry() : null;
    if (entry) {
      entries.push(entry);
    }
  }
  if (entries.length === 0) {
    return {
      folders: false,
      items: [...dt.files].map((file) => ({ file, path: file.name })),
    };
  }
  const items: Picked[] = [];
  for (const e of entries) {
    await walk(e, "", items);
  }
  return { folders: entries.some((e) => e.isDirectory), items };
};

/** Files from an input, with the folder path a `webkitdirectory` input gives them. */
export const readInput = (files: FileList | null): Picked[] =>
  [...(files ?? [])].map((file) => ({
    file,
    path: file.webkitRelativePath || file.name,
  }));
