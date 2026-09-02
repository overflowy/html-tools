// yarn.lock, both generations: classic (v1, `key value` fields) and berry
// (v2+, `key: value` fields with a __metadata block). Berry lists each
// workspace as an entry with its dependencies, so it knows which packages are
// direct; classic does not.
import { LockfileError, PackageSet, looksLikeVersion, nonRegistryReason, type ParsedLockfile } from "./lockfiles";

interface Block {
  /** The descriptors this entry satisfies, e.g. `lodash@^4.17.0`, `@babel/core@npm:^7.0.0`. */
  keys: string[];
  fields: Record<string, string>;
  /** Nested `dependencies:` mapping: name to descriptor range. */
  dependencies: Record<string, string>;
}

function unquote(s: string): string {
  s = s.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    try { return JSON.parse(s.startsWith("'") ? '"' + s.slice(1, -1).replace(/"/g, '\\"') + '"' : s); } catch { return s.slice(1, -1); }
  }
  return s;
}

/** Splits a block header (`"a@^1", "a@^2":`) into its descriptors, respecting quotes. */
function splitKeys(header: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote = "";
  for (const c of header) {
    if (quote) {
      if (c === quote) quote = "";
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ",") {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else {
      cur += c;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Splits `name@range` at the `@` that is not a scope marker. */
export function splitDescriptor(desc: string): { name: string; range: string } {
  const at = desc.indexOf("@", 1);
  if (at < 0) return { name: desc, range: "" };
  return { name: desc.slice(0, at), range: desc.slice(at + 1) };
}

export function isBerry(text: string): boolean {
  return /^__metadata:/m.test(text);
}

function parseBlocks(text: string, berry: boolean): Block[] {
  const blocks: Block[] = [];
  let cur: Block | null = null;
  let nested = "";
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const body = line.trim();
    if (indent === 0) {
      if (!body.endsWith(":")) continue;
      cur = { keys: splitKeys(body.slice(0, -1)), fields: {}, dependencies: {} };
      nested = "";
      blocks.push(cur);
      continue;
    }
    if (!cur) continue;
    if (indent === 2) {
      if (body.endsWith(":") && !body.includes(": ")) {
        nested = unquote(body.slice(0, -1));
        continue;
      }
      nested = "";
      const [k, v] = splitField(body, berry);
      cur.fields[k] = v;
      continue;
    }
    if (indent >= 4 && nested === "dependencies") {
      const [k, v] = splitField(body, berry);
      cur.dependencies[k] = v;
    }
  }
  return blocks;
}

function splitField(body: string, berry: boolean): [string, string] {
  if (berry) {
    const m = /^("[^"]*"|'[^']*'|[^:]+):\s*(.*)$/.exec(body);
    if (!m) return [body, ""];
    return [unquote(m[1]!), unquote(m[2]!)];
  }
  const m = /^("[^"]*"|'[^']*'|\S+)\s+(.*)$/.exec(body);
  if (!m) return [body, ""];
  return [unquote(m[1]!), unquote(m[2]!)];
}

export function parseYarnLock(text: string): ParsedLockfile {
  const berry = isBerry(text);
  if (!berry && !/^# yarn lockfile v1/m.test(text)) {
    throw new LockfileError("This yarn.lock has neither the classic \"# yarn lockfile v1\" header nor a berry __metadata block.");
  }
  const blocks = parseBlocks(text, berry).filter((b) => !b.keys.includes("__metadata"));
  const set = new PackageSet("npm");
  const byDescriptor = new Map<string, Block>();
  for (const b of blocks) for (const k of b.keys) byDescriptor.set(k, b);

  if (!berry) {
    for (const b of blocks) {
      const version = b.fields.version ?? "";
      const resolved = b.fields.resolved ?? "";
      for (const key of b.keys) {
        let { name, range } = splitDescriptor(key);
        if (range.startsWith("npm:")) {
          const alias = splitDescriptor(range.slice(4));
          name = alias.name;
          range = alias.range;
        }
        const reason = nonRegistryReason(range) ?? (resolved ? nonRegistryReason(resolved) : looksLikeVersion(version) ? null : "path");
        if (reason) set.skip(name, looksLikeVersion(version) ? version : "", reason, resolved || range);
        else if (looksLikeVersion(version)) set.add(name, version, null);
      }
    }
    return { kind: "yarn", ecosystem: "npm", label: "yarn.lock classic (v1)", packages: set.packages(), notChecked: set.notChecked, knowsDirect: false, knowsGroups: false };
  }

  // Berry: the resolution field names the real package and how it was fetched.
  const directBlocks = new Set<Block>();
  for (const b of blocks) {
    const res = b.fields.resolution ?? b.keys[0] ?? "";
    const { range } = splitDescriptor(res);
    if (!range.startsWith("workspace:")) continue;
    for (const [dep, desc] of Object.entries(b.dependencies)) {
      const target = byDescriptor.get(dep + "@" + desc) ?? byDescriptor.get(dep + "@npm:" + desc);
      if (target) directBlocks.add(target);
    }
  }
  for (const b of blocks) {
    const res = b.fields.resolution ?? b.keys[0] ?? "";
    let { name, range } = splitDescriptor(res);
    const version = b.fields.version ?? "";
    if (range.startsWith("patch:")) {
      // A patched package is still the registry release underneath; OSV knows it by that version.
      const inner = decodeURIComponent(range.slice(6).split("#")[0]!);
      const innerDesc = splitDescriptor(inner);
      name = innerDesc.name;
      range = innerDesc.range;
    }
    if (range.startsWith("npm:")) {
      if (looksLikeVersion(version)) set.add(name, version, directBlocks.has(b));
      continue;
    }
    if (range.startsWith("workspace:")) {
      set.skip(name, version === "0.0.0-use.local" ? "" : version, range === "workspace:." ? "root" : "workspace", range.slice(10));
      continue;
    }
    const reason = nonRegistryReason(range) ?? "url";
    set.skip(name, looksLikeVersion(version) ? version : "", reason, range);
  }
  return { kind: "yarn", ecosystem: "npm", label: "yarn.lock berry", packages: set.packages(), notChecked: set.notChecked, knowsDirect: true, knowsGroups: false };
}
