// The 7-Zip command lines the Archive Manager runs, and what their output
// means. Pure, so every argument list and every reading of 7-Zip's messages
// is unit tested without an engine.
//
// The worker mounts the files an operation reads under IN (read-only) and
// collects what it writes under OUT. Every command passes a password switch,
// empty when there is none: without one 7-Zip would ask on stdin, and a
// worker has no stdin to answer with. `-y` answers its other questions. `--`
// ends the switches, so a file named `-x.txt` is a file and not a switch, and
// `-spd` turns off wildcards, so a file named `a*.txt` matches only itself.

export const IN = "/in";
export const OUT = "/out";

export type FormatId =
  | "7z"
  | "zip"
  | "tar"
  | "tar.gz"
  | "tar.bz2"
  | "tar.xz"
  | "gz"
  | "bz2"
  | "xz";

export interface Format {
  id: FormatId;
  label: string;
  /** Extension appended to the archive name, without the dot. */
  ext: string;
  /** Compresses one file, not a set: offered only when there is exactly one. */
  single: boolean;
  /** Levels offered; empty when the format does not compress. */
  levels: Level[];
  /** Supports a password. */
  password: boolean;
  /** Can hide file names behind the password too. */
  encryptNames: boolean;
}

/** `-mx` levels, by 7-Zip's names. */
export type Level = 0 | 1 | 3 | 5 | 7 | 9;

export const LEVEL_NAMES: Record<Level, string> = {
  0: "Store",
  1: "Fastest",
  3: "Fast",
  5: "Normal",
  7: "Maximum",
  9: "Ultra",
};

const ALL_LEVELS: Level[] = [0, 1, 3, 5, 7, 9];
/** gzip, bzip2 and xz have no store mode. */
const STREAM_LEVELS: Level[] = [1, 3, 5, 7, 9];

export const FORMATS: Format[] = [
  {
    encryptNames: true,
    ext: "7z",
    id: "7z",
    label: "7z",
    levels: ALL_LEVELS,
    password: true,
    single: false,
  },
  {
    encryptNames: false,
    ext: "zip",
    id: "zip",
    label: "zip",
    levels: ALL_LEVELS,
    password: true,
    single: false,
  },
  {
    encryptNames: false,
    ext: "tar",
    id: "tar",
    label: "tar",
    levels: [],
    password: false,
    single: false,
  },
  {
    encryptNames: false,
    ext: "tar.gz",
    id: "tar.gz",
    label: "tar.gz",
    levels: STREAM_LEVELS,
    password: false,
    single: false,
  },
  {
    encryptNames: false,
    ext: "tar.bz2",
    id: "tar.bz2",
    label: "tar.bz2",
    levels: STREAM_LEVELS,
    password: false,
    single: false,
  },
  {
    encryptNames: false,
    ext: "tar.xz",
    id: "tar.xz",
    label: "tar.xz",
    levels: STREAM_LEVELS,
    password: false,
    single: false,
  },
  {
    encryptNames: false,
    ext: "gz",
    id: "gz",
    label: "gzip",
    levels: STREAM_LEVELS,
    password: false,
    single: true,
  },
  {
    encryptNames: false,
    ext: "bz2",
    id: "bz2",
    label: "bzip2",
    levels: STREAM_LEVELS,
    password: false,
    single: true,
  },
  {
    encryptNames: false,
    ext: "xz",
    id: "xz",
    label: "xz",
    levels: STREAM_LEVELS,
    password: false,
    single: true,
  },
];

export const formatById = (id: string): Format | undefined =>
  FORMATS.find((f) => f.id === id);

/** How a zip is encrypted: AES-256, or the legacy ZipCrypto that every unzipper (Windows Explorer included) opens. */
export type ZipEncryption = "aes" | "zipcrypto";

export interface CreateOptions {
  format: FormatId;
  level: Level;
  password: string;
  /** 7z only: the listing needs the password too. */
  encryptNames: boolean;
  zipEncryption: ZipEncryption;
}

