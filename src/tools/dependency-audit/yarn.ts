// yarn.lock, both generations: classic (v1, `key value` fields) and berry
// (v2+, `key: value` fields with a __metadata block). Berry lists each
// workspace as an entry with its dependencies, so it knows which packages are
// direct; classic does not.
import {
  LockfileError,
  looksLikeVersion,
  nonRegistryReason,
} from "./lockfiles";
import type { ParsedLockfile } from "./lockfiles";
import { PackageSet } from "./package-set";

interface Block {
  /** The descriptors this entry satisfies, e.g. `lodash@^4.17.0`, `@babel/core@npm:^7.0.0`. */
  keys: string[];
  fields: Record<string, string>;
  /** Nested `dependencies:` mapping: name to descriptor range. */
  dependencies: Record<string, string>;
}

const unquote = (raw: string): string => {
  const s = raw.trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    try {
      return JSON.parse(
        s.startsWith("'") ? `"${s.slice(1, -1).replaceAll('"', '\\"')}"` : s
      );
    } catch {
      return s.slice(1, -1);
    }
  }
  return s;
};

/** Splits a block header (`"a@^1", "a@^2":`) into its descriptors, respecting quotes. */
const splitKeys = (header: string): string[] => {
  const out: string[] = [];
  let cur = "";
  let quote = "";
  for (const c of header) {
    if (quote) {
      if (c === quote) {
        quote = "";
      } else {
        cur += c;
      }
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ",") {
      if (cur.trim()) {
        out.push(cur.trim());
      }
      cur = "";
    } else {
      cur += c;
    }
  }
  if (cur.trim()) {
    out.push(cur.trim());
  }
  return out;
};

/** Splits `name@range` at the `@` that is not a scope marker. */
export const splitDescriptor = (
  desc: string
): { name: string; range: string } => {
  const at = desc.indexOf("@", 1);
  if (at === -1) {
    return { name: desc, range: "" };
  }
  return { name: desc.slice(0, at), range: desc.slice(at + 1) };
};

export const isBerry = (text: string): boolean => /^__metadata:/mu.test(text);

const BERRY_FIELD = /^(?<key>"[^"]*"|'[^']*'|[^:]+):\s*(?<value>.*)$/u;
const CLASSIC_FIELD = /^(?<key>"[^"]*"|'[^']*'|\S+)\s+(?<value>.*)$/u;

const splitField = (body: string, berry: boolean): [string, string] => {
  const groups = (berry ? BERRY_FIELD : CLASSIC_FIELD).exec(body)?.groups;
  if (!groups) {
    return [body, ""];
  }
  return [unquote(groups.key), unquote(groups.value)];
};

const parseBlocks = (text: string, berry: boolean): Block[] => {
  const blocks: Block[] = [];
  let cur: Block | null = null;
  let nested = "";
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/u, "");
    if (!line.trim() || line.trimStart().startsWith("#")) {
      continue;
    }
    const indent = line.length - line.trimStart().length;
    const body = line.trim();
    if (indent === 0) {
      if (!body.endsWith(":")) {
        continue;
      }
      cur = {
        dependencies: {},
        fields: {},
        keys: splitKeys(body.slice(0, -1)),
      };
      nested = "";
      blocks.push(cur);
      continue;
    }
    if (!cur) {
      continue;
    }
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
};

/** Why a classic entry is not a registry release, from its range, its resolved URL, or a missing version. */
const classicReason = (range: string, resolved: string, version: string) => {
  const fromRange = nonRegistryReason(range);
  if (fromRange) {
    return fromRange;
  }
  if (resolved) {
    return nonRegistryReason(resolved);
  }
  return looksLikeVersion(version) ? null : "path";
};

const parseClassic = (blocks: Block[], set: PackageSet): ParsedLockfile => {
  for (const b of blocks) {
    const version = b.fields.version ?? "";
    const resolved = b.fields.resolved ?? "";
    for (const key of b.keys) {
      let { name, range } = splitDescriptor(key);
      if (range.startsWith("npm:")) {
        ({ name, range } = splitDescriptor(range.slice(4)));
      }
      const reason = classicReason(range, resolved, version);
      if (reason) {
        set.skip(
          name,
          looksLikeVersion(version) ? version : "",
          reason,
          resolved || range
        );
      } else if (looksLikeVersion(version)) {
        set.add(name, version, null);
      }
    }
  }
  return {
    ecosystem: "npm",
    kind: "yarn",
    knowsDirect: false,
    knowsGroups: false,
    label: "yarn.lock classic (v1)",
    notChecked: set.notChecked,
    packages: set.packages(),
  };
};

/** The blocks some workspace depends on directly. */
const directBerryBlocks = (blocks: Block[]): Set<Block> => {
  const byDescriptor = new Map<string, Block>();
  for (const b of blocks) {
    for (const k of b.keys) {
      byDescriptor.set(k, b);
    }
  }
  const directBlocks = new Set<Block>();
  for (const b of blocks) {
    const res = b.fields.resolution ?? b.keys[0] ?? "";
    const { range } = splitDescriptor(res);
    if (!range.startsWith("workspace:")) {
      continue;
    }
    for (const [dep, desc] of Object.entries(b.dependencies)) {
      const target =
        byDescriptor.get(`${dep}@${desc}`) ??
        byDescriptor.get(`${dep}@npm:${desc}`);
      if (target) {
        directBlocks.add(target);
      }
    }
  }
  return directBlocks;
};

const parseBerry = (blocks: Block[], set: PackageSet): ParsedLockfile => {
  // Berry: the resolution field names the real package and how it was fetched.
  const directBlocks = directBerryBlocks(blocks);
  for (const b of blocks) {
    const res = b.fields.resolution ?? b.keys[0] ?? "";
    let { name, range } = splitDescriptor(res);
    const version = b.fields.version ?? "";
    if (range.startsWith("patch:")) {
      // A patched package is still the registry release underneath; OSV knows it by that version.
      const [inner] = range.slice(6).split("#");
      ({ name, range } = splitDescriptor(decodeURIComponent(inner)));
    }
    if (range.startsWith("npm:")) {
      if (looksLikeVersion(version)) {
        set.add(name, version, directBlocks.has(b));
      }
      continue;
    }
    if (range.startsWith("workspace:")) {
      set.skip(
        name,
        version === "0.0.0-use.local" ? "" : version,
        range === "workspace:." ? "root" : "workspace",
        range.slice(10)
      );
      continue;
    }
    const reason = nonRegistryReason(range) ?? "url";
    set.skip(name, looksLikeVersion(version) ? version : "", reason, range);
  }
  return {
    ecosystem: "npm",
    kind: "yarn",
    knowsDirect: true,
    knowsGroups: false,
    label: "yarn.lock berry",
    notChecked: set.notChecked,
    packages: set.packages(),
  };
};

export const parseYarnLock = (text: string): ParsedLockfile => {
  const berry = isBerry(text);
  if (!berry && !/^# yarn lockfile v1/mu.test(text)) {
    throw new LockfileError(
      'This yarn.lock has neither the classic "# yarn lockfile v1" header nor a berry __metadata block.'
    );
  }
  const blocks = parseBlocks(text, berry).filter(
    (b) => !b.keys.includes("__metadata")
  );
  const set = new PackageSet("npm");
  return berry ? parseBerry(blocks, set) : parseClassic(blocks, set);
};
