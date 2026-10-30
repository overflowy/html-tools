// Checksum files, in and out: the lists download pages publish next to a
// file (SHA256SUMS, x.iso.sha256, CHECKSUMS) and what File Hashes writes for
// its own results. Three line formats are read: GNU (`<hex>  name`, what
// sha256sum prints), BSD tags (`SHA256 (name) = <hex>`, what `--tag` and
// OpenSSL print), and SFV (`name <crc32>`). Pure, so it is unit tested.

import { ALGORITHMS, algorithmById } from "./algorithms";
import type { AlgorithmId } from "./algorithms";

/** One line of a checksum file: which file, which Algorithm, which Digest. */
export interface Listed {
  name: string;
  algorithm: AlgorithmId;
  digest: string;
}

const HEX = /^[0-9a-f]+$/iu;
// Two spaces from sha256sum, ` *` in binary mode, one space from BSD `md5 -r`.
const GNU_LINE = /^(?<escaped>\\)?(?<hex>[0-9a-f]+) [ *]?(?<name>.+)$/iu;
const BSD_LINE =
  /^(?<escaped>\\)?(?<tag>[\w-]+) ?\((?<name>.+)\) ?= ?(?<hex>[0-9a-f]+)$/iu;
const SFV_LINE = /^(?<name>.+?)\s+(?<hex>[0-9a-f]{8})$/iu;
const NAME_TOKENS = /[^a-z0-9-]+/u;
const SUMS_SUFFIX = /sums?$/u;
const LIST_NAMES = /^(?:check)?sums?$|^checksums?$|^digests?$/u;
const LINE_BREAK = /\r?\n/u;
const SPACE_OR_COLON = /[\s:]/gu;
const WHITESPACE = /\s+/u;
const HEX_PREFIX = /^0x/iu;

/** The Algorithm a GNU-style list is in, when nothing but the Digest's length says: the common one of that length. */
const BY_LENGTH = new Map<number, AlgorithmId>([
  [8, "crc32"],
  [32, "md5"],
  [40, "sha1"],
  [56, "sha224"],
  [64, "sha256"],
  [96, "sha384"],
  [128, "sha512"],
]);

/** Names a checksum file's own name may carry, most specific first. */
const NAME_HINTS: [string, AlgorithmId][] = [
  ["sha3-256", "sha3-256"],
  ["sha3-512", "sha3-512"],
  ["sha512", "sha512"],
  ["sha384", "sha384"],
  ["sha256", "sha256"],
  ["sha224", "sha224"],
  ["sha1", "sha1"],
  ["md5", "md5"],
  ["b2", "blake2b"],
  ["blake2b", "blake2b"],
  ["b3", "blake3"],
  ["blake3", "blake3"],
  ["xxh128", "xxh128"],
  ["xxh64", "xxh64"],
  ["xxh32", "xxh32"],
  ["xxh3", "xxh3"],
  ["crc32c", "crc32c"],
  ["crc64", "crc64"],
  ["crc32", "crc32"],
  ["sfv", "crc32"],
];

/** A file name's words, with a `sums` suffix dropped: `SHA256SUMS.txt` is `sha256`, `txt`. */
const tokens = (fileName: string): string[] =>
  fileName
    .toLowerCase()
    .split(NAME_TOKENS)
    .map((t) => t.replace(SUMS_SUFFIX, ""))
    .filter(Boolean);

/** The Algorithm a checksum file's name announces, if any. */
export const algorithmFromName = (fileName: string): AlgorithmId | null => {
  const words = new Set(tokens(fileName));
  for (const [hint, id] of NAME_HINTS) {
    if (words.has(hint)) {
      return id;
    }
  }
  return null;
};

/** Whether a dropped file is taken as a list to check against, rather than as a file to hash. */
export const isSumsFileName = (fileName: string): boolean => {
  if (algorithmFromName(fileName) !== null) {
    return true;
  }
  const [first = ""] = tokens(fileName);
  return (
    LIST_NAMES.test(fileName.toLowerCase().replace(/\.txt$/u, "")) ||
    LIST_NAMES.test(first)
  );
};

/** A tag as printed, matched loosely: `SHA-256`, `sha256`, and `SHA256` are one. */
const squash = (s: string) => s.toLowerCase().replaceAll("-", "");

const TAGS = new Map<string, AlgorithmId>();
for (const a of ALGORITHMS) {
  TAGS.set(squash(a.tag), a.id);
  TAGS.set(squash(a.label), a.id);
  TAGS.set(squash(a.id), a.id);
}
TAGS.set("ripemd160", "ripemd160");
TAGS.set("blake2b512", "blake2b");
TAGS.set("blake2s256", "blake2s");
// OpenSSL 3 names SHA-2 `SHA2-256`.
for (const bits of ["224", "256", "384", "512"]) {
  TAGS.set(`sha2${bits}`, `sha${bits}` as AlgorithmId);
}

/** GNU's escaping: a line that starts with `\` has `\\` and `\n` in its name. */
const unescapeName = (name: string): string =>
  name.replaceAll(/\\(?<c>[\\n])/gu, (_, c: string) =>
    c === "n" ? "\n" : "\\"
  );

const nameOf = (escaped: string | undefined, name: string) =>
  escaped ? unescapeName(name) : name;

