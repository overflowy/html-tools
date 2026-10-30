// Panels that lay pages out anew: several to a sheet, a booklet, a poster,
// one long page, a new paper size, spreads cut in two, and cropping. Each
// previews live: change an option and the Result follows.

import { PAPER_NAMES } from "../../pdf/geometry";
import type { PaperId, Rect } from "../../pdf/geometry";
import { MAX_PAGE } from "../../pdf/layout";
import type {
  CropOptions,
  NupOptions,
  Orientation,
  Sheet,
} from "../../pdf/layout";
import { parseRanges } from "../../ranges";
import type { PanelDef } from "../api";
import { el } from "../dom";
import type { Field } from "../form";
import { transformPanel } from "../panel-kit";

const GROUP = "Layout";

const PAPER_OPTIONS: [string, string][] = Object.entries(PAPER_NAMES);
const SHEET_OPTIONS: [string, string][] = [
  ["same", "Same as the pages"],
  ...PAPER_OPTIONS,
];
const ORIENTATION: Field = {
  key: "orientation",
  kind: "seg",
  label: "Orientation",
  options: [
    ["auto", "Best fit"],
    ["portrait", "Portrait"],
    ["landscape", "Landscape"],
  ],
};
const mm = (
  key: string,
  label: string,
  max = 100,
  show?: Field["show"]
): Field => ({
  key,
  kind: "number",
  label,
  max,
  min: 0,
  show,
  step: 0.5,
  unit: "mm",
});

const nup = transformPanel({
  applyLabel: "the N-up layout",
  defaults: {
    borders: false,
    margin: 5,
    order: "rows",
    orientation: "auto",
    perSheet: "4",
    rtl: false,
    sheet: "same",
    spacing: 3,
  },
  fields: [
    {
      key: "perSheet",
      kind: "seg",
      label: "Pages per sheet",
      options: [
        ["2", "2"],
        ["4", "4"],
        ["6", "6"],
        ["8", "8"],
        ["9", "9"],
        ["16", "16"],
      ],
    },
    { key: "sheet", kind: "select", label: "Sheet", options: SHEET_OPTIONS },
    ORIENTATION,
    {
      key: "order",
      kind: "seg",
      label: "Order",
      options: [
        ["rows", "Across, then down"],
        ["columns", "Down, then across"],
      ],
    },
    { key: "rtl", kind: "check", label: "Right to left" },
    mm("margin", "Margin"),
    mm("spacing", "Space between"),
    { key: "borders", kind: "check", label: "Draw a border around each page" },
  ],
  group: GROUP,
  id: "nup",
  live: true,
  name: "N-up",
  op: "nup",
  options: (v) => ({
    borders: v.borders === true,
    margin: Number(v.margin),
    order: v.order === "columns" ? "columns" : "rows",
    orientation: v.orientation as Orientation,
    perSheet: Number(v.perSheet) as NupOptions["perSheet"],
    rtl: v.rtl === true,
    sheet: v.sheet as Sheet,
    spacing: Number(v.spacing),
  }),
  suffix: "-nup",
  summary:
    "Several pages on each sheet, shrunk to fit: handouts, proofs, saving paper.",
});

const booklet = transformPanel({
  applyLabel: "the booklet",
  defaults: { binding: "left", foldLine: false, gutter: 0, sheet: "same" },
  fields: [
    {
      key: "sheet",
      kind: "select",
      label: "Sheet",
      options: [["same", "Two pages side by side"], ...PAPER_OPTIONS],
    },
    {
      key: "binding",
      kind: "seg",
      label: "Bound on the",
      options: [
        ["left", "Left"],
        ["right", "Right"],
      ],
    },
    mm("gutter", "Gutter", 50),
    { key: "foldLine", kind: "check", label: "Draw the fold" },
  ],
  group: GROUP,
  id: "booklet",
  live: true,
  name: "Booklet",
  op: "booklet",
  options: (v) => ({
    binding: v.binding === "right" ? "right" : "left",
    foldLine: v.foldLine === true,
    gutter: Number(v.gutter),
    sheet: v.sheet as Sheet,
  }),
  suffix: "-booklet",
  summary:
    "Pages in saddle-stitch order, two to a side: print double-sided (flip on the short edge), fold the stack in half, and staple. Pages are padded with blanks to a multiple of four.",
});

