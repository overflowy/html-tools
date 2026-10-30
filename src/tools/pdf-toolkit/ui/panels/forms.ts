// Panels for what a reader adds to a PDF: annotations (marked up on the
// page, drawn in the overlay as they are made), form fields (filled in from
// a list, or new ones drawn on the page), and flattening both into the page.

import type { AnnotInfo, AnnotKind, NewAnnot } from "../../pdf/annotate";
import type { FieldInfo, NewField } from "../../pdf/forms";
import type { Point, Rect } from "../../pdf/geometry";
import type { Quad } from "../../pdf/text";
import type { Api, PanelDef } from "../api";
import {
  button,
  count,
  debounce,
  download,
  el,
  iconButton,
  message,
} from "../dom";
import { Form } from "../form";
import type { Field, Values } from "../form";
import { resultFoot, runner, transformPanel } from "../panel-kit";
import type { Gesture, Mark } from "../viewer";

const GROUP = "Forms and annotations";
const row = (...children: (Node | string)[]) =>
  el("div", { class: "row" }, ...children);
const ICON_X =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';

const normRect = (a: Point, b: Point): Rect => [
  Math.min(a[0], b[0]),
  Math.min(a[1], b[1]),
  Math.max(a[0], b[0]),
  Math.max(a[1], b[1]),
];
const big = (r: Rect) => r[2] - r[0] > 3 && r[3] - r[1] > 3;

/** A panel that changes the document only when asked: its foot runs the Operation for Download and Apply. */
const commitFoot = (
  api: Api,
  label: string,
  suffix: string,
  build: () => Promise<Awaited<ReturnType<Api["run"]>>>
) => {
  const status = el("span", {
    attrs: { "aria-live": "polite" },
    class: "foot-status",
  });
  const go = async (then: "download" | "apply") => {
    const r = await build();
    if (!r?.doc) {
      return;
    }
    if (then === "apply") {
      api.apply(r, label);
    } else {
      api.download(
        new Blob([r.doc.bytes as Uint8Array<ArrayBuffer>], {
          type: "application/pdf",
        }),
        `${api.name()}${suffix}.pdf`
      );
      api.showResult(r);
    }
  };
  const dl = button("Download", () => {
    void go("download");
  });
  const apply = button(
    "Apply",
    () => {
      void go("apply");
    },
    { primary: true }
  );
  api.foot.replaceChildren(status, el("span", { class: "spacer" }), dl, apply);
  return {
    enable: (on: boolean, text = "") => {
      dl.disabled = !on;
      apply.disabled = !on;
      status.textContent = text;
    },
  };
};

/* ---------------- annotate ---------------- */

/** A button in a list whose clicks the list handles: its label, or an icon named by it. */
const listButton = (label: string, icon?: string): HTMLButtonElement => {
  const b = el("button", {
    attrs: { "aria-label": label, type: "button" },
    class: icon ? "icon inline" : "inline",
    title: label,
  });
  if (icon) {
    b.innerHTML = icon;
  } else {
    b.textContent = label;
  }
  return b;
};

interface AnnotTool {
  kind: AnnotKind;
  label: string;
  /** How it is drawn on the page. */
  draw: "text" | "point" | "ink" | "rect" | "line";
}

const TOOLS: AnnotTool[] = [
  { draw: "text", kind: "highlight", label: "Highlight" },
  { draw: "text", kind: "underline", label: "Underline" },
  { draw: "text", kind: "strikeout", label: "Strike out" },
  { draw: "text", kind: "squiggly", label: "Squiggle" },
  { draw: "point", kind: "note", label: "Note" },
  { draw: "ink", kind: "ink", label: "Draw" },
  { draw: "rect", kind: "text", label: "Text box" },
  { draw: "rect", kind: "rect", label: "Rectangle" },
  { draw: "rect", kind: "ellipse", label: "Ellipse" },
  { draw: "line", kind: "arrow", label: "Arrow" },
  { draw: "line", kind: "line", label: "Line" },
];

const toolFor = (kind: unknown): AnnotTool =>
  TOOLS.find((t) => t.kind === kind) ?? {
    draw: "text",
    kind: "highlight",
    label: "Highlight",
  };

