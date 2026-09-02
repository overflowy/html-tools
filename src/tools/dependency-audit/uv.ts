// uv.lock: TOML with one [[package]] per resolved package. The project itself
// (and every workspace member) is a package with an editable or virtual
// source; its [package.metadata] lists the direct dependencies, by group.
import { LockfileError, PackageSet, normalizePyPiName, type ParsedLockfile } from "./lockfiles";
import { parseToml } from "./toml";

type Obj = Record<string, unknown>;

interface Requirement {
  name?: string;
  marker?: string;
  extra?: string;
}

/** The extra a requirement belongs to, read from its marker: `extra == 'socks'`. */
function extraOf(req: Requirement): string | null {
  if (typeof req.extra === "string") return req.extra;
  const m = typeof req.marker === "string" ? /extra\s*==\s*['"]([^'"]+)['"]/.exec(req.marker) : null;
  return m ? m[1]! : null;
}

export function parseUvLock(text: string): ParsedLockfile {
  const doc = parseToml(text);
  if (doc.version !== 1) throw new LockfileError("uv.lock version " + String(doc.version ?? "missing") + " is not supported; 1 is.");
  const packages = (doc.package ?? []) as Obj[];
  if (!Array.isArray(packages)) throw new LockfileError("uv.lock has no [[package]] entries.");
  const set = new PackageSet("PyPI");

  // Direct dependencies with their groups, from every project package's metadata.
  const directGroups = new Map<string, string[]>();
  const addDirect = (req: Requirement, group: string | null) => {
    if (typeof req.name !== "string") return;
    const name = normalizePyPiName(req.name);
    const groups = directGroups.get(name) ?? [];
    if (group && !groups.includes(group)) groups.push(group);
    directGroups.set(name, groups);
  };
  const projects = packages.filter((p) => {
    const src = (p.source ?? {}) as Obj;
    return typeof src.editable === "string" || typeof src.virtual === "string";
  });
  for (const p of projects) {
    const meta = (p.metadata ?? {}) as Obj;
    for (const req of (meta["requires-dist"] ?? []) as Requirement[]) addDirect(req, extraOf(req));
    const dev = (meta["requires-dev"] ?? {}) as Record<string, Requirement[]>;
    for (const [group, reqs] of Object.entries(dev)) for (const req of reqs ?? []) addDirect(req, group);
  }

  for (const p of packages) {
    const name = typeof p.name === "string" ? p.name : "";
    const version = typeof p.version === "string" ? p.version : "";
    const src = (p.source ?? {}) as Obj;
    if (typeof src.editable === "string" || typeof src.virtual === "string") {
      const where = String(src.editable ?? src.virtual);
      set.skip(name, version, where === "." ? "root" : "workspace", where);
    } else if (typeof src.git === "string") {
      set.skip(name, version, "git", String(src.git));
    } else if (typeof src.path === "string" || typeof src.directory === "string") {
      set.skip(name, version, "path", String(src.path ?? src.directory));
    } else if (typeof src.url === "string") {
      set.skip(name, version, "url", String(src.url));
    } else if (name && version) {
      const norm = normalizePyPiName(name);
      const groups = directGroups.get(norm);
      set.add(norm, version, projects.length ? groups !== undefined : null, groups ?? []);
    }
  }
  return {
    kind: "uv", ecosystem: "PyPI", label: "uv.lock v1", packages: set.packages(), notChecked: set.notChecked,
    knowsDirect: projects.length > 0, knowsGroups: projects.length > 0,
  };
}
