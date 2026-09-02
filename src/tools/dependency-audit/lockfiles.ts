// The Lockfile model shared by every parser, plus kind detection and dispatch.
// Terms (Lockfile, Package, Direct, Group, Not Checked) are the glossary's.

export type Ecosystem = "npm" | "PyPI";

export type LockfileKind = "package-lock" | "yarn" | "pnpm" | "bun" | "uv";

export const KIND_FILENAME: Record<LockfileKind, string> = {
  "package-lock": "package-lock.json",
  yarn: "yarn.lock",
  pnpm: "pnpm-lock.yaml",
  bun: "bun.lock",
  uv: "uv.lock",
};

export const KIND_ECOSYSTEM: Record<LockfileKind, Ecosystem> = {
  "package-lock": "npm",
  yarn: "npm",
  pnpm: "npm",
  bun: "npm",
  uv: "PyPI",
};

/** One name-and-version pair from a Lockfile, deduplicated within the file. */
export interface Package {
  name: string;
  version: string;
  ecosystem: Ecosystem;
  /** true or false when the Lockfile records it, null when it cannot tell. */
  direct: boolean | null;
  /** Groups the Lockfile places the Package in: "dev", "optional", "peer", or a named group. Empty means production. */
  groups: string[];
}

export type NotCheckedReason = "git" | "path" | "url" | "workspace" | "root";

/** A Lockfile entry OSV cannot be asked about: not a registry release. */
export interface NotChecked {
  name: string;
  version: string;
  reason: NotCheckedReason;
  /** Where the entry points instead (a git URL, a path). */
  detail: string;
}

export interface ParsedLockfile {
  kind: LockfileKind;
  ecosystem: Ecosystem;
  /** Kind and generation as shown to the user, e.g. "package-lock.json v3". */
  label: string;
  packages: Package[];
  notChecked: NotChecked[];
  /** Whether this Lockfile records which Packages are Direct. */
  knowsDirect: boolean;
  /** Whether this Lockfile records Groups. */
  knowsGroups: boolean;
}

/** A Lockfile that cannot be read: message fit to show as-is. */
export class LockfileError extends Error {}

export const REASON_LABEL: Record<NotCheckedReason, string> = {
  git: "git dependency",
  path: "local path",
  url: "tarball URL",
  workspace: "workspace member",
  root: "the project itself",
};

/** Builds a package list with duplicates merged: direct wins over transitive, groups union. */
export class PackageSet {
  private byKey = new Map<string, Package>();
  readonly notChecked: NotChecked[] = [];
  private seenNotChecked = new Set<string>();

  constructor(readonly ecosystem: Ecosystem) {}

  add(name: string, version: string, direct: boolean | null, groups: string[] = []): Package {
    const key = name + "@" + version;
    let p = this.byKey.get(key);
    if (!p) {
      p = { name, version, ecosystem: this.ecosystem, direct, groups: [...groups] };
      this.byKey.set(key, p);
      return p;
    }
    if (direct === true) p.direct = true;
    else if (direct === false && p.direct === null) p.direct = false;
    for (const g of groups) if (!p.groups.includes(g)) p.groups.push(g);
    return p;
  }

  skip(name: string, version: string, reason: NotCheckedReason, detail = "") {
    const key = name + "@" + version + "@" + reason;
    if (this.seenNotChecked.has(key)) return;
    this.seenNotChecked.add(key);
    this.notChecked.push({ name, version, reason, detail });
  }

  get(name: string, version: string): Package | undefined {
    return this.byKey.get(name + "@" + version);
  }

  hasSkipped(name: string): boolean {
    return this.notChecked.some((n) => n.name === name);
  }

  packages(): Package[] {
    return [...this.byKey.values()].toSorted((a, b) => a.name.localeCompare(b.name) || compareLoose(a.version, b.version));
  }
}

/**
 * Orders version strings well enough to sort a list and to pick the smallest
 * fix above an installed version: numeric segments compare as numbers, a
 * pre-release sorts before its release. Not a full semver or PEP 440 comparator;
 * OSV does the actual affected-version matching.
 */
