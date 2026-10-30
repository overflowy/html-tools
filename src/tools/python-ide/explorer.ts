// The Explorer's two lists: the Tree of a Project's files and folders, and
// the Packages section. Pure rendering: the Tool hands them data and
// callbacks and re-renders on change.

import { required } from "./dom";
import { fileIcon, ICON_FOLDER, ICON_FOLDER_OPEN } from "./file-icons";
import { ICON_CHEVRON, ICON_TRASH } from "./icons";
import { basename, dirname } from "./project";

export interface TreeCallbacks {
  onOpen: (path: string) => void;
  onToggle: (folder: string) => void;
  onMenu: (path: string, isFolder: boolean, x: number, y: number) => void;
  onDrop: (paths: string[], intoFolder: string) => void;
}

interface Node {
  name: string;
  path: string;
  folders: Node[];
  files: string[];
}

const buildTree = (files: Iterable<string>, folders: Set<string>): Node => {
  const root: Node = { files: [], folders: [], name: "", path: "" };
  const byPath = new Map<string, Node>([["", root]]);
  const ensure = (dir: string): Node => {
    let node = byPath.get(dir);
    if (node) {
      return node;
    }
    const parent = ensure(dirname(dir));
    node = { files: [], folders: [], name: basename(dir), path: dir };
    parent.folders.push(node);
    byPath.set(dir, node);
    return node;
  };
  for (const f of folders) {
    ensure(f);
  }
  for (const path of files) {
    ensure(dirname(path)).files.push(path);
  }
  const sort = (n: Node) => {
    n.folders.sort((a, b) => a.name.localeCompare(b.name));
    n.files.sort((a, b) => basename(a).localeCompare(basename(b)));
    for (const f of n.folders) {
      sort(f);
    }
  };
  sort(root);
  return root;
};

const bindDrop = (
  el: HTMLElement,
  folder: string,
  callbacks: TreeCallbacks
) => {
  el.addEventListener("dragover", (e) => {
    if (e.dataTransfer?.types.includes("text/x-pyide-path")) {
      e.preventDefault();
      e.stopPropagation();
      el.classList.add("drop-target");
    }
  });
  el.addEventListener("dragleave", () => el.classList.remove("drop-target"));
  el.addEventListener("drop", (e) => {
    const path = e.dataTransfer?.getData("text/x-pyide-path");
    el.classList.remove("drop-target");
    if (!path) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    callbacks.onDrop([path], folder);
  });
};

export const renderTree = (
  container: HTMLElement,
  files: Iterable<string>,
  folders: Set<string>,
  expanded: Set<string>,
  active: string | null,
  callbacks: TreeCallbacks
) => {
  const root = buildTree(files, folders);
  container.replaceChildren();
  const frag = document.createDocumentFragment();
  const render = (node: Node, depth: number) => {
    for (const child of node.folders) {
      const open = expanded.has(child.path);
      const row = document.createElement("div");
      row.className = `tree-row folder${open ? " open" : ""}`;
      row.style.setProperty("--depth", String(depth));
      row.dataset.path = child.path;
      row.innerHTML = `<span class="chev">${ICON_CHEVRON}</span><span class="icon">${open ? ICON_FOLDER_OPEN : ICON_FOLDER}</span><span class="name"></span>`;
      required(row, ".name").textContent = child.name;
      row.addEventListener("click", () => callbacks.onToggle(child.path));
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        callbacks.onMenu(child.path, true, e.clientX, e.clientY);
      });
      bindDrop(row, child.path, callbacks);
      row.draggable = true;
      row.addEventListener("dragstart", (e) =>
        e.dataTransfer?.setData("text/x-pyide-path", child.path)
      );
      frag.append(row);
      if (open) {
        render(child, depth + 1);
      }
    }
    for (const path of node.files) {
      const row = document.createElement("div");
      row.className = `tree-row file${path === active ? " active" : ""}`;
      row.style.setProperty("--depth", String(depth));
      row.dataset.path = path;
      row.innerHTML = `<span class="chev"></span><span class="icon">${fileIcon(path)}</span><span class="name"></span>`;
      required(row, ".name").textContent = basename(path);
      row.addEventListener("click", () => callbacks.onOpen(path));
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        callbacks.onMenu(path, false, e.clientX, e.clientY);
      });
      row.draggable = true;
      row.addEventListener("dragstart", (e) =>
        e.dataTransfer?.setData("text/x-pyide-path", path)
      );
      frag.append(row);
    }
  };
  render(root, 0);
  container.append(frag);
  bindDrop(container, "", callbacks);
};

/* ---------------- packages ---------------- */

export interface PackageRow {
  name: string;
  version: string;
  /** The Catalog, a PyPI pure wheel, or a PyPI wasm wheel. */
  origin: "catalog" | "pypi" | "wasm";
}

export interface PackagesCallbacks {
  onRemove: (spec: string) => void;
  onMenu: (spec: string, x: number, y: number) => void;
}

/** The distribution name a spec names: `requests==2.33` gives `requests`. */
export const specName = (spec: string): string => {
  const m = /^\s*(?<name>[A-Za-z0-9][A-Za-z0-9._-]*)/u.exec(spec);
  return (m?.groups?.name ?? spec).toLowerCase().replaceAll(/[-_.]+/gu, "-");
};

export const renderPackages = (
  direct: HTMLElement,
  transitive: HTMLElement,
  specs: string[],
  installed: PackageRow[],
  callbacks: PackagesCallbacks
) => {
  const byName = new Map(installed.map((p) => [specName(p.name), p]));
  direct.replaceChildren();
  const directNames = new Set<string>();
  for (const spec of specs) {
    const name = specName(spec);
    directNames.add(name);
    const p = byName.get(name);
    const row = document.createElement("div");
    row.className = `pkg-row${p ? "" : " pending"}`;
    // The badge and the remove button share one slot: hovering the row swaps them, and nothing shifts.
    row.innerHTML = `<span class="pkg-name"></span><span class="pkg-version"></span><span class="pkg-end"><span class="pkg-origin"></span><button type="button" class="icon pkg-remove" title="Remove from the project">${ICON_TRASH}</button></span>`;
    required(row, ".pkg-name").textContent = spec;
    required(row, ".pkg-version").textContent = p ? p.version : "not installed";
    const origin = required(row, ".pkg-origin");
    origin.textContent = p
      ? { catalog: "prebuilt", pypi: "PyPI", wasm: "PyPI wasm" }[p.origin]
      : "";
    required(row, ".pkg-remove").addEventListener("click", () =>
      callbacks.onRemove(spec)
    );
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      callbacks.onMenu(spec, e.clientX, e.clientY);
    });
    direct.append(row);
  }
  if (specs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "pkg-empty";
    empty.textContent = "No dependencies";
    direct.append(empty);
  }
  transitive.replaceChildren();
  const rest = installed
    .filter((p) => !directNames.has(specName(p.name)) && p.name !== "micropip")
    .toSorted((a, b) => a.name.localeCompare(b.name));
  for (const p of rest) {
    const row = document.createElement("div");
    row.className = "pkg-row transitive";
    row.innerHTML = `<span class="pkg-name"></span><span class="pkg-version"></span>`;
    required(row, ".pkg-name").textContent = p.name;
    required(row, ".pkg-version").textContent = p.version;
    transitive.append(row);
  }
  const summary = transitive.parentElement?.querySelector("summary");
  if (summary) {
    summary.textContent = rest.length
      ? `${rest.length} dependencies of dependencies`
      : "No dependencies of dependencies";
  }
};
