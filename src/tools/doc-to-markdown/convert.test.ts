// Unit tests for the engine-free parts of Document to Markdown. Run: bun test
import { describe, expect, test } from "bun:test";

import { ACCEPT, detect, extensionOf } from "./detect";
import {
  cleanLines,
  cleanParagraphs,
  gateByConfidence,
  ocrMarkdown,
} from "./ocr-text";
import {
  joinPages,
  markPage,
  paragraphsFromTextItems,
  splitByMarkers,
} from "./pages";

const bytes = (...b: (number | string)[]) => {
  const out: number[] = [];
  for (const x of b) {
    if (typeof x === "string") {
      for (const c of x) {
        const code = c.codePointAt(0);
        if (code === undefined) {
          throw new Error(
            "unreachable: iterating a string yields no empty strings"
          );
        }
        out.push(code);
      }
    } else {
      out.push(x);
    }
  }
  return new Uint8Array(out);
};

describe("detect", () => {
  test("images by signature, whatever the name says", () => {
    expect(detect(bytes(0x89, "PNG\r\n", 0x1a, "\n"), "scan.pdf")).toEqual({
      format: "png",
      kind: "image",
    });
    expect(detect(bytes(0xff, 0xd8, 0xff, 0xe0), "")).toEqual({
      format: "jpeg",
      kind: "image",
    });
    expect(detect(bytes("RIFF", 0, 0, 0, 0, "WEBP"), "x")).toEqual({
      format: "webp",
      kind: "image",
    });
    expect(detect(bytes("II*", 0), "x.tif")).toEqual({
      format: "tiff",
      kind: "image",
    });
  });
  test("office by signature", () => {
    expect(detect(bytes("%PDF-1.7"), "x")).toEqual({
      format: "pdf",
      kind: "office",
    });
    expect(detect(bytes("{\\rtf1"), "x.txt")).toEqual({
      format: "rtf",
      kind: "office",
    });
  });
  test("zip and OLE containers take the family from the extension", () => {
    expect(detect(bytes("PK", 3, 4), "a.xlsx")).toEqual({
      format: "xlsx",
      kind: "office",
    });
    expect(detect(bytes("PK", 3, 4), "a.ppsm")).toEqual({
      format: "pptx",
      kind: "office",
    });
    expect(detect(bytes("PK", 3, 4), "a.zip")).toEqual({
      format: "docx",
      kind: "office",
    });
    const ole = bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);
    expect(detect(ole, "old.xls")).toEqual({ format: "xlsx", kind: "office" });
    expect(detect(ole, "old.pps")).toEqual({ format: "ppt", kind: "office" });
    expect(detect(ole, "old.doc")).toEqual({ format: "doc", kind: "office" });
  });
  test("no signature: extension decides, else unknown", () => {
    expect(detect(bytes("a,b\n1,2\n"), "data.csv")).toEqual({
      format: "csv",
      kind: "office",
    });
    expect(detect(bytes("a,b\n1,2\n"), "data.CSV")).toEqual({
      format: "csv",
      kind: "office",
    });
    expect(detect(bytes("hello"), "notes.txt")).toEqual({
      ext: "txt",
      kind: "unknown",
    });
    expect(detect(bytes("hello"), "noext")).toEqual({
      ext: "",
      kind: "unknown",
    });
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
      [
        { confidence: 96, text: "Revenue by quarter" },
        { confidence: 42, text: "| i /" },
      ],
      [
        { confidence: 25, text: "MAN IN" },
        { confidence: 19, text: "AAPA NO" },
      ],
      [{ confidence: 89, text: "Q1 Q2 Q3 Q4" }],
    ];
    expect(gateByConfidence(measured)).toEqual([
      ["Revenue by quarter"],
      ["Q1 Q2 Q3 Q4"],
    ]);
    expect(gateByConfidence(measured, 20)).toEqual([
      ["Revenue by quarter", "| i /"],
      ["MAN IN"],
      ["Q1 Q2 Q3 Q4"],
    ]);
    expect(gateByConfidence([[{ confidence: 20, text: "eg" }]])).toEqual([]);
  });
  test("lines are kept one per line; a hyphen before a lowercase continuation is a broken word", () => {
    expect(cleanLines(["The quick", "brown fox"])).toEqual([
      "The quick",
      "brown fox",
    ]);
    expect(cleanLines(["a well-", "known fact"])).toEqual(["a wellknown fact"]);
    expect(cleanLines(["the Franco-", "Prussian war"])).toEqual([
      "the Franco-",
      "Prussian war",
    ]);
    expect(cleanLines(["  ", "x", ""])).toEqual(["x"]);
  });
  test("cleanParagraphs drops empties, collapses runs of spaces, keeps line breaks", () => {
    expect(cleanParagraphs([["a  b", "c"], [""], ["   "], ["d"]])).toEqual([
      "a b\nc",
      "d",
    ]);
  });
  test("ocrMarkdown without a label is just the body", () => {
    expect(ocrMarkdown(null, [["One"], ["Two", "lines"]])).toBe(
      "One\n\nTwo\nlines\n"
    );
    expect(ocrMarkdown(null, [])).toBe("");
  });
  test("ocrMarkdown marks the page with a comment", () => {
    expect(ocrMarkdown("page 3", [["One"], ["Two", "lines"]])).toBe(
      "<!-- page 3, OCR -->\n\nOne\n\nTwo\nlines\n"
    );
    expect(ocrMarkdown("image", [])).toBe(
      "<!-- image, OCR: no text found -->\n"
    );
  });
});

