// package-lock.json (and npm-shrinkwrap.json): lockfileVersion 1, 2, and 3.
// v2 carries both the v3 "packages" map and the v1 "dependencies" tree; the
// map is read and the tree ignored, since only the map names the root's
// direct dependencies.
import {
  LockfileError,
  looksLikeVersion,
  nonRegistryReason,
} from "./lockfiles";
import type { ParsedLockfile } from "./lockfiles";
import { PackageSet } from "./package-set";

type Obj = Record<string, unknown>;

interface Entry {
  name?: string;
  version?: string;
  resolved?: string;
  link?: boolean;
  dev?: boolean;
  optional?: boolean;
  devOptional?: boolean;
  peer?: boolean;
  dependencies?: Record<string, Entry>;
}

const ROOT_GROUPS: [string, string[]][] = [
  ["dependencies", []],
  ["devDependencies", ["dev"]],
  ["optionalDependencies", ["optional"]],
  ["peerDependencies", ["peer"]],
];

const NODE_MODULES = "node_modules/";

const flagGroups = (e: Entry): string[] => {
  const g: string[] = [];
  if (e.dev || e.devOptional) {
    g.push("dev");
  }
  if (e.optional || e.devOptional) {
    g.push("optional");
  }
  if (e.peer) {
    g.push("peer");
  }
  return g;
};

/** The package name a "node_modules/…" path ends in, scope included. */
export const nameFromPath = (path: string): string => {
  const at = path.lastIndexOf(NODE_MODULES);
  const tail = at === -1 ? path : path.slice(at + NODE_MODULES.length);
  return tail.replace(/\/$/u, "");
};

const supportedVersion = (lock: Obj): number => {
  const version =
    typeof lock.lockfileVersion === "number"
      ? lock.lockfileVersion
      : Number(lock.lockfileVersion);
  if (![1, 2, 3].includes(version)) {
    throw new LockfileError(
      `package-lock.json lockfileVersion ${String(
        lock.lockfileVersion
      )} is not supported; 1, 2, and 3 are.`
    );
  }
  return version;
};

/** v1: only the nested "dependencies" tree, which does not say what is direct. */
const parseV1 = (lock: Obj, label: string): ParsedLockfile => {
  const set = new PackageSet("npm");
  const walk = (deps: Record<string, Entry> | undefined) => {
    if (!deps) {
      return;
    }
    for (const [name, e] of Object.entries(deps)) {
      const v = e.version ?? "";
      const reason =
        nonRegistryReason(v) ??
        (e.resolved ? nonRegistryReason(e.resolved) : null);
      if (reason) {
        set.skip(name, looksLikeVersion(v) ? v : "", reason, e.resolved ?? v);
      } else if (looksLikeVersion(v)) {
        set.add(name, v, null, flagGroups(e));
      }
      walk(e.dependencies);
    }
  };
  walk(lock.dependencies as Record<string, Entry> | undefined);
  return {
    ecosystem: "npm",
    kind: "package-lock",
    knowsDirect: false,
    knowsGroups: true,
    label,
    notChecked: set.notChecked,
    packages: set.packages(),
  };
};

/** The root's direct dependencies, each with the Groups its declaring fields give it. */
const rootDirectGroups = (root: Entry): Map<string, string[]> => {
  const directGroups = new Map<string, string[]>();
  for (const [field, groups] of ROOT_GROUPS) {
    const deps = (root as unknown as Obj)[field];
    if (deps && typeof deps === "object") {
      for (const name of Object.keys(deps as Obj)) {
        directGroups.set(name, [...(directGroups.get(name) ?? []), ...groups]);
      }
    }
  }
  return directGroups;
};

/** One "packages" entry other than the root, added or skipped. */
const addEntry = (
  set: PackageSet,
  path: string,
  e: Entry,
  directGroups: Map<string, string[]> | null
) => {
  if (!path.includes(NODE_MODULES)) {
    set.skip(e.name ?? path, e.version ?? "", "workspace", path);
    return;
  }
  const name = e.name ?? nameFromPath(path);
  const v = e.version ?? "";
  const reason =
    (e.resolved ? nonRegistryReason(e.resolved) : null) ??
    (looksLikeVersion(v) ? null : (nonRegistryReason(v) ?? "url"));
  if (reason) {
    set.skip(name, looksLikeVersion(v) ? v : "", reason, e.resolved ?? v);
    return;
  }
  const topLevel = path === `${NODE_MODULES}${nameFromPath(path)}`;
  const rootGroups = topLevel
    ? directGroups?.get(nameFromPath(path))
    : undefined;
  set.add(
    name,
    v,
    directGroups ? rootGroups !== undefined : null,
    rootGroups ?? flagGroups(e)
  );
};

export const parsePackageLock = (doc: unknown): ParsedLockfile => {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new LockfileError("package-lock.json must be a JSON object.");
  }
  const lock = doc as Obj;
  const version = supportedVersion(lock);
  const label = `package-lock.json v${version}`;
  if (version === 1) {
    return parseV1(lock, label);
  }

  const packages = lock.packages as Record<string, Entry> | undefined;
  if (!packages || typeof packages !== "object") {
    throw new LockfileError(
      `package-lock.json v${version} has no "packages" map.`
    );
  }
  const set = new PackageSet("npm");
  const root = packages[""];
  // Null when there is no root entry, and so no telling what is direct.
  const directGroups = root ? rootDirectGroups(root) : null;
  if (root && typeof root.name === "string") {
    set.skip(root.name, root.version ?? "", "root", "");
  }

  for (const [path, e] of Object.entries(packages)) {
    if (path === "" || !e || typeof e !== "object") {
      continue;
    }
    if (e.link) {
      // A symlink to a workspace package listed under its own path.
      continue;
    }
    addEntry(set, path, e, directGroups);
  }
  return {
    ecosystem: "npm",
    kind: "package-lock",
    knowsDirect: root !== undefined,
    knowsGroups: true,
    label,
    notChecked: set.notChecked,
    packages: set.packages(),
  };
};
