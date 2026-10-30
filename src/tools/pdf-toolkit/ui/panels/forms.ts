// Panels for what a reader adds to a PDF: annotations (marked up on the
// page, drawn in the overlay as they are made), form fields (filled in from
// a list, or new ones drawn on the page), and flattening both into the page.

import ICON_ELLIPSE from "lucide-static/icons/ellipse.svg";
import ICON_HIGHLIGHT from "lucide-static/icons/highlighter.svg";
import ICON_SQUIGGLE from "lucide-static/icons/line-squiggle.svg";
import ICON_ARROW from "lucide-static/icons/move-up-right.svg";
import ICON_DRAW from "lucide-static/icons/pencil.svg";
import ICON_LINE from "lucide-static/icons/slash.svg";
import ICON_RECT from "lucide-static/icons/square.svg";
import ICON_NOTE from "lucide-static/icons/sticky-note.svg";
import ICON_STRIKEOUT from "lucide-static/icons/strikethrough.svg";
import ICON_TEXT from "lucide-static/icons/type.svg";
import ICON_UNDERLINE from "lucide-static/icons/underline.svg";

import { NOTE_ICON } from "../../pdf/annotate";
import type {
  AnnotInfo,
  AnnotKind,
  MarkupKind,
  NewAnnot,
} from "../../pdf/annotate";
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
  icon: string;
  /** How it is drawn on the page. */
  draw: "text" | "point" | "ink" | "rect" | "line" | "write";
}

/** The tools, in the groups the toolbar shows them in. */
const TOOL_GROUPS: AnnotTool[][] = [
  [
    {
      draw: "text",
      icon: ICON_HIGHLIGHT,
      kind: "highlight",
      label: "Highlight",
    },
    {
      draw: "text",
      icon: ICON_UNDERLINE,
      kind: "underline",
      label: "Underline",
    },
    {
      draw: "text",
      icon: ICON_STRIKEOUT,
      kind: "strikeout",
      label: "Strike out",
    },
    { draw: "text", icon: ICON_SQUIGGLE, kind: "squiggly", label: "Squiggle" },
  ],
  [
    { draw: "write", icon: ICON_TEXT, kind: "text", label: "Text" },
    { draw: "point", icon: ICON_NOTE, kind: "note", label: "Note" },
    { draw: "ink", icon: ICON_DRAW, kind: "ink", label: "Draw" },
  ],
  [
    { draw: "rect", icon: ICON_RECT, kind: "rect", label: "Rectangle" },
    { draw: "rect", icon: ICON_ELLIPSE, kind: "ellipse", label: "Ellipse" },
    { draw: "line", icon: ICON_ARROW, kind: "arrow", label: "Arrow" },
    { draw: "line", icon: ICON_LINE, kind: "line", label: "Line" },
  ],
];
const TOOLS = TOOL_GROUPS.flat();

const toolFor = (kind: unknown): AnnotTool =>
  TOOLS.find((t) => t.kind === kind) ?? {
    draw: "text",
    icon: ICON_HIGHLIGHT,
    kind: "highlight",
    label: "Highlight",
  };

const MARKUP_KINDS: ReadonlySet<AnnotKind> = new Set([
  "highlight",
  "underline",
  "strikeout",
  "squiggly",
]);
const isMarkup = (kind: AnnotKind): kind is MarkupKind =>
  MARKUP_KINDS.has(kind);

/**
 * The tools as a toolbar above the pages (one tab stop, the arrow keys
 * between tools), and after them `controls`: how what is drawn looks.
 */
