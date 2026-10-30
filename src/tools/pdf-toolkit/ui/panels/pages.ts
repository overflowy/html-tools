// Panels that work on the Page List itself: organizing it (the grid does
// most of that: select, drag, turn, delete), interleaving two scanned
// stacks, turning pages upright, finding blank pages, splitting into
// files, and making images into pages.

import type { ImagePagesOptions } from "../../pdf/images";
import { splitPlan } from "../../pdf/split";
import type { Part, SplitOptions } from "../../pdf/split";
import { formatRanges, parseRanges, uniqueSorted } from "../../ranges";
import type { Api, PageEntry, PanelDef, Ran } from "../api";
import { button, count, el, message, pdfBlob } from "../dom";
import { Form } from "../form";
import type { Field, Values } from "../form";
import { resultFoot } from "../panel-kit";

const GROUP = "Pages";

const row = (...children: (Node | string)[]) =>
  el("div", { class: "row" }, ...children);

/* ---------------- organize ---------------- */

const organize: PanelDef = {
  group: GROUP,
  id: "organize",
  mount: (api) => {
    const selInfo = el("p", {
      attrs: { "aria-live": "polite" },
      class: "sel-info",
    });
    const rangeInput = el("input", {
      attrs: {
        "aria-label": "Pages to select",
        placeholder: "1-3, 5, 8-",
        spellcheck: "false",
        type: "text",
      },
    });
    const orderInput = el("input", {
      attrs: {
        "aria-label": "New page order",
        placeholder: "3, 1, 2, 4-",
        spellcheck: "false",
        type: "text",
      },
    });
    const files = el("ul", { class: "files" });
    const actionButtons: HTMLButtonElement[] = [];

    const selected = (): Set<string> => new Set(api.selection());
    const keysAt = (indices: number[]) => {
      const list = api.pages();
      return indices.map((i) => list[i]?.key ?? "").filter(Boolean);
    };

    const sync = () => {
      const n = api.selection().length;
      selInfo.textContent =
        n === 0
          ? "No pages selected."
          : `${count(n, "page", "pages")} selected: ${formatRanges(api.pages().flatMap((p, i) => (selected().has(p.key) ? [i] : [])))}.`;
      for (const b of actionButtons) {
        b.disabled = n === 0;
      }
      files.replaceChildren(
        ...api
          .sources()
          .filter((s) => api.pages().some((p) => p.src === s.key))
          .map((s, i, all) =>
            el(
              "li",
              {},
              ...(all.length > 1
                ? [
                    el("span", {
                      attrs: { "aria-hidden": "true" },
                      class: `tag tag-${i % 6}`,
                    }),
                  ]
                : []),
              `${s.name} · ${count(api.pages().filter((p) => p.src === s.key).length, "page", "pages")}`
            )
          )
      );
    };

    const onSelection =
      (
        fn: (keys: Set<string>, pages: PageEntry[]) => PageEntry[],
        label: string
      ) =>
      () => {
        const keys = selected();
        if (keys.size) {
          api.setPages(fn(keys, api.pages()), label);
        }
      };
    const turn = (deg: number) =>
      onSelection(
        (keys, list) =>
          list.map((p) =>
            keys.has(p.key) ? { ...p, rotate: (p.rotate + deg) % 360 } : p
          ),
        ""
      );
    const act = (label: string, fn: () => void, title = "") => {
      const b = button(label, fn, { title });
      actionButtons.push(b);
      return b;
    };

    const extract = async () => {
      const keys = selected();
      const chosen = api.pages().filter((p) => keys.has(p.key));
      if (!chosen.length) {
        return;
      }
      try {
        const w = await api.worker();
        // Taken from the Current Document, so they come out turned as shown.
        const doc = await api.current();
        const positions = api
          .pages()
          .flatMap((p, i) => (keys.has(p.key) ? [i] : []));
        const bytes = await w.call("extract", [
          positions.map((index) => ({ index, rotate: 0, src: doc.id })),
        ]);
        api.download(
          pdfBlob(bytes),
          `${api.name()}-pages-${formatRanges(positions).replaceAll(",", "_")}.pdf`
        );
      } catch (error) {
        api.error(message(error));
      }
    };

    const blankAfter = async () => {
      const keys = selected();
      const list = api.pages();
      const last = list.findLastIndex((p) => keys.has(p.key));
      const ref = list[last] ?? list.at(-1);
      if (!ref) {
        return;
      }
      const size = api.sizes()[last] ?? { h: 842, w: 595 };
      const src = await api.blank(size.w, size.h);
      const entry: PageEntry = { index: 0, key: api.newKey(), rotate: 0, src };
      api.setPages(
        [...list.slice(0, last + 1), entry, ...list.slice(last + 1)],
        "Inserted a blank page."
      );
    };

    const applyOrder = () => {
      const list = api.pages();
      const r = parseRanges(orderInput.value, list.length);
      if (!r.ok) {
        api.error(r.error);
        return;
      }
      api.clearMessages();
      // The pages named come first, in that order; any not named follow as they were.
      const named =
        uniqueSorted(r.pages).length === r.pages.length
          ? r.pages
          : [...new Set(r.pages)];
      const rest = list.map((_, i) => i).filter((i) => !named.includes(i));
      api.setPages(
        [...named, ...rest]
          .map((i) => list[i])
          .filter((p): p is PageEntry => p !== undefined),
        "Pages reordered."
      );
    };

    const selectRange = () => {
      const r = parseRanges(rangeInput.value, api.pageCount());
      if (!r.ok) {
        api.error(r.error);
        return;
      }
      api.clearMessages();
      api.select(keysAt(r.pages));
    };
    rangeInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        selectRange();
      }
    });
    orderInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        applyOrder();
      }
    });

    const all = () => api.pages().map((_, i) => i);
    api.body.replaceChildren(
      el("p", { class: "summary", text: organize.summary }),
      el("h3", { text: "Files" }),
      files,
      el("h3", { text: "Select" }),
      row(rangeInput, button("Select", selectRange)),
      row(
        button("All", () => api.select(keysAt(all()))),
        button("None", () => api.select([])),
        button("Odd", () =>
          api.select(keysAt(all().filter((i) => i % 2 === 0)))
        ),
        button("Even", () =>
          api.select(keysAt(all().filter((i) => i % 2 === 1)))
        ),
        button("Invert", () => {
          const keys = selected();
          api.select(
            api
              .pages()
              .filter((p) => !keys.has(p.key))
              .map((p) => p.key)
          );
        })
      ),
      selInfo,
      el("h3", { text: "Selected pages" }),
      row(
        act("Turn left", turn(270)),
        act("Turn right", turn(90)),
        act("Turn 180°", turn(180))
      ),
      row(
        act(
          "Move to start",
          onSelection(
            (keys, list) => [
              ...list.filter((p) => keys.has(p.key)),
              ...list.filter((p) => !keys.has(p.key)),
            ],
            ""
          )
        ),
        act(
          "Move to end",
          onSelection(
            (keys, list) => [
              ...list.filter((p) => !keys.has(p.key)),
              ...list.filter((p) => keys.has(p.key)),
            ],
            ""
          )
        )
      ),
      row(
        act(
          "Duplicate",
          onSelection(
            (keys, list) =>
              list.flatMap((p) =>
                keys.has(p.key) ? [p, { ...p, key: api.newKey() }] : [p]
              ),
            "Duplicated."
          )
        ),
        act("Insert blank after", () => {
          void blankAfter();
        }),
        act(
          "Delete",
          onSelection(
            (keys, list) => list.filter((p) => !keys.has(p.key)),
            "Deleted. Undo brings them back."
          )
        )
      ),
      row(
        act(
          "Keep only these",
          onSelection(
            (keys, list) => list.filter((p) => keys.has(p.key)),
            "Kept the selected pages."
          )
        ),
        act(
          "Extract as PDF",
          () => {
            void extract();
          },
          "Download the selected pages as a PDF of their own"
        )
      ),
      el("h3", { text: "All pages" }),
      row(
        button("Reverse order", () =>
          api.setPages(api.pages().toReversed(), "Order reversed.")
        )
      ),
      row(orderInput, button("Reorder", applyOrder)),
      el("p", {
        class: "hint",
        text: "Keys in the grid: arrows move, Space selects, Shift extends, Alt with an arrow moves pages, Delete deletes, Ctrl or Cmd Z undoes.",
      })
    );
    api.foot.replaceChildren();
    sync();
    return { docChanged: sync, selectionChanged: sync };
  },
  name: "Organize pages",
  summary:
    "Drag pages to reorder them, from any of the files. Click to select, Shift-click for a run, Ctrl or Cmd-click to add one; each page's corner turns or deletes it.",
};

