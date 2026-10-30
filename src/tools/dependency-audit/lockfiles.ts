// The Lockfile model shared by every parser, plus kind detection and dispatch.
// Terms (Lockfile, Package, Direct, Group, Not Checked) are the glossary's.

export type Ecosystem = "npm" | "PyPI";

export type LockfileKind = "package-lock" | "yarn" | "pnpm" | "bun" | "uv";

/** Every kind, in the order a repository is searched for its Lockfile. */
export const LOCKFILE_KINDS: readonly LockfileKind[] = [
  "package-lock",
  "yarn",
  "pnpm",
  "bun",
  "uv",
];

export const KIND_FILENAME: Record<LockfileKind, string> = {
  bun: "bun.lock",
  "package-lock": "package-lock.json",
  pnpm: "pnpm-lock.yaml",
  uv: "uv.lock",
  yarn: "yarn.lock",
};

export const KIND_ECOSYSTEM: Record<LockfileKind, Ecosystem> = {
  bun: "npm",
  "package-lock": "npm",
  pnpm: "npm",
  uv: "PyPI",
  yarn: "npm",
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
export class LockfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockfileError";
  }
}

export const REASON_LABEL: Record<NotCheckedReason, string> = {
  git: "git dependency",
  path: "local path",
  root: "the project itself",
  url: "tarball URL",
  workspace: "workspace member",
};

/**
 * Orders version strings well enough to sort a list and to pick the smallest
 * fix above an installed version: numeric segments compare as numbers, a
 * pre-release sorts before its release. Not a full semver or PEP 440 comparator;
 * OSV does the actual affected-version matching.
 */
export const compareLoose = (a: string, b: string): number => {
  const split = (v: string) => {
    const [main, pre = ""] = v.replace(/^v/u, "").split(/[-+]/u, 2) as [
      string,
      string?,
    ];
    const nums = main.split(".").map((s) => (/^\d+$/u.test(s) ? Number(s) : s));
    return { nums, pre };
  };
  const x = split(a);
  const y = split(b);
  const len = Math.max(x.nums.length, y.nums.length);
  for (let i = 0; i < len; i += 1) {
    const p = x.nums[i] ?? 0;
    const q = y.nums[i] ?? 0;
    if (p === q) {
      continue;
    }
    if (typeof p === "number" && typeof q === "number") {
      return p < q ? -1 : 1;
    }
    return String(p) < String(q) ? -1 : 1;
  }
  if (x.pre === y.pre) {
    return 0;
  }
  if (!x.pre) {
    return 1;
  }
  if (!y.pre) {
    return -1;
  }
  return x.pre < y.pre ? -1 : 1;
};

/** True for a version string a registry could hold, as opposed to a URL, path, or protocol spec. */
export const looksLikeVersion = (v: string): boolean =>
  /^\d/u.test(v) && !v.includes("://") && !v.includes("/");

const PATH_PREFIXES = [
  "file:",
  "link:",
  "portal:",
  "directory:",
  "./",
  "../",
  "/",
];

const GIT_PREFIXES = [
  "git+",
  "git:",
  "git@",
  "github:",
  "gitlab:",
  "bitbucket:",
  "ssh://",
];

/** Whether a lowercased spec names a git host or repository rather than a tarball. */
const isGitSpec = (s: string): boolean =>
  GIT_PREFIXES.some((p) => s.startsWith(p)) ||
  s.includes("codeload.github.com") ||
  (/^https?:\/\//u.test(s) && /\.git(?:#|$)/u.test(s)) ||
  /^(?:github|gitlab|bitbucket)\.(?:com|org)\//u.test(s);

/** How a package spec or resolution says it is not a registry release; null when it is one. */
export const nonRegistryReason = (spec: string): NotCheckedReason | null => {
  const s = spec.toLowerCase();
  if (s.startsWith("workspace:")) {
    return "workspace";
  }
  if (PATH_PREFIXES.some((p) => s.startsWith(p))) {
    return "path";
  }
  if (isGitSpec(s)) {
    return "git";
  }
  if (/^https?:\/\//u.test(s)) {
    return s.includes("/-/") ? null : "url";
  }
  if (/^[\w.-]+\/[\w.-]+(?:#|$)/u.test(s) && !s.startsWith("@")) {
    return "git";
  }
  return null;
};

/** PEP 503 normalization: what PyPI and OSV know a Python package by. */
export const normalizePyPiName = (name: string): string =>
  name.toLowerCase().replaceAll(/[-_.]+/gu, "-");

export type Detected = { kind: LockfileKind } | { kind: null; refusal: string };

const BINARY_BUN =
  "bun.lockb is Bun's binary lockfile. Run `bun install --save-text-lockfile` (Bun 1.2 or newer) to get a text bun.lock and audit that.";

const declarationRefusal = (name: string): string =>
  `This looks like ${
    name
  }, which declares version ranges, not installed versions. Audit the lockfile instead${
    name === "package.json"
      ? " (package-lock.json, yarn.lock, pnpm-lock.yaml, or bun.lock)."
      : " (uv.lock)."
  }`;

/** The index just past the closing quote of the JSON string opening at `start`. */
const skipString = (src: string, start: number): number => {
  let j = start + 1;
  while (j < src.length && src[j] !== '"') {
    if (src[j] === "\\") {
      j += 1;
    }
    j += 1;
  }
  return j + 1;
};

/** Whether the next non-whitespace character from `start` is a colon. */
const colonFollows = (src: string, start: number): boolean => {
  let k = start;
  while (
    k < src.length &&
    (src[k] === " " || src[k] === "\t" || src[k] === "\n" || src[k] === "\r")
  ) {
    k += 1;
  }
  return src[k] === ":";
};

/** The index just past a comment opening at `start`, or `start` when none opens there. */
const skipComment = (src: string, start: number): number => {
  if (src[start] !== "/") {
    return start;
  }
  if (src[start + 1] === "/") {
    const e = src.indexOf("\n", start);
    return e === -1 ? src.length : e;
  }
  if (src[start + 1] === "*") {
    const e = src.indexOf("*/", start + 2);
    return e === -1 ? src.length : e + 2;
  }
  return start;
};

/** The keys of the outermost object, read by skipping nested values; tolerant of comments and trailing commas. */
const topLevelKeys = (src: string): Set<string> => {
  const keys = new Set<string>();
  let depth = 0;
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '"') {
      const end = skipString(src, i);
      if (depth === 1 && colonFollows(src, end)) {
        keys.add(src.slice(i + 1, end - 1));
      }
      i = end;
      continue;
    }
    const afterComment = skipComment(src, i);
    if (afterComment !== i) {
      i = afterComment;
      continue;
    }
    if (c === "{" || c === "[") {
      depth += 1;
    } else if (c === "}" || c === "]") {
      depth -= 1;
    }
    i += 1;
  }
  return keys;
};

