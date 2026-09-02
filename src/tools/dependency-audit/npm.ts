// package-lock.json (and npm-shrinkwrap.json): lockfileVersion 1, 2, and 3.
// v2 carries both the v3 "packages" map and the v1 "dependencies" tree; the
// map is read and the tree ignored, since only the map names the root's
// direct dependencies.
import { LockfileError, PackageSet, looksLikeVersion, nonRegistryReason, type ParsedLockfile } from "./lockfiles";

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

function flagGroups(e: Entry): string[] {
  const g: string[] = [];
  if (e.dev || e.devOptional) g.push("dev");
  if (e.optional || e.devOptional) g.push("optional");
  if (e.peer) g.push("peer");
  return g;
}

/** The package name a "node_modules/…" path ends in, scope included. */
export function nameFromPath(path: string): string {
  const parts = path.split("node_modules/");
  return parts[parts.length - 1]!.replace(/\/$/, "");
}

export function parsePackageLock(doc: unknown): ParsedLockfile {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) throw new LockfileError("package-lock.json must be a JSON object.");
  const lock = doc as Obj;
  const version = typeof lock.lockfileVersion === "number" ? lock.lockfileVersion : Number(lock.lockfileVersion);
  if (![1, 2, 3].includes(version)) {
    throw new LockfileError("package-lock.json lockfileVersion " + String(lock.lockfileVersion) + " is not supported; 1, 2, and 3 are.");
  }
  const set = new PackageSet("npm");
  const label = "package-lock.json v" + version;

  if (version === 1) {
    const walk = (deps: Record<string, Entry> | undefined) => {
      if (!deps) return;
      for (const [name, e] of Object.entries(deps)) {
        const v = e.version ?? "";
        const reason = nonRegistryReason(v) ?? (e.resolved ? nonRegistryReason(e.resolved) : null);
        if (reason) set.skip(name, looksLikeVersion(v) ? v : "", reason, e.resolved ?? v);
        else if (looksLikeVersion(v)) set.add(name, v, null, flagGroups(e));
        walk(e.dependencies);
      }
    };
    walk(lock.dependencies as Record<string, Entry> | undefined);
    return { kind: "package-lock", ecosystem: "npm", label, packages: set.packages(), notChecked: set.notChecked, knowsDirect: false, knowsGroups: true };
  }

  const packages = lock.packages as Record<string, Entry> | undefined;
  if (!packages || typeof packages !== "object") throw new LockfileError("package-lock.json v" + version + " has no \"packages\" map.");
  const root = packages[""];
  const directGroups = new Map<string, string[]>();
  if (root) {
    for (const [field, groups] of ROOT_GROUPS) {
      const deps = (root as unknown as Obj)[field];
      if (deps && typeof deps === "object") {
        for (const name of Object.keys(deps as Obj)) directGroups.set(name, [...(directGroups.get(name) ?? []), ...groups]);
      }
    }
    if (typeof root.name === "string") set.skip(root.name, root.version ?? "", "root", "");
  }

  for (const [path, e] of Object.entries(packages)) {
    if (path === "" || !e || typeof e !== "object") continue;
    if (e.link) continue; // a symlink to a workspace package listed under its own path
    if (!path.includes("node_modules/")) {
      set.skip(e.name ?? path, e.version ?? "", "workspace", path);
      continue;
    }
    const name = e.name ?? nameFromPath(path);
    const v = e.version ?? "";
    const reason = (e.resolved ? nonRegistryReason(e.resolved) : null) ?? (looksLikeVersion(v) ? null : nonRegistryReason(v) ?? "url");
    if (reason) {
      set.skip(name, looksLikeVersion(v) ? v : "", reason, e.resolved ?? v);
      continue;
    }
    const topLevel = path === "node_modules/" + nameFromPath(path);
    const direct = topLevel && directGroups.has(nameFromPath(path));
    const groups = direct ? directGroups.get(nameFromPath(path))! : flagGroups(e);
    set.add(name, v, root ? direct : null, groups);
  }
  return {
    kind: "package-lock", ecosystem: "npm", label, packages: set.packages(), notChecked: set.notChecked,
    knowsDirect: root !== undefined, knowsGroups: true,
  };
}
