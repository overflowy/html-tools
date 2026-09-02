// pnpm-lock.yaml, lockfileVersion 6 (pnpm 8) and 9 (pnpm 9 and 10). Both list
// the project's direct dependencies per importer, split by group; v6 also
// flags every package dev/optional, v9 no longer does.
import { LockfileError, PackageSet, looksLikeVersion, nonRegistryReason, type NotCheckedReason, type ParsedLockfile } from "./lockfiles";

type Obj = Record<string, unknown>;

const IMPORTER_GROUPS: [string, string[]][] = [
  ["dependencies", []],
  ["devDependencies", ["dev"]],
  ["optionalDependencies", ["optional"]],
];

/** Strips the peer-dependency suffix pnpm appends to a resolved version: `1.2.3(react@18.2.0)` to `1.2.3`. */
export function stripPeers(v: string): string {
  const i = v.indexOf("(");
  return i < 0 ? v : v.slice(0, i);
}

/** Splits a packages key (`/name@1.0.0(peer)` in v6, `name@1.0.0` in v9) into name and version. */
export function splitPackageKey(key: string): { name: string; version: string } {
  let k = key.startsWith("/") ? key.slice(1) : key;
  k = stripPeers(k);
  const at = k.indexOf("@", 1);
  if (at < 0) return { name: k, version: "" };
  return { name: k.slice(0, at), version: k.slice(at + 1) };
}

function majorOf(v: unknown): number {
  return parseInt(String(v), 10);
}

function resolutionReason(res: Obj | undefined): NotCheckedReason | null {
  if (!res) return null;
  if (res.type === "git" || typeof res.repo === "string") return "git";
  if (typeof res.directory === "string" || res.type === "directory") return "path";
  if (typeof res.tarball === "string") return String(res.tarball).includes("/-/") ? null : nonRegistryReason(String(res.tarball)) ?? "url";
  return null;
}

export function parsePnpmLock(doc: unknown): ParsedLockfile {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) throw new LockfileError("pnpm-lock.yaml must be a YAML mapping.");
  const lock = doc as Obj;
  const major = majorOf(lock.lockfileVersion);
  if (major !== 6 && major !== 9) {
    throw new LockfileError("pnpm-lock.yaml lockfileVersion " + String(lock.lockfileVersion ?? "missing") + " is not supported; 6 (pnpm 8) and 9 (pnpm 9+) are.");
  }
  const set = new PackageSet("npm");

  // Every listed package first, so importer entries can be matched to them.
  const packages = (lock.packages ?? {}) as Record<string, Obj>;
  for (const [key, entry] of Object.entries(packages)) {
    const e = entry ?? {};
    const fromKey = splitPackageKey(key);
    const name = typeof e.name === "string" ? e.name : fromKey.name;
    const version = typeof e.version === "string" ? e.version : fromKey.version;
    const reason = nonRegistryReason(key.startsWith("/") ? key.slice(1) : key) ?? resolutionReason(e.resolution as Obj | undefined) ??
      nonRegistryReason(version) ?? (looksLikeVersion(version) ? null : "url");
    if (reason) {
      set.skip(name, looksLikeVersion(version) ? version : "", reason, key.startsWith("/") ? key.slice(1) : key);
      continue;
    }
    const groups: string[] = [];
    if (e.dev === true) groups.push("dev");
    if (e.optional === true) groups.push("optional");
    set.add(name, version, false, groups);
  }

  // Importers: the project and each workspace package, with their direct dependencies by group.
  let importers = lock.importers as Record<string, Obj> | undefined;
  if (!importers) {
    const single: Obj = {};
    for (const [field] of IMPORTER_GROUPS) if (lock[field]) single[field] = lock[field];
    importers = { ".": single };
  }
  for (const [path, importer] of Object.entries(importers)) {
    if (path !== ".") set.skip(path.split("/").pop() || path, "", "workspace", path);
    for (const [field, groups] of IMPORTER_GROUPS) {
      const deps = importer?.[field] as Record<string, unknown> | undefined;
      if (!deps || typeof deps !== "object") continue;
      for (const [name, spec] of Object.entries(deps)) {
        const s = spec as Obj | string;
        const resolved = typeof s === "string" ? s : String(s.version ?? "");
        const specifier = typeof s === "string" ? "" : String(s.specifier ?? "");
        // An alias (`specifier: npm:real@^1`) resolves to `real@1.2.3` (v6: `/real@1.2.3`) in the version field.
        const rawVersion = resolved.startsWith("/") ? resolved.slice(1) : resolved;
        if (rawVersion.startsWith("link:")) {
          set.skip(name, "", specifier.startsWith("workspace:") ? "workspace" : "path", rawVersion);
          continue;
        }
        const reason = nonRegistryReason(rawVersion);
        if (reason) {
          if (!set.hasSkipped(name)) set.skip(name, "", reason, rawVersion); // the packages map usually listed it already, with its version
          continue;
        }
        const v = stripPeers(rawVersion);
        const at = v.indexOf("@", 1);
        const realName = at > 0 ? v.slice(0, at) : name;
        const realVersion = at > 0 ? v.slice(at + 1) : v;
        if (!looksLikeVersion(realVersion)) continue;
        set.add(realName, realVersion, true, groups);
      }
    }
  }
  return {
    kind: "pnpm", ecosystem: "npm", label: "pnpm-lock.yaml v" + String(lock.lockfileVersion), packages: set.packages(), notChecked: set.notChecked,
    knowsDirect: true, knowsGroups: true,
  };
}
