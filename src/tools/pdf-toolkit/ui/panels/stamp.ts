// Panels that add to the pages: a watermark, an image stamp, another PDF
// over or under them, text in the margins (headers and footers, page
// numbers, Bates numbers), and reading modes. All preview live.

import type { FontFamily } from "../../pdf/fonts";
import type { Position, Slot } from "../../pdf/stamp";
import { parseRanges } from "../../ranges";
import type { Api, PanelDef } from "../api";
import { el } from "../dom";
import type { Field, FileValue, Values } from "../form";
import { transformPanel } from "../panel-kit";

const GROUP = "Stamp";

const FAMILY: Field = {
  key: "family",
  kind: "select",
  label: "Font",
  options: [
    ["helvetica", "Sans serif"],
    ["times", "Serif"],
    ["courier", "Monospace"],
  ],
};
const OPACITY: Field = {
  format: (v) => `${Math.round(v * 100)}%`,
  key: "opacity",
  kind: "range",
  label: "Opacity",
  max: 1,
  min: 0.05,
  step: 0.05,
};
const LAYER: Field = {
  key: "layer",
  kind: "seg",
  label: "Put it",
  options: [
    ["over", "Over the page"],
    ["under", "Under the text"],
  ],
};
const PAGES: Field = { key: "pages", kind: "pages", label: "Pages" };

/** The 0-based pages a Page Range field names, or why it names none. */
const pagesOf = (v: Values, api: Api): number[] | string => {
  const r = parseRanges(String(v.pages ?? ""), api.pageCount());
  return r.ok ? r.pages : r.error;
};

const watermark = transformPanel({
  applyLabel: "the watermark",
  defaults: {
    angle: 45,
    bold: true,
    color: "#c0392b",
    family: "helvetica",
    layer: "over",
    layout: "center",
    opacity: 0.25,
    pages: "",
    size: 0,
    text: "DRAFT",
  },
  fields: [
    { key: "text", kind: "text", label: "Text", placeholder: "CONFIDENTIAL" },
    FAMILY,
    { key: "bold", kind: "check", label: "Bold" },
    {
      hint: "0 makes it as large as the page allows.",
      key: "size",
      kind: "number",
      label: "Size",
      max: 500,
      min: 0,
      unit: "pt",
    },
    { key: "color", kind: "color", label: "Colour" },
    OPACITY,
    {
      key: "angle",
      kind: "number",
      label: "Angle",
      max: 180,
      min: -180,
      step: 5,
      unit: "°",
    },
    {
      key: "layout",
      kind: "seg",
      label: "Layout",
      options: [
        ["center", "Once, centred"],
        ["tile", "Repeated"],
      ],
    },
    LAYER,
    PAGES,
  ],
  group: GROUP,
  id: "watermark",
  live: true,
  name: "Watermark",
  op: "watermark",
  options: (v, api) => {
    const pages = pagesOf(v, api);
    if (typeof pages === "string") {
      return pages;
    }
    if (!String(v.text).trim()) {
      return "Type the watermark's text.";
    }
    return {
      angle: Number(v.angle),
      bold: v.bold === true,
      color: String(v.color),
      family: v.family as FontFamily,
      layer: v.layer === "under" ? "under" : "over",
      layout: v.layout === "tile" ? "tile" : "center",
      opacity: Number(v.opacity),
      pages,
      size: Number(v.size),
      text: String(v.text),
    };
  },
  suffix: "-watermarked",
  summary:
    "Text across every page: DRAFT, CONFIDENTIAL, a name. It is real text, so it prints sharp and can be found by search.",
});

/* ---------------- image stamp ---------------- */

const ANCHORS: Record<string, [number, number]> = {
  bc: [0.5, 0.9],
  bl: [0.15, 0.9],
  br: [0.85, 0.9],
  mc: [0.5, 0.5],
  ml: [0.15, 0.5],
  mr: [0.85, 0.5],
  tc: [0.5, 0.1],
  tl: [0.15, 0.1],
  tr: [0.85, 0.1],
};

