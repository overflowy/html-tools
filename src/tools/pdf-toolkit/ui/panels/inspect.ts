// Panels that look into a PDF and tidy it: what it is and holds, its
// document information, its bookmarks, its attachments, its text and
// images, and making it smaller, faster to open on the web, repaired, or
// checked.

import type { AttachmentInfo } from "../../pdf/attachments";
import type { InfoReport, Metadata } from "../../pdf/inspect";
import { parsePdfDate } from "../../pdf/inspect";
import type { Bookmark } from "../../pdf/outline";
import type { PanelDef } from "../api";
import {
  button,
  count,
  download,
  el,
  facts,
  formatBytes,
  formatDate,
} from "../dom";
import { Form } from "../form";
import type { Values } from "../form";
import { resultFoot, transformPanel } from "../panel-kit";

const GROUP = "Inspect and optimize";
const row = (...children: (Node | string)[]) =>
  el("div", { class: "row" }, ...children);

/* ---------------- info ---------------- */

const yesNo = (b: boolean) => (b ? "Yes" : "No");

const when = (pdfDate: string) =>
  formatDate(parsePdfDate(pdfDate)?.toISOString() ?? null) || "Not said";

const documentFacts = (r: InfoReport) => {
  const md = r.metadata;
  return facts([
    ["Pages", String(r.pages)],
    [
      "Page sizes",
      r.sizes
        .map((s) => (r.sizes.length > 1 ? `${s.size} (${s.count})` : s.size))
        .join(", "),
    ],
    ["File size", formatBytes(r.bytes)],
    ["PDF version", r.version],
    ["Title", md.title || "None"],
    ["Author", md.author || "None"],
    ["Subject", md.subject || "None"],
    ["Keywords", md.keywords || "None"],
    [
      "Made with",
      [md.creator, md.producer].filter(Boolean).join(", produced by ") ||
        "Not said",
    ],
    ["Created", when(md.created)],
    ["Modified", when(md.modified)],
    ["Language", md.language || "Not said"],
  ]);
};

const contentFacts = (r: InfoReport) => {
  const annotations = Object.entries(r.annotations)
    .map(([t, n]) => `${n} ${t}`)
    .join(", ");
  return facts([
    ["Images", String(r.images)],
    ["Annotations", annotations || "None"],
    ["Form fields", String(r.fields)],
    ["Signatures", String(r.signatures)],
    ["Attachments", String(r.attachments)],
    ["Bookmarks", String(r.bookmarks)],
    ["Layers", String(r.layers)],
    ["JavaScript", yesNo(r.javascript)],
    ["Tagged (accessible structure)", yesNo(r.tagged)],
    ["Page labels", yesNo(r.pageLabels)],
    ["Linearized (fast web view)", yesNo(r.linearized)],
    ["PDF/A", r.pdfa ?? "Not claimed"],
    ["Objects", r.objects.toLocaleString()],
  ]);
};

const embedding = (f: InfoReport["fonts"][number]): string => {
  if (!f.embedded) {
    return "No";
  }
  return f.subset ? "Subset" : "Whole";
};

const infoView = (r: InfoReport): HTMLElement[] => {
  const fonts = el("table", { class: "fonts" });
  fonts.append(
    el(
      "thead",
      {},
      el(
        "tr",
        {},
        el("th", { text: "Font" }),
        el("th", { text: "Type" }),
        el("th", { text: "Embedded" }),
        el("th", { text: "Pages" })
      )
    )
  );
  const body = el("tbody");
  for (const f of r.fonts) {
    const pages =
      f.pages.length > 6
        ? `${f.pages.slice(0, 5).join(", ")}…`
        : f.pages.join(", ");
    body.append(
      el(
        "tr",
        {},
        el("td", { text: f.name }),
        el("td", { text: f.type }),
        el("td", { class: f.embedded ? "" : "warn", text: embedding(f) }),
        el("td", { text: pages })
      )
    );
  }
  fonts.append(body);
  return [
    el("h3", { text: "Document" }),
    documentFacts(r),
    el("h3", { text: "Contents" }),
    contentFacts(r),
    el("h3", { text: `Fonts (${r.fonts.length})` }),
    ...(r.fonts.length
      ? [fonts]
      : [
          el("p", {
            class: "hint",
            text: "No fonts: the pages have no text, or their text is drawn as shapes.",
          }),
        ]),
    ...(r.fonts.some((f) => !f.embedded)
      ? [
          el("p", {
            class: "hint",
            text: "A font that is not embedded is drawn with a substitute where it is missing, so the text may look different elsewhere.",
          }),
        ]
      : []),
  ];
};