const annotToolbar = (controls: HTMLElement) => {
  const bar = el("div", {
    attrs: { "aria-label": "Annotation tools", role: "toolbar" },
    class: "annot-tools",
  });
  const buttons: HTMLButtonElement[] = [];
  for (const [i, group] of TOOL_GROUPS.entries()) {
    if (i > 0) {
      bar.append(
        el("span", { attrs: { "aria-hidden": "true" }, class: "sep" })
      );
    }
    for (const t of group) {
      const b = el("button", {
        attrs: { "aria-label": t.label, "data-value": t.kind, type: "button" },
        class: "icon",
        title: t.label,
      });
      b.innerHTML = t.icon;
      buttons.push(b);
      bar.append(b);
    }
  }
  bar.addEventListener("keydown", (e) => {
    const at = buttons.indexOf(e.target as HTMLButtonElement);
    const step: Record<string, number> = {
      ArrowLeft: at - 1,
      ArrowRight: at + 1,
      End: buttons.length - 1,
      Home: 0,
    };
    const to = step[e.key];
    if (at === -1 || to === undefined) {
      return;
    }
    e.preventDefault();
    buttons[(to + buttons.length) % buttons.length]?.focus();
  });
  return {
    /** Hear which tool the user chooses. */
    onChoose: (choose: (kind: string) => void) => {
      bar.addEventListener("click", (e) => {
        const kind = (e.target as Element).closest("button")?.dataset.value;
        if (kind) {
          choose(kind);
        }
      });
    },
    root: el("div", { class: "annot-tools-row" }, bar, controls),
    /** Show `kind` as the tool chosen. */
    show: (kind: string) => {
      for (const b of buttons) {
        const on = b.dataset.value === kind;
        b.classList.toggle("active", on);
        b.setAttribute("aria-pressed", String(on));
        b.tabIndex = on ? 0 : -1;
      }
    },
  };
};

/** How annotations look, set in the toolbar: each shown for the tools it applies to. */
const STYLE_FIELDS: Field[] = [
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
    key: "size",
    kind: "number",
    label: "Size",
    max: 144,
    min: 4,
    show: (v) => v.tool === "text",
    step: 1,
    unit: "pt",
  },
  {
    key: "width",
    kind: "number",
    label: "Width",
    max: 20,
    min: 0.5,
    show: (v) =>
      ["ink", "rect", "ellipse", "arrow", "line"].includes(String(v.tool)),
    step: 0.5,
    unit: "pt",
  },
];

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

/** Whether `p` falls on the icon of a note put at `rect`. */
const onNoteIcon = (rect: Rect, p: Point) =>
  p[0] >= rect[0] &&
  p[0] <= rect[0] + NOTE_ICON &&
  p[1] >= rect[1] &&
  p[1] <= rect[1] + NOTE_ICON;

/** How an annotation still to be added is drawn over its page: as it will look. */
const markOf = (a: NewAnnot): Mark | null => {
  const { color, opacity } = a;
  if (a.quads && isMarkup(a.kind)) {
    return { color, kind: "markup", markup: a.kind, opacity, quads: a.quads };
  }
  if (a.ink) {
    return { color, kind: "ink", opacity, strokes: a.ink, width: a.width ?? 2 };
  }
  if (a.line) {
    return {
      a: a.line[0],
      arrow: a.kind === "arrow",
      b: a.line[1],
      color,
      kind: "line",
      opacity,
      width: a.width ?? 1,
    };
  }
  if (a.kind === "text" && a.at) {
    return {
      at: a.at,
      color,
      kind: "written",
      opacity,
      size: a.fontSize ?? 12,
      text: a.text ?? "",
    };
  }
  if (!a.rect) {
    return null;
  }
  if (a.kind === "note") {
    const at: Point = [a.rect[0], a.rect[1]];
    return { at, color, kind: "note", opacity, text: a.text ?? "" };
  }
  return {
    color,
    kind: "shape",
    opacity,
    rect: a.rect,
    shape: a.kind === "ellipse" ? "ellipse" : "rect",
    width: a.width ?? 1,
  };
};

