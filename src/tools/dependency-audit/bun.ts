// bun.lock, the text lockfile Bun 1.2 introduced, lockfileVersion 0 through 2:
// JSON with comments and trailing commas. Each package entry is an array whose
// first element is the resolution, `name@version` for a registry release. The
// root workspace lists its direct dependencies by group.
import {
  LockfileError,
  looksLikeVersion,
  nonRegistryReason,
} from "./lockfiles";
import type { ParsedLockfile } from "./lockfiles";
import { PackageSet } from "./package-set";

type Obj = Record<string, unknown>;

/** JSON with // and /* comments and trailing commas allowed. */
export const parseJsonc = (src: string): unknown => {
  let i = 0;
  const n = src.length;
  const fail: (msg: string) => never = (msg) => {
    throw new LockfileError(`${msg} at offset ${i}`);
  };
  const ws = () => {
    for (;;) {
      while (i < n && /\s/u.test(src[i])) {
        i += 1;
      }
      if (src[i] === "/" && src[i + 1] === "/") {
        while (i < n && src[i] !== "\n") {
          i += 1;
        }
        continue;
      }
      if (src[i] === "/" && src[i + 1] === "*") {
        const end = src.indexOf("*/", i + 2);
        if (end === -1) {
          fail("Unterminated comment");
        }
        i = end + 2;
        continue;
      }
      return;
    }
  };
  const str = (): string => {
    let j = i + 1;
    while (j < n && src[j] !== '"') {
      if (src[j] === "\\") {
        j += 1;
      }
      j += 1;
    }
    if (j >= n) {
      fail("Unterminated string");
    }
    const raw = src.slice(i, j + 1);
    i = j + 1;
    return JSON.parse(raw);
  };
  const value = (): unknown => {
    ws();
    const c = src[i];
    if (c === "{") {
      i += 1;
      const out: Obj = {};
      for (;;) {
        ws();
        if (src[i] === "}") {
          i += 1;
          return out;
        }
        if (src[i] !== '"') {
          fail("Expected a key");
        }
        const k = str();
        ws();
        if (src[i] !== ":") {
          fail("Expected ':'");
        }
        i += 1;
        out[k] = value();
        ws();
        if (src[i] === ",") {
          i += 1;
          continue;
        }
        if (src[i] === "}") {
          i += 1;
          return out;
        }
        fail("Expected ',' or '}'");
      }
    }
    if (c === "[") {
      i += 1;
      const out: unknown[] = [];
      for (;;) {
        ws();
        if (src[i] === "]") {
          i += 1;
          return out;
        }
        out.push(value());
        ws();
        if (src[i] === ",") {
          i += 1;
          continue;
        }
        if (src[i] === "]") {
          i += 1;
          return out;
        }
        fail("Expected ',' or ']'");
      }
    }
    if (c === '"') {
      return str();
    }
    const m = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/u.exec(
      src.slice(i, i + 64)
    );
    if (!m) {
      return fail(
        `Unexpected character ${JSON.stringify(c ?? "end of input")}`
      );
    }
    i += m[0].length;
    return JSON.parse(m[0]);
  };
  const v = value();
  ws();
  if (i < n) {
    fail("Unexpected content after the document");
  }
  return v;
};

const ROOT_GROUPS: [string, string[]][] = [
  ["dependencies", []],
  ["devDependencies", ["dev"]],
  ["optionalDependencies", ["optional"]],
  ["peerDependencies", ["peer"]],
];

/** The lockfileVersion, when it is one this reader knows. */
const supportedVersion = (lock: Obj): number => {
  // v2 (Bun 1.4) only tightened what Bun accepts at parse time; the shape is that of v0 and v1.
  const version = Number(lock.lockfileVersion);
  if (![0, 1, 2].includes(version)) {
    throw new LockfileError(
      `bun.lock lockfileVersion ${String(
        lock.lockfileVersion
      )} is not supported; 0, 1, and 2 are.`
    );
  }
  return version;
};

/** Lists every workspace as Not Checked and returns the root's direct dependencies with their Groups. */
const readWorkspaces = (
  workspaces: Record<string, Obj>,
  set: PackageSet
): Map<string, string[]> => {
  const directGroups = new Map<string, string[]>();
  for (const [path, ws] of Object.entries(workspaces)) {
    const name = typeof ws?.name === "string" ? ws.name : path;
    set.skip(
      name,
      typeof ws?.version === "string" ? ws.version : "",
      path === "" ? "root" : "workspace",
      path
    );
    if (path !== "") {
      continue;
    }
    for (const [field, groups] of ROOT_GROUPS) {
      const deps = ws[field];
      if (deps && typeof deps === "object") {
        for (const dep of Object.keys(deps as Obj)) {
          directGroups.set(dep, [...(directGroups.get(dep) ?? []), ...groups]);
        }
      }
    }
  }
  return directGroups;
};

export const parseBunLock = (text: string): ParsedLockfile => {
  const doc = parseJsonc(text);
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new LockfileError("bun.lock must be a JSON object.");
  }
  const lock = doc as Obj;
  const version = supportedVersion(lock);
  const set = new PackageSet("npm");

  const workspaces = (lock.workspaces ?? {}) as Record<string, Obj>;
  const directGroups = readWorkspaces(workspaces, set);

  const packages = (lock.packages ?? {}) as Record<string, unknown[]>;
  for (const [key, entry] of Object.entries(packages)) {
    const res = Array.isArray(entry) ? entry[0] : undefined;
    if (typeof res !== "string") {
      continue;
    }
    const at = res.indexOf("@", 1);
    const name = at > 0 ? res.slice(0, at) : res;
    const spec = at > 0 ? res.slice(at + 1) : "";
    const reason =
      nonRegistryReason(spec) ?? (looksLikeVersion(spec) ? null : "url");
    if (reason) {
      if (reason === "workspace" && workspaces[spec.slice(10)]) {
        // Already listed from the workspaces map.
        continue;
      }
      set.skip(name, "", reason, spec);
      continue;
    }
    // Only a top-level key (no "parent/" prefix) can be one of the root's own dependencies.
    const groups =
      !key.includes("/") || key === name ? directGroups.get(key) : undefined;
    set.add(name, spec, groups !== undefined, groups ?? []);
  }
  return {
    ecosystem: "npm",
    kind: "bun",
    knowsDirect: true,
    knowsGroups: true,
    label: `bun.lock v${version}`,
    notChecked: set.notChecked,
    packages: set.packages(),
  };
};