export function compareLoose(a: string, b: string): number {
  const split = (v: string) => {
    const [main, pre = ""] = v.replace(/^v/, "").split(/[-+]/, 2) as [string, string?];
    const nums = main.split(".").map((s) => /^\d+$/.test(s) ? Number(s) : s);
    return { nums, pre };
  };
  const x = split(a), y = split(b);
  const len = Math.max(x.nums.length, y.nums.length);
  for (let i = 0; i < len; i++) {
    const p = x.nums[i] ?? 0, q = y.nums[i] ?? 0;
    if (p === q) continue;
    if (typeof p === "number" && typeof q === "number") return p < q ? -1 : 1;
    return String(p) < String(q) ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** True for a version string a registry could hold, as opposed to a URL, path, or protocol spec. */
export function looksLikeVersion(v: string): boolean {
  return /^\d/.test(v) && !v.includes("://") && !v.includes("/");
}

/** How a package spec or resolution says it is not a registry release; null when it is one. */
export function nonRegistryReason(spec: string): NotCheckedReason | null {
  const s = spec.toLowerCase();
  if (s.startsWith("workspace:")) return "workspace";
  if (s.startsWith("file:") || s.startsWith("link:") || s.startsWith("portal:") || s.startsWith("directory:") || s.startsWith("./") || s.startsWith("../") || s.startsWith("/")) return "path";
  if (s.startsWith("git+") || s.startsWith("git:") || s.startsWith("git@") || s.startsWith("github:") || s.startsWith("gitlab:") || s.startsWith("bitbucket:") || s.startsWith("ssh://")) return "git";
  if (s.includes("codeload.github.com") || (/^https?:\/\//.test(s) && /\.git(#|$)/.test(s))) return "git";
  if (/^(github|gitlab|bitbucket)\.(com|org)\//.test(s)) return "git";
  if (/^https?:\/\//.test(s)) return s.includes("/-/") ? null : "url";
  if (/^[\w.-]+\/[\w.-]+(#|$)/.test(s) && !s.startsWith("@")) return "git";
  return null;
}

/** PEP 503 normalization: what PyPI and OSV know a Python package by. */
export function normalizePyPiName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

export type Detected =
  | { kind: LockfileKind }
  | { kind: null; refusal: string };

const BINARY_BUN = "bun.lockb is Bun's binary lockfile. Run `bun install --save-text-lockfile` (Bun 1.2 or newer) to get a text bun.lock and audit that.";

/** Decides which parser a file gets, from its name when it has one, otherwise from its content. */
export function detectKind(text: string, filename = ""): Detected {
  const base = filename.split("/").pop()!.toLowerCase();
  if (base === "bun.lockb") return { kind: null, refusal: BINARY_BUN };
  if (base === "package-lock.json" || base === "npm-shrinkwrap.json") return { kind: "package-lock" };
  if (base === "yarn.lock") return { kind: "yarn" };
  if (base === "pnpm-lock.yaml") return { kind: "pnpm" };
  if (base === "bun.lock") return { kind: "bun" };
  if (base === "uv.lock") return { kind: "uv" };
  if (base === "package.json") return { kind: null, refusal: declarationRefusal("package.json") };
  if (base === "pyproject.toml") return { kind: null, refusal: declarationRefusal("pyproject.toml") };
  if (base === "requirements.txt" || /^requirements[-_.\w]*\.txt$/.test(base)) return { kind: null, refusal: declarationRefusal("requirements.txt") };
  if (base === "poetry.lock") return { kind: null, refusal: "poetry.lock is not supported; uv.lock is the Python lockfile this tool reads." };
  if (base === "pipfile.lock") return { kind: null, refusal: "Pipfile.lock is not supported; uv.lock is the Python lockfile this tool reads." };

  const t = text.trimStart();
  if (Array.from(t.slice(0, 64)).some((c) => c.charCodeAt(0) < 9)) return { kind: null, refusal: BINARY_BUN };
  if (t.startsWith("{")) {
    // Top-level keys decide: bun.lock has "workspaces" beside "lockfileVersion"; package-lock.json has "packages" or "dependencies" there.
    const keys = topLevelKeys(t);
    if (keys.has("lockfileVersion") && keys.has("workspaces")) return { kind: "bun" };
    if (keys.has("lockfileVersion")) return { kind: "package-lock" };
    if (keys.has("dependencies") || keys.has("devDependencies")) return { kind: null, refusal: declarationRefusal("package.json") };
    return { kind: null, refusal: "This JSON is not a lockfile this tool reads." };
  }
  if (/^lockfileVersion:/m.test(t)) return { kind: "pnpm" };
  if (/^# yarn lockfile v1/m.test(t) || /^__metadata:/m.test(t)) return { kind: "yarn" };
  if (/^\[\[package\]\]/m.test(t) || (/^version = \d/m.test(t) && /^requires-python = /m.test(t))) return { kind: "uv" };
  if (/^\[project\]/m.test(t) || /^\[tool\.poetry\]/m.test(t) || /^\[build-system\]/m.test(t)) return { kind: null, refusal: declarationRefusal("pyproject.toml") };
  if (/^[A-Za-z0-9][\w.-]*\s*(==|>=|<=|~=|!=|>|<)/m.test(t)) return { kind: null, refusal: declarationRefusal("requirements.txt") };
  return { kind: null, refusal: "Not a lockfile this tool reads. Paste package-lock.json, yarn.lock, pnpm-lock.yaml, bun.lock, or uv.lock." };
}

/** The keys of the outermost object, read by skipping nested values; tolerant of comments and trailing commas. */
function topLevelKeys(src: string): Set<string> {
  const keys = new Set<string>();
  let depth = 0;
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== '"') { if (src[j] === "\\") j++; j++; }
      const s = src.slice(i + 1, j);
      i = j + 1;
      if (depth === 1) {
        let k = i;
        while (k < n && (src[k] === " " || src[k] === "\t" || src[k] === "\n" || src[k] === "\r")) k++;
        if (src[k] === ":") keys.add(s);
      }
      continue;
    }
    if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
    i++;
  }
  return keys;
}

function declarationRefusal(name: string): string {
  return "This looks like " + name + ", which declares version ranges, not installed versions. Audit the lockfile instead" +
    (name === "package.json" ? " (package-lock.json, yarn.lock, pnpm-lock.yaml, or bun.lock)." : " (uv.lock).");
}