/* ---------------- interleave ---------------- */

/** Ask for files and add them to the Workspace. */
const pick = (api: Api, accept = ".pdf,application/pdf,image/*") => {
  const input = el("input", { attrs: { accept, multiple: "", type: "file" } });
  input.addEventListener("change", () =>
    api.addFiles([...(input.files ?? [])])
  );
  input.click();
};

const interleave: PanelDef = {
  group: GROUP,
  id: "interleave",
  mount: (api) => {
    const render = () => {
      const files = api
        .sources()
        .filter((s) => api.pages().some((p) => p.src === s.key));
      if (files.length < 2) {
        api.body.replaceChildren(
          el("p", { class: "summary", text: interleave.summary }),
          el("p", {
            class: "hint",
            text: "Add a second file first: the fronts and the backs, each scanned as one stack.",
          }),
          row(button("Add files…", () => pick(api)))
        );
        api.foot.replaceChildren();
        return;
      }
      const options: [string, string][] = files.map((f) => [f.key, f.name]);
      const values: Values = {
        a: files[0]?.key ?? "",
        b: files[1]?.key ?? "",
        reverse: true,
        stepA: 1,
        stepB: 1,
      };
      const fields: Field[] = [
        { key: "a", kind: "select", label: "Fronts", options },
        { key: "b", kind: "select", label: "Backs", options },
        {
          hint: "A duplex stack scanned upside down comes out last page first.",
          key: "reverse",
          kind: "check",
          label: "Backs are in reverse order",
        },
        {
          key: "stepA",
          kind: "number",
          label: "Pages at a time from the fronts",
          max: 50,
          min: 1,
        },
        {
          key: "stepB",
          kind: "number",
          label: "Pages at a time from the backs",
          max: 50,
          min: 1,
        },
      ];
      const form = new Form(fields, values, () => api.clearMessages());
      const go = () => {
        const list = api.pages();
        const a = list.filter((p) => p.src === values.a);
        let b = list.filter((p) => p.src === values.b);
        if (values.a === values.b) {
          api.error("Choose two different files.");
          return;
        }
        if (values.reverse) {
          b = b.toReversed();
        }
        const others = list.filter(
          (p) => p.src !== values.a && p.src !== values.b
        );
        const out: PageEntry[] = [];
        const sa = Number(values.stepA);
        const sb = Number(values.stepB);
        for (let i = 0, j = 0; i < a.length || j < b.length; i += sa, j += sb) {
          out.push(...a.slice(i, i + sa), ...b.slice(j, j + sb));
        }
        api.setPages([...out, ...others], "Interleaved.");
      };
      api.body.replaceChildren(
        el("p", { class: "summary", text: interleave.summary }),
        form.root,
        row(button("Interleave", go, { primary: true }))
      );
      api.foot.replaceChildren();
    };
    render();
    return { docChanged: render };
  },
  name: "Interleave two files",
  summary:
    "Merge fronts and backs scanned as two stacks into one document in page order: front 1, back 1, front 2, back 2.",
};