const poster = transformPanel({
  applyLabel: "the poster",
  defaults: {
    cols: 2,
    guides: true,
    orientation: "auto",
    overlap: 10,
    rows: 2,
    sheet: "a4",
  },
  fields: [
    {
      key: "sheet",
      kind: "select",
      label: "Printed on",
      options: PAPER_OPTIONS,
    },
    ORIENTATION,
    { key: "cols", kind: "number", label: "Sheets across", max: 20, min: 1 },
    { key: "rows", kind: "number", label: "Sheets down", max: 20, min: 1 },
    mm("overlap", "Overlap", 50),
    { key: "guides", kind: "check", label: "Crop marks and labels" },
  ],
  group: GROUP,
  id: "poster",
  live: true,
  name: "Poster",
  op: "poster",
  options: (v) => ({
    cols: Number(v.cols),
    guides: v.guides === true,
    orientation: v.orientation as Orientation,
    overlap: Number(v.overlap),
    rows: Number(v.rows),
    sheet: v.sheet as PaperId,
  }),
  suffix: "-poster",
  summary:
    "Each page enlarged across a grid of sheets, to print on an ordinary printer and tape together. The overlap leaves room to glue.",
});

const stitch = transformPanel({
  applyLabel: "the stitched page",
  defaults: { direction: "vertical", margin: 0, spacing: 0 },
  fields: [
    {
      key: "direction",
      kind: "seg",
      label: "Stack",
      options: [
        ["vertical", "Top to bottom"],
        ["horizontal", "Left to right"],
      ],
    },
    mm("margin", "Margin"),
    mm("spacing", "Space between"),
  ],
  group: GROUP,
  id: "stitch",
  live: true,
  name: "Stitch into one page",
  op: "stitch",
  options: (v) => ({
    direction: v.direction === "horizontal" ? "horizontal" : "vertical",
    margin: Number(v.margin),
    spacing: Number(v.spacing),
  }),
  report: (r) => {
    const [size] = r.doc?.pages ?? [];
    if (size && Math.max(size.w, size.h) > MAX_PAGE) {
      return el("p", {
        class: "hint warn",
        text: `The page is ${Math.round(Math.max(size.w, size.h) / 72)} inches long; Acrobat opens pages up to 200 inches. Browsers and most other readers show it whole.`,
      });
    }
    return null;
  },
  suffix: "-stitched",
  summary:
    "Every page on one long page, as a web page reads: one continuous scroll.",
});