/** The level a format actually uses: the asked one if offered, else the nearest offered. */
export const levelFor = (f: Format, level: Level): Level | null => {
  if (f.levels.length === 0) {
    return null;
  }
  if (f.levels.includes(level)) {
    return level;
  }
  let [best = level] = f.levels;
  for (const l of f.levels) {
    if (Math.abs(l - level) < Math.abs(best - level)) {
      best = l;
    }
  }
  return best;
};

/** One 7-Zip run of a multi-step operation. */
export interface Step {
  args: string[];
  /** Working directory, so the paths given are stored relative to it. */
  cwd: string;
}

const passwordSwitch = (password: string) => `-p${password}`;

/** The 7-Zip type name a single-stream format is written with. */
const STREAM_TYPE: Record<string, string> = {
  bz2: "bzip2",
  gz: "gzip",
  xz: "xz",
};

/**
 * The runs that make an archive called `name` (extension included) from the
 * top-level `items` under IN. A compressed tarball is two: the tar, then the
 * tar compressed, which reads the first run's output as its input. The last
 * run writes `${OUT}/${name}`.
 */
export const createSteps = (
  name: string,
  items: string[],
  o: CreateOptions
): Step[] => {
  const f = formatById(o.format);
  if (!f) {
    throw new Error(`Unknown format: ${o.format}`);
  }
  const level = levelFor(f, o.level);
  const mx = level === null ? [] : [`-mx${level}`];
  const out = `${OUT}/${name}`;
  if (f.id === "7z") {
    const secret = o.password
      ? [passwordSwitch(o.password), ...(o.encryptNames ? ["-mhe=on"] : [])]
      : [];
    return [
      {
        args: [
          "a",
          "-t7z",
          ...mx,
          ...secret,
          "-y",
          "-spd",
          "--",
          out,
          ...items,
        ],
        cwd: IN,
      },
    ];
  }
  if (f.id === "zip") {
    const secret = o.password
      ? [
          passwordSwitch(o.password),
          o.zipEncryption === "aes" ? "-mem=AES256" : "-mem=ZipCrypto",
        ]
      : [];
    // Names as UTF-8 always, so they read the same in every unzipper.
    return [
      {
        args: [
          "a",
          "-tzip",
          ...mx,
          "-mcu=on",
          ...secret,
          "-y",
          "-spd",
          "--",
          out,
          ...items,
        ],
        cwd: IN,
      },
    ];
  }
  if (f.id === "tar") {
    return [
      { args: ["a", "-ttar", "-y", "-spd", "--", out, ...items], cwd: IN },
    ];
  }
  if (f.single) {
    return [
      {
        args: [
          `a`,
          `-t${STREAM_TYPE[f.id]}`,
          ...mx,
          "-y",
          "-spd",
          "--",
          out,
          ...items,
        ],
        cwd: IN,
      },
    ];
  }
  // tar.gz, tar.bz2, tar.xz: the tar is named after the archive, since the
  // compressor records its input's name and unpacking restores it.
  const tarName = name.replace(/\.(?:gz|bz2|xz)$/u, "");
  const stream = f.id.slice("tar.".length);
  return [
    {
      args: ["a", "-ttar", "-y", "-spd", "--", `${OUT}/${tarName}`, ...items],
      cwd: IN,
    },
    {
      args: [
        "a",
        `-t${STREAM_TYPE[stream]}`,
        ...mx,
        "-y",
        "-spd",
        "--",
        out,
        tarName,
      ],
      cwd: IN,
    },
  ];
};

/** List an archive's Entries and properties. */
export const listArgs = (archive: string, password: string): string[] => [
  "l",
  "-slt",
  passwordSwitch(password),
  "--",
  archive,
];