const infoPanel: PanelDef = {
  group: GROUP,
  id: "info",
  mount: (api) => {
    const load = async () => {
      api.body.replaceChildren(
        el("p", { class: "summary", text: infoPanel.summary }),
        el("p", { class: "sel-info", text: "Reading…" })
      );
      const r = await api.run("info", {}, "Reading the document", {
        quiet: true,
      });
      if (r) {
        api.body.replaceChildren(
          el("p", { class: "summary", text: infoPanel.summary }),
          ...infoView(r.report)
        );
      }
    };
    api.foot.replaceChildren();
    void load();
    return {
      docChanged: () => {
        void load();
      },
    };
  },
  name: "Document info",
  summary:
    "What the document is and what it holds, as of the pages in the Workspace now.",
};

/* ---------------- metadata ---------------- */

const META_FIELDS = [
  ["title", "Title"],
  ["author", "Author"],
  ["subject", "Subject"],
  ["keywords", "Keywords"],
  ["creator", "Creating program"],
  ["producer", "Producer"],
  ["language", "Language"],
] as const;

const metadata: PanelDef = {
  group: GROUP,
  id: "metadata",
  mount: (api) => {
    const foot = resultFoot(api, {
      applyLabel: "the new metadata",
      fileName: (a) => `${a.name()}.pdf`,
    });
    const load = async () => {
      const r = await api.run("metadata", {}, "Reading metadata", {
        quiet: true,
      });
      if (!r) {
        return;
      }
      const md: Metadata = r.report;
      const values: Values = { touch: true };
      for (const [k] of META_FIELDS) {
        values[k] = md[k];
      }
      const form = new Form(
        [
          ...META_FIELDS.map(([key, label]) => ({
            key,
            kind: "text" as const,
            label,
            placeholder: key === "language" ? "en-GB" : "",
          })),
          {
            key: "touch",
            kind: "check",
            label: "Set the modified date to now",
          },
        ],
        values,
        () => {
          foot.show(null, "Changed: Save to see it.");
        }
      );
      const save = button(
        "Save metadata",
        async () => {
          const out = await api.run(
            "writeMetadata",
            {
              touch: values.touch === true,
              values: {
                author: String(values.author),
                creator: String(values.creator),
                keywords: String(values.keywords),
                language: String(values.language),
                producer: String(values.producer),
                subject: String(values.subject),
                title: String(values.title),
              },
            },
            "Writing metadata"
          );
          if (out?.doc) {
            foot.show(out, "Ready: Apply or Download.");
          }
        },
        { primary: true }
      );
      api.body.replaceChildren(
        el("p", { class: "summary", text: metadata.summary }),
        form.root,
        facts([
          [
            "Created",
            formatDate(parsePdfDate(md.created)?.toISOString() ?? null) ||
              "Not said",
          ],
          [
            "Modified",
            formatDate(parsePdfDate(md.modified)?.toISOString() ?? null) ||
              "Not said",
          ],
        ]),
        row(save),
        el("p", {
          class: "hint",
          text: "An empty field removes that entry. The XMP copy of the metadata, which would contradict the new values, is removed.",
        })
      );
    };
    void load();
    return {
      docChanged: () => {
        void load();
      },
    };
  },
  name: "Metadata",
  summary:
    "The document's title, author, subject, keywords, and the rest, as readers show them in Properties.",
};