const stamp = transformPanel({
  applyLabel: "the stamp",
  defaults: {
    anchor: "br",
    cx: 0.85,
    cy: 0.9,
    image: null,
    layer: "over",
    opacity: 1,
    pages: "",
    width: 0.25,
  },
  extend: ({ api, form, run, values }) => {
    let aspect = 1;
    const measure = async () => {
      const img = values.image as FileValue | null;
      if (!img) {
        return;
      }
      try {
        const bitmap = await createImageBitmap(new Blob([img.bytes]));
        aspect = bitmap.height / bitmap.width;
        bitmap.close();
      } catch {
        aspect = 1;
      }
      api.redrawMarks();
    };
    api.setMarks((page) => {
      const s = api.sizes()[page];
      if (!s || !values.image) {
        return [];
      }
      const w = Number(values.width) * s.w;
      const h = w * aspect;
      const x = Number(values.cx) * s.w - w / 2;
      const y = Number(values.cy) * s.h - h / 2;
      return [
        {
          kind: "rect",
          label: "Stamp",
          rect: [x, y, x + w, y + h],
          style: "stamp",
        },
      ];
    });
    api.setTool("point", (g) => {
      const s = api.sizes()[g.page];
      if (!s) {
        return;
      }
      form.set("cx", g.to[0] / s.w);
      form.set("cy", g.to[1] / s.h);
      api.persist();
      api.redrawMarks();
      void run.run();
    });
    return {
      changed: (key) => {
        if (key === "anchor") {
          const [cx, cy] = ANCHORS[String(values.anchor)] ?? [0.5, 0.5];
          form.set("cx", cx);
          form.set("cy", cy);
        }
        if (key === "image") {
          void measure();
        }
        api.redrawMarks();
      },
      destroy: () => {
        api.setTool(null);
        api.setMarks(null);
      },
    };
  },
  fields: [
    {
      accept: "image/png,image/jpeg,image/gif,image/bmp,image/tiff",
      key: "image",
      kind: "file",
      label: "Image",
    },
    {
      hint: "Or click on a page in the Pages view to put it there.",
      key: "anchor",
      kind: "position",
      label: "Position",
    },
    {
      format: (v) => `${Math.round(v * 100)}% of the page`,
      key: "width",
      kind: "range",
      label: "Width",
      max: 1,
      min: 0.02,
      step: 0.01,
    },
    OPACITY,
    LAYER,
    PAGES,
  ],
  group: GROUP,
  id: "stamp",
  live: true,
  name: "Image stamp",
  op: "stamp",
  options: (v, api) => {
    const pages = pagesOf(v, api);
    if (typeof pages === "string") {
      return pages;
    }
    const img = v.image as FileValue | null;
    if (!img) {
      return "Choose an image: a logo, a signature, a seal.";
    }
    return {
      cx: Number(v.cx),
      cy: Number(v.cy),
      image: img.bytes,
      layer: v.layer === "under" ? "under" : "over",
      opacity: Number(v.opacity),
      pages,
      width: Number(v.width),
    };
  },
  suffix: "-stamped",
  summary:
    "An image (a logo, a scanned signature, a seal) placed on the pages. Its position and width scale with each page.",
});

/* ---------------- overlay ---------------- */

const overlay = transformPanel({
  applyLabel: "the overlay",
  defaults: {
    fit: "stretch",
    layer: "under",
    opacity: 1,
    pages: "",
    repeat: "first",
    template: null,
  },
  fields: [
    {
      accept: ".pdf,application/pdf",
      hint: "Letterhead, a form background, a transparency.",
      key: "template",
      kind: "file",
      label: "PDF to lay",
    },
    {
      key: "layer",
      kind: "seg",
      label: "Put it",
      options: [
        ["under", "Under the pages"],
        ["over", "Over the pages"],
      ],
    },
    {
      key: "repeat",
      kind: "select",
      label: "Which of its pages",
      options: [
        ["first", "Its first page on every page"],
        ["cycle", "Its pages in turn, then round again"],
        ["match", "Page for page, and none past its end"],
      ],
    },
    {
      key: "fit",
      kind: "seg",
      label: "Size",
      options: [
        ["stretch", "Stretch to the page"],
        ["fit", "Fit inside"],
        ["actual", "As it is"],
      ],
    },
    OPACITY,
    PAGES,
  ],
  group: GROUP,
  id: "overlay",
  live: true,
  name: "Overlay or underlay",
  op: "overlay",
  options: (v, api) => {
    const pages = pagesOf(v, api);
    if (typeof pages === "string") {
      return pages;
    }
    const t = v.template as FileValue | null;
    if (!t) {
      return "Choose the PDF to lay over or under the pages.";
    }
    return {
      fit: v.fit as "stretch" | "fit" | "actual",
      layer: v.layer === "over" ? "over" : "under",
      opacity: Number(v.opacity),
      pages,
      repeat: v.repeat as "first" | "cycle" | "match",
      template: t.bytes,
    };
  },
  suffix: "-overlaid",
  summary:
    "Another PDF's pages drawn over or under these: letterhead under a letter, a form's background, a stamp made in another program.",
});