/** A BSD tag line, if it names an Algorithm offered here with a Digest of the right length. */
const bsdLine = (line: string): Listed | null | undefined => {
  const m = BSD_LINE.exec(line)?.groups;
  if (!m) {
    return undefined;
  }
  const algorithm = TAGS.get(squash(m.tag));
  if (!algorithm || algorithmById(algorithm)?.hex !== m.hex.length) {
    return null;
  }
  return {
    algorithm,
    digest: m.hex.toLowerCase(),
    name: nameOf(m.escaped, m.name),
  };
};

/** A GNU line: the list's name says the Algorithm, or else the Digest's length does. */
const gnuLine = (line: string, hinted: AlgorithmId | null): Listed | null => {
  const m = GNU_LINE.exec(line)?.groups;
  if (!m) {
    return null;
  }
  const byName =
    hinted && algorithmById(hinted)?.hex === m.hex.length ? hinted : null;
  const algorithm = byName ?? BY_LENGTH.get(m.hex.length);
  return algorithm
    ? {
        algorithm,
        digest: m.hex.toLowerCase(),
        name: nameOf(m.escaped, m.name),
      }
    : null;
};

const sfvLine = (line: string): Listed | null => {
  const m = SFV_LINE.exec(line)?.groups;
  return m
    ? { algorithm: "crc32", digest: m.hex.toLowerCase(), name: m.name }
    : null;
};

/**
 * Read a checksum file. Lines that fit no format (comments, blank lines,
 * PGP armor around a signed list) are skipped. Null when no line fits.
 */
export const parseSums = (text: string, fileName: string): Listed[] | null => {
  const hinted = algorithmFromName(fileName);
  const sfv = tokens(fileName).at(-1) === "sfv";
  const out: Listed[] = [];
  for (const raw of text.split(LINE_BREAK)) {
    const line = raw.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) {
      continue;
    }
    // A BSD line naming something not offered here is skipped, not read as GNU.
    let listed = bsdLine(line);
    if (listed === undefined) {
      listed = sfv ? sfvLine(line) : gnuLine(line, hinted);
    }
    if (listed) {
      out.push(listed);
    }
  }
  return out.length ? out : null;
};

/**
 * A Digest as typed or pasted, made comparable: lowercase hex, with the
 * spaces and colons some tools group digits with removed, and a `0x`
 * dropped. A whole checksum line (`<hex>  name`) gives its Digest. Null
 * when what is left is not hex.
 */
export const normalizeDigest = (input: string): string | null => {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }
  const [first = ""] = trimmed.split(WHITESPACE);
  const head = first.replace(HEX_PREFIX, "");
  if (HEX.test(head) && BY_LENGTH.has(head.length) && trimmed !== first) {
    return head.toLowerCase();
  }
  const squashed = trimmed
    .replace(HEX_PREFIX, "")
    .replaceAll(SPACE_OR_COLON, "");
  return HEX.test(squashed) ? squashed.toLowerCase() : null;
};

/** A name as a list line needs it: a newline or backslash in it is escaped GNU's way, and the line marked. */
const escapeName = (name: string): { name: string; escaped: boolean } => {
  if (!name.includes("\\") && !name.includes("\n")) {
    return { escaped: false, name };
  }
  return {
    escaped: true,
    name: name.replaceAll("\\", "\\\\").replaceAll("\n", "\\n"),
  };
};

export interface Hashed {
  name: string;
  digests: Map<AlgorithmId, string>;
}

/**
 * A checksum file for results. With one Algorithm it is GNU's format,
 * named after it (`SHA256SUMS`), so `sha256sum -c` reads it; with several,
 * BSD tags, which name the Algorithm on every line (`sha256sum -c` reads
 * those too, one Algorithm at a time).
 */
export const formatSums = (
  files: Hashed[],
  algorithms: AlgorithmId[]
): { text: string; fileName: string } => {
  const lines: string[] = [];
  const [only] = algorithms;
  const single =
    algorithms.length === 1 && only ? algorithmById(only) : undefined;
  for (const f of files) {
    const { name, escaped } = escapeName(f.name);
    const mark = escaped ? "\\" : "";
    for (const id of algorithms) {
      const digest = f.digests.get(id);
      const a = algorithmById(id);
      if (!digest || !a) {
        continue;
      }
      lines.push(
        single
          ? `${mark}${digest}  ${name}`
          : `${mark}${a.tag} (${name}) = ${digest}`
      );
    }
  }
  return {
    fileName: single ? `${single.tag.toUpperCase()}SUMS` : "CHECKSUMS",
    text: lines.length ? `${lines.join("\n")}\n` : "",
  };
};

/**
 * The hashed file a listed name means: the one at that path, or failing
 * that the only one with that file name. GNU lists write `./x` and a
 * binary-mode `*` is already gone.
 */
export const matchListed = <T extends { path: string }>(
  listedName: string,
  files: T[]
): T | null => {
  const want = listedName.replace(/^\.\//u, "");
  const exact = files.find((f) => f.path === want);
  if (exact) {
    return exact;
  }
  const tail = (p: string) => p.slice(p.lastIndexOf("/") + 1);
  const named = files.filter(
    (f) => f.path.endsWith(`/${want}`) || tail(f.path) === tail(want)
  );
  return named.length === 1 ? (named[0] ?? null) : null;
};
