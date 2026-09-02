// bun.lock, the text lockfile Bun 1.2 introduced, lockfileVersion 0 through 2:
// JSON with comments and trailing commas. Each package entry is an array whose
// first element is the resolution, `name@version` for a registry release. The
// root workspace lists its direct dependencies by group.
import { LockfileError, PackageSet, looksLikeVersion, nonRegistryReason, type ParsedLockfile } from "./lockfiles";

type Obj = Record<string, unknown>;

/** JSON with // and /* comments and trailing commas allowed. */
export function parseJsonc(src: string): unknown {
  let i = 0;
  const n = src.length;
  function fail(msg: string): never {
    throw new LockfileError(msg + " at offset " + i);
  }
  function ws() {
    for (;;) {
      while (i < n && /\s/.test(src[i]!)) i++;
      if (src[i] === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
      if (src[i] === "/" && src[i + 1] === "*") {
        const end = src.indexOf("*/", i + 2);
        if (end < 0) fail("Unterminated comment");
        i = end + 2;
        continue;
      }
      return;
    }
  }
  function value(): unknown {
    ws();
    const c = src[i];
    if (c === "{") {
      i++;
      const out: Obj = {};
      for (;;) {
        ws();
        if (src[i] === "}") { i++; return out; }
        if (src[i] !== '"') fail("Expected a key");
        const k = str();
        ws();
        if (src[i] !== ":") fail("Expected ':'");
        i++;
        out[k] = value();
        ws();
        if (src[i] === ",") { i++; continue; }
        if (src[i] === "}") { i++; return out; }
        fail("Expected ',' or '}'");
      }
    }
    if (c === "[") {
      i++;
      const out: unknown[] = [];
      for (;;) {
        ws();
        if (src[i] === "]") { i++; return out; }
        out.push(value());
        ws();
        if (src[i] === ",") { i++; continue; }
        if (src[i] === "]") { i++; return out; }
        fail("Expected ',' or ']'");
      }
    }
    if (c === '"') return str();
    const m = /^(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(src.slice(i, i + 64));
    if (!m) fail("Unexpected character " + JSON.stringify(c ?? "end of input"));
    i += m[0].length;
    return JSON.parse(m[0]);
  }
  function str(): string {
    let j = i + 1;
    while (j < n && src[j] !== '"') { if (src[j] === "\\") j++; j++; }
    if (j >= n) fail("Unterminated string");
    const raw = src.slice(i, j + 1);
    i = j + 1;
    return JSON.parse(raw);
  }
  const v = value();
  ws();
  if (i < n) fail("Unexpected content after the document");
  return v;
}

const ROOT_GROUPS: [string, string[]][] = [
  ["dependencies", []],
  ["devDependencies", ["dev"]],
  ["optionalDependencies", ["optional"]],
  ["peerDependencies", ["peer"]],
];

export function parseBunLock(text: string): ParsedLockfile {
  const doc = parseJsonc(text);
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) throw new LockfileError("bun.lock must be a JSON object.");
  const lock = doc as Obj;
  // v2 (Bun 1.4) only tightened what Bun accepts at parse time; the shape is that of v0 and v1.
  const version = Number(lock.lockfileVersion);
  if (![0, 1, 2].includes(version)) throw new LockfileError("bun.lock lockfileVersion " + String(lock.lockfileVersion) + " is not supported; 0, 1, and 2 are.");
  const set = new PackageSet("npm");

  const workspaces = (lock.workspaces ?? {}) as Record<string, Obj>;
  const directGroups = new Map<string, string[]>();
  for (const [path, ws] of Object.entries(workspaces)) {
    const name = typeof ws?.name === "string" ? ws.name : path;
    set.skip(name, typeof ws?.version === "string" ? ws.version : "", path === "" ? "root" : "workspace", path);
    if (path !== "") continue;
    for (const [field, groups] of ROOT_GROUPS) {
      const deps = ws[field];
      if (deps && typeof deps === "object") {
        for (const dep of Object.keys(deps as Obj)) directGroups.set(dep, [...(directGroups.get(dep) ?? []), ...groups]);
      }
    }
  }

  const packages = (lock.packages ?? {}) as Record<string, unknown[]>;
  for (const [key, entry] of Object.entries(packages)) {
    const res = Array.isArray(entry) ? entry[0] : undefined;
    if (typeof res !== "string") continue;
    const at = res.indexOf("@", 1);
    const name = at > 0 ? res.slice(0, at) : res;
    const spec = at > 0 ? res.slice(at + 1) : "";
    const reason = nonRegistryReason(spec) ?? (looksLikeVersion(spec) ? null : "url");
    if (reason) {
      if (reason === "workspace" && workspaces[spec.slice(10)]) continue; // already listed from the workspaces map
      set.skip(name, "", reason, spec);
      continue;
    }
    // Only a top-level key (no "parent/" prefix) can be one of the root's own dependencies.
    const direct = !key.includes("/") || key === name ? directGroups.has(key) : false;
    set.add(name, spec, direct, direct ? directGroups.get(key)! : []);
  }
  return {
    kind: "bun", ecosystem: "npm", label: "bun.lock v" + version, packages: set.packages(), notChecked: set.notChecked,
    knowsDirect: true, knowsGroups: true,
  };
}