/** Extract everything, or only `paths` (folders with all they hold), under OUT. */
export const extractArgs = (
  archive: string,
  password: string,
  paths: string[] = []
): string[] => [
  "x",
  "-y",
  passwordSwitch(password),
  `-o${OUT}`,
  "-spd",
  "--",
  archive,
  ...paths,
];

/** Test every Entry's data against its checksum. */
export const testArgs = (archive: string, password: string): string[] => [
  "t",
  passwordSwitch(password),
  "--",
  archive,
];

/* ---------------- reading 7-Zip's output ---------------- */

export interface Outcome {
  /** The command did what it was asked (warnings aside). */
  ok: boolean;
  /** The archive, or one of its Entries, needs a password it did not get, or got a wrong one. */
  wrongPassword: boolean;
  /** 7-Zip does not recognize the file as any archive it knows. */
  notArchive: boolean;
  /** The archive ends early: truncated, or a volume is missing. */
  truncated: boolean;
  /** Error messages, paths under IN made relative, each once. */
  errors: string[];
  warnings: string[];
}

/** 7-Zip's exit codes: 0 ok, 1 warning, 2 fatal error, 7 bad command line, 8 out of memory, 255 stopped. */
const EXIT_MEANING = new Map([
  [2, "7-Zip reported an error."],
  [7, "7-Zip did not understand the command."],
  [8, "7-Zip ran out of memory."],
  [255, "7-Zip stopped to ask a question nobody could answer."],
]);

const HEADING = /^(?:ERRORS?|WARNINGS?|System ERROR):$/u;
const ERROR_LINE = /^(?:Open |System )?ERROR:\s*(?<text>.+)$/u;
const WARNING_LINE = /^(?:Open )?WARNING:\s*(?<text>.+)$/u;

const IN_PREFIX = /\/in\//gu;
/** `a.zip : a.zip`, which 7-Zip prints when the file and the archive are one. */
const SAME_TWICE = /^(?<name>[^:]+) : \k<name>$/u;

/** Paths under IN as the user knows them: `/in/a.zip` is `a.zip`. */
const relative = (s: string) =>
  s.replaceAll(IN_PREFIX, "").replace(SAME_TWICE, "$<name>");

/**
 * What a run's exit code and messages mean. 7-Zip writes errors to stderr,
 * either on one line (`ERROR: Wrong password : a.txt`) or as a heading and
 * the lines under it until a blank one.
 */
export const readOutcome = (
  code: number,
  stdout: string[],
  stderr: string[]
): Outcome => {
  const errors: string[] = [];
  const warnings: string[] = [];
  let under: "error" | "warning" | null = null;
  const add = (list: string[], text: string) => {
    const t = relative(text.trim());
    if (t && !list.includes(t)) {
      list.push(t);
    }
  };
  for (const raw of [...stderr, ...stdout]) {
    const line = raw.trim();
    if (line === "") {
      under = null;
      continue;
    }
    if (HEADING.test(line)) {
      under = line.startsWith("WARNING") ? "warning" : "error";
      continue;
    }
    const e = ERROR_LINE.exec(line);
    if (e?.groups) {
      add(errors, e.groups.text);
      continue;
    }
    const w = WARNING_LINE.exec(line);
    if (w?.groups) {
      add(warnings, w.groups.text);
      continue;
    }
    if (under === "error") {
      add(errors, line);
    } else if (under === "warning") {
      add(warnings, line);
    }
  }
  // stdout lists the archive's own warnings in its header; the listing parser keeps those.
  const all = errors.join("\n");
  const wrongPassword = /Wrong password|encrypted archive/iu.test(all);
  const notArchive =
    /Cannot open the file as(?: \[[^\]]+\])? archive|Is not archive|Unsupported archive type/iu.test(
      all
    );
  const truncated = /Unexpected end of (?:data|archive)|Missing volume/iu.test(
    all + warnings.join("\n")
  );
  const ok = code === 0 || code === 1;
  if (!ok && errors.length === 0) {
    errors.push(EXIT_MEANING.get(code) ?? `7-Zip exited with code ${code}.`);
  }
  return { errors, notArchive, ok, truncated, warnings, wrongPassword };
};

