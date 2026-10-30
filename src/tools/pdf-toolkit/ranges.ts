// Page Ranges: how the user names pages, 1-based, the way every PDF tool
// does. "1,3,5-7" is pages one, three, and five to seven; "9-" runs to the
// last page, "-3" is the first three; "last", "odd", "even", and "all" mean
// what they say. Parsed against a page count into 0-based indices, in the
// order written; whether duplicates and order matter is up to the caller.

export type RangeResult =
  | { ok: true; pages: number[] }
  | { ok: false; error: string };

const PART = /^(?<from>\d+|last)?\s*(?<dash>-)?\s*(?<to>\d+|last)?$/iu;

const point = (s: string | undefined, count: number): number | null => {
  if (s === undefined) {
    return null;
  }
  return s.toLowerCase() === "last" ? count : Number(s);
};

const outOfRange = (part: string, page: number, count: number): string =>
  count === 1
    ? `There is only one page; “${part}” asks for page ${page}.`
    : `There are ${count} pages; “${part}” asks for page ${page}.`;

/** One comma-separated part: its pages, 0-based, or what is wrong with it. */
const parsePart = (
  part: string,
  count: number
): { pages: number[] } | { error: string } => {
  if (part === "odd" || part === "even") {
    const pages: number[] = [];
    for (let p = part === "odd" ? 0 : 1; p < count; p += 2) {
      pages.push(p);
    }
    return { pages };
  }
  const g = PART.exec(part)?.groups;
  if (!g || (!g.from && !g.to)) {
    return { error: `“${part}” is not a page or a range.` };
  }
  const from = point(g.from, count) ?? 1;
  const to = g.dash ? (point(g.to, count) ?? count) : from;
  const bad = [from, to].find((p) => p < 1 || p > count);
  if (bad !== undefined) {
    return { error: outOfRange(part, bad, count) };
  }
  const step = from <= to ? 1 : -1;
  const pages: number[] = [];
  for (let p = from; p !== to + step; p += step) {
    pages.push(p - 1);
  }
  return { pages };
};

/**
 * Parse `text` into 0-based indices for a document of `count` pages. An
 * empty text is every page. Pages past the end are an error, not silently
 * dropped: a typo there would otherwise act on the wrong pages.
 */
export const parseRanges = (text: string, count: number): RangeResult => {
  const trimmed = text.trim().toLowerCase();
  if (trimmed === "" || trimmed === "all") {
    return { ok: true, pages: Array.from({ length: count }, (_, i) => i) };
  }
  const pages: number[] = [];
  for (const raw of trimmed.split(/[,;]/u)) {
    const part = raw.trim();
    if (part !== "") {
      const parsed = parsePart(part, count);
      if ("error" in parsed) {
        return { error: parsed.error, ok: false };
      }
      pages.push(...parsed.pages);
    }
  }
  if (pages.length === 0) {
    return { error: "No pages given.", ok: false };
  }
  return { ok: true, pages };
};

/** The pages once each, ascending. */
export const uniqueSorted = (pages: number[]): number[] =>
  [...new Set(pages)].toSorted((a, b) => a - b);

/** 0-based indices as the shortest Page Range: runs of three or more become "a-b". */
export const formatRanges = (pages: number[]): string => {
  const sorted = uniqueSorted(pages);
  const parts: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    const start = sorted[i] ?? 0;
    let end = start;
    while (sorted[i + 1] === end + 1) {
      i += 1;
      end += 1;
    }
    if (end - start >= 2) {
      parts.push(`${start + 1}-${end + 1}`);
    } else {
      for (let p = start; p <= end; p += 1) {
        parts.push(String(p + 1));
      }
    }
    i += 1;
  }
  return parts.join(",");
};

/**
 * Pages as qpdf's --pages wants them for one file: 1-based, comma-separated,
 * runs written "a-b" in either direction, the order kept.
 */
export const qpdfRanges = (pages: number[]): string => {
  const parts: string[] = [];
  let i = 0;
  while (i < pages.length) {
    const start = pages[i] ?? 0;
    let end = start;
    let step = 0;
    const next = pages[i + 1];
    if (next !== undefined && Math.abs(next - start) === 1) {
      step = next - start;
      while (pages[i + 1] === end + step) {
        i += 1;
        end += step;
      }
    }
    parts.push(end === start ? `${start + 1}` : `${start + 1}-${end + 1}`);
    i += 1;
  }
  return parts.join(",");
};
