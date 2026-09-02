// Turning recognized text into Markdown. OCR gives lines grouped into
// paragraphs by layout, nothing more; this module writes those out as plain
// paragraphs and marks where each page's OCR text begins with an HTML comment,
// so provenance is visible in the source and invisible when rendered.

/** One recognized paragraph: its lines in reading order, already trimmed. */
export type OcrParagraph = string[];

/**
 * Join the lines of a paragraph into one line of prose. A line that ends in a
 * hyphen is joined to a following line that starts lowercase without the
 * hyphen, since that is a word broken at the margin; any other hyphen stays.
 */
export function joinLines(lines: string[]): string {
  let out = "";
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (!out) {
      out = line;
      continue;
    }
    if (out.endsWith("-") && /^[a-zà-öø-ÿа-яα-ω]/.test(line)) out = out.slice(0, -1) + line;
    else out += " " + line;
  }
  return out;
}

/** Drop empty paragraphs and collapse runs of whitespace inside each line. */
export function cleanParagraphs(paragraphs: OcrParagraph[]): string[] {
  const out: string[] = [];
  for (const p of paragraphs) {
    const text = joinLines(p.map((l) => l.replace(/[ \t\f\v]+/g, " ")));
    if (text) out.push(text);
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