/* ---------------- margin text ---------------- */

const TOKENS_HINT =
  "{n} page number, {total} last number, {roman} or {ROMAN} in numerals, {date}, {filename}, {title}.";

const marginFields = (): Field[] => [
  FAMILY,
  { key: "bold", kind: "check", label: "Bold" },
  { key: "size", kind: "number", label: "Size", max: 72, min: 4, unit: "pt" },
  { key: "color", kind: "color", label: "Colour" },
  {
    key: "margin",
    kind: "number",
    label: "From the edge",
    max: 100,
    min: 0,
    step: 0.5,
    unit: "mm",
  },
];

const MARGIN_DEFAULTS: Values = {
  bold: false,
  color: "#000000",
  family: "helvetica",
  margin: 10,
  size: 10,
};

/** What every margin text Operation shares: font, size, colour, and the document's names. */
const marginBase = (v: Values, api: Api) => ({
  bold: v.bold === true,
  color: String(v.color),
  date: new Date().toLocaleDateString(),
  family: v.family as FontFamily,
  filename: `${api.name()}.pdf`,
  margin: Number(v.margin),
  opacity: 1,
  size: Number(v.size),
  title: api.name(),
});

const SLOTS: [Position, string][] = [
  ["tl", "Header, left"],
  ["tc", "Header, centre"],
  ["tr", "Header, right"],
  ["bl", "Footer, left"],
  ["bc", "Footer, centre"],
  ["br", "Footer, right"],
];

const headerFooter = transformPanel({
  applyLabel: "the header and footer",
  defaults: {
    ...MARGIN_DEFAULTS,
    bc: "",
    bl: "",
    br: "Page {n} of {total}",
    mirror: false,
    pages: "",
    start: 1,
    tc: "",
    tl: "{title}",
    tr: "{date}",
  },
  fields: [
    ...SLOTS.map(([key, label]): Field => ({ key, kind: "text", label })),
    {
      hint: TOKENS_HINT,
      key: "start",
      kind: "number",
      label: "First page's number",
      max: 100_000,
      min: 0,
    },
    {
      key: "mirror",
      kind: "check",
      label: "Swap left and right on every other page",
    },
    ...marginFields(),
    PAGES,
  ],
  group: GROUP,
  id: "headerfooter",
  live: true,
  name: "Header and footer",
  op: "margin",
  options: (v, api) => {
    const pages = pagesOf(v, api);
    if (typeof pages === "string") {
      return pages;
    }
    const slots: Slot[] = SLOTS.map(([position]) => ({
      position,
      text: String(v[position] ?? ""),
    })).filter((s) => s.text.trim());
    if (slots.length === 0) {
      return "Type something in a header or a footer.";
    }
    return {
      ...marginBase(v, api),
      digits: 1,
      mirror: v.mirror === true,
      pages,
      slots,
      start: Number(v.start),
    };
  },
  suffix: "-headed",
  summary:
    "Text at the top and bottom of every page, with the page number, the date, or the file's name filled in.",
});

const FORMATS: [string, string][] = [
  ["{n}", "1"],
  ["Page {n}", "Page 1"],
  ["{n} of {total}", "1 of 12"],
  ["Page {n} of {total}", "Page 1 of 12"],
  ["{roman}", "i"],
  ["{ROMAN}", "I"],
  ["- {n} -", "- 1 -"],
];

