// What 7-Zip says about an archive, read from its technical listing
// (`7z l -slt`): the archive's own properties, then one block of
// `Key = value` lines per Entry. Pure, so it is unit tested against real
// output without an engine.

/** One item of an archive: a file, or a folder the archive records. */
export interface Entry {
  /** Path inside the archive, `/`-separated, as 7-Zip prints it. */
  path: string;
  dir: boolean;
  /** Unpacked bytes; null where the format does not say. */
  size: number | null;
  /** Packed bytes; null where the format does not say (the rest of a solid block, say). */
  packed: number | null;
  /** Modification time as 7-Zip prints it, in the browser's time zone; "" when absent. */
  modified: string;
  /** The same instant in milliseconds, or null. */
  mtime: number | null;
  /** Hex CRC32, or "". */
  crc: string;
  encrypted: boolean;
  /** Compression method, e.g. `LZMA2:24 7zAES`; "" when absent. */
  method: string;
}

/** The archive's own properties, from the block before its Entries. */
export interface ArchiveInfo {
  /** 7-Zip's name for the format: `7z`, `zip`, `gzip`, `Rar5`, `Iso`... */
  type: string;
  physicalSize: number | null;
  method: string;
  /** null where the format has no notion of it. */
  solid: boolean | null;
  /** Archive comment, if any. */
  comment: string;
  /** Every property as printed, in order, for the details view. */
  props: [string, string][];
  /** What 7-Zip warned about while opening: data after the end, a missing volume, and so on. */
  warnings: string[];
}

export interface Listing {
  info: ArchiveInfo;
  entries: Entry[];
}

const TIME =
  /^(?<y>\d{4})-(?<mo>\d\d)-(?<d>\d\d) (?<h>\d\d):(?<mi>\d\d):(?<s>\d\d)(?:\.(?<frac>\d+))?$/u;

/** A 7-Zip timestamp (local time, fraction optional) in milliseconds, or null. */
export const parseTime = (s: string): number | null => {
  const m = TIME.exec(s);
  if (!m?.groups) {
    return null;
  }
  const { y, mo, d, h, mi, s: sec, frac = "" } = m.groups;
  const ms = Math.round(Number(`0.${frac || "0"}`) * 1000);
  const t = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(sec),
    ms
  ).getTime();
  return Number.isNaN(t) ? null : t;
};

const num = (s: string | undefined): number | null => {
  if (s === undefined || s.trim() === "") {
    return null;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** `Key = value`, split at the first ` = `; a bare `Key =` has an empty value. */
const keyValue = (line: string): [string, string] | null => {
  const at = line.indexOf(" = ");
  if (at > 0) {
    return [line.slice(0, at), line.slice(at + 3)];
  }
  if (line.endsWith(" =")) {
    return [line.slice(0, -2), ""];
  }
  return null;
};

/**
 * A folder by any of the ways formats say so: `Folder = +` (zip, tar, rar),
 * or a `D` among the Windows attribute letters before the Unix mode (7z,
 * which prints no Folder line).
 */
const isDir = (fields: Map<string, string>): boolean => {
  if (fields.get("Folder") === "+") {
    return true;
  }
  const attrs = fields.get("Attributes") ?? "";
  const [win = ""] = attrs.split(" ");
  return /^[RHSDAIN]*D[RHSDAIN]*$/u.test(win) || attrs.startsWith("d");
};

const toEntry = (fields: Map<string, string>): Entry | null => {
  const path = fields.get("Path");
  if (path === undefined || path === "") {
    return null;
  }
  const modified = fields.get("Modified") ?? "";
  return {
    crc: fields.get("CRC") ?? "",
    dir: isDir(fields),
    encrypted: fields.get("Encrypted") === "+",
    method: fields.get("Method") ?? "",
    modified,
    mtime: parseTime(modified),
    packed: num(fields.get("Packed Size")),
    path,
    size: num(fields.get("Size")),
  };
};

const toInfo = (props: [string, string][], warnings: string[]): ArchiveInfo => {
  const get = (k: string) => props.find(([key]) => key === k)?.[1] ?? "";
  const solid = get("Solid");
  return {
    comment: get("Comment"),
    method: get("Method"),
    physicalSize: num(get("Physical Size")),
    props,
    solid: solid === "" ? null : solid === "+",
    type: get("Type"),
    warnings,
  };
};

/** Lines under a `WARNINGS:` heading, and `Open WARNING: ...` lines, until a blank line. */
const WARNING_LINE = /^(?:Open )?WARNINGS?:\s*(?<text>.*)$/u;

/**
 * Parse `7z l -slt` output (stdout lines). The archive's properties are the
 * first `--` block; a nested archive (a tar inside an image, say) prints
 * one block per level, and the innermost, which owns the Entries, wins.
 * Entries follow the `----------` line, one blank-line-separated block each.
 */
export const parseListing = (lines: string[]): Listing => {
  let props: [string, string][] = [];
  const warnings: string[] = [];
  const entries: Entry[] = [];
  let section: "head" | "props" | "entries" = "head";
  let fields = new Map<string, string>();
  let inWarnings = false;

  const flush = () => {
    const e = toEntry(fields);
    if (e) {
      entries.push(e);
    }
    fields = new Map();
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (section !== "entries") {
      const w = WARNING_LINE.exec(line);
      if (w?.groups) {
        // `WARNING: text` is the whole warning; a bare `WARNINGS:` heads the lines under it.
        const text = w.groups.text.trim();
        if (text) {
          warnings.push(text);
        }
        inWarnings = text === "";
        continue;
      }
      // A heading's warnings run until a blank line or, inside the
      // properties, the next property: 7-Zip prints them mid-block.
      if (inWarnings) {
        if (line === "" || keyValue(line)) {
          inWarnings = false;
        } else {
          warnings.push(line.trim());
          continue;
        }
      }
    }
    if (line === "----------") {
      section = "entries";
      continue;
    }
    if (section !== "entries" && line === "--") {
      section = "props";
      props = [];
      continue;
    }
    if (section === "props") {
      const kv = keyValue(line);
      if (kv) {
        props.push(kv);
      }
      continue;
    }
    if (section === "entries") {
      if (line === "") {
        flush();
        continue;
      }
      const kv = keyValue(line);
      if (kv) {
        fields.set(kv[0], kv[1]);
      }
    }
  }
  flush();
  return { entries, info: toInfo(props, warnings) };
};