/* ---------------- auto-rotate ---------------- */

const autorotate: PanelDef = {
  defaults: { direction: "cw", target: "portrait" },
  fields: [
    {
      key: "target",
      kind: "seg",
      label: "Turn every page to",
      options: [
        ["portrait", "Portrait"],
        ["landscape", "Landscape"],
      ],
    },
    {
      key: "direction",
      kind: "seg",
      label: "Turning",
      options: [
        ["cw", "Clockwise"],
        ["ccw", "Counter-clockwise"],
      ],
    },
  ],
  group: GROUP,
  id: "autorotate",
  mount: (api, values) => {
    const info = el("p", {
      attrs: { "aria-live": "polite" },
      class: "sel-info",
    });
    const wrong = () =>
      api
        .sizes()
        .flatMap((s, i) =>
          (values.target === "portrait" ? s.w > s.h : s.h > s.w) ? [i] : []
        );
    const go = button(
      "Turn them",
      () => {
        const turn = new Set(wrong());
        const deg = values.direction === "cw" ? 90 : 270;
        api.setPages(
          api
            .pages()
            .map((p, i) =>
              turn.has(i) ? { ...p, rotate: (p.rotate + deg) % 360 } : p
            ),
          `Turned ${count(turn.size, "page", "pages")}.`
        );
      },
      { primary: true }
    );
    const sync = () => {
      const n = wrong();
      info.textContent =
        n.length === 0
          ? "Every page already is."
          : `${count(n.length, "page turns", "pages turn")}: ${formatRanges(n)}.`;
      go.disabled = n.length === 0;
    };
    const form = new Form(autorotate.fields ?? [], values, () => {
      api.persist();
      sync();
    });
    api.body.replaceChildren(
      el("p", { class: "summary", text: autorotate.summary }),
      form.root,
      info,
      row(go)
    );
    api.foot.replaceChildren();
    sync();
    return { docChanged: sync };
  },
  name: "Auto-rotate",
  summary:
    "Turn the pages that lie the wrong way, so every page is portrait (or every page landscape).",
};