/* ---------------- bookmarks ---------------- */

interface FlatMark {
  title: string;
  page: number | null;
  level: number;
  y: number | null;
  uri?: string;
  open: boolean;
}

const flatten = (items: Bookmark[], level = 0): FlatMark[] =>
  items.flatMap((b) => [
    { level, open: b.open, page: b.page, title: b.title, uri: b.uri, y: b.y },
    ...flatten(b.children, level + 1),
  ]);

/** A flat list with levels back into a tree; a level that jumps is taken as one deeper. */
const nest = (flat: FlatMark[]): Bookmark[] => {
  const root: Bookmark[] = [];
  const stack: { level: number; children: Bookmark[] }[] = [
    { children: root, level: -1 },
  ];
  for (const f of flat) {
    while ((stack.at(-1)?.level ?? -1) >= f.level) {
      stack.pop();
    }
    const b: Bookmark = {
      children: [],
      open: f.open,
      page: f.page,
      title: f.title,
      uri: f.uri,
      y: f.y,
    };
    stack.at(-1)?.children.push(b);
    stack.push({ children: b.children, level: f.level });
  }
  return root;
};

/** A small button that names what it does to its row in `data-action`. */
const rowAction = (action: string, label: string, title: string) => {
  const b = el("button", {
    attrs: { "data-action": action, type: "button" },
    class: "inline",
    text: label,
    title,
  });
  b.setAttribute("aria-label", title);
  return b;
};

/** Where a new top-level bookmark for `page` goes: before the first top-level one after it. */
const insertAt = (marks: FlatMark[], page: number): number => {
  const at = marks.findIndex((m) => m.level === 0 && (m.page ?? 0) > page);
  return at === -1 ? marks.length : at;
};