const KIND_NAMES: Record<string, string> = Object.fromEntries(
  TOOLS.map((t) => [t.kind, t.label])
);
const DEFAULT_COLORS: Partial<Record<AnnotKind, string>> = {
  highlight: "#ffd400",
  note: "#ffd400",
  strikeout: "#d62828",
  text: "#1d3557",
  underline: "#2a9d8f",
};

const annotate: PanelDef = {
  defaults: {
    color: "#ffd400",
    opacity: 1,
    text: "",
    tool: "highlight",
    width: 2,
  },
  fields: [],
  group: GROUP,
  id: "annotate",
  mount: (api, values) => {
    const added: NewAnnot[] = [];
    const removed = new Set<string>();
    let existing: AnnotInfo[] = [];
    let live: { page: number; mark: Mark } | null = null;
    const toolSeg = el("div", {
      attrs: { "aria-label": "Tool", role: "group" },
      class: "seg tools",
    });
    const list = el("ul", { class: "annots" });
    const textField = el("textarea", {
      attrs: {
        "aria-label": "Text of the next note or text box",
        placeholder: "Text for notes and text boxes",
        rows: "2",
      },
    });
    textField.value = String(values.text ?? "");
    const fields: Field[] = [
      { key: "color", kind: "color", label: "Colour" },
      {
        format: (v) => `${Math.round(v * 100)}%`,
        key: "opacity",
        kind: "range",
        label: "Opacity",
        max: 1,
        min: 0.1,
        step: 0.05,
      },
      {
        key: "width",
        kind: "number",
        label: "Line width",
        max: 20,
        min: 0.5,
        show: (v) =>
          ["ink", "rect", "ellipse", "arrow", "line"].includes(String(v.tool)),
        step: 0.5,
        unit: "pt",
      },
    ];
    const form = new Form(fields, values, () => api.persist());
    const foot = commitFoot(api, "the annotations", "-annotated", () =>
      api.run(
        "annotate",
        {
          add: added,
          remove: existing
            .filter((a) => removed.has(`${a.page}:${a.index}`))
            .map((a) => ({ index: a.index, page: a.page })),
        },
        "Adding the annotations"
      )
    );
    const renderList = () => {
      list.replaceChildren();
      for (const [i, a] of added.entries()) {
        list.append(
          el(
            "li",
            { attrs: { "data-added": String(i) } },
            el("span", {
              attrs: { style: `background:${a.color}` },
              class: "swatch",
            }),
            `${KIND_NAMES[a.kind] ?? a.kind}, page ${a.page + 1}${a.text ? `: ${a.text}` : ""}`,
            listButton("Remove", ICON_X)
          )
        );
      }
      for (const a of existing) {
        const id = `${a.page}:${a.index}`;
        const gone = removed.has(id);
        list.append(
          el(
            "li",
            { attrs: { "data-existing": id }, class: gone ? "gone" : "" },
            el("span", {
              attrs: { style: `background:${a.color || "transparent"}` },
              class: "swatch",
            }),
            `${a.type}, page ${a.page + 1}${a.contents ? `: ${a.contents.slice(0, 60)}` : ""}`,
            listButton(gone ? "Keep" : "Remove")
          )
        );
      }
      if (!list.childElementCount) {
        list.append(el("li", { class: "empty", text: "No annotations yet." }));
      }
    };
    const changed = () => {
      foot.enable(
        added.length > 0 || removed.size > 0,
        added.length || removed.size
          ? `${count(added.length, "new", "new")}, ${count(removed.size, "removal", "removals")}`
          : ""
      );
      renderList();
      api.redrawMarks();
    };
    const add = (a: Omit<NewAnnot, "color" | "opacity" | "kind">) => {
      added.push({
        ...a,
        color: String(values.color),
        kind: values.tool as AnnotKind,
        opacity: Number(values.opacity),
        width: Number(values.width),
      });
      changed();
    };
    const selectQuads = debounce(async (g: Gesture) => {
      try {
        const w = await api.worker();
        const doc = await api.current();
        const quads = (await w.call("select", [
          doc.id,
          g.page,
          g.from,
          g.to,
        ])) as Quad[];
        if (g.done) {
          live = null;
          if (quads.length) {
            add({ page: g.page, quads });
          } else {
            api.redrawMarks(g.page);
          }
        } else {
          live = {
            mark: {
              color: String(values.color),
              kind: "quads",
              quads,
              style: "markup",
            },
            page: g.page,
          };
          api.redrawMarks(g.page);
        }
      } catch (error) {
        api.error(message(error));
      }
    }, 30);
    const gesture = (g: Gesture) => {
      const tool = toolFor(values.tool).draw;
      const color = String(values.color);
      const width = Number(values.width);
      if (tool === "text") {
        void selectQuads(g);
        return;
      }
      if (!g.done) {
        const kind = values.tool;
        let mark: Mark;
        if (tool === "ink") {
          mark = { color, kind: "ink", strokes: [g.points], width };
        } else if (tool === "line") {
          mark = {
            a: g.from,
            arrow: kind === "arrow",
            b: g.to,
            color,
            kind: "line",
            width,
          };
        } else {
          mark = { kind: "rect", rect: normRect(g.from, g.to), style: "box" };
        }
        live = { mark, page: g.page };
        api.redrawMarks(g.page);
        return;
      }
      live = null;
      if (tool === "point") {
        add({
          page: g.page,
          rect: [g.to[0], g.to[1], g.to[0], g.to[1]],
          text: textField.value,
        });
      } else if (tool === "ink" && g.points.length > 1) {
        add({ ink: [g.points], page: g.page });
      } else if (
        tool === "line" &&
        Math.hypot(g.to[0] - g.from[0], g.to[1] - g.from[1]) > 3
      ) {
        add({ line: [g.from, g.to], page: g.page });
      } else if (tool === "rect" && big(normRect(g.from, g.to))) {
        add({
          fontSize: 12,
          page: g.page,
          rect: normRect(g.from, g.to),
          text: values.tool === "text" ? textField.value || "Text" : undefined,
        });
      } else {
        api.redrawMarks(g.page);
      }
    };
    const markOf = (a: NewAnnot): Mark | null => {
      if (a.quads) {
        return {
          color: a.color,
          kind: "quads",
          quads: a.quads,
          style: "markup",
        };
      }
      if (a.ink) {
        return {
          color: a.color,
          kind: "ink",
          strokes: a.ink,
          width: a.width ?? 2,
        };
      }
      if (a.line) {
        return {
          a: a.line[0],
          arrow: a.kind === "arrow",
          b: a.line[1],
          color: a.color,
          kind: "line",
          width: a.width ?? 1,
        };
      }
      if (a.kind === "note" && a.rect) {
        return { at: [a.rect[0], a.rect[1]], color: a.color, kind: "note" };
      }
      return a.rect
        ? {
            kind: "rect",
            label: KIND_NAMES[a.kind],
            rect: a.rect,
            style: "box",
          }
        : null;
    };
    api.setMarks((page) => {
      const marks = added
        .filter((a) => a.page === page)
        .map(markOf)
        .filter((m): m is Mark => m !== null);
      for (const a of existing) {
        if (a.page === page && removed.has(`${a.page}:${a.index}`)) {
          marks.push({
            kind: "rect",
            label: "Removed",
            rect: a.rect,
            style: "redact",
          });
        }
      }
      if (live?.page === page) {
        marks.push(live.mark);
      }
      return marks;
    });
    const setTool = (kind: string) => {
      values.tool = kind;
      const tool = toolFor(kind).draw;
      const color = DEFAULT_COLORS[kind as AnnotKind];
      if (color) {
        form.set("color", color);
      }
      for (const b of toolSeg.querySelectorAll("button")) {
        b.classList.toggle("active", b.dataset.value === kind);
        b.setAttribute("aria-pressed", String(b.dataset.value === kind));
      }
      api.setTool(tool, gesture);
      form.refresh();
      api.persist();
    };
    for (const t of TOOLS) {
      toolSeg.append(
        button(t.label, () => setTool(t.kind), {
          attrs: { "data-value": t.kind },
        })
      );
    }
    const load = async () => {
      const r = await api.run("annotations", {}, "Reading annotations", {
        quiet: true,
      });
      existing = r?.report ?? [];
      removed.clear();
      changed();
    };
    // One listener for the list's buttons: a new annotation goes, an existing one is marked to go or kept.
    list.addEventListener("click", (e) => {
      const li = (e.target as HTMLElement).closest("li");
      if (!(e.target as HTMLElement).closest("button") || !li) {
        return;
      }
      if (li.dataset.added !== undefined) {
        added.splice(Number(li.dataset.added), 1);
      } else if (li.dataset.existing) {
        const id = li.dataset.existing;
        if (removed.has(id)) {
          removed.delete(id);
        } else {
          removed.add(id);
        }
      }
      changed();
    });
    textField.addEventListener("input", () => {
      values.text = textField.value;
    });
    api.body.replaceChildren(
      el("p", { class: "summary", text: annotate.summary }),
      toolSeg,
      form.root,
      el(
        "div",
        { class: "field" },
        el("label", { text: "Note and text box text" }),
        textField
      ),
      el("h3", { text: "Annotations" }),
      list
    );
    setTool(String(values.tool));
    void load();
    return {
      destroy: () => {
        api.setTool(null);
        api.setMarks(null);
      },
      docChanged: () => {
        added.length = 0;
        void load();
      },
    };
  },
  name: "Annotate",
  summary:
    "Mark up the pages in the Pages view: drag across text to highlight it, click to leave a note, draw, box, or point. They stay annotations any PDF reader can edit.",
};