/* ---------------- blank pages ---------------- */

const blank: PanelDef = {
  defaults: { ink: 0.5, text: true },
  fields: [
    {
      format: (v) => `${v.toFixed(1)}% ink`,
      key: "ink",
      kind: "range",
      label: "Blank means at most",
      max: 5,
      min: 0,
      step: 0.1,
    },
    { key: "text", kind: "check", label: "A page with any text is not blank" },
  ],
  group: GROUP,
  id: "blank",
  mount: (api, values) => {
    const info = el("p", {
      attrs: { "aria-live": "polite" },
      class: "sel-info",
    });
    let found: number[] = [];
    const del = button("Delete them", () => {
      const keys = new Set(found.map((i) => api.pages()[i]?.key));
      api.setPages(
        api.pages().filter((p) => !keys.has(p.key)),
        `Deleted ${count(found.length, "blank page", "blank pages")}.`
      );
    });
    del.disabled = true;
    const scan = async () => {
      info.textContent = "Looking…";
      try {
        const w = await api.worker();
        const doc = await api.current();
        const scores = await w.call("ink", [doc.id]);
        found = scores.flatMap((s, i) =>
          s.ink * 100 <= Number(values.ink) && !(values.text && s.text)
            ? [i]
            : []
        );
        info.textContent =
          found.length === 0
            ? "No blank pages."
            : `${count(found.length, "blank page", "blank pages")}: ${formatRanges(found)}. They are selected in the grid.`;
        api.view("grid");
        api.select(found.map((i) => api.pages()[i]?.key ?? ""));
        del.disabled = found.length === 0;
      } catch (error) {
        info.textContent = "";
        api.error(message(error));
      }
    };
    const form = new Form(blank.fields ?? [], values, () => {
      api.persist();
      del.disabled = true;
    });
    api.body.replaceChildren(
      el("p", { class: "summary", text: blank.summary }),
      form.root,
      row(
        button(
          "Find blank pages",
          () => {
            void scan();
          },
          { primary: true }
        ),
        del
      ),
      info
    );
    api.foot.replaceChildren();
    return {
      docChanged: () => {
        found = [];
        del.disabled = true;
        info.textContent = "";
      },
    };
  },
  name: "Remove blank pages",
  summary:
    "Find pages with next to nothing on them (the back of a single-sided scan, a separator sheet) and delete them.",
};

/* ---------------- split ---------------- */

const SPLIT_FIELDS: Field[] = [
  {
    key: "mode",
    kind: "select",
    label: "Split",
    options: [
      ["each", "Into single pages"],
      ["every", "Every few pages"],
      ["ranges", "At Page Ranges"],
      ["bookmarks", "At bookmarks"],
    ],
  },
  {
    key: "every",
    kind: "number",
    label: "Pages per file",
    max: 9999,
    min: 1,
    show: (v) => v.mode === "every",
  },
  {
    hint: "One file per line (or per semicolon), each a Page Range: 1-3; 4-10; 11-",
    key: "ranges",
    kind: "textarea",
    label: "Files",
    placeholder: "1-3\n4-10\n11-",
    show: (v) => v.mode === "ranges",
  },
  {
    hint: "1 splits at chapters only; 2 at their sections too.",
    key: "depth",
    kind: "number",
    label: "Bookmark levels",
    max: 9,
    min: 1,
    show: (v) => v.mode === "bookmarks",
  },
];