const bookmarks: PanelDef = {
  group: GROUP,
  id: "bookmarks",
  mount: (api) => {
    let marks: FlatMark[] = [];
    let dirty = false;
    const list = el("ol", { class: "bookmarks" });
    const foot = resultFoot(api, {
      applyLabel: "the bookmarks",
      fileName: (a) => `${a.name()}.pdf`,
    });
    const render = () => {
      list.replaceChildren();
      for (const [i, m] of marks.entries()) {
        const title = el("input", {
          attrs: {
            "aria-label": "Title",
            "data-field": "title",
            spellcheck: "false",
            type: "text",
          },
        });
        title.value = m.title;
        const page = el("input", {
          attrs: {
            "aria-label": "Page",
            "data-field": "page",
            inputmode: "numeric",
            type: "text",
          },
        });
        page.value = m.page === null ? "" : String(m.page + 1);
        list.append(
          el(
            "li",
            { attrs: { "data-i": String(i), style: `--level:${m.level}` } },
            title,
            page,
            rowAction("go", "Go", "Go to its page"),
            rowAction("up", "↑", "Up"),
            rowAction("down", "↓", "Down"),
            rowAction("out", "←", "Out a level"),
            rowAction("in", "→", "In a level"),
            rowAction("delete", "×", "Delete")
          )
        );
      }
      if (!marks.length) {
        list.append(el("li", { class: "empty", text: "No bookmarks." }));
      }
    };
    const touch = () => {
      dirty = true;
      foot.show(null, "Changed: Save to see it.");
      render();
    };
    const move = (i: number, d: number) => {
      const j = i + d;
      const [item] = j >= 0 && j < marks.length ? marks.splice(i, 1) : [];
      if (item) {
        marks.splice(j, 0, item);
      }
    };
    const indent = (i: number, d: number) => {
      const m = marks[i];
      if (m) {
        m.level = Math.max(
          0,
          Math.min((marks[i - 1]?.level ?? -1) + 1, m.level + d)
        );
      }
    };
    const act = (action: string, i: number) => {
      const m = marks[i];
      if (!m) {
        return;
      }
      if (action === "go") {
        if (m.page !== null) {
          api.goTo(m.page, m.y ?? undefined);
        }
        return;
      }
      if (action === "up" || action === "down") {
        move(i, action === "up" ? -1 : 1);
      } else if (action === "out" || action === "in") {
        indent(i, action === "in" ? 1 : -1);
      } else if (action === "delete") {
        marks.splice(i, 1);
      }
      touch();
    };
    const rowOf = (target: EventTarget | null) =>
      Number((target as HTMLElement | null)?.closest("li")?.dataset.i ?? -1);
    list.addEventListener("click", (e) => {
      const action = (e.target as HTMLElement).closest<HTMLElement>(
        "[data-action]"
      )?.dataset.action;
      if (action) {
        act(action, rowOf(e.target));
      }
    });
    list.addEventListener("change", (e) => {
      const input = e.target as HTMLInputElement;
      const m = marks[rowOf(input)];
      if (!m) {
        return;
      }
      if (input.dataset.field === "title") {
        m.title = input.value;
        dirty = true;
        foot.show(null, "Changed: Save to see it.");
        return;
      }
      const n = Number(input.value);
      m.page =
        Number.isInteger(n) && n >= 1 && n <= api.pageCount() ? n - 1 : null;
      m.y = null;
      touch();
    });
    const load = async () => {
      const r = await api.run("outline", {}, "Reading bookmarks", {
        quiet: true,
      });
      marks = flatten(r?.report ?? []);
      dirty = false;
      render();
    };
    const add = button("Add for the current page", () => {
      const page = api.currentPage();
      marks.splice(insertAt(marks, page), 0, {
        level: 0,
        open: false,
        page,
        title: `Page ${page + 1}`,
        y: null,
      });
      touch();
    });
    const save = button(
      "Save bookmarks",
      async () => {
        const out = await api.run(
          "writeOutline",
          { items: nest(marks) },
          "Writing bookmarks"
        );
        if (out?.doc) {
          dirty = false;
          foot.show(out, "Ready: Apply or Download.");
        }
      },
      { primary: true }
    );
    api.body.replaceChildren(
      el("p", { class: "summary", text: bookmarks.summary }),
      row(add, save),
      list
    );
    void load();
    return {
      docChanged: () => {
        if (!dirty) {
          void load();
        }
      },
    };
  },
  name: "Bookmarks",
  summary:
    "The document's outline: rename, reorder, nest, and point bookmarks at pages, or add one for the page you are on.",
};

/* ---------------- attachments ---------------- */

