import { expect, test } from "bun:test";

import * as mupdf from "mupdf";

import { makePdf, openTest, pageTexts, testEnv } from "../test-env";
import { annotate, listAnnots, selectText } from "./annotate";
import { PAGE_TEXT_FIXTURE } from "./fixtures";
import { addFields, fillFields, flatten, readFields } from "./forms";
import { isCardNumber, isIban, isPhone, luhn, scanPii } from "./pii";
import { extractText, pageText, queryRegExp, search } from "./text";

/** One page with the given lines of Helvetica text, from the top. */
const textPdf = (lines: string[]): Uint8Array => {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font("Helvetica"));
  const resources = doc.newDictionary();
  const fonts = doc.newDictionary();
  fonts.put("F1", font);
  resources.put("Font", fonts);
  const body = lines
    .map(
      (l, i) =>
        `BT /F1 12 Tf 72 ${770 - i * 20} Td (${l.replaceAll(/[\\()]/gu, (c) => `\\${c}`)}) Tj ET`
    )
    .join("\n");
  doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, resources, body));
  return new Uint8Array(doc.saveToBuffer("").asUint8Array());
};

test("page text keeps a quad for every character and a break between lines", () => {
  const doc = openTest(textPdf(["Hello world", "Second line"]));
  const pt = pageText(doc.loadPage(0));
  // Each line is a text block of its own here, so a blank line parts them.
  expect(pt.text).toContain("Hello world\n\nSecond line");
  expect(pt.quads.length).toBe(pt.text.length);
  expect(pt.quads[pt.text.indexOf("\n")]).toBeNull();
});

test("search matches across a line break, case-insensitively, whole words when asked", () => {
  const doc = openTest(textPdf(["The quick brown", "fox jumps; foxes run"]));
  const re = queryRegExp("brown fox", {
    caseSensitive: false,
    regex: false,
    wholeWords: false,
  });
  if (typeof re === "string") {
    throw new TypeError(re);
  }
  const [hit] = search(doc, re);
  expect(hit?.quads.length).toBe(2);
  const whole = queryRegExp("FOX", {
    caseSensitive: false,
    regex: false,
    wholeWords: true,
  });
  if (typeof whole === "string") {
    throw new TypeError(whole);
  }
  expect(search(doc, whole).length).toBe(1);
  expect(
    typeof queryRegExp("(", {
      caseSensitive: false,
      regex: true,
      wholeWords: false,
    })
  ).toBe("string");
});

test("text comes out page by page", () => {
  const doc = openTest(makePdf(2));
  expect(extractText(doc, true)).toBe(
    "--- Page 1 ---\n\nPage 1\n\n--- Page 2 ---\n\nPage 2\n"
  );
});

test("checksums tell real numbers from look-alikes", () => {
  expect(luhn("4111111111111111")).toBe(true);
  expect(isCardNumber("4111 1111 1111 1111")).toBe(true);
  expect(isCardNumber("4111 1111 1111 1112")).toBe(false);
  expect(isIban("DE89 3704 0044 0532 0130 00")).toBe(true);
  expect(isIban("DE89 3704 0044 0532 0130 01")).toBe(false);
  expect(isPhone("+44 20 7946 0958")).toBe(true);
  expect(isPhone("20250101")).toBe(false);
});

test("a PII scan finds each kind once, masked, and not the decoys", () => {
  const doc = openTest(textPdf(PAGE_TEXT_FIXTURE));
  const found = scanPii(doc, ["email", "phone", "card", "ssn", "iban"]);
  expect(found.map((f) => [f.kind, f.masked])).toEqual([
    ["email", "j•••@example.com"],
    ["phone", "•••58"],
    ["card", "•••• 1111"],
    ["ssn", "•••-••-6789"],
    ["iban", "DE89 •••• 3000"],
  ]);
  for (const f of found) {
    expect(f.context).not.toContain("4111 1111 1111 1111");
    expect(f.context).not.toContain("jane.doe");
  }
});

test("annotations are added in display space, listed, and removed", async () => {
  const env = await testEnv();
  const src = textPdf(["Highlight me please"]);
  const page = openTest(src).loadPage(0);
  const quads = selectText(page, [70, 60], [200, 80]);
  expect(quads.length).toBeGreaterThan(0);
  const out = annotate(env, src, {
    add: [
      { color: "#ffff00", kind: "highlight", opacity: 0.5, page: 0, quads },
      {
        color: "#ff0000",
        kind: "note",
        opacity: 1,
        page: 0,
        rect: [300, 300, 300, 300],
        text: "Look",
      },
      {
        color: "#0000ff",
        ink: [
          [
            [100, 400],
            [150, 450],
            [200, 400],
          ],
        ],
        kind: "ink",
        opacity: 1,
        page: 0,
        width: 2,
      },
      {
        color: "#000000",
        fontSize: 14,
        kind: "text",
        opacity: 1,
        page: 0,
        rect: [100, 500, 300, 530],
        text: "Boxed",
      },
      {
        color: "#00aa00",
        kind: "arrow",
        line: [
          [100, 600],
          [200, 650],
        ],
        opacity: 1,
        page: 0,
        width: 1,
      },
    ],
    remove: [],
  });
  const listed = listAnnots(openTest(out));
  expect(listed.map((a) => a.type)).toEqual([
    "Highlight",
    "Text",
    "Ink",
    "FreeText",
    "Line",
  ]);
  expect(listed[1]?.contents).toBe("Look");
  const fewer = annotate(env, out, {
    add: [],
    remove: [{ index: 1, page: 0 }],
  });
  expect(listAnnots(openTest(fewer)).map((a) => a.type)).toEqual([
    "Highlight",
    "Ink",
    "FreeText",
    "Line",
  ]);
});

test("new fields are fillable, filled values read back, and flattening fixes them", async () => {
  const env = await testEnv();
  const withFields = addFields(env, makePdf(1), [
    {
      fontSize: 0,
      name: "Name",
      options: [],
      page: 0,
      rect: [72, 100, 300, 124],
      type: "text",
      value: "",
    },
    {
      fontSize: 0,
      name: "Agree",
      options: [],
      page: 0,
      rect: [72, 140, 86, 154],
      type: "checkbox",
      value: "",
    },
    {
      fontSize: 12,
      name: "Size",
      options: ["S", "M", "L"],
      page: 0,
      rect: [72, 170, 200, 190],
      type: "combobox",
      value: "M",
    },
    {
      fontSize: 0,
      name: "Name",
      options: [],
      page: 0,
      rect: [72, 200, 300, 224],
      type: "text",
      value: "",
    },
  ]);
  const fields = readFields(openTest(withFields));
  expect(fields.map((f) => [f.name, f.type])).toEqual([
    ["Name", "text"],
    ["Agree", "checkbox"],
    ["Size", "combobox"],
    ["Name 2", "text"],
  ]);
  expect(fields[2]?.options).toEqual(["S", "M", "L"]);
  const filled = fillFields(env, withFields, {
    flatten: false,
    values: {
      Agree: fields[1]?.onState ?? "Yes",
      Name: "Ada Lovelace",
      Size: "L",
    },
  });
  const after = readFields(openTest(filled));
  expect(after.map((f) => f.value)).toEqual([
    "Ada Lovelace",
    fields[1]?.onState,
    "L",
    "",
  ]);
  const flat = flatten(env, filled, { annotations: true, forms: true });
  expect(readFields(openTest(flat))).toEqual([]);
  expect(pageTexts(flat)[0]).toContain("Ada Lovelace");
});
