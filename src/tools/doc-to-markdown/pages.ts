// Assembling a PDF's Markdown from its pages. Text pages come from the
// converter as one Markdown string with `<!-- Page N -->` markers; Scanned
// Pages come from OCR one at a time. Everything here is pure so it can be
// unit-tested without an engine.

const MARKER = /^<!-- Page (\d+) -->[ \t]*(?:\r?\n)*/gm;

/**
 * Split converter output into per-page Markdown, keyed by 1-indexed page
 * number, and strip the markers. Text before the first marker (there should be
 * none) is attached to the first page found.
 */
export function splitByMarkers(markdown: string): Map<number, string> {
  const pages = new Map<number, string>();
  const hits: { page: number; start: number; end: number }[] = [];
  for (const m of markdown.matchAll(MARKER)) {
    hits.push({ page: Number(m[1]), start: m.index, end: m.index + m[0].length });
  }
  if (hits.length === 0) return pages;
  const lead = markdown.slice(0, hits[0]!.start);
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i]!;
    const next = hits[i + 1];
    let body = markdown.slice(h.end, next ? next.start : markdown.length);
    if (i === 0 && lead.trim()) body = lead + body;
    const prev = pages.get(h.page);
    pages.set(h.page, prev ? prev + body : body);
  }
  return pages;
}

/** Lines of a page's text layer as pdf.js reports it, grouped into paragraphs by gaps. */
export interface TextItem {
  str: string;
  /** pdf.js transform: [a, b, c, d, x, y]. */
  transform: number[];
  hasEOL: boolean;
}

/**
 * Fallback for a page whose text layer the converter could not use: reading
 * pdf.js text items in order, breaking lines where pdf.js says a line ends or
 * the baseline jumps, and paragraphs where the jump is more than a line and a
 * half. Plain paragraphs; nothing structural is inferred.
 */
export function paragraphsFromTextItems(items: TextItem[]): string[][] {
  const paragraphs: string[][] = [];
  let lines: string[] = [];
  let line = "";
  let lastY: number | null = null;
  let lastHeight = 0;
  const flushLine = () => {
    if (line.trim()) lines.push(line.trim());
    line = "";
  };
  const flushPara = () => {
    flushLine();
    if (lines.length) paragraphs.push(lines);
    lines = [];
  };
  for (const it of items) {
    const y = it.transform[5] ?? 0;
    const height = Math.abs(it.transform[3] ?? 0) || lastHeight;
    if (lastY !== null && Math.abs(y - lastY) > 0.5 * Math.max(height, 1)) {
      if (Math.abs(y - lastY) > 1.5 * Math.max(height, lastHeight, 1)) flushPara();
      else flushLine();
    }
    line += it.str;
    if (it.hasEOL) flushLine();
    lastY = y;
    if (height) lastHeight = height;
  }
  flushPara();
  return paragraphs;
}

/** Join page segments in page order into one document. Each segment already ends in a newline. */
export function joinPages(segments: { page: number; markdown: string }[]): string {
  const sorted = segments.toSorted((a, b) => a.page - b.page);
  const parts = sorted.map((s) => s.markdown.replace(/\s+$/, "")).filter((s) => s.length > 0);
  return parts.length ? parts.join("\n\n") + "\n" : "";
}
