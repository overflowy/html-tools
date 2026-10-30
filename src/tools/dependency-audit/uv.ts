// uv.lock: TOML with one [[package]] per resolved package. The project itself
// (and every workspace member) is a package with an editable or virtual
// source; its [package.metadata] lists the direct dependencies, by group.
import { LockfileError, normalizePyPiName } from "./lockfiles";
import type { ParsedLockfile } from "./lockfiles";
import { PackageSet } from "./package-set";
import { parseToml } from "./toml";

type Obj = Record<string, unknown>;

interface Requirement {
  name?: string;
  marker?: string;
  extra?: string;
}

/** The extra a requirement belongs to, read from its marker: `extra == 'socks'`. */
const extraOf = (req: Requirement): string | null => {
  if (typeof req.extra === "string") {
    return req.extra;
  }
  if (typeof req.marker !== "string") {
    return null;
  }
  return (
    /extra\s*==\s*['"](?<extra>[^'"]+)['"]/u.exec(req.marker)?.groups?.extra ??
    null
  );
};

const sourceOf = (p: Obj): Obj => (p.source ?? {}) as Obj;

/** Whether a package is the project or a workspace member rather than a dependency. */
const isProject = (src: Obj): boolean =>
  typeof src.editable === "string" || typeof src.virtual === "string";

/** Direct dependencies with their groups, from every project package's metadata. */
const directGroupsOf = (projects: Obj[]): Map<string, string[]> => {
  const directGroups = new Map<string, string[]>();
  const addDirect = (req: Requirement, group: string | null) => {
    if (typeof req.name !== "string") {
      return;
    }
    const name = normalizePyPiName(req.name);
    const groups = directGroups.get(name) ?? [];
    if (group && !groups.includes(group)) {
      groups.push(group);
    }
    directGroups.set(name, groups);
  };
  for (const p of projects) {
    const meta = (p.metadata ?? {}) as Obj;
    for (const req of (meta["requires-dist"] ?? []) as Requirement[]) {
      addDirect(req, extraOf(req));
    }
    const dev = (meta["requires-dev"] ?? {}) as Record<string, Requirement[]>;
    for (const [group, reqs] of Object.entries(dev)) {
      for (const req of reqs ?? []) {
        addDirect(req, group);
      }
    }
  }
  return directGroups;
};

/** One [[package]], added or skipped; `directGroups` is null when no project says what is direct. */
const addPackage = (
  set: PackageSet,
  p: Obj,
  directGroups: Map<string, string[]> | null
) => {
  const name = typeof p.name === "string" ? p.name : "";
  const version = typeof p.version === "string" ? p.version : "";
  const src = sourceOf(p);
  if (isProject(src)) {
    const where = String(src.editable ?? src.virtual);
    set.skip(name, version, where === "." ? "root" : "workspace", where);
  } else if (typeof src.git === "string") {
    set.skip(name, version, "git", String(src.git));
  } else if (
    typeof src.path === "string" ||
    typeof src.directory === "string"
  ) {
    set.skip(name, version, "path", String(src.path ?? src.directory));
  } else if (typeof src.url === "string") {
    set.skip(name, version, "url", String(src.url));
  } else if (name && version) {
    const norm = normalizePyPiName(name);
    const groups = directGroups?.get(norm);
    set.add(
      norm,
      version,
      directGroups ? groups !== undefined : null,
      groups ?? []
    );
  }
};

export const parseUvLock = (text: string): ParsedLockfile => {
  const doc = parseToml(text);
  if (doc.version !== 1) {
    throw new LockfileError(
      `uv.lock version ${String(
        doc.version ?? "missing"
      )} is not supported; 1 is.`
    );
  }
  const packages = (doc.package ?? []) as Obj[];
  if (!Array.isArray(packages)) {
    throw new LockfileError("uv.lock has no [[package]] entries.");
  }
  const set = new PackageSet("PyPI");
  const projects = packages.filter((p) => isProject(sourceOf(p)));
  const directGroups = projects.length ? directGroupsOf(projects) : null;
  for (const p of packages) {
    addPackage(set, p, directGroups);
  }
  return {
    ecosystem: "PyPI",
    kind: "uv",
    knowsDirect: projects.length > 0,
    knowsGroups: projects.length > 0,
    label: "uv.lock v1",
    notChecked: set.notChecked,
    packages: set.packages(),
  };
};