const attachments: PanelDef = {
  group: GROUP,
  id: "attachments",
  mount: (api) => {
    let list: AttachmentInfo[] = [];
    const remove = new Set<string>();
    const add: {
      name: string;
      mime: string;
      bytes: Uint8Array;
      modified: number;
    }[] = [];
    const ul = el("ul", { class: "annots" });
    const foot = resultFoot(api, {
      applyLabel: "the attachment changes",
      fileName: (a) => `${a.name()}.pdf`,
    });
    const render = () => {
      ul.replaceChildren();
      for (const a of list) {
        const gone = remove.has(a.key);
        const meta = [
          formatBytes(a.bytes),
          a.page ? `on page ${a.page}` : "",
          a.description,
        ]
          .filter(Boolean)
          .join(" · ");
        ul.append(
          el(
            "li",
            { attrs: { "data-key": a.key }, class: gone ? "gone" : "" },
            el("span", { class: "att-name", text: a.filename }),
            el("span", { class: "att-meta", text: meta }),
            rowAction("save", "Save", `Save ${a.filename}`),
            rowAction(
              "toggle",
              gone ? "Keep" : "Remove",
              gone ? `Keep ${a.filename}` : `Remove ${a.filename}`
            )
          )
        );
      }
      for (const [i, f] of add.entries()) {
        ul.append(
          el(
            "li",
            { attrs: { "data-new": String(i) }, class: "new" },
            el("span", { class: "att-name", text: f.name }),
            el("span", {
              class: "att-meta",
              text: `${formatBytes(f.bytes.length)} · to add`,
            }),
            rowAction("unadd", "×", `Do not add ${f.name}`)
          )
        );
      }
      if (!ul.childElementCount) {
        ul.append(el("li", { class: "empty", text: "No attachments." }));
      }
    };
    const changed = async () => {
      render();
      if (!add.length && !remove.size) {
        foot.show(null, "");
        return;
      }
      const r = await api.run(
        "editAttachments",
        { add, remove: [...remove] },
        "Updating attachments",
        { quiet: true }
      );
      if (r?.doc) {
        foot.show(
          r,
          `${count(add.length, "to add", "to add")}, ${count(remove.size, "to remove", "to remove")}.`
        );
      }
    };
    const save = async (key: string) => {
      const r = await api.run(
        "extractAttachments",
        { keys: [key] },
        "Saving the attachment",
        { quiet: true }
      );
      const [file] = r?.files ?? [];
      if (file) {
        download(
          new Blob([file.bytes as Uint8Array<ArrayBuffer>], {
            type: file.mime,
          }),
          file.name
        );
      }
    };
    ul.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const action =
        target.closest<HTMLElement>("[data-action]")?.dataset.action;
      const li = target.closest("li");
      const key = li?.dataset.key ?? "";
      if (action === "save") {
        void save(key);
      } else if (action === "toggle") {
        if (remove.has(key)) {
          remove.delete(key);
        } else {
          remove.add(key);
        }
        void changed();
      } else if (action === "unadd") {
        add.splice(Number(li?.dataset.new ?? -1), 1);
        void changed();
      }
    });
    const load = async () => {
      const r = await api.run("attachments", {}, "Reading attachments", {
        quiet: true,
      });
      list = r?.report ?? [];
      remove.clear();
      render();
    };
    const saveAll = button("Save all", async () => {
      const r = await api.run(
        "extractAttachments",
        { keys: list.map((a) => a.key) },
        "Saving attachments",
        { quiet: true }
      );
      if (r?.files?.length) {
        await api.downloadFiles(r.files, `${api.name()}-attachments.zip`);
      }
    });
    const pick = button("Add files…", () => {
      const input = el("input", { attrs: { multiple: "", type: "file" } });
      input.addEventListener("change", async () => {
        for (const f of input.files ?? []) {
          add.push({
            bytes: new Uint8Array(await f.arrayBuffer()),
            mime: f.type,
            modified: f.lastModified,
            name: f.name,
          });
        }
        void changed();
      });
      input.click();
    });
    api.body.replaceChildren(
      el("p", { class: "summary", text: attachments.summary }),
      row(pick, saveAll),
      ul
    );
    void load();
    return {
      docChanged: () => {
        void load();
      },
    };
  },
  name: "Attachments",
  summary:
    "Files embedded in the PDF, the document's own and those pinned to a page: save them, remove them, or attach more.",
};

/* ---------------- text ---------------- */

const text = transformPanel({
  applyLabel: "",
  defaults: { headings: true },
  downloadOnly: true,
  extend: ({ area }) => {
    area.classList.add("text-out");
    return {};
  },
  fields: [
    {
      key: "headings",
      kind: "check",
      label: "A heading before each page (else a page break character)",
    },
  ],
  group: GROUP,
  id: "text",
  live: true,
  name: "Extract text",
  op: "text",
  options: (v, api) => ({
    headings: v.headings === true,
    name: `${api.name()}.txt`,
  }),
  report: (r) => {
    const t = el("textarea", {
      attrs: {
        "aria-label": "Extracted text",
        readonly: "",
        rows: "16",
        spellcheck: "false",
      },
    });
    t.value =
      r.report.length > 2_000_000
        ? `${r.report.slice(0, 2_000_000)}\n…`
        : r.report;
    return t;
  },
  suffix: "",
  summary:
    "The document's text, page by page, as plain text. Scanned pages have none until OCR gives them some; Document to Markdown keeps headings, lists, and tables.",
});