/* ---------------- fill form ---------------- */

const fill: PanelDef = {
  defaults: { flatten: false },
  group: GROUP,
  id: "fill",
  mount: (api, values) => {
    let fields: FieldInfo[] = [];
    /** What the user filled in, by field name. */
    const filled = new Map<string, string>();
    const list = el("div", { class: "fields" });
    const info = el("p", { class: "sel-info" });
    const foot = resultFoot(api, {
      applyLabel: "the filled form",
      fileName: (a) => `${a.name()}-filled.pdf`,
    });
    const run = runner(
      () =>
        filled.size
          ? api.run(
              "fill",
              {
                flatten: values.flatten === true,
                values: Object.fromEntries(filled),
              },
              "Filling in",
              { quiet: true }
            )
          : Promise.resolve(null),
      (r) => {
        api.showResult(r);
        foot.show(
          r,
          r ? `${count(filled.size, "field", "fields")} filled` : ""
        );
      }
    );
    const focusField = (f: FieldInfo) => {
      api.setMarks((page) =>
        page === f.page ? [{ kind: "rect", rect: f.rect, style: "field" }] : []
      );
      api.showResult(null);
      api.goTo(f.page, f.rect[1]);
    };
    const set = (name: string, value: string) => {
      filled.set(name, value);
      run.schedule();
    };
    const control = (f: FieldInfo, all: FieldInfo[]): HTMLElement => {
      const label = el("label", { text: f.name });
      const wrap = el("div", { class: `field fill-${f.type}` }, label);
      if (f.type === "checkbox") {
        const box = el("input", { attrs: { type: "checkbox" } });
        box.checked = f.value === f.onState;
        box.disabled = f.readOnly;
        box.addEventListener("change", () =>
          set(f.name, box.checked ? f.onState : "Off")
        );
        box.addEventListener("focus", () => focusField(f));
        wrap.replaceChildren(el("label", { class: "check" }, box, f.name));
      } else if (f.type === "radio") {
        const s = el("select", { attrs: { "aria-label": f.name } });
        s.append(el("option", { attrs: { value: "Off" }, text: "(none)" }));
        for (const b of all) {
          s.append(
            el("option", { attrs: { value: b.onState }, text: b.onState })
          );
        }
        s.value = f.value || "Off";
        s.disabled = f.readOnly;
        s.addEventListener("change", () => set(f.name, s.value));
        s.addEventListener("focus", () => focusField(f));
        wrap.append(s);
      } else if (f.type === "combobox" || f.type === "listbox") {
        const s = el("select", { attrs: { "aria-label": f.name } });
        for (const o of ["", ...f.options]) {
          s.append(el("option", { attrs: { value: o }, text: o || "(none)" }));
        }
        s.value = f.value;
        s.disabled = f.readOnly;
        s.addEventListener("change", () => set(f.name, s.value));
        s.addEventListener("focus", () => focusField(f));
        wrap.append(s);
      } else if (f.type === "text") {
        const input = f.multiline
          ? el("textarea", { attrs: { "aria-label": f.name, rows: "3" } })
          : el("input", { attrs: { "aria-label": f.name, type: "text" } });
        input.value = f.value;
        input.disabled = f.readOnly;
        input.addEventListener("input", () => set(f.name, input.value));
        input.addEventListener("focus", () => focusField(f));
        wrap.append(input);
      } else {
        wrap.append(
          el("span", {
            class: "hint",
            text:
              f.type === "signature"
                ? "A signature field: see Signatures."
                : "A button: nothing to fill.",
          })
        );
      }
      if (f.readOnly) {
        wrap.append(el("span", { class: "hint", text: "Read-only" }));
      }
      return wrap;
    };
    const render = () => {
      list.replaceChildren();
      const byName = new Map<string, FieldInfo[]>();
      for (const f of fields) {
        byName.set(f.name, [...(byName.get(f.name) ?? []), f]);
      }
      for (const [, group] of byName) {
        const [first] = group;
        if (first) {
          list.append(control(first, group));
        }
      }
      info.textContent = fields.length
        ? `${count(byName.size, "field", "fields")} on ${count(new Set(fields.map((f) => f.page)).size, "page", "pages")}.`
        : "This document has no form fields. Add fields makes some.";
    };
    const load = async () => {
      const r = await api.run("fields", {}, "Reading the form", {
        quiet: true,
      });
      fields = r?.report ?? [];
      render();
    };
    const exportJson = () => {
      const out: Record<string, string> = {};
      for (const f of fields) {
        out[f.name] = filled.get(f.name) ?? f.value;
      }
      download(
        new Blob([`${JSON.stringify(out, null, 2)}\n`], {
          type: "application/json",
        }),
        `${api.name()}-form.json`
      );
    };
    const importJson = () => {
      const input = el("input", {
        attrs: { accept: ".json,application/json", type: "file" },
      });
      input.addEventListener("change", async () => {
        const file = input.files?.[0];
        if (!file) {
          return;
        }
        try {
          const data = JSON.parse(await file.text()) as Record<string, unknown>;
          let n = 0;
          for (const [k, v] of Object.entries(data)) {
            if (fields.some((f) => f.name === k)) {
              filled.set(k, String(v));
              n += 1;
            }
          }
          api.note(`${count(n, "value", "values")} loaded from ${file.name}.`);
          for (const f of fields) {
            f.value = filled.get(f.name) ?? f.value;
          }
          render();
          void run.run();
        } catch (error) {
          api.error(`${file.name} is not JSON: ${message(error)}`);
        }
      });
      input.click();
    };
    const form = new Form(
      [
        {
          key: "flatten",
          kind: "check",
          label: "Flatten after filling: the values become part of the page",
        },
      ],
      values,
      () => {
        api.persist();
        run.schedule();
      }
    );
    api.body.replaceChildren(
      el("p", { class: "summary", text: fill.summary }),
      info,
      list,
      form.root,
      row(
        button("Export values", exportJson),
        button("Import values…", importJson)
      )
    );
    void load();
    return {
      destroy: () => {
        run.destroy();
        api.setMarks(null);
      },
      docChanged: () => {
        filled.clear();
        void load();
      },
    };
  },
  name: "Fill in a form",
  summary:
    "Every field of the document's form, to fill in here; the preview shows the filled pages. Values can be saved to JSON and loaded again.",
};