const split: PanelDef = {
  defaults: { depth: 1, every: 2, mode: "each", ranges: "" },
  fields: SPLIT_FIELDS,
  group: GROUP,
  id: "split",
  mount: (api, values) => {
    const plan = el("ol", { class: "plan" });
    const info = el("p", { class: "sel-info" });
    const foot = resultFoot(api, {
      downloadOnly: true,
      fileName: (a) => `${a.name()}-split.zip`,
    });
    let parts: Part[] = [];
    let outline: Ran<"outline"> | null = null;
    const go = button(
      "Split",
      async () => {
        const r = await api.run("split", { parts }, "Splitting");
        if (r?.files) {
          foot.show(r, `${count(r.files.length, "file", "files")} ready.`);
          await api.downloadFiles(r.files, `${api.name()}-split.zip`);
        }
      },
      { primary: true }
    );
    const replan = async () => {
      foot.show(null, "");
      if (values.mode === "bookmarks" && !outline) {
        outline = await api.run("outline", {}, "Reading bookmarks", {
          quiet: true,
        });
      }
      const o: SplitOptions = {
        base: api.name(),
        depth: Number(values.depth),
        every: Number(values.every),
        mode: values.mode as SplitOptions["mode"],
        ranges: String(values.ranges),
      };
      const bookmarks = outline?.report ?? [];
      const r = splitPlan(api.pageCount(), bookmarks, o);
      plan.replaceChildren();
      if (!r.ok) {
        parts = [];
        info.textContent = r.error;
        go.disabled = true;
        return;
      }
      ({ parts } = r);
      info.textContent = `${count(parts.length, "file", "files")}:`;
      go.disabled = parts.length === 0;
      for (const p of parts.slice(0, 200)) {
        plan.append(
          el(
            "li",
            {},
            el("span", { class: "part-name", text: p.name }),
            el("span", {
              class: "part-pages",
              text: count(p.pages.length, "page", "pages"),
            })
          )
        );
      }
      if (parts.length > 200) {
        plan.append(el("li", { text: `and ${parts.length - 200} more` }));
      }
    };
    const form = new Form(SPLIT_FIELDS, values, () => {
      api.persist();
      void replan();
    });
    api.body.replaceChildren(
      el("p", { class: "summary", text: split.summary }),
      form.root,
      row(go),
      info,
      plan
    );
    void replan();
    return {
      docChanged: () => {
        outline = null;
        void replan();
      },
    };
  },
  name: "Split into files",
  summary:
    "Make several PDFs out of this one: a file per page, per few pages, per Page Range, or per chapter. Each keeps its pages' links, comments, and form fields.",
};

/* ---------------- images to PDF ---------------- */

export const IMAGE_OPTIONS_KEY = "html-tools:pdf-toolkit:images";

const IMAGE_DEFAULTS: ImagePagesOptions = {
  fit: "contain",
  margin: 0,
  orientation: "auto",
  page: "a4",
};

/** How images are made into pages: the visitor's last choice (a Preference). */
export const imageOptions = (): ImagePagesOptions => {
  try {
    const raw = localStorage.getItem(IMAGE_OPTIONS_KEY);
    return raw
      ? {
          ...IMAGE_DEFAULTS,
          ...(JSON.parse(raw) as Partial<ImagePagesOptions>),
        }
      : IMAGE_DEFAULTS;
  } catch {
    return IMAGE_DEFAULTS;
  }
};

const PAPERS: [string, string][] = [
  ["image", "The image's own size"],
  ["a4", "A4"],
  ["letter", "Letter"],
  ["legal", "Legal"],
  ["a5", "A5"],
  ["a3", "A3"],
  ["tabloid", "Tabloid"],
];

const images: PanelDef = {
  group: GROUP,
  id: "images",
  mount: (api) => {
    const values: Values = { ...imageOptions() };
    const fields: Field[] = [
      { key: "page", kind: "select", label: "Page size", options: PAPERS },
      {
        key: "orientation",
        kind: "seg",
        label: "Orientation",
        options: [
          ["auto", "As the image"],
          ["portrait", "Portrait"],
          ["landscape", "Landscape"],
        ],
        show: (v) => v.page !== "image",
      },
      {
        key: "margin",
        kind: "number",
        label: "Margin",
        max: 100,
        min: 0,
        show: (v) => v.page !== "image",
        unit: "mm",
      },
      {
        key: "fit",
        kind: "seg",
        label: "Fit",
        options: [
          ["contain", "Whole image"],
          ["cover", "Fill the page"],
        ],
        show: (v) => v.page !== "image",
      },
    ];
    const form = new Form(fields, values, () => {
      try {
        localStorage.setItem(IMAGE_OPTIONS_KEY, JSON.stringify(values));
      } catch {
        // A private window: the choice holds for this visit.
      }
    });
    api.body.replaceChildren(
      el("p", { class: "summary", text: images.summary }),
      form.root,
      row(button("Add images…", () => pick(api, "image/*"), { primary: true })),
      el("p", {
        class: "hint",
        text: "JPEG, PNG, GIF, BMP, TIFF, and JPEG 2000 go in as they are; WebP, AVIF, HEIC, and SVG are decoded by the browser first. A photo's EXIF orientation is honoured. To fit pages already in the document to a paper size, use Scale pages.",
      })
    );
    api.foot.replaceChildren();
    return {};
  },
  name: "Images to PDF",
  summary:
    "Images dropped or added become pages, one each, set up as chosen here; dropped onto a document they join it.",
};

export const PAGE_PANELS: PanelDef[] = [
  organize,
  interleave,
  autorotate,
  blank,
  split,
  images,
];