describe("pages", () => {
  test("markPage announces text, OCR, and empty pages when markers are on", () => {
    expect(markPage(1, "text", "# Title\n", true)).toBe(
      "<!-- page 1 -->\n\n# Title\n"
    );
    expect(markPage(2, "ocr", "Scan.\n", true)).toBe(
      "<!-- page 2, OCR -->\n\nScan.\n"
    );
    expect(markPage(3, "text", "", true)).toBe("<!-- page 3, no text -->\n");
    expect(markPage(4, "ocr", "  \n", true)).toBe(
      "<!-- page 4, OCR: no text found -->\n"
    );
  });
  test("markPage with markers off is the bare body, and nothing for an empty page", () => {
    expect(markPage(1, "text", "# Title\n", false)).toBe("# Title\n");
    expect(markPage(2, "ocr", "Scan.\n", false)).toBe("Scan.\n");
    expect(markPage(3, "text", "", false)).toBe("");
    expect(
      joinPages([
        { markdown: "", page: 3 },
        { markdown: "a\n", page: 1 },
      ])
    ).toBe("a\n");
  });
  test("splitByMarkers keys page bodies by number and strips the markers", () => {
    const md =
      "<!-- Page 1 -->\n\n# Title\n\nBody.\n\n<!-- Page 4 -->\n\nLater.\n";
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
      { markdown: "<!-- page 3, OCR -->\n\nScan.\n", page: 3 },
      { markdown: "# One\n\n", page: 1 },
      { markdown: "   \n", page: 2 },
    ]);
    expect(out).toBe("# One\n\n<!-- page 3, OCR -->\n\nScan.\n");
    expect(joinPages([])).toBe("");
  });
  test("paragraphsFromTextItems breaks lines on EOL or baseline jumps and paragraphs on big gaps", () => {
    const items = [
      { hasEOL: false, str: "Hello ", transform: [10, 0, 0, 10, 0, 700] },
      { hasEOL: true, str: "world", transform: [10, 0, 0, 10, 40, 700] },
      { hasEOL: false, str: "second line", transform: [10, 0, 0, 10, 0, 688] },
      { hasEOL: false, str: "new para", transform: [10, 0, 0, 10, 0, 650] },
    ];
    expect(paragraphsFromTextItems(items)).toEqual([
      ["Hello world", "second line"],
      ["new para"],
    ]);
  });
});