const annotate: PanelDef = {
  defaults: {
    color: "#ffd400",
    opacity: 1,
    size: 12,
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
    /** Bumped when what was being typed no longer has a place: the document changed, or the panel closed. */
    let generation = 0;
    const list = el("ul", { class: "annots" });
    const form = new Form(STYLE_FIELDS, values, () => api.persist());
    const look = () => ({
      color: String(values.color),
      opacity: Number(values.opacity),
    });
    /** How what the chosen tool makes will look, taken when it is started. */
    const styleNow = () => ({
      ...look(),
      kind: toolFor(values.tool).kind,
      width: Number(values.width),
    });
    type Style = ReturnType<typeof styleNow>;
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
    const listItem = (
      attrs: Record<string, string>,
      color: string,
      name: string,
      action: HTMLButtonElement,
      gone = false
    ) =>
      el(
        "li",
        { attrs, class: gone ? "gone" : "" },
        el("span", {
          attrs: { style: `background:${color || "transparent"}` },
          class: "swatch",
        }),
        el("span", { class: "att-name", text: name, title: name }),
        action
      );
    const renderList = () => {
      list.replaceChildren();
      for (const [i, a] of added.entries()) {
        list.append(
          listItem(
            { "data-added": String(i) },
            a.color,
            `${KIND_NAMES[a.kind] ?? a.kind}, page ${a.page + 1}${a.text ? `: ${a.text}` : ""}`,
            listButton("Remove", ICON_X)
          )
        );
      }
      for (const a of existing) {
        const id = `${a.page}:${a.index}`;
        const gone = removed.has(id);
        list.append(
          listItem(
            { "data-existing": id },
            a.color,
            `${a.type}, page ${a.page + 1}${a.contents ? `: ${a.contents.slice(0, 60)}` : ""}`,
            listButton(gone ? "Keep" : "Remove"),
            gone
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
    const add = (
      a: Omit<NewAnnot, "color" | "opacity" | "kind" | "width">,
      style: Style
    ) => {
      added.push({ ...a, ...style });
      changed();
    };
    /** Counts the text selections asked of the worker: only the latest is shown while dragging. */
    let selections = 0;
    /** Mark up the text a drag goes across: shown while it goes on, added when it ends. */
    const markText = async (g: Gesture, style: Style) => {
      selections += 1;
      const mine = selections;
      const made = generation;
      try {
        const w = await api.worker();
        const doc = await api.current();
        const quads = (await w.call("select", [
          doc.id,
          g.page,
          g.from,
          g.to,
        ])) as Quad[];
        if (made !== generation) {
          return;
        }
        if (g.done) {
          live = null;
          if (quads.length) {
            add({ page: g.page, quads }, style);
          } else {
            api.redrawMarks(g.page);
          }
          return;
        }
        if (mine !== selections) {
          return;
        }
        const { color, kind, opacity } = style;
        live = {
          mark: {
            color,
            kind: "markup",
            markup: isMarkup(kind) ? kind : "highlight",
            opacity,
            quads,
          },
          page: g.page,
        };
        api.redrawMarks(g.page);
      } catch (error) {
        api.error(message(error));
      }
    };
    // While dragging, a selection at most every 30 ms; the drag's end at once, never dropped.
    const markTextSoon = debounce((g: Gesture, style: Style) => {
      void markText(g, style);
    }, 30);
    /** Type at where the page was clicked; what is typed becomes a text box. */
    const writeAt = async (page: number, at: Point) => {
      const mine = generation;
      const style = styleNow();
      const size = Number(values.size);
      const text = await api.write(page, at, { ...style, size });
      if (mine === generation && text.trim()) {
        add({ at, fontSize: size, page, text }, style);
      }
    };
    /** Rewrite a note added before; one left empty goes. */
    const rewriteNote = async (note: NewAnnot, corner: Point) => {
      const mine = generation;
      const text = await api.writeNote(note.page, corner, {
        color: note.color,
        text: note.text ?? "",
      });
      const at = added.indexOf(note);
      if (mine !== generation || at === -1) {
        return;
      }
      if (text.trim()) {
        note.text = text;
      } else {
        added.splice(at, 1);
      }
      changed();
    };
    /** Write a note where the page was clicked, or rewrite the one added there. */
    const noteAt = async (page: number, at: Point) => {
      const before = added.find(
        (a) =>
          a.kind === "note" &&
          a.page === page &&
          a.rect !== undefined &&
          onNoteIcon(a.rect, at)
      );
      if (before?.rect) {
        await rewriteNote(before, [before.rect[0], before.rect[1]]);
        return;
      }
      const mine = generation;
      const style = styleNow();
      // Its icon shows while it is written.
      live = {
        mark: {
          at,
          color: style.color,
          kind: "note",
          opacity: style.opacity,
          text: "",
        },
        page,
      };
      api.redrawMarks(page);
      const text = await api.writeNote(page, at, {
        color: style.color,
        text: "",
      });
      if (mine !== generation) {
        return;
      }
      live = null;
      if (text.trim()) {
        add({ page, rect: [at[0], at[1], at[0], at[1]], text }, style);
      } else {
        api.redrawMarks(page);
      }
    };
    /** What is drawn while a box, a line or a stroke is dragged out. */
    const dragMark = (g: Gesture): Mark => {
      const { draw, kind } = toolFor(values.tool);
      const width = Number(values.width);
      if (draw === "ink") {
        return { ...look(), kind: "ink", strokes: [g.points], width };
      }
      if (draw === "line") {
        return {
          ...look(),
          a: g.from,
          arrow: kind === "arrow",
          b: g.to,
          kind: "line",
          width,
        };
      }
      return {
        ...look(),
        kind: "shape",
        rect: normRect(g.from, g.to),
        shape: kind === "ellipse" ? "ellipse" : "rect",
        width,
      };
    };
    const gesture = (g: Gesture) => {
      const tool = toolFor(values.tool).draw;
      if (tool === "text" && g.done) {
        markTextSoon.cancel();
        void markText(g, styleNow());
        return;
      }
      if (tool === "text") {
        markTextSoon(g, styleNow());
        return;
      }
      if (tool === "write") {
        void writeAt(g.page, g.to);
        return;
      }
      if (tool === "point") {
        void noteAt(g.page, g.to);
        return;
      }
      if (!g.done) {
        live = { mark: dragMark(g), page: g.page };
        api.redrawMarks(g.page);
        return;
      }
      live = null;
      const style = styleNow();
      if (tool === "ink" && g.points.length > 1) {
        add({ ink: [g.points], page: g.page }, style);
      } else if (
        tool === "line" &&
        Math.hypot(g.to[0] - g.from[0], g.to[1] - g.from[1]) > 3
      ) {
        add({ line: [g.from, g.to], page: g.page }, style);
      } else if (tool === "rect" && big(normRect(g.from, g.to))) {
        add({ page: g.page, rect: normRect(g.from, g.to) }, style);
      } else {
        api.redrawMarks(g.page);
      }
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
    const toolbar = annotToolbar(form.root);
    const setTool = (kind: string) => {
      values.tool = kind;
      const color = DEFAULT_COLORS[kind as AnnotKind];
      if (color) {
        form.set("color", color);
      }
      toolbar.show(kind);
      api.setTool(toolFor(kind).draw, gesture);
      form.refresh();
      api.persist();
    };
    toolbar.onChoose(setTool);
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
    api.body.replaceChildren(
      el("p", { class: "summary", text: annotate.summary }),
      el("h3", { text: "Annotations" }),
      list
    );
    api.toolbar(toolbar.root);
    setTool(String(values.tool));
    void load();
    return {
      destroy: () => {
        markTextSoon.cancel();
        generation += 1;
        live = null;
        api.setTool(null);
        api.setMarks(null);
      },
      docChanged: () => {
        generation += 1;
        live = null;
        added.length = 0;
        void load();
      },
    };
  },
  name: "Annotate",
  summary:
    "Mark up the pages with the tools above them: highlight text, write on the page, leave a note, draw, box, or point. They stay annotations any PDF reader can edit.",
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
