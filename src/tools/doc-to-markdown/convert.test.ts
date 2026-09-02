// Unit tests for the engine-free parts of Document to Markdown. Run: bun test
import { describe, expect, test } from "bun:test";
import { ACCEPT, detect, extensionOf } from "./detect";
import { cleanLines, cleanParagraphs, gateByConfidence, ocrMarkdown } from "./ocr-text";
import { joinPages, markPage, paragraphsFromTextItems, splitByMarkers } from "./pages";

const bytes = (...b: (number | string)[]) => {
  const out: number[] = [];
  for (const x of b) {
    if (typeof x === "string") for (const c of x) out.push(c.charCodeAt(0));
    else out.push(x);
  }
  return new Uint8Array(out);
};

describe("detect", () => {
  test("images by signature, whatever the name says", () => {
    expect(detect(bytes(0x89, "PNG\r\n", 0x1a, "\n"), "scan.pdf")).toEqual({ kind: "image", format: "png" });
    expect(detect(bytes(0xff, 0xd8, 0xff, 0xe0), "")).toEqual({ kind: "image", format: "jpeg" });
    expect(detect(bytes("RIFF", 0, 0, 0, 0, "WEBP"), "x")).toEqual({ kind: "image", format: "webp" });
    expect(detect(bytes("II*", 0), "x.tif")).toEqual({ kind: "image", format: "tiff" });
  });
  test("office by signature", () => {
    expect(detect(bytes("%PDF-1.7"), "x")).toEqual({ kind: "office", format: "pdf" });
    expect(detect(bytes("{\\rtf1"), "x.txt")).toEqual({ kind: "office", format: "rtf" });
  });
  test("zip and OLE containers take the family from the extension", () => {
    expect(detect(bytes("PK", 3, 4), "a.xlsx")).toEqual({ kind: "office", format: "xlsx" });
    expect(detect(bytes("PK", 3, 4), "a.ppsm")).toEqual({ kind: "office", format: "pptx" });
    expect(detect(bytes("PK", 3, 4), "a.zip")).toEqual({ kind: "office", format: "docx" });
    const ole = bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);
    expect(detect(ole, "old.xls")).toEqual({ kind: "office", format: "xlsx" });
    expect(detect(ole, "old.pps")).toEqual({ kind: "office", format: "ppt" });
    expect(detect(ole, "old.doc")).toEqual({ kind: "office", format: "doc" });
  });
  test("no signature: extension decides, else unknown", () => {
    expect(detect(bytes("a,b\n1,2\n"), "data.csv")).toEqual({ kind: "office", format: "csv" });
    expect(detect(bytes("a,b\n1,2\n"), "data.CSV")).toEqual({ kind: "office", format: "csv" });
    expect(detect(bytes("hello"), "notes.txt")).toEqual({ kind: "unknown", ext: "txt" });
    expect(detect(bytes("hello"), "noext")).toEqual({ kind: "unknown", ext: "" });
  });
  test("extensions and accept list", () => {
    expect(extensionOf("a.b.DOCX")).toBe("docx");
    expect(extensionOf(".hidden")).toBe("");
    expect(ACCEPT.split(",")).toContain(".xlsb");
    expect(ACCEPT.split(",")).toContain(".tiff");
  });
});

