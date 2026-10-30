// Splitting one PDF into several: a plan (which pages go in which part, and
// what each part is called), then qpdf to make the parts, so every part
// keeps its pages' annotations and form fields.

import { parseRanges } from "../ranges";
import type { Env, OutFile } from "./doc";
import type { Bookmark } from "./outline";

export interface SplitOptions {
  /** One part per page, per run of `every` pages, per Page Range, per bookmark. */
  mode: "each" | "every" | "ranges" | "bookmarks";
  every: number;
  /** Page Ranges separated by semicolons or new lines: "1-3; 4-10; 11-". */
  ranges: string;
  /** For bookmarks: how deep a bookmark still starts a part (1 is the top level only). */
  depth: number;
  /** The input's name without extension: parts are named after it. */
  base: string;
}

export interface Part {
  name: string;
  /** 0-based pages, in order. */
  pages: number[];
}

/** A name safe on every filesystem: no separators, no control characters, not too long. */
export const safeName = (s: string): string =>
  s
    .replaceAll(/[\p{Cc}<>:"/\\|?*]+/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim()
    .slice(0, 80)
    .replace(/[. ]+$/u, "") || "part";

const span = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** The bookmarks down to `depth`, flattened, with their pages. */
const starts = (
  items: Bookmark[],
  depth: number,
  level = 1
): { title: string; page: number }[] =>
  items.flatMap((b) => [
    ...(b.page === null ? [] : [{ page: b.page, title: b.title }]),
    ...(level < depth ? starts(b.children, depth, level + 1) : []),
  ]);

export type PlanResult =
  | { ok: true; parts: Part[] }
  | { ok: false; error: string };

export const splitPlan = (
  count: number,
  outline: Bookmark[],
  o: SplitOptions
): PlanResult => {
  const digits = String(count).length;
  const num = (n: number) => String(n).padStart(digits, "0");
  if (o.mode === "each" || o.mode === "every") {
    const every = o.mode === "each" ? 1 : Math.max(1, Math.round(o.every));
    const parts: Part[] = [];
    for (let from = 0; from < count; from += every) {
      const to = Math.min(count, from + every) - 1;
      const label =
        from === to ? num(from + 1) : `${num(from + 1)}-${num(to + 1)}`;
      parts.push({ name: `${o.base}-${label}.pdf`, pages: span(from, to) });
    }
    return { ok: true, parts };
  }
  if (o.mode === "ranges") {
    const parts: Part[] = [];
    const chunks = o.ranges
      .split(/[;\n]/u)
      .map((c) => c.trim())
      .filter(Boolean);
    if (chunks.length === 0) {
      return { error: "Give at least one Page Range.", ok: false };
    }
    for (const [i, chunk] of chunks.entries()) {
      const r = parseRanges(chunk, count);
      if (!r.ok) {
        return r;
      }
      parts.push({
        name: `${o.base}-${String(i + 1).padStart(2, "0")}.pdf`,
        pages: r.pages,
      });
    }
    return { ok: true, parts };
  }
  const marks = starts(outline, Math.max(1, o.depth))
    .filter((m) => m.page >= 0 && m.page < count)
    .toSorted((a, b) => a.page - b.page);
  // One part per page a bookmark starts on; the first bookmark there names it.
  const firsts = marks.filter(
    (m, i) => i === 0 || marks[i - 1]?.page !== m.page
  );
  if (firsts.length === 0) {
    return { error: "The document has no bookmarks to split at.", ok: false };
  }
  const parts: Part[] = [];
  const width = String(firsts.length + 1).length;
  const label = (i: number, title: string) =>
    `${o.base}-${String(i).padStart(width, "0")} ${safeName(title)}.pdf`;
  const head = firsts[0]?.page ?? 0;
  if (head > 0) {
    parts.push({ name: label(0, "front matter"), pages: span(0, head - 1) });
  }
  for (const [i, m] of firsts.entries()) {
    const end = (firsts[i + 1]?.page ?? count) - 1;
    parts.push({ name: label(i + 1, m.title), pages: span(m.page, end) });
  }
  return { ok: true, parts };
};

export const split = (
  env: Env,
  bytes: Uint8Array,
  parts: Part[]
): OutFile[] => {
  const input = "/in/split.pdf";
  env.qpdf.write(input, bytes);
  try {
    return parts.map((part, i) => {
      const output = `/out/part-${i}.pdf`;
      const pages = part.pages.map((p) => p + 1).join(",");
      const { bytes: out } = env.qpdf.produce(
        `Could not make ${part.name}`,
        {},
        [input, "--pages", input, pages, "--", output],
        output
      );
      return { bytes: out, mime: "application/pdf", name: part.name };
    });
  } finally {
    env.qpdf.remove(input);
  }
};
