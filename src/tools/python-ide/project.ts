// A Project in memory: its record, its files, and what its Project File
// (pyproject.toml) says. Files are kept as text or bytes exactly as the
// store holds them; every change is written through to IndexedDB, so
// there is no Save. The Project File is parsed on every change, and a
// file that does not parse leaves the previous settings standing.

import { parse, stringify, TomlError } from "smol-toml";
import { PYODIDE_VERSION } from "./engines";
import { deleteFiles, deleteProject, getProject, listFiles, putFiles, putProject, type FileRecord, type ProjectRecord } from "./store";

export const PROJECT_FILE = "pyproject.toml";
export const ENTRY_FILE = "main.py";

const TEXT_EXTENSIONS = new Set([
  "py", "pyi", "pyx", "txt", "md", "markdown", "rst", "toml", "json", "yaml", "yml", "ini", "cfg", "csv", "tsv",
  "html", "htm", "css", "js", "ts", "xml", "svg", "sh", "env", "sql", "log", "in", "lock", "typed", "gitignore",
]);
const TEXT_NAMES = new Set(["Makefile", "Dockerfile", "LICENSE", "README", ".gitignore", ".editorconfig", "py.typed"]);

/** A pyproject.toml's [tool.python-ide] table with defaults filled in. */
export interface IdeSettings {
  args: string[];
  env: Record<string, string>;
  tabSize: number;
  formatOnRun: boolean;
  minimap: boolean;
  wordWrap: boolean;
}

export interface ProjectSettings {
  name: string;
  /** Direct Dependencies, as written. */
  dependencies: string[];
  /** The [tool.ruff] table, as Ruff's wasm build takes it. */
  ruff: Record<string, unknown>;
  /** The [tool.basedpyright] table, merged into pyrightconfig.json. */
  pyright: Record<string, unknown>;
  ide: IdeSettings;
}

export const DEFAULT_RUFF = { "line-length": 88, lint: { select: ["E4", "E7", "E9", "F", "I"] } };
export const DEFAULT_PYRIGHT = { typeCheckingMode: "standard" };
const DEFAULT_IDE: IdeSettings = { args: [], env: {}, tabSize: 4, formatOnRun: false, minimap: false, wordWrap: false };