/* ---------------- add fields ---------------- */

const addFieldsPanel: PanelDef = {
  defaults: { fontSize: 0, name: "Field", options: "Yes, No", type: "text" },
  fields: [
    {
      key: "type",
      kind: "seg",
      label: "Type",
      options: [
        ["text", "Text"],
        ["multiline", "Paragraph"],
        ["checkbox", "Check box"],
        ["combobox", "Dropdown"],
      ],
    },
    {
      hint: "Fields of the same name are numbered: Field, Field 2.",
      key: "name",
      kind: "text",
      label: "Name",
    },
    {
      key: "options",
      kind: "text",
      label: "Choices",
      placeholder: "Comma, separated",
      show: (v) => v.type === "combobox",
    },
    {
      hint: "0 sizes the text to the field.",
      key: "fontSize",
      kind: "number",
      label: "Text size",
      max: 72,
      min: 0,
      show: (v) => v.type !== "checkbox",
      unit: "pt",
    },
  ],
  group: GROUP,
  id: "addfields",
  mount: (api, values: Values) => {
    const pending: NewField[] = [];
    let live: { page: number; rect: Rect } | null = null;
    const list = el("ul", { class: "annots" });
    const foot = commitFoot(api, "the new fields", "-form", () =>
      api.run("addFields", { fields: pending }, "Adding the fields")
    );
    const changed = () => {
      foot.enable(
        pending.length > 0,
        pending.length
          ? count(pending.length, "new field", "new fields")
          : "Draw a field on a page."
      );
      list.replaceChildren(
        ...pending.map((f, i) =>
          el(
            "li",
            {},
            `${f.name} (${f.type}), page ${f.page + 1}`,
            iconButton(
              ICON_X,
              "Remove",
              () => {
                pending.splice(i, 1);
                changed();
              },
              "inline"
            )
          )
        )
      );
      api.redrawMarks();
    };
    api.setMarks((page) => {
      const marks: Mark[] = pending
        .filter((f) => f.page === page)
        .map((f) => ({
          kind: "rect",
          label: f.name,
          rect: f.rect,
          style: "field",
        }));
      if (live?.page === page) {
        marks.push({ kind: "rect", rect: live.rect, style: "field" });
      }
      return marks;
    });
    api.setTool("rect", (g) => {
      const rect = normRect(g.from, g.to);
      if (!g.done) {
        live = { page: g.page, rect };
        api.redrawMarks(g.page);
        return;
      }
      live = null;
      if (!big(rect)) {
        api.redrawMarks(g.page);
        return;
      }
      const type = values.type as NewField["type"];
      // A check box is square, whatever was drawn.
      const side = Math.min(rect[2] - rect[0], rect[3] - rect[1]);
      const r: Rect =
        type === "checkbox"
          ? [rect[0], rect[1], rect[0] + side, rect[1] + side]
          : rect;
      pending.push({
        fontSize: Number(values.fontSize),
        name: String(values.name).trim() || "Field",
        options: String(values.options)
          .split(",")
          .map((o) => o.trim())
          .filter(Boolean),
        page: g.page,
        rect: r,
        type,
        value: "",
      });
      changed();
    });
    const form = new Form(addFieldsPanel.fields ?? [], values, () =>
      api.persist()
    );
    api.body.replaceChildren(
      el("p", { class: "summary", text: addFieldsPanel.summary }),
      form.root,
      el("h3", { text: "New fields" }),
      list
    );
    changed();
    return {
      destroy: () => {
        api.setTool(null);
        api.setMarks(null);
      },
      docChanged: () => {
        pending.length = 0;
        changed();
      },
    };
  },
  name: "Add form fields",
  summary:
    "Make a fillable form: pick a type and a name, then draw each field on a page in the Pages view.",
};

/* ---------------- flatten ---------------- */

const flattenPanel = transformPanel({
  applyLabel: "flattening",
  defaults: { annotations: true, forms: true },
  fields: [
    {
      key: "forms",
      kind: "check",
      label: "Form fields: their values become page content",
    },
    {
      key: "annotations",
      kind: "check",
      label: "Annotations: comments, highlights, drawings",
    },
  ],
  group: GROUP,
  id: "flatten",
  live: true,
  name: "Flatten",
  op: "flatten",
  options: (v) =>
    v.forms || v.annotations
      ? { annotations: v.annotations === true, forms: v.forms === true }
      : "Choose what to flatten.",
  suffix: "-flat",
  summary:
    "Make form fields and annotations part of the page: they look the same, but can no longer be edited or removed in a reader.",
});

export const FORM_PANELS: PanelDef[] = [
  annotate,
  fill,
  addFieldsPanel,
  flattenPanel,
];