const KIND_BY_BASENAME = new Map<string, LockfileKind>([
  ["package-lock.json", "package-lock"],
  ["npm-shrinkwrap.json", "package-lock"],
  ["yarn.lock", "yarn"],
  ["pnpm-lock.yaml", "pnpm"],
  ["bun.lock", "bun"],
  ["uv.lock", "uv"],
]);

const unsupportedPython = (name: string) =>
  `${name} is not supported; uv.lock is the Python lockfile this tool reads.`;

/** The refusal a file name alone earns, or null when the name does not decide. */
const refusalByName = (base: string): string | null => {
  if (base === "bun.lockb") {
    return BINARY_BUN;
  }
  if (base === "package.json" || base === "pyproject.toml") {
    return declarationRefusal(base);
  }
  if (
    base === "requirements.txt" ||
    /^requirements[-_.\w]*\.txt$/u.test(base)
  ) {
    return declarationRefusal("requirements.txt");
  }
  if (base === "poetry.lock") {
    return unsupportedPython("poetry.lock");
  }
  if (base === "pipfile.lock") {
    return unsupportedPython("Pipfile.lock");
  }
  return null;
};

/** Whether a string holds a character below tab, which text lockfiles never do. */
const hasControlCharacter = (s: string): boolean => {
  for (let k = 0; k < s.length; k += 1) {
    if ((s.codePointAt(k) ?? 0) < 9) {
      return true;
    }
  }
  return false;
};

const detectJson = (t: string): Detected => {
  // Top-level keys decide: bun.lock has "workspaces" beside "lockfileVersion"; package-lock.json has "packages" or "dependencies" there.
  const keys = topLevelKeys(t);
  if (keys.has("lockfileVersion") && keys.has("workspaces")) {
    return { kind: "bun" };
  }
  if (keys.has("lockfileVersion")) {
    return { kind: "package-lock" };
  }
  if (keys.has("dependencies") || keys.has("devDependencies")) {
    return { kind: null, refusal: declarationRefusal("package.json") };
  }
  return {
    kind: null,
    refusal: "This JSON is not a lockfile this tool reads.",
  };
};

const detectText = (t: string): Detected => {
  if (/^lockfileVersion:/mu.test(t)) {
    return { kind: "pnpm" };
  }
  if (/^# yarn lockfile v1/mu.test(t) || /^__metadata:/mu.test(t)) {
    return { kind: "yarn" };
  }
  if (
    /^\[\[package\]\]/mu.test(t) ||
    (/^version = \d/mu.test(t) && /^requires-python = /mu.test(t))
  ) {
    return { kind: "uv" };
  }
  if (
    /^\[project\]/mu.test(t) ||
    /^\[tool\.poetry\]/mu.test(t) ||
    /^\[build-system\]/mu.test(t)
  ) {
    return { kind: null, refusal: declarationRefusal("pyproject.toml") };
  }
  if (/^[A-Za-z0-9][\w.-]*\s*(?:==|>=|<=|~=|!=|>|<)/mu.test(t)) {
    return { kind: null, refusal: declarationRefusal("requirements.txt") };
  }
  return {
    kind: null,
    refusal:
      "Not a lockfile this tool reads. Paste package-lock.json, yarn.lock, pnpm-lock.yaml, bun.lock, or uv.lock.",
  };
};

/** Decides which parser a file gets, from its name when it has one, otherwise from its content. */
export const detectKind = (text: string, filename = ""): Detected => {
  const base = (filename.split("/").pop() ?? "").toLowerCase();
  const kind = KIND_BY_BASENAME.get(base);
  if (kind) {
    return { kind };
  }
  const refusal = refusalByName(base);
  if (refusal !== null) {
    return { kind: null, refusal };
  }
  const t = text.trimStart();
  if (hasControlCharacter(t.slice(0, 64))) {
    return { kind: null, refusal: BINARY_BUN };
  }
  return t.startsWith("{") ? detectJson(t) : detectText(t);
};
