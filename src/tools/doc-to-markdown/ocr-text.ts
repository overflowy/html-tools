// Turning recognized text into Markdown. OCR gives lines grouped into
// paragraphs by layout, nothing more; this module writes those out line for
// line, paragraphs separated by a blank line, and marks where each page's OCR
// text begins with an HTML comment, so provenance is visible in the source
// and invisible when rendered.

/** One recognized paragraph: its lines in reading order, already trimmed. */
export type OcrParagraph = string[];

/** A line as the recognizer reports it, with its confidence (0 to 100). */
export interface OcrLine {
  text: string;
  confidence: number;
}

/**
 * The least confidence a line needs to be kept. To the recognizer a chart, a
 * photo, or a diagram is just shapes, and it reads them as short scraps of
 * nonsense at 3 to 45; prose on a real scan, and the labels on a chart, come
 * back at 85 to 96. Between those, with room on both sides.
 */
export const OCR_MIN_CONFIDENCE = 60;

/**
 * Drop every line the recognizer was not confident about, and every
 * paragraph that has nothing left. A figure page comes out empty, a scanned
 * page keeps its text, a labelled chart keeps its labels.
 */
export function gateByConfidence(paragraphs: OcrLine[][], min = OCR_MIN_CONFIDENCE): OcrParagraph[] {
  const out: OcrParagraph[] = [];
  for (const p of paragraphs) {
    const kept = p.filter((l) => l.confidence >= min).map((l) => l.text);
    if (kept.length) out.push(kept);
  }
  return out;
}

/**
 * The lines of a paragraph, one per line as recognized. Markdown reads a
 * single newline as a soft break, so prose still flows when rendered while
 * lists, addresses, and table-like layouts keep their shape in the source.
 * A line that ends in a hyphen is joined to a following line that starts
 * lowercase without the hyphen, since that is a word broken at the margin;
 * any other hyphen stays.
 */
export function cleanLines(lines: string[]): string[] {
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/[ \t\f\v]+/g, " ").trim();
    if (!line) continue;
    const prev = out[out.length - 1];
    if (prev !== undefined && prev.endsWith("-") && /^[a-zà-öø-ÿа-яα-ω]/.test(line)) out[out.length - 1] = prev.slice(0, -1) + line;
    else out.push(line);
  }
  return out;
}

/** Drop empty paragraphs; each surviving paragraph is its lines joined by newlines. */
export function cleanParagraphs(paragraphs: OcrParagraph[]): string[] {
  const out: string[] = [];
  for (const p of paragraphs) {
    const lines = cleanLines(p);
    if (lines.length) out.push(lines.join("\n"));
  }
  return out;
}

/** The recognized text as Markdown body: paragraphs separated by blank lines, ending in a newline, or "" when nothing was read. */
export function ocrBody(paragraphs: OcrParagraph[]): string {
  const clean = cleanParagraphs(paragraphs);
  return clean.length ? clean.join("\n\n") + "\n" : "";
}

/**
 * Markdown for one unit of OCR output. `label` names it in a leading comment
 * ("image", "page 3"); null means no comment at all, just the body.
 */
export function ocrMarkdown(label: string | null, paragraphs: OcrParagraph[]): string {
  const body = ocrBody(paragraphs);
  if (label === null) return body;
  if (!body) return `<!-- ${label}, OCR: no text found -->\n`;
  return `<!-- ${label}, OCR -->\n\n` + body;
}
