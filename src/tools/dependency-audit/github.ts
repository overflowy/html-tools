// Repository Fetch: what the repo box accepts and where the Lockfiles are read from.
// Only raw.githubusercontent.com is used; the GitHub API is never called.
import { KIND_FILENAME, type LockfileKind } from "./lockfiles";

export const LOCKFILE_NAMES = Object.values(KIND_FILENAME);

export interface RepoSource {
  kind: "repo";
  owner: string;
  repo: string;
  /** Branch, tag, or commit; "HEAD" for the default branch. */
  ref: string;
  /** Directory inside the repository, "" for the root. */
  dir: string;
}

export interface FileSource {
  kind: "file";
  url: string;
  filename: string;
}

export type Source = RepoSource | FileSource;

const RAW = "https://raw.githubusercontent.com/";

function clean(seg: string): string {
  return seg.replace(/^\/+|\/+$/g, "");
}

/**
 * Reads `owner/repo`, `owner/repo/dir`, either with `@ref`, a github.com URL
 * (repository, tree, or blob), a raw.githubusercontent.com URL, or any other
 * https URL to a single file. Null when the input is none of these.
 */
export function parseSource(input: string): Source | null {
  const s = input.trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) {
    let url: URL;
    try { url = new URL(s); } catch { return null; }
    const segs = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (url.hostname === "github.com" || url.hostname === "www.github.com") {
      const [owner, repoRaw, mode, ref, ...rest] = segs;
      if (!owner || !repoRaw) return null;
      const repo = repoRaw.replace(/\.git$/, "");
      if (mode === "blob" && ref && rest.length) {
        return { kind: "file", url: RAW + [owner, repo, ref, ...rest].map(encodeURIComponent).join("/"), filename: rest[rest.length - 1]! };
      }
      if ((mode === "tree" || mode === "blob") && ref) return { kind: "repo", owner, repo, ref, dir: rest.join("/") };
      return { kind: "repo", owner, repo, ref: "HEAD", dir: "" };
    }
    if (url.hostname === "raw.githubusercontent.com") {
      const [owner, repo, ref, ...rest] = segs;
      if (!owner || !repo || !ref || !rest.length) return null;
      return { kind: "file", url: RAW + [owner, repo, ref, ...rest].map(encodeURIComponent).join("/"), filename: rest[rest.length - 1]! };
    }
    return { kind: "file", url: url.toString(), filename: segs[segs.length - 1] ?? "" };
  }
  const at = s.indexOf("@");
  const ref = at > 0 ? s.slice(at + 1).trim() : "HEAD";
  const path = clean(at > 0 ? s.slice(0, at) : s);
  const segs = path.split("/").filter(Boolean);
  if (segs.length < 2 || !ref) return null;
  const [owner, repoRaw, ...rest] = segs;
  if (!/^[\w.-]+$/.test(owner!) || !/^[\w.-]+$/.test(repoRaw!)) return null;
  return { kind: "repo", owner: owner!, repo: repoRaw!.replace(/\.git$/, ""), ref, dir: rest.join("/") };
}

/** The raw URL of each known Lockfile name at the source's directory. */
export function lockfileUrls(src: RepoSource): { kind: LockfileKind; name: string; url: string }[] {
  const base = RAW + [src.owner, src.repo, src.ref].map(encodeURIComponent).join("/") + "/" + (src.dir ? src.dir.split("/").map(encodeURIComponent).join("/") + "/" : "");
  return (Object.entries(KIND_FILENAME) as [LockfileKind, string][]).map(([kind, name]) => ({ kind, name, url: base + name }));
}

/** The shorthand a source is shown and stored as: `owner/repo[/dir][@ref]`, or the file URL. */
export function sourceLabel(src: Source): string {
  if (src.kind === "file") return src.url;
  return src.owner + "/" + src.repo + (src.dir ? "/" + src.dir : "") + (src.ref === "HEAD" ? "" : "@" + src.ref);
}

/** The GitHub page for a repo source, for the results header. */
export function sourcePage(src: RepoSource): string {
  return "https://github.com/" + src.owner + "/" + src.repo + (src.ref !== "HEAD" || src.dir ? "/tree/" + src.ref + (src.dir ? "/" + src.dir : "") : "");
}