/* ---------------- images ---------------- */

const images = transformPanel({
  applyLabel: "",
  defaults: { minSide: 16 },
  downloadOnly: true,
  fields: [
    {
      hint: "Smaller ones are icons, rules, and spacers.",
      key: "minSide",
      kind: "number",
      label: "Skip images smaller than",
      max: 4000,
      min: 1,
      unit: "px",
    },
  ],
  group: GROUP,
  id: "images-out",
  live: false,
  name: "Extract images",
  op: "extractImages",
  options: (v) => ({ minSide: Number(v.minSide) }),
  report: (r) => {
    const files = r.files ?? [];
    const { images: list, unreadable } = r.report;
    // Images found but too broken to read: said, not silently missing.
    const broken = unreadable.length
      ? el("p", {
          class: "hint warn",
          text: `${count(unreadable.length, "image", "images")} could not be read, on ${unreadable.length === 1 ? "page" : "pages"} ${[...new Set(unreadable)].join(", ")}: ${unreadable.length === 1 ? "its" : "their"} data is missing or damaged in the file.`,
        })
      : "";
    if (!files.length) {
      return el(
        "div",
        {},
        el("p", { class: "sel-info", text: "No images." }),
        broken
      );
    }
    const grid = el("div", { class: "gallery" });
    for (const [i, info] of list.entries()) {
      const file = files[i];
      if (!file) {
        continue;
      }
      const blob = new Blob([file.bytes as Uint8Array<ArrayBuffer>], {
        type: file.mime,
      });
      const url = URL.createObjectURL(blob);
      const fig = el("button", {
        attrs: { title: `Save ${file.name}`, type: "button" },
        class: "image-tile",
      });
      // The browser cannot show JPEG 2000; its tile names it instead.
      if (info.format !== "JPEG 2000") {
        fig.append(
          el("img", { attrs: { alt: "", loading: "lazy", src: url } })
        );
      }
      fig.append(
        el("span", {
          text: `${info.width} × ${info.height} ${info.format}, page ${info.page}`,
        })
      );
      fig.addEventListener("click", () => download(blob, file.name));
      grid.append(fig);
    }
    return el(
      "div",
      {},
      el("p", {
        class: "sel-info",
        text: `${count(files.length, "image", "images")}. Click one to save it; Download saves them all.`,
      }),
      broken,
      grid
    );
  },
  runLabel: "Find images",
  suffix: "-images",
  summary:
    "Every image in the document, saved as it is stored: JPEG and JPEG 2000 byte for byte, anything else as PNG.",
});

/* ---------------- compress ---------------- */

const compress = transformPanel({
  applyLabel: "the compression",
  defaults: { images: "medium", objectStreams: true, subsetFonts: true },
  fields: [
    {
      key: "images",
      kind: "seg",
      label: "Images",
      options: [
        ["keep", "Keep"],
        ["high", "High (200 dpi)"],
        ["medium", "Medium (150 dpi)"],
        ["low", "Small (96 dpi)"],
      ],
    },
    {
      key: "subsetFonts",
      kind: "check",
      label: "Keep only the letters fonts use",
    },
    {
      key: "objectStreams",
      kind: "check",
      label: "Compress the file's structure (PDF 1.5 and later)",
    },
  ],
  group: GROUP,
  id: "compress",
  live: false,
  name: "Compress",
  op: "compress",
  options: (v) => ({
    images: v.images as "keep" | "high" | "medium" | "low",
    objectStreams: v.objectStreams === true,
    subsetFonts: v.subsetFonts === true,
  }),
  report: (r) => {
    const { before, after, images: replaced, kept } = r.report;
    const saved = before - after;
    return facts([
      ["Before", formatBytes(before)],
      ["After", formatBytes(after)],
      [
        "Saved",
        saved > 0
          ? `${formatBytes(saved)} (${Math.round((saved / before) * 100)}%)`
          : "Nothing: it was as small as this makes it",
      ],
      [
        "Images recompressed",
        `${replaced}${kept ? ` (${kept} left, already smaller)` : ""}`,
      ],
    ]);
  },
  runLabel: "Compress",
  suffix: "-compressed",
  summary:
    "Make the file smaller: photos resampled and recompressed (drawings and scans of text are left sharp), duplicate objects merged, fonts subset.",
});