const scale = transformPanel({
  applyLabel: "the new page size",
  defaults: {
    customH: 297,
    customW: 210,
    factor: 100,
    fit: "fit",
    margin: 0,
    mode: "paper",
    orientation: "auto",
    paper: "a4",
  },
  fields: [
    {
      key: "mode",
      kind: "seg",
      label: "Scale",
      options: [
        ["paper", "To a paper size"],
        ["factor", "By a percentage"],
      ],
    },
    {
      key: "paper",
      kind: "select",
      label: "Paper",
      options: [...PAPER_OPTIONS, ["custom", "Custom"]],
      show: (v) => v.mode === "paper",
    },
    {
      key: "customW",
      kind: "number",
      label: "Width",
      max: 5000,
      min: 10,
      show: (v) => v.mode === "paper" && v.paper === "custom",
      unit: "mm",
    },
    {
      key: "customH",
      kind: "number",
      label: "Height",
      max: 5000,
      min: 10,
      show: (v) => v.mode === "paper" && v.paper === "custom",
      unit: "mm",
    },
    {
      ...ORIENTATION,
      options: [
        ["auto", "As each page"],
        ["portrait", "Portrait"],
        ["landscape", "Landscape"],
      ],
      show: (v) => v.mode === "paper",
    },
    {
      key: "factor",
      kind: "number",
      label: "Size",
      max: 1000,
      min: 1,
      show: (v) => v.mode === "factor",
      unit: "%",
    },
    {
      key: "fit",
      kind: "seg",
      label: "Fit",
      options: [
        ["fit", "Fit inside"],
        ["fill", "Fill and crop"],
        ["stretch", "Stretch"],
      ],
      show: (v) => v.mode === "paper",
    },
    mm("margin", "Margin", 100, (v) => v.mode === "paper"),
  ],
  group: GROUP,
  id: "scale",
  live: true,
  name: "Scale pages",
  op: "scale",
  options: (v) => ({
    customH: Number(v.customH),
    customW: Number(v.customW),
    factor: Number(v.factor),
    fit: v.fit as "fit" | "fill" | "stretch",
    margin: Number(v.margin),
    mode: v.mode === "factor" ? "factor" : "paper",
    orientation: v.orientation as Orientation,
    paper: v.paper as PaperId | "custom",
  }),
  suffix: "-scaled",
  summary:
    "Every page made one paper size (Letter to A4, photos to A4 with a margin) or a percentage of its own, content scaled to match.",
});

const spreads = transformPanel({
  applyLabel: "the split spreads",
  defaults: {
    cut: "vertical",
    keepFirst: false,
    keepLast: false,
    order: "ltr",
    overlap: 0,
  },
  fields: [
    {
      key: "cut",
      kind: "seg",
      label: "Cut",
      options: [
        ["vertical", "Down the middle"],
        ["horizontal", "Across the middle"],
      ],
    },
    {
      key: "order",
      kind: "seg",
      label: "Read",
      options: [
        ["ltr", "Left half first"],
        ["rtl", "Right half first"],
      ],
      show: (v) => v.cut === "vertical",
    },
    mm("overlap", "Keep of the other half", 50),
    {
      key: "keepFirst",
      kind: "check",
      label: "Leave the first page whole (a cover)",
    },
    { key: "keepLast", kind: "check", label: "Leave the last page whole" },
  ],
  group: GROUP,
  id: "spreads",
  live: true,
  name: "Split scanned spreads",
  op: "spreads",
  options: (v) => ({
    cut: v.cut === "horizontal" ? "horizontal" : "vertical",
    keepFirst: v.keepFirst === true,
    keepLast: v.keepLast === true,
    order: v.order === "rtl" ? "rtl" : "ltr",
    overlap: Number(v.overlap),
  }),
  suffix: "-pages",
  summary:
    "A book scanned two pages at a time, made one page per page. Nothing is thrown away: each half is the whole scan, cropped.",
});

/** A crop box drawn on the page, as fractions of it: what applies to pages of any size. */
const boxOf = (v: Record<string, unknown>): Rect => [
  Number(v.bx0),
  Number(v.by0),
  Number(v.bx1),
  Number(v.by1),
];