describe("ocr text", () => {
  test("gateByConfidence keeps confident lines and drops empty paragraphs", () => {
    const measured = [
      [{ text: "Revenue by quarter", confidence: 96 }, { text: "| i /", confidence: 42 }],
      [{ text: "MAN IN", confidence: 25 }, { text: "AAPA NO", confidence: 19 }],
      [{ text: "Q1 Q2 Q3 Q4", confidence: 89 }],
    ];
    expect(gateByConfidence(measured)).toEqual([["Revenue by quarter"], ["Q1 Q2 Q3 Q4"]]);
    expect(gateByConfidence(measured, 20)).toEqual([["Revenue by quarter", "| i /"], ["MAN IN"], ["Q1 Q2 Q3 Q4"]]);
    expect(gateByConfidence([[{ text: "eg", confidence: 20 }]])).toEqual([]);
  });
  test("lines are kept one per line; a hyphen before a lowercase continuation is a broken word", () => {
    expect(cleanLines(["The quick", "brown fox"])).toEqual(["The quick", "brown fox"]);
    expect(cleanLines(["a well-", "known fact"])).toEqual(["a wellknown fact"]);
    expect(cleanLines(["the Franco-", "Prussian war"])).toEqual(["the Franco-", "Prussian war"]);
    expect(cleanLines(["  ", "x", ""])).toEqual(["x"]);
  });
  test("cleanParagraphs drops empties, collapses runs of spaces, keeps line breaks", () => {
    expect(cleanParagraphs([["a  b", "c"], [""], ["   "], ["d"]])).toEqual(["a b\nc", "d"]);
  });
  test("ocrMarkdown without a label is just the body", () => {
    expect(ocrMarkdown(null, [["One"], ["Two", "lines"]])).toBe("One\n\nTwo\nlines\n");
    expect(ocrMarkdown(null, [])).toBe("");
  });
  test("ocrMarkdown marks the page with a comment", () => {
    expect(ocrMarkdown("page 3", [["One"], ["Two", "lines"]])).toBe("<!-- page 3, OCR -->\n\nOne\n\nTwo\nlines\n");
    expect(ocrMarkdown("image", [])).toBe("<!-- image, OCR: no text found -->\n");
  });
});

describe("pages", () => {
  test("markPage announces text, OCR, and empty pages when markers are on", () => {
    expect(markPage(1, "text", "# Title\n", true)).toBe("<!-- page 1 -->\n\n# Title\n");
    expect(markPage(2, "ocr", "Scan.\n", true)).toBe("<!-- page 2, OCR -->\n\nScan.\n");
    expect(markPage(3, "text", "", true)).toBe("<!-- page 3, no text -->\n");
    expect(markPage(4, "ocr", "  \n", true)).toBe("<!-- page 4, OCR: no text found -->\n");
  });
  test("markPage with markers off is the bare body, and nothing for an empty page", () => {
    expect(markPage(1, "text", "# Title\n", false)).toBe("# Title\n");
    expect(markPage(2, "ocr", "Scan.\n", false)).toBe("Scan.\n");
    expect(markPage(3, "text", "", false)).toBe("");
    expect(joinPages([{ page: 3, markdown: "" }, { page: 1, markdown: "a\n" }])).toBe("a\n");
  });
  test("splitByMarkers keys page bodies by number and strips the markers", () => {
    const md = "<!-- Page 1 -->\n\n# Title\n\nBody.\n\n<!-- Page 4 -->\n\nLater.\n";
    const pages = splitByMarkers(md);
    expect([...pages.keys()]).toEqual([1, 4]);
    expect(pages.get(1)).toBe("# Title\n\nBody.\n\n");
    expect(pages.get(4)).toBe("Later.\n");
  });
  test("splitByMarkers with no markers is empty", () => {
    expect(splitByMarkers("plain\n").size).toBe(0);
  });
  test("joinPages orders by page and normalizes the seams", () => {
    const out = joinPages([
      { page: 3, markdown: "<!-- page 3, OCR -->\n\nScan.\n" },
      { page: 1, markdown: "# One\n\n" },
      { page: 2, markdown: "   \n" },
    ]);
    expect(out).toBe("# One\n\n<!-- page 3, OCR -->\n\nScan.\n");
    expect(joinPages([])).toBe("");
  });
  test("paragraphsFromTextItems breaks lines on EOL or baseline jumps and paragraphs on big gaps", () => {
    const items = [
      { str: "Hello ", transform: [10, 0, 0, 10, 0, 700], hasEOL: false },
      { str: "world", transform: [10, 0, 0, 10, 40, 700], hasEOL: true },
      { str: "second line", transform: [10, 0, 0, 10, 0, 688], hasEOL: false },
      { str: "new para", transform: [10, 0, 0, 10, 0, 650], hasEOL: false },
    ];
    expect(paragraphsFromTextItems(items)).toEqual([["Hello world", "second line"], ["new para"]]);
  });
});
