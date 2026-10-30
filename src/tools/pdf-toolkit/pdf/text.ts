// A page's text with where each character is, so anything found in it (a
// search, a PII finding, a phrase to redact) can be pointed at on the page.
// MuPDF's own search stops at 500 hits a page and knows nothing of regular
// expressions; matching against the text here does both.

import type { PDFDocument, PDFPage } from "mupdf";

export type Quad = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export interface PageText {
  text: string;
  /** For each UTF-16 unit of `text`, the quad of the character it belongs to; null for the line and block breaks added between them. */
  quads: (Quad | null)[];
}

export const pageText = (page: PDFPage): PageText => {
  const stext = page.toStructuredText("preserve-whitespace");
  let text = "";
  const quads: (Quad | null)[] = [];
  const brk = () => {
    if (text !== "" && !text.endsWith("\n")) {
      text += "\n";
      quads.push(null);
    }
  };
  try {
    stext.walk({
      endLine: brk,
      endTextBlock: () => {
        brk();
        text += "\n";
        quads.push(null);
      },
      onChar: (c, _origin, _font, _size, quad) => {
        text += c;
        // One entry per UTF-16 unit: a character outside the BMP is two.
        quads.push(...Array.from({ length: c.length }, () => quad as Quad));
      },
    });
  } finally {
    stext.destroy();
  }
  return { quads, text };
};

/** The rectangle around a run of quads, as a quad. */
const hull = (qs: Quad[]): Quad => {
  const xs = qs.flatMap((q) => [q[0], q[2], q[4], q[6]]);
  const ys = qs.flatMap((q) => [q[1], q[3], q[5], q[7]]);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  const x1 = Math.max(...xs);
  const y1 = Math.max(...ys);
  return [x0, y0, x1, y0, x0, y1, x1, y1];
};

/** The quads of `text[start..end)`, one per line it spans. */
export const quadsOf = (pt: PageText, start: number, end: number): Quad[] => {
  const lines: Quad[][] = [];
  let line: Quad[] = [];
  let last: Quad | null = null;
  for (let i = start; i < end; i += 1) {
    const q = pt.quads[i] ?? null;
    if (q === null) {
      if (line.length) {
        lines.push(line);
      }
      line = [];
      last = null;
    } else if (q !== last) {
      line.push(q);
      last = q;
    }
  }
  if (line.length) {
    lines.push(line);
  }
  return lines.map(hull);
};

export interface Hit {
  /** 0-based page. */
  page: number;
  /** What matched, as written. */
  text: string;
  /** The line around it. */
  context: string;
  quads: Quad[];
}

/** The text around a match, on one line, at most about `reach` characters either side. */
export const contextOf = (
  text: string,
  start: number,
  end: number,
  reach = 40
): string => {
  const from = Math.max(0, start - reach);
  const to = Math.min(text.length, end + reach);
  const before = text.slice(from, start).replaceAll(/\s+/gu, " ");
  const after = text.slice(end, to).replaceAll(/\s+/gu, " ");
  return `${from > 0 ? "…" : ""}${before}${text.slice(start, end)}${after}${to < text.length ? "…" : ""}`;
};

export const findIn = (
  pt: PageText,
  re: RegExp,
  page: number,
  limit = Infinity
): Hit[] => {
  const hits: Hit[] = [];
  const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
  const global = new RegExp(re.source, flags);
  for (const m of pt.text.matchAll(global)) {
    if (hits.length >= limit) {
      break;
    }
    const start = m.index;
    const end = start + m[0].length;
    if (end === start) {
      continue;
    }
    const quads = quadsOf(pt, start, end);
    if (quads.length) {
      hits.push({
        context: contextOf(pt.text, start, end),
        page,
        quads,
        text: m[0],
      });
    }
  }
  return hits;
};

const escapeRegExp = (s: string) =>
  s.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");

export interface SearchOptions {
  caseSensitive: boolean;
  wholeWords: boolean;
  /** The query is a regular expression. */
  regex: boolean;
}

/** The query as a regular expression, or the reason it is not one. */
export const queryRegExp = (
  query: string,
  o: SearchOptions
): RegExp | string => {
  // Whitespace in a query matches any run of it, line breaks included.
  const body = o.regex
    ? query
    : query.trim().split(/\s+/u).map(escapeRegExp).join("\\s+");
  const bounded = o.wholeWords
    ? `(?<![\\p{L}\\p{N}])(?:${body})(?![\\p{L}\\p{N}])`
    : body;
  try {
    return new RegExp(bounded, o.caseSensitive ? "gu" : "giu");
  } catch (error) {
    return (error as Error).message;
  }
};

/** Most hits a search returns: past this the list is no use to anyone. */
export const SEARCH_LIMIT = 5000;

export const search = (doc: PDFDocument, re: RegExp): Hit[] => {
  const hits: Hit[] = [];
  const n = doc.countPages();
  for (let i = 0; i < n && hits.length < SEARCH_LIMIT; i += 1) {
    hits.push(
      ...findIn(pageText(doc.loadPage(i)), re, i, SEARCH_LIMIT - hits.length)
    );
  }
  return hits;
};

/** Every page's text, with a form feed between pages (or a heading each, when `headings`). */
export const extractText = (doc: PDFDocument, headings: boolean): string => {
  const parts: string[] = [];
  const n = doc.countPages();
  for (let i = 0; i < n; i += 1) {
    const stext = doc.loadPage(i).toStructuredText("preserve-whitespace");
    const body = stext
      .asText()
      .replaceAll(/\n{3,}/gu, "\n\n")
      .trimEnd();
    stext.destroy();
    parts.push(headings ? `--- Page ${i + 1} ---\n\n${body}\n` : `${body}\n`);
  }
  return parts.join(headings ? "\n" : "\f");
};

/** Whether a page has any text to select at all. */
export const hasText = (page: PDFPage): boolean => {
  const stext = page.toStructuredText("");
  try {
    return stext.asText().trim() !== "";
  } finally {
    stext.destroy();
  }
};
