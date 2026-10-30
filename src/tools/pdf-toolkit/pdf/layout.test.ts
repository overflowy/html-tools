import { expect, test } from "bun:test";

import { makePdf, openTest, pageTexts, testEnv } from "../test-env";
import { PAPER } from "./geometry";
import {
  booklet,
  bookletOrder,
  crop,
  nup,
  poster,
  scalePages,
  splitSpreads,
  stitch,
} from "./layout";

const sizes = (bytes: Uint8Array) => {
  const doc = openTest(bytes);
  const out: [number, number][] = [];
  for (let i = 0; i < doc.countPages(); i += 1) {
    const [x0, y0, x1, y1] = doc.loadPage(i).getBounds();
    out.push([Math.round(x1 - x0), Math.round(y1 - y0)]);
  }
  return out;
};

test("4-up puts four pages on each sheet, in reading order", async () => {
  const env = await testEnv();
  const out = nup(env, makePdf(6), {
    borders: true,
    margin: 5,
    order: "rows",
    orientation: "auto",
    perSheet: 4,
    rtl: false,
    sheet: "same",
    spacing: 3,
  });
  expect(pageTexts(out)).toEqual([
    "Page 1 Page 2 Page 3 Page 4",
    "Page 5 Page 6",
  ]);
  expect(sizes(out)).toEqual([
    [595, 842],
    [595, 842],
  ]);
});

test("2-up of portrait pages turns the sheet to landscape", async () => {
  const env = await testEnv();
  const out = nup(env, makePdf(2), {
    borders: false,
    margin: 0,
    order: "rows",
    orientation: "auto",
    perSheet: 2,
    rtl: true,
    sheet: "a4",
    spacing: 0,
  });
  expect(sizes(out)).toEqual([[842, 595]]);
  // Right to left: the first page is on the right half.
  const [[first] = []] = openTest(out).loadPage(0).search("Page 1", "");
  expect(first?.[0]).toBeGreaterThan(421);
});

test("booklet order folds into page order", () => {
  expect(bookletOrder(8)).toEqual([
    [7, 0],
    [1, 6],
    [5, 2],
    [3, 4],
  ]);
  expect(bookletOrder(5)).toEqual([
    [null, 0],
    [1, null],
    [null, 2],
    [3, 4],
  ]);
});

test("a booklet of five pages is four sheet sides of two", async () => {
  const env = await testEnv();
  const out = booklet(env, makePdf(5), {
    binding: "left",
    foldLine: true,
    gutter: 0,
    sheet: "same",
  });
  expect(sizes(out)).toEqual([
    [1190, 842],
    [1190, 842],
    [1190, 842],
    [1190, 842],
  ]);
  expect(pageTexts(out)).toEqual([
    "Page 1",
    "Page 2",
    "Page 3",
    "Page 4 Page 5",
  ]);
});

test("a 2×2 poster is four A4 tiles of one page", async () => {
  const env = await testEnv();
  const out = poster(env, makePdf(1), {
    cols: 2,
    guides: true,
    orientation: "portrait",
    overlap: 10,
    rows: 2,
    sheet: "a4",
  });
  expect(sizes(out).length).toBe(4);
  // The heading is at the top left: on the first tile, not the last.
  const texts = pageTexts(out);
  expect(texts[0]).toContain("Page 1");
  expect(texts[3]).not.toContain("Page 1");
});

test("stitching stacks every page on one", async () => {
  const env = await testEnv();
  const out = stitch(env, makePdf(3), {
    direction: "vertical",
    margin: 0,
    spacing: 0,
  });
  expect(sizes(out)).toEqual([[595, 2526]]);
  expect(pageTexts(out)).toEqual(["Page 1 Page 2 Page 3"]);
});

test("scaling Letter pages to A4 keeps the content", async () => {
  const env = await testEnv();
  const out = scalePages(env, makePdf(2, { h: 792, w: 612 }), {
    customH: 0,
    customW: 0,
    factor: 100,
    fit: "fit",
    margin: 0,
    mode: "paper",
    orientation: "auto",
    paper: "a4",
  });
  const [w, h] = PAPER.a4;
  expect(sizes(out)).toEqual([
    [Math.round(w), Math.round(h)],
    [Math.round(w), Math.round(h)],
  ]);
  expect(pageTexts(out)).toEqual(["Page 1", "Page 2"]);
});

test("splitting spreads halves every page but the cover", async () => {
  const env = await testEnv();
  const out = splitSpreads(env, makePdf(3, { h: 600, w: 800 }), {
    cut: "vertical",
    keepFirst: true,
    keepLast: false,
    order: "ltr",
    overlap: 0,
  });
  expect(sizes(out)).toEqual([
    [800, 600],
    [400, 600],
    [400, 600],
    [400, 600],
    [400, 600],
  ]);
  // The heading sits on the left half.
  expect(pageTexts(out)).toEqual(["Page 1", "Page 2", "", "Page 3", ""]);
});

test("trimming crops to the content", async () => {
  const env = await testEnv();
  const out = crop(env, makePdf(1), {
    box: [0, 0, 1, 1],
    margins: [0, 0, 0, 0],
    mode: "trim",
    padding: 0,
    uniform: false,
  });
  const [[w, h] = [0, 0]] = sizes(out);
  expect(w).toBeLessThan(120);
  expect(h).toBeLessThan(40);
  expect(pageTexts(out)).toEqual(["Page 1"]);
});