export function isTextPath(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (TEXT_NAMES.has(name)) return true;
  const dot = name.lastIndexOf(".");
  if (dot === -1) return false;
  return TEXT_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/** Whether bytes read as text: no NUL in the first 8 KB and valid UTF-8. */
export function looksLikeText(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 8192);
  for (const b of head) if (b === 0) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export function languageFor(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const ext = name.slice(name.lastIndexOf(".") + 1);
  switch (ext) {
    case "py": case "pyi": case "pyx": return "python";
    case "md": case "markdown": return "markdown";
    case "yaml": case "yml": return "yaml";
    case "ini": case "cfg": return "ini";
    case "sh": return "shell";
    case "rst": return "restructuredtext";
    case "json": return "json";
    case "toml": return "toml";
    default: return "plaintext";
  }
}

export function defaultPyproject(name: string): string {
  return stringify({
    project: { name, dependencies: [] },
    tool: {
      ruff: DEFAULT_RUFF,
      basedpyright: DEFAULT_PYRIGHT,
      "python-ide": { args: [], env: {}, "tab-size": 4, "format-on-run": false },
    },
  });
}

export const DEFAULT_MAIN = `def main() -> None:
    print("Hello from Python!")


if __name__ == "__main__":
    main()
`;

function isTable(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Reads the settings out of a pyproject.toml. Throws on a TOML error. */
export function parseSettings(text: string, fallbackName: string): ProjectSettings {
  const doc = parse(text) as Record<string, unknown>;
  const project = isTable(doc.project) ? doc.project : {};
  const tool = isTable(doc.tool) ? doc.tool : {};
  const ideTable = isTable(tool["python-ide"]) ? tool["python-ide"] : {};
  const env: Record<string, string> = {};
  if (isTable(ideTable.env)) for (const [k, v] of Object.entries(ideTable.env)) env[k] = String(v);
  return {
    name: typeof project.name === "string" ? project.name : fallbackName,
    dependencies: strings(project.dependencies),
    ruff: isTable(tool.ruff) ? tool.ruff : DEFAULT_RUFF,
    pyright: isTable(tool.basedpyright) ? tool.basedpyright : DEFAULT_PYRIGHT,
    ide: {
      args: strings(ideTable.args),
      env,
      tabSize: typeof ideTable["tab-size"] === "number" ? ideTable["tab-size"] : DEFAULT_IDE.tabSize,
      formatOnRun: ideTable["format-on-run"] === true,
      minimap: ideTable.minimap === true,
      wordWrap: ideTable["word-wrap"] === true,
    },
  };
}

/**
 * Rewrites one table of a pyproject.toml, keeping everything else. TOML has
 * no comment-preserving round trip in reach, so the file is re-emitted from
 * its parsed form; comments in it do not survive an edit made through the UI.
 */
export function updatePyproject(text: string, update: (doc: Record<string, unknown>) => void): string {
  let doc: Record<string, unknown>;
  try {
    doc = parse(text) as Record<string, unknown>;
  } catch {
    doc = {};
  }
  update(doc);
  return stringify(doc);
}

export function tomlErrorMessage(e: unknown): string {
  if (e instanceof TomlError) return e.message.split("\n")[0] ?? "invalid TOML";
  return e instanceof Error ? e.message : String(e);
}

/* ---------------- files ---------------- */

export interface ProjectFile {
  path: string;
  text?: string;
  bytes?: ArrayBuffer;
  mtime: number;
}

export function isText(f: ProjectFile): f is ProjectFile & { text: string } {
  return f.text !== undefined;
}

export function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const seg of path.replaceAll("\\", "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export class Project {
  readonly files = new Map<string, ProjectFile>();
  settings: ProjectSettings;
  /** Why the Project File could not be read, or null while it parses. */
  settingsError: string | null = null;

  private constructor(public record: ProjectRecord, files: ProjectFile[]) {
    for (const f of files) this.files.set(f.path, f);
    this.settings = parseSettings(defaultPyproject(record.name), record.name);
    this.readSettings();
  }

  static async open(id: string): Promise<Project | null> {
    const record = await getProject(id);
    if (!record) return null;
    const rows = await listFiles(id);
    return new Project(record, rows.map((r) => ({ path: r.path, text: r.text, bytes: r.bytes, mtime: r.mtime })));
  }

  static async create(name: string, files?: ProjectFile[]): Promise<Project> {
    const now = Date.now();
    const record: ProjectRecord = {
      id: crypto.randomUUID(),
      name,
      createdAt: now,
      updatedAt: now,
      openTabs: [],
      activeFile: null,
      lock: null,
      lockPyodide: null,
      packages: [],
      folders: [],
    };
    const initial = files ?? [
      { path: ENTRY_FILE, text: DEFAULT_MAIN, mtime: now },
      { path: PROJECT_FILE, text: defaultPyproject(name), mtime: now },
    ];
    if (!initial.some((f) => f.path === PROJECT_FILE)) initial.push({ path: PROJECT_FILE, text: defaultPyproject(name), mtime: now });
    record.activeFile = initial.find((f) => f.path === ENTRY_FILE)?.path ?? initial.find((f) => isText(f))?.path ?? null;
    record.openTabs = record.activeFile ? [record.activeFile] : [];
    await putProject(record);
    await putFiles(initial.map((f) => ({ projectId: record.id, ...f })));
    return new Project(record, initial);
  }

  get id() {
    return this.record.id;
  }

  get name() {
    return this.record.name;
  }

  /** Whether the Lock was made under the Pyodide the Collection ships now. */
  get lockCurrent(): boolean {
    return this.record.lock !== null && this.record.lockPyodide === PYODIDE_VERSION;
  }

  private readSettings() {
    const file = this.files.get(PROJECT_FILE);
    if (!file || !isText(file)) {
      this.settings = parseSettings(defaultPyproject(this.record.name), this.record.name);
      this.settingsError = null;
      return;
    }
    try {
      this.settings = parseSettings(file.text, this.record.name);
      this.settingsError = null;
    } catch (e) {
      this.settingsError = tomlErrorMessage(e);
    }
  }

  async saveRecord(patch: Partial<ProjectRecord> = {}) {
    Object.assign(this.record, patch, { updatedAt: Date.now() });
    await putProject(this.record);
  }

  /** Writes a file, creating it if needed. Returns whether the Project File's settings changed. */
  async write(path: string, data: string | ArrayBuffer): Promise<boolean> {
    const file: ProjectFile = typeof data === "string" ? { path, text: data, mtime: Date.now() } : { path, bytes: data, mtime: Date.now() };
    this.files.set(path, file);
    await putFiles([{ projectId: this.id, ...file }]);
    if (path !== PROJECT_FILE) return false;
    const before = JSON.stringify(this.settings);
    this.readSettings();
    return JSON.stringify(this.settings) !== before;
  }

  async writeMany(files: ProjectFile[]) {
    for (const f of files) this.files.set(f.path, f);
    await putFiles(files.map((f) => ({ projectId: this.id, ...f }) as FileRecord));
    if (files.some((f) => f.path === PROJECT_FILE)) this.readSettings();
  }

  async remove(paths: string[]) {
    for (const p of paths) this.files.delete(p);
    await deleteFiles(this.id, paths);
    if (paths.includes(PROJECT_FILE)) this.readSettings();
  }

  /** The [from, to] pairs a move of a file or a folder (every path under it) would make. */
  movePairs(from: string, to: string): [string, string][] {
    const pairs: [string, string][] = [];
    for (const path of this.files.keys()) {
      if (path === from) pairs.push([path, to]);
      else if (path.startsWith(from + "/")) pairs.push([path, to + path.slice(from.length)]);
    }
    return pairs;
  }

  /** Moves a file or a folder (every path under it). Returns the [from, to] pairs moved. */
  async move(from: string, to: string): Promise<[string, string][]> {
    const pairs = this.movePairs(from, to);
    const moved: ProjectFile[] = [];
    for (const [a, b] of pairs) {
      const f = this.files.get(a)!;
      this.files.delete(a);
      const nf = { ...f, path: b };
      this.files.set(b, nf);
      moved.push(nf);
    }
    await deleteFiles(this.id, pairs.map((p) => p[0]));
    await putFiles(moved.map((f) => Object.assign({ projectId: this.id }, f) as FileRecord));
    if (pairs.some((p) => p[0] === PROJECT_FILE || p[1] === PROJECT_FILE)) this.readSettings();
    return pairs;
  }

  /** Every folder path implied by the files, so empty-looking parents still show. */
  folders(): Set<string> {
    const out = new Set<string>();
    for (const path of this.files.keys()) {
      let dir = dirname(path);
      while (dir) {
        out.add(dir);
        dir = dirname(dir);
      }
    }
    return out;
  }

  /** The Project's Python and other text files as the Checker's virtual filesystem wants them. */
  checkerFiles(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const f of this.files.values()) if (isText(f) && /\.pyi?$/i.test(f.path)) out["/project/" + f.path] = f.text;
    return out;
  }

  static async delete(id: string) {
    await deleteProject(id);
  }
}
