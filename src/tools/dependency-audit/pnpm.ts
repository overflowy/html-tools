// pnpm-lock.yaml, lockfileVersion 6 (pnpm 8) and 9 (pnpm 9 and 10). Both list
// the project's direct dependencies per importer, split by group; v6 also
// flags every package dev/optional, v9 no longer does.
import {
  LockfileError,
  looksLikeVersion,
  nonRegistryReason,
} from "./lockfiles";
import type { NotCheckedReason, ParsedLockfile } from "./lockfiles";
import { PackageSet } from "./package-set";

type Obj = Record<string, unknown>;

const IMPORTER_GROUPS: [string, string[]][] = [
  ["dependencies", []],
  ["devDependencies", ["dev"]],
  ["optionalDependencies", ["optional"]],
];

/** Strips the peer-dependency suffix pnpm appends to a resolved version: `1.2.3(react@18.2.0)` to `1.2.3`. */
export const stripPeers = (v: string): string => {
  const i = v.indexOf("(");
  return i === -1 ? v : v.slice(0, i);
};

/** Splits a packages key (`/name@1.0.0(peer)` in v6, `name@1.0.0` in v9) into name and version. */
export const splitPackageKey = (
  key: string
): {
  name: string;
  version: string;
} => {
  let k = key.startsWith("/") ? key.slice(1) : key;
  k = stripPeers(k);
  const at = k.indexOf("@", 1);
  if (at === -1) {
    return { name: k, version: "" };
  }
  return { name: k.slice(0, at), version: k.slice(at + 1) };
};

/** The leading integer of a lockfileVersion such as "9.0" or 6.1, read the way parseInt reads it; NaN when there is none. */
const majorOf = (v: unknown): number => {
  const digits = /^\s*[+-]?\d+/u.exec(String(v))?.[0];
  return digits === undefined ? Number.NaN : Number(digits);
};

const resolutionReason = (res: Obj | undefined): NotCheckedReason | null => {
  if (!res) {
    return null;
  }
  if (res.type === "git" || typeof res.repo === "string") {
    return "git";
  }
  if (typeof res.directory === "string" || res.type === "directory") {
    return "path";
  }
  if (typeof res.tarball === "string") {
    return String(res.tarball).includes("/-/")
      ? null
      : (nonRegistryReason(String(res.tarball)) ?? "url");
  }
  return null;
};

/** Every listed package, added as transitive or skipped, so importer entries can be matched to them. */
const addPackages = (packages: Record<string, Obj>, set: PackageSet) => {
  for (const [key, entry] of Object.entries(packages)) {
    const e = entry ?? {};
    const fromKey = splitPackageKey(key);
    const name = typeof e.name === "string" ? e.name : fromKey.name;
    const version = typeof e.version === "string" ? e.version : fromKey.version;
    const reason =
      nonRegistryReason(key.startsWith("/") ? key.slice(1) : key) ??
      resolutionReason(e.resolution as Obj | undefined) ??
      nonRegistryReason(version) ??
      (looksLikeVersion(version) ? null : "url");
    if (reason) {
      set.skip(
        name,
        looksLikeVersion(version) ? version : "",
        reason,
        key.startsWith("/") ? key.slice(1) : key
      );
      continue;
    }
    const groups: string[] = [];
    if (e.dev === true) {
      groups.push("dev");
    }
    if (e.optional === true) {
      groups.push("optional");
    }
    set.add(name, version, false, groups);
  }
};

/** The importers map, or for a single-project lockfile without one, the root's fields as the "." importer. */
const importersOf = (lock: Obj): Record<string, Obj> => {
  const importers = lock.importers as Record<string, Obj> | undefined;
  if (importers) {
    return importers;
  }
  const single: Obj = {};
  for (const [field] of IMPORTER_GROUPS) {
    if (lock[field]) {
      single[field] = lock[field];
    }
  }
  return { ".": single };
};

/** One direct dependency of an importer, added as Direct in `groups` or skipped. */
const addDirect = (
  set: PackageSet,
  name: string,
  spec: unknown,
  groups: string[]
) => {
  const s = spec as Obj | string;
  const resolved = typeof s === "string" ? s : String(s.version ?? "");
  const specifier = typeof s === "string" ? "" : String(s.specifier ?? "");
  // An alias (`specifier: npm:real@^1`) resolves to `real@1.2.3` (v6: `/real@1.2.3`) in the version field.
  const rawVersion = resolved.startsWith("/") ? resolved.slice(1) : resolved;
  if (rawVersion.startsWith("link:")) {
    set.skip(
      name,
      "",
      specifier.startsWith("workspace:") ? "workspace" : "path",
      rawVersion
    );
    return;
  }
  const reason = nonRegistryReason(rawVersion);
  if (reason) {
    // The packages map usually listed it already, with its version.
    if (!set.hasSkipped(name)) {
      set.skip(name, "", reason, rawVersion);
    }
    return;
  }
  const v = stripPeers(rawVersion);
  const at = v.indexOf("@", 1);
  const realName = at > 0 ? v.slice(0, at) : name;
  const realVersion = at > 0 ? v.slice(at + 1) : v;
  if (!looksLikeVersion(realVersion)) {
    return;
  }
  set.add(realName, realVersion, true, groups);
};

export const parsePnpmLock = (doc: unknown): ParsedLockfile => {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new LockfileError("pnpm-lock.yaml must be a YAML mapping.");
  }
  const lock = doc as Obj;
  const major = majorOf(lock.lockfileVersion);
  if (major !== 6 && major !== 9) {
    throw new LockfileError(
      `pnpm-lock.yaml lockfileVersion ${String(
        lock.lockfileVersion ?? "missing"
      )} is not supported; 6 (pnpm 8) and 9 (pnpm 9+) are.`
    );
  }
  const set = new PackageSet("npm");
  addPackages((lock.packages ?? {}) as Record<string, Obj>, set);

  // Importers: the project and each workspace package, with their direct dependencies by group.
  for (const [path, importer] of Object.entries(importersOf(lock))) {
    if (path !== ".") {
      set.skip(path.split("/").pop() || path, "", "workspace", path);
    }
    for (const [field, groups] of IMPORTER_GROUPS) {
      const deps = importer?.[field] as Record<string, unknown> | undefined;
      if (!deps || typeof deps !== "object") {
        continue;
      }
      for (const [name, spec] of Object.entries(deps)) {
        addDirect(set, name, spec, groups);
      }
    }
  }
  return {
    ecosystem: "npm",
    kind: "pnpm",
    knowsDirect: true,
    knowsGroups: true,
    label: `pnpm-lock.yaml v${String(lock.lockfileVersion)}`,
    notChecked: set.notChecked,
    packages: set.packages(),
  };
};
