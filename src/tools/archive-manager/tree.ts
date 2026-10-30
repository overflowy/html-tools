// The folders of an archive as the Archive Manager shows them. Archives list
// paths, not a hierarchy, and many leave their folders implied (a zip made
// without folder entries lists `a/b/c.txt` and nothing for `a` or `a/b`),
// so the tree is built from the paths, with every implied folder made real.

import type { Entry } from "./listing";

export interface Node {
  /** Last path segment. */
  name: string;
  /** Normalized full path, `/`-separated, no leading or trailing slash; "" for the root. */
  path: string;
  dir: boolean;
  /** The archive's own Entry; absent for an implied folder and the root. */
  entry?: Entry;
  /** Children by name. A file and a folder may share a name in a broken archive; the folder wins. */
  children: Map<string, Node>;
  /** Unpacked bytes: a file's own, a folder's every file's. Unknown sizes count as 0. */
  size: number;
  /** Files beneath a folder, at any depth; 1 for a file. */
  files: number;
  /** Newest modification time beneath, for a folder without its own. */
  mtime: number | null;
}

/**
 * A path's segments with the noise removed: backslashes are separators too
 * (zips made on Windows), and empty and `.` segments go. `..` stays, so a
 * hostile path is shown as it is rather than quietly made to look safe.
 */
export const segments = (path: string): string[] =>
  path.split(/[/\\]/u).filter((s) => s !== "" && s !== ".");

const makeNode = (name: string, path: string, dir: boolean): Node => ({
  children: new Map(),
  dir,
  files: 0,
  mtime: null,
  name,
  path,
  size: 0,
});

/** The tree of an archive's Entries, rooted at an unnamed folder. */
export const buildTree = (entries: Entry[]): Node => {
  const root = makeNode("", "", true);
  for (const e of entries) {
    const parts = segments(e.path);
    if (parts.length === 0) {
      continue;
    }
    let at = root;
    for (const [i, name] of parts.entries()) {
      const last = i === parts.length - 1;
      const dir = !last || e.dir;
      const path = parts.slice(0, i + 1).join("/");
      let child = at.children.get(name);
      if (!child) {
        child = makeNode(name, path, dir);
        at.children.set(name, child);
      } else if (dir && !child.dir) {
        child.dir = true;
        delete child.entry;
      }
      if (last && (child.dir === e.dir || !child.entry)) {
        child.entry = e;
      }
      at = child;
    }
  }
  const total = (n: Node): void => {
    if (!n.dir) {
      n.size = n.entry?.size ?? 0;
      n.files = 1;
      n.mtime = n.entry?.mtime ?? null;
      return;
    }
    n.size = 0;
    n.files = 0;
    let newest: number | null = null;
    for (const c of n.children.values()) {
      total(c);
      n.size += c.size;
      n.files += c.files;
      if (c.mtime !== null && (newest === null || c.mtime > newest)) {
        newest = c.mtime;
      }
    }
    n.mtime = n.entry?.mtime ?? newest;
  };
  total(root);
  return root;
};

/** The folder at `path`, or null when there is none. */
export const findNode = (root: Node, path: string): Node | null => {
  let at: Node | undefined = root;
  for (const name of segments(path)) {
    at = at?.children.get(name);
    if (!at) {
      return null;
    }
  }
  return at ?? null;
};

/** Every node beneath `n`, depth first, `n` excluded. */
export const descendants = (n: Node): Node[] => {
  const out: Node[] = [];
  const walk = (at: Node) => {
    for (const c of at.children.values()) {
      out.push(c);
      walk(c);
    }
  };
  walk(n);
  return out;
};

export type SortKey = "name" | "size" | "modified";

const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

/** Folders first, then by the key; ties fall back to the name. */
export const sortNodes = (
  nodes: Node[],
  key: SortKey,
  descending: boolean
): Node[] => {
  const sign = descending ? -1 : 1;
  const byName = (a: Node, b: Node) => collator.compare(a.name, b.name);
  return nodes.toSorted((a, b) => {
    if (a.dir !== b.dir) {
      return a.dir ? -1 : 1;
    }
    let c = 0;
    if (key === "size") {
      c = a.size - b.size;
    } else if (key === "modified") {
      c = (a.mtime ?? 0) - (b.mtime ?? 0);
    }
    return sign * (c || byName(a, b));
  });
};
