// Bookmarks (the document outline): read as a tree of titles and target
// pages, written back as a whole. MuPDF reads an outline well; writing one
// is done here object by object, because a tree built in one pass is
// simpler to get right than one edited through MuPDF's outline iterator.

import type { PDFDocument, PDFObject } from "mupdf";

import { apply, invert } from "./geometry";
import type { Matrix } from "./geometry";

export interface Bookmark {
  title: string;
  /** 0-based page the bookmark opens, or null for one that goes nowhere in the document. */
  page: number | null;
  /** How far down the page, in display space; null for the top. */
  y: number | null;
  /** A web link instead of a page. */
  uri?: string;
  open: boolean;
  children: Bookmark[];
}

interface MupdfOutlineItem {
  title: string | undefined;
  uri: string | undefined;
  open: boolean;
  down?: MupdfOutlineItem[];
  page?: number;
}

const toBookmark = (doc: PDFDocument, item: MupdfOutlineItem): Bookmark => {
  let y: number | null = null;
  const internal = item.uri?.startsWith("#") ?? false;
  if (item.uri && internal) {
    try {
      const dest = doc.resolveLinkDestination(item.uri);
      y = Number.isFinite(dest.y) ? dest.y : null;
    } catch {
      y = null;
    }
  }
  return {
    children: (item.down ?? []).map((c) => toBookmark(doc, c)),
    open: item.open,
    page: item.page ?? null,
    title: item.title ?? "",
    uri: item.uri && !internal ? item.uri : undefined,
    y,
  };
};

export const readOutline = (doc: PDFDocument): Bookmark[] => {
  const items = doc.loadOutline() as MupdfOutlineItem[] | null;
  return (items ?? []).map((i) => toBookmark(doc, i));
};

/** How many bookmarks there are, at every level. */
export const countBookmarks = (items: Bookmark[]): number => {
  let n = 0;
  for (const b of items) {
    n += 1 + countBookmarks(b.children);
  }
  return n;
};

/** Visible descendants of an open item: its children, and theirs while open. */
const visible = (items: Bookmark[]): number => {
  let n = 0;
  for (const b of items) {
    n += 1 + (b.open ? visible(b.children) : 0);
  }
  return n;
};

const destination = (
  doc: PDFDocument,
  b: Bookmark
): { dest?: PDFObject; action?: PDFObject } => {
  if (b.uri) {
    const action = doc.newDictionary();
    action.put("S", doc.newName("URI"));
    action.put("URI", doc.newString(b.uri));
    return { action };
  }
  if (b.page === null || b.page < 0 || b.page >= doc.countPages()) {
    return {};
  }
  const page = doc.loadPage(b.page);
  const dest = doc.newArray();
  for (const part of [page.getObject(), doc.newName("XYZ"), doc.newNull()]) {
    dest.push(part);
  }
  if (b.y === null) {
    dest.push(doc.newNull());
  } else {
    // Display space down the page, as user space up it.
    const [, top] = apply(invert(page.getTransform() as Matrix), [0, b.y]);
    dest.push(doc.newReal(top));
  }
  dest.push(doc.newNull());
  return { dest };
};

/** Write `items` under `parent`; returns the first and last written, for the parent's links. */
const writeLevel = (
  doc: PDFDocument,
  parent: PDFObject,
  items: Bookmark[]
): { first: PDFObject; last: PDFObject } | null => {
  const refs = items.map(() => doc.addObject(doc.newDictionary()));
  for (const [i, b] of items.entries()) {
    const ref = refs[i];
    if (!ref) {
      continue;
    }
    ref.put("Title", doc.newString(b.title));
    ref.put("Parent", parent);
    const prev = refs[i - 1];
    const next = refs[i + 1];
    if (prev) {
      ref.put("Prev", prev);
    }
    if (next) {
      ref.put("Next", next);
    }
    const { dest, action } = destination(doc, b);
    if (dest) {
      ref.put("Dest", dest);
    }
    if (action) {
      ref.put("A", action);
    }
    const kids = writeLevel(doc, ref, b.children);
    if (kids) {
      ref.put("First", kids.first);
      ref.put("Last", kids.last);
      const n = visible(b.children);
      // An open item counts what shows under it; a closed one, negated, what would.
      ref.put("Count", doc.newInteger(b.open ? n : -n));
    }
  }
  const [first] = refs;
  const last = refs.at(-1);
  return first && last ? { first, last } : null;
};

/** Replace the document's outline with `items` (none removes it). */
export const writeOutline = (doc: PDFDocument, items: Bookmark[]) => {
  const root = doc.getTrailer().get("Root");
  if (items.length === 0) {
    root.delete("Outlines");
    return;
  }
  const outlines = doc.addObject(doc.newDictionary());
  outlines.put("Type", doc.newName("Outlines"));
  const top = writeLevel(doc, outlines, items);
  if (top) {
    outlines.put("First", top.first);
    outlines.put("Last", top.last);
    outlines.put("Count", doc.newInteger(visible(items)));
  }
  root.put("Outlines", outlines);
};

/**
 * The bookmarks that still have somewhere to go when pages move: `map`
 * gives each old page's new index, or none for a page that is gone. A
 * bookmark whose page is gone keeps its place if any of its children
 * survive, opening the first of them; otherwise it goes too.
 */
export const remapOutline = (
  items: Bookmark[],
  map: (page: number) => number | undefined
): Bookmark[] => {
  const out: Bookmark[] = [];
  for (const b of items) {
    const children = remapOutline(b.children, map);
    // A heading that opens nothing, or a web link, has no page to lose.
    const page = b.page === null ? null : map(b.page);
    if (page !== undefined) {
      out.push({ ...b, children, page });
    } else if (children.length > 0) {
      out.push({ ...b, children, page: children[0]?.page ?? null, y: null });
    }
  }
  return out;
};