const pageNumbers = transformPanel({
  applyLabel: "the page numbers",
  defaults: {
    ...MARGIN_DEFAULTS,
    from: 1,
    mirror: false,
    position: "bc",
    start: 1,
    template: "{n}",
  },
  fields: [
    { key: "position", kind: "position", label: "Position" },
    { key: "template", kind: "select", label: "Format", options: FORMATS },
    {
      hint: "Pages before it (a cover, a title page) are not numbered.",
      key: "from",
      kind: "number",
      label: "Number from page",
      max: 100_000,
      min: 1,
    },
    {
      key: "start",
      kind: "number",
      label: "Starting at",
      max: 100_000,
      min: 0,
    },
    { key: "mirror", kind: "check", label: "Outside edge, as in a book" },
    ...marginFields(),
  ],
  group: GROUP,
  id: "pagenumbers",
  live: true,
  name: "Page numbers",
  op: "margin",
  options: (v, api) => {
    const n = api.pageCount();
    const from = Math.min(n, Math.max(1, Number(v.from)));
    const pages = Array.from({ length: n - from + 1 }, (_, i) => from - 1 + i);
    return {
      ...marginBase(v, api),
      digits: 1,
      mirror: v.mirror === true,
      pages,
      slots: [{ position: v.position as Position, text: String(v.template) }],
      start: Number(v.start),
    };
  },
  suffix: "-numbered",
  summary:
    "Page numbers in a corner or the middle of the margin, in the format you pick, starting where you say.",
});

const bates = transformPanel({
  applyLabel: "the Bates numbers",
  defaults: {
    ...MARGIN_DEFAULTS,
    digits: 6,
    pages: "",
    position: "br",
    prefix: "ABC",
    start: 1,
    suffix: "",
  },
  fields: [
    { key: "prefix", kind: "text", label: "Prefix", placeholder: "CASE-" },
    {
      key: "start",
      kind: "number",
      label: "First number",
      max: 999_999_999,
      min: 0,
    },
    { key: "digits", kind: "number", label: "Digits", max: 12, min: 1 },
    { key: "suffix", kind: "text", label: "Suffix" },
    { key: "position", kind: "position", label: "Position" },
    ...marginFields(),
    PAGES,
  ],
  group: GROUP,
  id: "bates",
  live: true,
  name: "Bates numbering",
  op: "margin",
  options: (v, api) => {
    const pages = pagesOf(v, api);
    if (typeof pages === "string") {
      return pages;
    }
    const text = `${String(v.prefix).replaceAll("{", "(")}{bates}${String(v.suffix).replaceAll("{", "(")}`;
    return {
      ...marginBase(v, api),
      digits: Number(v.digits),
      mirror: false,
      pages,
      slots: [{ position: v.position as Position, text }],
      start: Number(v.start),
    };
  },
  report: (_r, api) => {
    const n = api.pageCount();
    return el("p", {
      class: "hint",
      text: `${n} pages numbered. The next document in the set starts at the number after the last.`,
    });
  },
  suffix: "-bates",
  summary:
    "A unique, padded, increasing number on every page, as legal documents are numbered for discovery.",
});

/* ---------------- reading modes ---------------- */

const recolor = transformPanel({
  applyLabel: "the colours",
  defaults: { mode: "dark", pages: "" },
  fields: [
    {
      key: "mode",
      kind: "seg",
      label: "Mode",
      options: [
        ["dark", "Dark"],
        ["invert", "Inverted"],
        ["contrast", "High contrast"],
        ["sepia", "Sepia"],
      ],
    },
    PAGES,
  ],
  group: GROUP,
  id: "recolor",
  live: true,
  name: "Reading modes",
  op: "recolor",
  options: (v, api) => {
    const pages = pagesOf(v, api);
    if (typeof pages === "string") {
      return pages;
    }
    return { mode: v.mode as "dark" | "invert" | "contrast" | "sepia", pages };
  },
  suffix: "-recoloured",
  summary:
    "Recolour pages for reading: dark (light text on dark, colours kept), inverted, high-contrast grey, or sepia. Text stays text, sharp at any zoom.",
});

export const STAMP_PANELS: PanelDef[] = [
  watermark,
  stamp,
  overlay,
  headerFooter,
  pageNumbers,
  bates,
  recolor,
];