/** The totals a test or extraction prints at the end: `Files: 3`, `Size: 12`, `Folders: 2`. */
export interface Totals {
  files: number | null;
  folders: number | null;
  size: number | null;
}

const TOTAL = /^(?<key>Files|Folders|Size):\s+(?<n>\d+)$/u;

export const readTotals = (stdout: string[]): Totals => {
  const found = new Map<string, number>();
  for (const line of stdout) {
    const m = TOTAL.exec(line.trim());
    if (m?.groups && !found.has(m.groups.key)) {
      found.set(m.groups.key, Number(m.groups.n));
    }
  }
  return {
    files: found.get("Files") ?? null,
    folders: found.get("Folders") ?? null,
    size: found.get("Size") ?? null,
  };
};

/* ---------------- recognizing archives by name ---------------- */

/**
 * Extensions opened as an archive when a lone file with one is dropped;
 * any other lone file is taken as something to pack. Office documents,
 * EPUBs, and APKs are zips inside, but a user dropping one means the file:
 * Open archive reads them as archives on request.
 */
const ARCHIVE_EXTS = new Set([
  "7z",
  "zip",
  "zipx",
  "rar",
  "tar",
  "gz",
  "tgz",
  "bz2",
  "tbz",
  "tbz2",
  "xz",
  "txz",
  "zst",
  "tzst",
  "lz",
  "lzma",
  "tlz",
  "lz4",
  "z",
  "taz",
  "cab",
  "iso",
  "img",
  "dmg",
  "wim",
  "swm",
  "esd",
  "cpio",
  "rpm",
  "deb",
  "arj",
  "lzh",
  "lha",
  "chm",
  "msi",
  "vhd",
  "vhdx",
  "vmdk",
  "qcow2",
  "squashfs",
  "xar",
  "pkg",
  "ar",
  "a",
  "001",
]);

export const extOf = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

export const looksLikeArchive = (name: string): boolean =>
  ARCHIVE_EXTS.has(extOf(name)) ||
  /\.(?:r\d\d|z\d\d|part\d+\.rar)$/iu.test(name);

/**
 * The volume 7-Zip opens a multi-volume archive by, when `names` are the
 * volumes of one: `x.7z.001` (any split), `x.part1.rar` (or `x.rar` with
 * `.r00`... beside it), `x.zip` with `.z01`... beside it. Null when the
 * names are not volumes of one archive.
 */
export const firstVolume = (names: string[]): string | null => {
  if (names.length < 2) {
    return null;
  }
  const lower = names.map((n) => n.toLowerCase());
  const base = (n: string, re: RegExp) => n.replace(re, "");
  const same = (re: RegExp) => {
    const bases = new Set(lower.map((n) => base(n, re)));
    return bases.size === 1 && lower.every((n) => re.test(n));
  };
  const pick = (re: RegExp) => {
    const i = lower.findIndex((n) => re.test(n));
    return i === -1 ? null : names[i];
  };
  if (same(/\.\d{3}$/u)) {
    return pick(/\.0*1$/u);
  }
  if (same(/\.part\d+\.rar$/u)) {
    return pick(/\.part0*1\.rar$/u);
  }
  if (same(/\.(?:rar|r\d\d)$/u)) {
    return pick(/\.rar$/u);
  }
  if (same(/\.(?:zip|z\d\d)$/u)) {
    return pick(/\.zip$/u);
  }
  return null;
};

/** An archive name with its extension removed, for naming what comes out of it. */
export const baseName = (name: string): string => {
  const stripped = name
    .replace(/\.(?:part\d+\.rar|\d{3})$/iu, "")
    .replace(/\.tar\.(?:gz|bz2|xz|zst|lz|lzma|z)$/iu, "")
    .replace(/\.[^.]+$/u, "");
  return stripped || name || "archive";
};
