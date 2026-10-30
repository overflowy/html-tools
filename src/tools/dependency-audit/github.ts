// Repository Fetch: what the repo box accepts and where the Lockfiles are read from.
// Only raw.githubusercontent.com is used; the GitHub API is never called.
import { KIND_FILENAME, LOCKFILE_KINDS } from "./lockfiles";
import type { LockfileKind } from "./lockfiles";

export const LOCKFILE_NAMES = LOCKFILE_KINDS.map((kind) => KIND_FILENAME[kind]);

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

const clean = (seg: string): string => seg.replaceAll(/^\/+|\/+$/gu, "");

const rawUrl = (parts: string[]): string =>
  RAW + parts.map(encodeURIComponent).join("/");

/** A github.com repository, tree, or blob URL, split into path segments. */
const githubPageSource = (segs: string[]): Source | null => {
  const [owner, repoRaw, mode, ref, ...rest] = segs;
  if (!owner || !repoRaw) {
    return null;
  }
  const repo = repoRaw.replace(/\.git$/u, "");
  const filename = rest.at(-1);
  if (mode === "blob" && ref && filename) {
    return {
      filename,
      kind: "file",
      url: rawUrl([owner, repo, ref, ...rest]),
    };
  }
  if ((mode === "tree" || mode === "blob") && ref) {
    return { dir: rest.join("/"), kind: "repo", owner, ref, repo };
  }
  return { dir: "", kind: "repo", owner, ref: "HEAD", repo };
};

/** A raw.githubusercontent.com URL, split into path segments. */
const rawFileSource = (segs: string[]): Source | null => {
  const [owner, repo, ref, ...rest] = segs;
  const filename = rest.at(-1);
  if (!owner || !repo || !ref || !filename) {
    return null;
  }
  return {
    filename,
    kind: "file",
    url: rawUrl([owner, repo, ref, ...rest]),
  };
};

const urlSource = (s: string): Source | null => {
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  const segs = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (url.hostname === "github.com" || url.hostname === "www.github.com") {
    return githubPageSource(segs);
  }
  if (url.hostname === "raw.githubusercontent.com") {
    return rawFileSource(segs);
  }
  return {
    filename: segs.at(-1) ?? "",
    kind: "file",
    url: url.toString(),
  };
};

/** `owner/repo[/dir][@ref]`. */
const shorthandSource = (s: string): Source | null => {
  const at = s.indexOf("@");
  const ref = at > 0 ? s.slice(at + 1).trim() : "HEAD";
  const path = clean(at > 0 ? s.slice(0, at) : s);
  const segs = path.split("/").filter(Boolean);
  if (segs.length < 2 || !ref) {
    return null;
  }
  const [owner, repoRaw, ...rest] = segs;
  if (
    !owner ||
    !repoRaw ||
    !/^[\w.-]+$/u.test(owner) ||
    !/^[\w.-]+$/u.test(repoRaw)
  ) {
    return null;
  }
  return {
    dir: rest.join("/"),
    kind: "repo",
    owner,
    ref,
    repo: repoRaw.replace(/\.git$/u, ""),
  };
};

/**
 * Reads `owner/repo`, `owner/repo/dir`, either with `@ref`, a github.com URL
 * (repository, tree, or blob), a raw.githubusercontent.com URL, or any other
 * https URL to a single file. Null when the input is none of these.
 */
export const parseSource = (input: string): Source | null => {
  const s = input.trim();
  if (!s) {
    return null;
  }
  return /^https?:\/\//iu.test(s) ? urlSource(s) : shorthandSource(s);
};

/** The raw URL of each known Lockfile name at the source's directory. */
export const lockfileUrls = (
  src: RepoSource
): { kind: LockfileKind; name: string; url: string }[] => {
  const base = `${rawUrl([src.owner, src.repo, src.ref])}/${
    src.dir ? `${src.dir.split("/").map(encodeURIComponent).join("/")}/` : ""
  }`;
  return LOCKFILE_KINDS.map((kind) => {
    const name = KIND_FILENAME[kind];
    return { kind, name, url: base + name };
  });
};

/** The shorthand a source is shown and stored as: `owner/repo[/dir][@ref]`, or the file URL. */
export const sourceLabel = (src: Source): string => {
  if (src.kind === "file") {
    return src.url;
  }
  return `${src.owner}/${src.repo}${
    src.dir ? `/${src.dir}` : ""
  }${src.ref === "HEAD" ? "" : `@${src.ref}`}`;
};

/** The GitHub page for a repo source, for the results header. */
export const sourcePage = (src: RepoSource): string =>
  `https://github.com/${src.owner}/${src.repo}${
    src.ref !== "HEAD" || src.dir
      ? `/tree/${src.ref}${src.dir ? `/${src.dir}` : ""}`
      : ""
  }`;