const crop = transformPanel({
  applyLabel: "the crop",
  defaults: {
    bx0: 0.1,
    bx1: 0.9,
    by0: 0.1,
    by1: 0.9,
    mb: 10,
    ml: 10,
    mode: "trim",
    mr: 10,
    mt: 10,
    padding: 3,
    pages: "",
    uniform: false,
  },
  extend: ({ api, form, run, values }) => {
    const draw = () => {
      if (values.mode !== "box") {
        api.setTool(null);
        api.setMarks(null);
        return;
      }
      const sizes = api.sizes();
      api.setMarks((page) => {
        const s = sizes[page];
        if (!s) {
          return [];
        }
        const [x0, y0, x1, y1] = boxOf(values);
        return [
          {
            kind: "rect",
            label: "Crop",
            rect: [x0 * s.w, y0 * s.h, x1 * s.w, y1 * s.h],
            style: "crop",
          },
        ];
      });
      api.setTool("rect", (g) => {
        const s = api.sizes()[g.page];
        if (!s) {
          return;
        }
        // Fractions of the page, to a thousandth: a fraction of a point at any page size.
        const frac = (v: number) =>
          Math.round(Math.max(0, Math.min(1, v)) * 1000) / 1000;
        const fx = (x: number) => frac(x / s.w);
        const fy = (y: number) => frac(y / s.h);
        const [x0, x1] = [fx(g.from[0]), fx(g.to[0])].toSorted((a, b) => a - b);
        const [y0, y1] = [fy(g.from[1]), fy(g.to[1])].toSorted((a, b) => a - b);
        form.set("bx0", x0 ?? 0);
        form.set("bx1", x1 ?? 1);
        form.set("by0", y0 ?? 0);
        form.set("by1", y1 ?? 1);
        api.redrawMarks();
        if (
          g.done &&
          (x1 ?? 1) - (x0 ?? 0) > 0.01 &&
          (y1 ?? 1) - (y0 ?? 0) > 0.01
        ) {
          api.persist();
          // The page being drawn on is the Workspace's; the cropped Result is a click on After away.
          void run.run();
        }
      });
    };
    draw();
    return {
      changed: (key) => {
        if (key === "mode") {
          draw();
        }
      },
      destroy: () => {
        api.setTool(null);
        api.setMarks(null);
      },
      docChanged: draw,
    };
  },
  fields: [
    {
      key: "mode",
      kind: "seg",
      label: "Crop",
      options: [
        ["trim", "To the content"],
        ["margins", "Margins off"],
        ["box", "To a box I draw"],
      ],
    },
    mm("padding", "Leave around the content", 50, (v) => v.mode === "trim"),
    {
      key: "uniform",
      kind: "check",
      label: "One box for every page",
      show: (v) => v.mode === "trim",
    },
    mm("mt", "Top", 500, (v) => v.mode === "margins"),
    mm("mr", "Right", 500, (v) => v.mode === "margins"),
    mm("mb", "Bottom", 500, (v) => v.mode === "margins"),
    mm("ml", "Left", 500, (v) => v.mode === "margins"),
    {
      hint: "Draw the box on any page in the Pages view; it applies to every page, in proportion.",
      key: "bx0",
      kind: "number",
      label: "Left edge",
      max: 1,
      min: 0,
      show: (v) => v.mode === "box",
      step: 0.01,
    },
    {
      key: "by0",
      kind: "number",
      label: "Top edge",
      max: 1,
      min: 0,
      show: (v) => v.mode === "box",
      step: 0.01,
    },
    {
      key: "bx1",
      kind: "number",
      label: "Right edge",
      max: 1,
      min: 0,
      show: (v) => v.mode === "box",
      step: 0.01,
    },
    {
      key: "by1",
      kind: "number",
      label: "Bottom edge",
      max: 1,
      min: 0,
      show: (v) => v.mode === "box",
      step: 0.01,
    },
    { key: "pages", kind: "pages", label: "Pages" },
  ],
  group: GROUP,
  id: "crop",
  live: true,
  name: "Crop",
  op: "crop",
  options: (v, api) => {
    const r = parseRanges(String(v.pages), api.pageCount());
    if (!r.ok) {
      return r.error;
    }
    return {
      box: boxOf(v),
      margins: [Number(v.mt), Number(v.mr), Number(v.mb), Number(v.ml)],
      mode: v.mode as CropOptions["mode"],
      padding: Number(v.padding),
      pages: r.pages,
      uniform: v.uniform === true,
    };
  },
  suffix: "-cropped",
  summary:
    "Crop pages to their content, by margins, or to a box drawn on the page. The parts cropped away stay in the file, hidden; Redact removes content for good.",
});

export const LAYOUT_PANELS: PanelDef[] = [
  nup,
  booklet,
  poster,
  stitch,
  scale,
  spreads,
  crop,
];
