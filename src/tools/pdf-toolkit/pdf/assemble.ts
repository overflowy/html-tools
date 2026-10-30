// The Page List made into one PDF. qpdf does the copying: it carries every
// page's annotations and form fields along and keeps field names apart when
// two files use the same ones, which copying pages with MuPDF does not. The
// first Source is qpdf's primary input, so the document keeps its metadata
// and page labels. Bookmarks are rebuilt afterwards from each Source's, with
// their pages renumbered, and dropped where their page is gone.

import { formatRanges, qpdfRanges } from "../ranges";
import { openPdf, savePdf } from "./doc";
import type { Env } from "./doc";
import { remapOutline, writeOutline } from "./outline";
import type { Bookmark } from "./outline";

/** One page of the Page List: a Source page, turned by `rotate` degrees clockwise (0, 90, 180, 270) more than it was. */
export interface PageRef {
  src: string;
  index: number;
  rotate: number;
}

export interface AssemblySource {
  /** Where the Source's bytes are in qpdf's filesystem. */
  path: string;
  /** The file name, for a bookmark grouping its bookmarks. */
  name: string;
  outline: Bookmark[];
}

/** qpdf's command line for the Page List. */
export const assembleArgs = (
  pages: PageRef[],
  pathOf: (src: string) => string,
  out: string
): string[] => {
  const [first] = pages;
  if (!first) {
    throw new Error("There are no pages.");
  }
  const args = [pathOf(first.src), "--pages"];
  let i = 0;
  while (i < pages.length) {
    const src = pages[i]?.src ?? "";
    const run: number[] = [];
    while (i < pages.length && pages[i]?.src === src) {
      run.push(pages[i]?.index ?? 0);
      i += 1;
    }
    args.push(pathOf(src), qpdfRanges(run));
  }
  args.push("--");
  const byAngle = new Map<number, number[]>();
  for (const [at, p] of pages.entries()) {
    const angle = ((p.rotate % 360) + 360) % 360;
    if (angle !== 0) {
      byAngle.set(angle, [...(byAngle.get(angle) ?? []), at]);
    }
  }
  for (const [angle, at] of byAngle) {
    args.push(`--rotate=+${angle}:${formatRanges(at)}`);
  }
  args.push(out);
  return args;
};

/** Each Source's bookmarks, renumbered to where its pages landed. */
const carriedOutline = (
  pages: PageRef[],
  sources: Map<string, AssemblySource>
): Bookmark[] => {
  // Where each Source page first appears in the output.
  const landed = new Map<string, Map<number, number>>();
  for (const [at, p] of pages.entries()) {
    const m = landed.get(p.src) ?? new Map<number, number>();
    if (!m.has(p.index)) {
      m.set(p.index, at);
    }
    landed.set(p.src, m);
  }
  const groups: { name: string; first: number; items: Bookmark[] }[] = [];
  for (const [id, m] of landed) {
    const src = sources.get(id);
    if (!src || src.outline.length === 0) {
      continue;
    }
    const items = remapOutline(src.outline, (page) => m.get(page));
    if (items.length > 0) {
      groups.push({ first: Math.min(...m.values()), items, name: src.name });
    }
  }
  const [only] = groups;
  if (groups.length === 1 && only) {
    return only.items;
  }
  // Several files' bookmarks, each under its file name, in page order.
  return groups
    .toSorted((a, b) => a.first - b.first)
    .map((g) => ({
      children: g.items,
      open: false,
      page: g.first,
      title: g.name,
      y: null,
    }));
};

/** The output is the first Source untouched: the same pages, in order, none turned. */
export const isIdentity = (pages: PageRef[], count: number): boolean => {
  const [first] = pages;
  return (
    first !== undefined &&
    pages.length === count &&
    pages.every(
      (p, i) => p.src === first.src && p.index === i && p.rotate % 360 === 0
    )
  );
};

export const assemble = (
  env: Env,
  pages: PageRef[],
  sources: Map<string, AssemblySource>
): Uint8Array => {
  const pathOf = (id: string) => {
    const src = sources.get(id);
    if (!src) {
      throw new Error(`No Source ${id}.`);
    }
    return src.path;
  };
  const out = "/out/assembled.pdf";
  const { bytes } = env.qpdf.produce(
    "Could not put the pages together",
    {},
    assembleArgs(pages, pathOf, out),
    out
  );
  const outline = carriedOutline(pages, sources);
  const primary = sources.get(pages[0]?.src ?? "");
  if (outline.length === 0 && (primary?.outline.length ?? 0) === 0) {
    return bytes;
  }
  // The primary's own outline came through qpdf as it was; replace it with the carried one.
  const doc = openPdf(env, bytes);
  try {
    writeOutline(doc, outline);
    return savePdf(doc);
  } finally {
    doc.destroy();
  }
};