const linearize = transformPanel({
  applyLabel: "",
  defaults: {},
  downloadOnly: true,
  fields: [],
  group: GROUP,
  id: "linearize",
  live: false,
  name: "Fast web view",
  op: "linearize",
  options: (_v, api) => ({ name: `${api.name()}-web.pdf` }),
  runLabel: "Linearize",
  suffix: "-web",
  summary:
    "Linearize the PDF, so a browser shows its first page while the rest still downloads. Do this last: any later change undoes it.",
});

const repair = transformPanel({
  applyLabel: "the repair",
  defaults: {},
  fields: [],
  group: GROUP,
  id: "repair",
  live: false,
  name: "Repair",
  op: "repair",
  options: () => ({}),
  report: (r) =>
    el(
      "div",
      {},
      el("p", {
        class: "sel-info",
        text: r.report.repaired
          ? "The file was damaged; MuPDF rebuilt it from what it could read."
          : "The file's structure was sound; it has been rewritten cleanly anyway.",
      }),
      ...(r.report.warnings.length
        ? [
            el(
              "ul",
              { class: "lines" },
              ...r.report.warnings
                .slice(0, 100)
                .map((w) => el("li", { text: w }))
            ),
          ]
        : [])
    ),
  runLabel: "Repair",
  suffix: "-repaired",
  summary:
    "Rewrite the file from what MuPDF can read of it: a broken cross-reference table, a cut-off download, objects in the wrong place.",
});

/* ---------------- validate ---------------- */

const mupdfVerdict = (m: { repaired: boolean; warnings: string[] }): string => {
  if (m.repaired) {
    return "The file needed repair to open.";
  }
  return m.warnings.length
    ? count(m.warnings.length, "warning", "warnings")
    : "Read without a warning.";
};

const validate: PanelDef = {
  group: GROUP,
  id: "validate",
  mount: (api) => {
    const out = el("div");
    const check = async () => {
      out.replaceChildren(el("p", { class: "sel-info", text: "Checking…" }));
      const r = await api.run("validate", {}, "Checking the structure", {
        quiet: true,
      });
      if (!r) {
        out.replaceChildren();
        return;
      }
      const { qpdf, mupdf } = r.report;
      out.replaceChildren(
        el("h3", { text: "qpdf's structural check" }),
        el("p", {
          class: `verdict-line ${qpdf.ok ? "ok" : "bad"}`,
          text: qpdf.ok
            ? "No syntax or stream errors found."
            : "Problems found.",
        }),
        el(
          "ul",
          { class: "lines" },
          ...qpdf.lines.slice(0, 200).map((l) => el("li", { text: l }))
        ),
        el("h3", { text: "MuPDF reading every page" }),
        el("p", {
          class: `verdict-line ${mupdf.repaired || mupdf.warnings.length ? "warn" : "ok"}`,
          text: mupdfVerdict(mupdf),
        }),
        el(
          "ul",
          { class: "lines" },
          ...mupdf.warnings.slice(0, 200).map((l) => el("li", { text: l }))
        )
      );
    };
    api.body.replaceChildren(
      el("p", { class: "summary", text: validate.summary }),
      out
    );
    api.foot.replaceChildren();
    void check();
    return {
      docChanged: () => {
        void check();
      },
    };
  },
  name: "Validate",
  summary:
    "Check the file's structure two ways: qpdf's check of its syntax and streams, and MuPDF's warnings as it reads and interprets every page.",
};

export const INSPECT_PANELS: PanelDef[] = [
  infoPanel,
  metadata,
  bookmarks,
  attachments,
  text,
  images,
  compress,
  linearize,
  repair,
  validate,
];
