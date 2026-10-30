import { expect, test } from "bun:test";

import * as mupdf from "mupdf";

import { makePdf, openTest, pageTexts, testEnv } from "../test-env";
import {
  expandTokens,
  fittingSize,
  imageStamp,
  marginText,
  overlay,
  recolor,
  roman,
  watermark,
} from "./stamp";
import type { MarginTextOptions } from "./stamp";

const MARGIN_DEFAULTS: MarginTextOptions = {
  bold: false,
  color: "#000000",
  date: "2026-10-30",
  digits: 6,
  family: "helvetica",
  filename: "report.pdf",
  margin: 10,
  mirror: false,
  opacity: 1,
  size: 10,
  slots: [],
  start: 1,
  title: "Report",
};

/** The average colour of the page rendered small, 0..255 per channel. */
const meanColor = (bytes: Uint8Array, page = 0): [number, number, number] => {
  const doc = openTest(bytes);
  const pix = doc
    .loadPage(page)
    .toPixmap([0.2, 0, 0, 0.2, 0, 0], mupdf.ColorSpace.DeviceRGB, false, true);
  const px = pix.getPixels();
  const sum = [0, 0, 0];
  for (let i = 0; i < px.length; i += 3) {
    sum[0] += px[i] ?? 0;
    sum[1] += px[i + 1] ?? 0;
    sum[2] += px[i + 2] ?? 0;
  }
  const n = px.length / 3;
  return [sum[0] / n, sum[1] / n, sum[2] / n] as [number, number, number];
};

test("roman numerals and tokens", () => {
  expect(roman(1994)).toBe("MCMXCIV");
  expect(roman(4)).toBe("IV");
  expect(
    expandTokens(
      "Page {n} of {total} · {roman} · {bates} · {filename} · {nope}",
      {
        date: "",
        digits: 4,
        filename: "a.pdf",
        n: 9,
        title: "",
        total: 12,
      }
    )
  ).toBe("Page 9 of 12 · ix · 0009 · a.pdf · {nope}");
});

test("a fitted watermark spans most of the page", () => {
  const size = fittingSize(5, 45, 595, 842);
  // Five em by one, turned 45°: about 4.2 em on each axis, the width binding.
  expect(size).toBeCloseTo((0.8 * 595) / (6 * Math.SQRT1_2), 3);
});

test("a watermark is real, selectable text in every page asked for", async () => {
  const env = await testEnv();
  const out = watermark(env, makePdf(3), {
    angle: 45,
    bold: true,
    color: "#c00000",
    family: "helvetica",
    layer: "over",
    layout: "center",
    opacity: 0.3,
    pages: [0, 2],
    size: 0,
    text: "DRAFT Ünïcode 草稿",
  });
  const texts = pageTexts(out);
  expect(texts[0]).toContain("DRAFT");
  expect(texts[0]).toContain("草稿");
  expect(texts[1]).not.toContain("DRAFT");
  expect(texts[2]).toContain("Ünïcode");
});

test("a tiled watermark repeats", async () => {
  const env = await testEnv();
  const out = watermark(env, makePdf(1), {
    angle: 30,
    bold: false,
    color: "#888888",
    family: "times",
    layer: "under",
    layout: "tile",
    opacity: 0.5,
    size: 24,
    text: "SECRET",
  });
  const hits = openTest(out).loadPage(0).search("SECRET", "");
  expect(hits.length).toBeGreaterThan(10);
});

test("page numbers count the stamped pages from the start number, and Bates pads", async () => {
  const env = await testEnv();
  const out = marginText(env, makePdf(3), {
    ...MARGIN_DEFAULTS,
    pages: [1, 2],
    slots: [
      { position: "bc", text: "Page {n} of {total}" },
      { position: "tr", text: "ABC{bates}" },
    ],
    start: 1,
  });
  const texts = pageTexts(out);
  expect(texts[0]).toBe("Page 1");
  expect(texts[1]).toContain("Page 1 of 2");
  expect(texts[1]).toContain("ABC000001");
  expect(texts[2]).toContain("Page 2 of 2");
});

test("margin text lands in its corner, turned pages included", async () => {
  const env = await testEnv();
  for (const rotate of [0, 90] as const) {
    const out = marginText(env, makePdf(1, { rotate }), {
      ...MARGIN_DEFAULTS,
      slots: [{ position: "br", text: "corner" }],
    });
    const page = openTest(out).loadPage(0);
    const [x0, y0, x1, y1] = page.getBounds();
    const [[q] = []] = page.search("corner", "");
    expect(q).toBeDefined();
    // The quad's bottom right is near the page's bottom right, as displayed.
    expect(x1 - x0 - (q?.[6] ?? 0)).toBeLessThan(40);
    expect(y1 - y0 - (q?.[7] ?? 0)).toBeLessThan(40);
  }
});

test("an image stamp is drawn where it was placed", async () => {
  const env = await testEnv();
  const pix = new mupdf.Pixmap(
    mupdf.ColorSpace.DeviceRGB,
    [0, 0, 10, 10],
    false
  );
  pix.clear(0);
  const png = pix.asPNG();
  const out = imageStamp(env, makePdf(1), {
    cx: 0.5,
    cy: 0.5,
    image: png,
    layer: "over",
    opacity: 1,
    width: 0.5,
  });
  const [r] = meanColor(out);
  // A black square a quarter of the page's area darkens it by about that much.
  expect(r).toBeLessThan(255 * 0.85);
  expect(r).toBeGreaterThan(255 * 0.6);
});

test("an overlay brings the template's text onto every page", async () => {
  const env = await testEnv();
  const out = overlay(env, makePdf(2), {
    fit: "stretch",
    layer: "under",
    opacity: 1,
    repeat: "first",
    template: makePdf(1, { label: "Letterhead" }),
  });
  for (const t of pageTexts(out)) {
    expect(t).toContain("Letterhead 1");
  }
});

test("dark mode turns white paper dark, invert turns it black", async () => {
  const env = await testEnv();
  const dark = meanColor(recolor(env, makePdf(1), { mode: "dark" }));
  expect(dark[0]).toBeLessThan(50);
  expect(dark[0]).toBeGreaterThan(20);
  const inverted = meanColor(recolor(env, makePdf(1), { mode: "invert" }));
  expect(inverted[0]).toBeLessThan(20);
  const sepia = meanColor(recolor(env, makePdf(1), { mode: "sepia" }));
  // Warm paper: more red than blue.
  expect(sepia[0] - sepia[2]).toBeGreaterThan(10);
});
