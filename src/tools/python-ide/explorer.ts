// The Explorer's two lists: the Tree of a Project's files and folders, and
// the Packages section. Pure rendering: the Tool hands them data and
// callbacks and re-renders on change.

import { ICON_CHEVRON, ICON_FILE, ICON_FOLDER, ICON_FOLDER_OPEN, ICON_PYTHON, ICON_TRASH } from "./icons";
import { basename, dirname } from "./project";

export interface TreeCallbacks {
  onOpen(path: string): void;
  onToggle(folder: string): void;
  onMenu(path: string, isFolder: boolean, x: number, y: number): void;
  onDrop(paths: string[], intoFolder: string): void;
}

interface Node {
  name: string;
  path: string;
  folders: Node[];
  files: string[];
}

function buildTree(files: Iterable<string>, folders: Set<string>): Node {
  const root: Node = { name: "", path: "", folders: [], files: [] };
  const byPath = new Map<string, Node>([["", root]]);
  const ensure = (dir: string): Node => {
    let node = byPath.get(dir);
    if (node) return node;
    const parent = ensure(dirname(dir));
    node = { name: basename(dir), path: dir, folders: [], files: [] };
    parent.folders.push(node);
    byPath.set(dir, node);
    return node;
  };
  for (const f of folders) ensure(f);
  for (const path of files) ensure(dirname(path)).files.push(path);
  const sort = (n: Node) => {
    n.folders.sort((a, b) => a.name.localeCompare(b.name));
    n.files.sort((a, b) => basename(a).localeCompare(basename(b)));
    n.folders.forEach(sort);
  };
  sort(root);
  return root;
}

export function renderTree(
  container: HTMLElement,
  files: Iterable<string>,
  folders: Set<string>,
  expanded: Set<string>,
  active: string | null,
  cb: TreeCallbacks,
) {
  const root = buildTree(files, folders);
  container.replaceChildren();
  const frag = document.createDocumentFragment();
  const render = (node: Node, depth: number) => {
    for (const child of node.folders) {
      const open = expanded.has(child.path);
      const row = document.createElement("div");
      row.className = "tree-row folder" + (open ? " open" : "");
      row.style.setProperty("--depth", String(depth));
      row.dataset.path = child.path;
      row.innerHTML = `<span class="chev">${ICON_CHEVRON}</span><span class="icon">${open ? ICON_FOLDER_OPEN : ICON_FOLDER}</span><span class="name"></span>`;
      row.querySelector(".name")!.textContent = child.name;
      row.addEventListener("click", () => cb.onToggle(child.path));
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        cb.onMenu(child.path, true, e.clientX, e.clientY);
      });
      bindDrop(row, child.path, cb);
      row.draggable = true;
      row.addEventListener("dragstart", (e) => e.dataTransfer?.setData("text/x-pyide-path", child.path));
      frag.appendChild(row);
      if (open) render(child, depth + 1);
    }
    for (const path of node.files) {
      const row = document.createElement("div");
      row.className = "tree-row file" + (path === active ? " active" : "");
      row.style.setProperty("--depth", String(depth));
      row.dataset.path = path;
      const py = /\.pyi?$/i.test(path);
      row.innerHTML = `<span class="chev"></span><span class="icon${py ? " py" : ""}">${py ? ICON_PYTHON : ICON_FILE}</span><span class="name"></span>`;
      row.querySelector(".name")!.textContent = basename(path);
      row.addEventListener("click", () => cb.onOpen(path));
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        cb.onMenu(path, false, e.clientX, e.clientY);
      });
      row.draggable = true;
      row.addEventListener("dragstart", (e) => e.dataTransfer?.setData("text/x-pyide-path", path));
      frag.appendChild(row);
    }
  };
  render(root, 0);
  container.appendChild(frag);
  bindDrop(container, "", cb);
}

function bindDrop(el: HTMLElement, folder: string, cb: TreeCallbacks) {
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
    if (!path) return;
    e.preventDefault();
    e.stopPropagation();
    cb.onDrop([path], folder);
  });
}

/* ---------------- packages ---------------- */

export interface PackageRow {
  name: string;
  version: string;
  /** The Catalog, a PyPI pure wheel, or a PyPI wasm wheel. */
  origin: "catalog" | "pypi" | "wasm";
}

export interface PackagesCallbacks {
  onRemove(spec: string): void;
  onMenu(spec: string, x: number, y: number): void;
}

/** The distribution name a spec names: `requests==2.33` gives `requests`. */
export function specName(spec: string): string {
  const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(spec);
  return (m?.[1] ?? spec).toLowerCase().replaceAll(/[-_.]+/g, "-");
}

export function renderPackages(
  direct: HTMLElement,
  transitive: HTMLElement,
  specs: string[],
  installed: PackageRow[],
  cb: PackagesCallbacks,
) {
  const byName = new Map(installed.map((p) => [specName(p.name), p]));
  direct.replaceChildren();
  const directNames = new Set<string>();
  for (const spec of specs) {
    const name = specName(spec);
    directNames.add(name);
    const p = byName.get(name);
    const row = document.createElement("div");
    row.className = "pkg-row" + (p ? "" : " pending");
    // The badge and the remove button share one slot: hovering the row swaps them, and nothing shifts.
    row.innerHTML = `<span class="pkg-name"></span><span class="pkg-version"></span><span class="pkg-end"><span class="pkg-origin"></span><button type="button" class="icon pkg-remove" title="Remove from the project">${ICON_TRASH}</button></span>`;
    row.querySelector(".pkg-name")!.textContent = spec;
    row.querySelector(".pkg-version")!.textContent = p ? p.version : "not installed";
    const origin = row.querySelector(".pkg-origin")!;
    origin.textContent = p ? { catalog: "prebuilt", pypi: "PyPI", wasm: "PyPI wasm" }[p.origin] : "";
    row.querySelector(".pkg-remove")!.addEventListener("click", () => cb.onRemove(spec));
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      cb.onMenu(spec, e.clientX, e.clientY);
    });
    direct.appendChild(row);
  }
  if (specs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "pkg-empty";
    empty.textContent = "No dependencies yet. Add one above.";
    direct.appendChild(empty);
  }
  transitive.replaceChildren();
  const rest = installed.filter((p) => !directNames.has(specName(p.name)) && p.name !== "micropip").toSorted((a, b) => a.name.localeCompare(b.name));
  for (const p of rest) {
    const row = document.createElement("div");
    row.className = "pkg-row transitive";
    row.innerHTML = `<span class="pkg-name"></span><span class="pkg-version"></span>`;
    row.querySelector(".pkg-name")!.textContent = p.name;
    row.querySelector(".pkg-version")!.textContent = p.version;
    transitive.appendChild(row);
  }
  const summary = transitive.parentElement?.querySelector("summary");
  if (summary) summary.textContent = rest.length ? `${rest.length} dependencies of dependencies` : "No dependencies of dependencies";
}
