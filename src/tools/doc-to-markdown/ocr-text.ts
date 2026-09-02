// Turning recognized text into Markdown. OCR gives lines grouped into
// paragraphs by layout, nothing more; this module writes those out line for
// line, paragraphs separated by a blank line, and marks where each page's OCR
// text begins with an HTML comment, so provenance is visible in the source
// and invisible when rendered.

/** One recognized paragraph: its lines in reading order, already trimmed. */
export type OcrParagraph = string[];

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

/**
 * Markdown for one unit of OCR output. `label` names it: "page 3" inside a PDF, or
 * "image" for a standalone picture. Always ends with a single newline.
 */
export function ocrMarkdown(label: string, paragraphs: OcrParagraph[]): string {
  const clean = cleanParagraphs(paragraphs);
  if (clean.length === 0) return `<!-- ${label}, OCR: no text found -->\n`;
  return `<!-- ${label}, OCR -->\n\n` + clean.join("\n\n") + "\n";
}
