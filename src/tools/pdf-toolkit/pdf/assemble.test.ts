import { expect, test } from "bun:test";

import { openTest, makePdf, pageTexts, testEnv } from "../test-env";
import { assemble, assembleArgs, isIdentity } from "./assemble";
import type { AssemblySource, PageRef } from "./assemble";
import { readOutline, writeOutline } from "./outline";

const ref = (src: string, index: number, rotate = 0): PageRef => ({
  index,
  rotate,
  src,
});

test("runs of one Source become one --pages range, rotations one flag per angle", () => {
  const args = assembleArgs(
    [
      ref("a", 0),
      ref("a", 1),
      ref("a", 2),
      ref("b", 4, 90),
      ref("a", 5, 90),
      ref("a", 3, 180),
    ],
    (id) => `/src/${id}.pdf`,
    "/out.pdf"
  );
  expect(args).toEqual([
    "/src/a.pdf",
    "--pages",
    "/src/a.pdf",
    "1-3",
    "/src/b.pdf",
    "5",
    "/src/a.pdf",
    "6,4",
    "--",
    "--rotate=+90:4,5",
    "--rotate=+180:6",
    "/out.pdf",
  ]);
});

test("the untouched first Source is recognized, so it is passed through as is", () => {
  expect(isIdentity([ref("a", 0), ref("a", 1)], 2)).toBe(true);
  expect(isIdentity([ref("a", 1), ref("a", 0)], 2)).toBe(false);
  expect(isIdentity([ref("a", 0), ref("a", 1, 90)], 2)).toBe(false);
  expect(isIdentity([ref("a", 0)], 2)).toBe(false);
});

const withOutline = (bytes: Uint8Array, titles: [string, number][]) => {
  const doc = openTest(bytes);
  writeOutline(
    doc,
    titles.map(([title, page]) => ({
      children: [],
      open: false,
      page,
      title,
      y: null,
    }))
  );
  return new Uint8Array(doc.saveToBuffer("").asUint8Array());
};

test("pages from two files come out in order, turned, with their annotations and bookmarks", async () => {
  const env = await testEnv();
  const a = withOutline(makePdf(3, { label: "A" }), [
    ["Intro", 0],
    ["Último", 2],
  ]);
  const b = makePdf(2, { label: "B" });
  const docB = openTest(b);
  const note = docB.loadPage(1).createAnnotation("Text");
  note.setRect([100, 100, 120, 120]);
  note.setContents("keep me");
  note.update();
  const bWithNote = new Uint8Array(docB.saveToBuffer("").asUint8Array());
  env.qpdf.write("/src/a.pdf", a);
  env.qpdf.write("/src/b.pdf", bWithNote);
  const sources = new Map<string, AssemblySource>([
    [
      "a",
      { name: "a.pdf", outline: readOutline(openTest(a)), path: "/src/a.pdf" },
    ],
    ["b", { name: "b.pdf", outline: [], path: "/src/b.pdf" }],
  ]);
  const out = assemble(
    env,
    [ref("b", 1, 90), ref("a", 2), ref("a", 0)],
    sources
  );
  expect(pageTexts(out)).toEqual(["B 2", "A 3", "A 1"]);
  const doc = openTest(out);
  expect(doc.loadPage(0).getObject().getInheritable("Rotate").asNumber()).toBe(
    90
  );
  expect(
    doc
      .loadPage(0)
      .getAnnotations()
      .map((x) => x.getContents())
  ).toEqual(["keep me"]);
  const outline = readOutline(doc);
  expect(outline.map((o) => [o.title, o.page])).toEqual([
    ["Intro", 2],
    ["Último", 1],
  ]);
});
