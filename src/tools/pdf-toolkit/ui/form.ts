// An Operation's options as a form, from a list of Fields: each Field is a
// control bound to one key of the Operation's values. The values (but never
// files or passwords) are what the Deep Link carries, so a copied link
// opens the same Operation with the same settings.

import { el } from "./dom";

export interface FileValue {
  name: string;
  mime: string;
  bytes: Uint8Array<ArrayBuffer>;
}

export type Value = string | number | boolean | FileValue | null;
export type Values = Record<string, Value>;

interface Base {
  key: string;
  label: string;
  /** A line under the control; a function to say what the current values mean. */
  hint?: string | ((v: Values) => string);
  /** Shown only when this holds of the current values. */
  show?: (v: Values) => boolean;
}

export type Field =
  | (Base & {
      kind: "number";
      min?: number;
      max?: number;
      step?: number;
      unit?: string;
    })
  | (Base & { kind: "text"; placeholder?: string })
  | (Base & { kind: "password"; placeholder?: string })
  | (Base & { kind: "textarea"; placeholder?: string; rows?: number })
  | (Base & { kind: "select"; options: [value: string, label: string][] })
  | (Base & { kind: "seg"; options: [value: string, label: string][] })
  | (Base & { kind: "check" })
  | (Base & { kind: "color" })
  | (Base & {
      kind: "range";
      min: number;
      max: number;
      step: number;
      format: (v: number) => string;
    })
  | (Base & { kind: "pages" })
  | (Base & { kind: "file"; accept: string })
  | (Base & { kind: "position" });

const POSITIONS: [string, string][] = [
  ["tl", "Top left"],
  ["tc", "Top centre"],
  ["tr", "Top right"],
  ["ml", "Middle left"],
  ["mc", "Centre"],
  ["mr", "Middle right"],
  ["bl", "Bottom left"],
  ["bc", "Bottom centre"],
  ["br", "Bottom right"],
];

/** Keys whose values never go in a link: files, and anything secret. */
export const unshareable = (fields: Field[]): Set<string> =>
  new Set(
    fields
      .filter((f) => f.kind === "file" || f.kind === "password")
      .map((f) => f.key)
  );

let uid = 0;

export class Form {
  readonly root: HTMLElement;
  readonly values: Values;
  private readonly fields: Field[];
  private readonly rows = new Map<string, HTMLElement>();
  /** Hints that change with the values, and where each is shown. */
  private readonly hints = new Map<HTMLElement, (v: Values) => string>();
  private readonly setters = new Map<string, (v: Value) => void>();
  private readonly onChange: (key: string) => void;

  constructor(
    fields: Field[],
    values: Values,
    onChange: (key: string) => void
  ) {
    this.fields = fields;
    this.values = values;
    this.onChange = onChange;
    this.root = el("div", { class: "form" });
    for (const f of fields) {
      const row = this.row(f);
      this.rows.set(f.key, row);
      this.root.append(row);
    }
    this.refresh();
  }

  private changed(key: string, value: Value) {
    this.values[key] = value;
    this.refresh();
    this.onChange(key);
  }

  /** Set a value from outside (a drag on the page, a reset) without it counting as the user's change. */
  set(key: string, value: Value) {
    this.values[key] = value;
    this.setters.get(key)?.(value);
    this.refresh();
  }

  /** Show and hide Fields that depend on others, and say what the values mean. */
  refresh() {
    for (const f of this.fields) {
      this.rows
        .get(f.key)
        ?.classList.toggle("off", f.show ? !f.show(this.values) : false);
    }
    for (const [p, say] of this.hints) {
      p.textContent = say(this.values);
    }
  }

  private row(f: Field): HTMLElement {
    uid += 1;
    const id = `ptk-f${uid}`;
    const row = el("div", { class: `field field-${f.kind}` });
    const control = this.control(f, id);
    if (f.kind === "check") {
      row.append(control);
    } else {
      row.append(el("label", { attrs: { for: id }, text: f.label }), control);
    }
    if (typeof f.hint === "string") {
      row.append(el("p", { class: "hint", text: f.hint }));
    } else if (f.hint) {
      const p = el("p", { attrs: { "aria-live": "polite" }, class: "hint" });
      this.hints.set(p, f.hint);
      row.append(p);
    }
    return row;
  }

  private control(f: Field, id: string): HTMLElement {
    switch (f.kind) {
      case "number": {
        return this.number(f, id);
      }
      case "text":
      case "password":
      case "pages": {
        return this.text(f, id);
      }
      case "textarea": {
        return this.textarea(f, id);
      }
      case "select": {
        return this.select(f, id);
      }
      case "seg": {
        return this.seg(f, id);
      }
      case "check": {
        const box = el("input", { attrs: { id, type: "checkbox" } });
        box.checked = this.values[f.key] === true;
        box.addEventListener("change", () => this.changed(f.key, box.checked));
        this.setters.set(f.key, (v) => {
          box.checked = v === true;
        });
        return el(
          "label",
          { attrs: { for: id }, class: "check" },
          box,
          f.label
        );
      }
      case "color": {
        const c = el("input", { attrs: { id, type: "color" } });
        c.value = String(this.values[f.key] ?? "#000000");
        c.addEventListener("input", () => this.changed(f.key, c.value));
        this.setters.set(f.key, (v) => {
          c.value = String(v);
        });
        return c;
      }
      case "range": {
        return this.range(f, id);
      }
      case "file": {
        return this.file(f, id);
      }
      case "position": {
        return this.position(f, id);
      }
      default: {
        return el("span");
      }
    }
  }

  private textarea(
    f: Extract<Field, { kind: "textarea" }>,
    id: string
  ): HTMLElement {
    const t = el("textarea", {
      attrs: {
        id,
        placeholder: f.placeholder ?? "",
        rows: String(f.rows ?? 3),
        spellcheck: "false",
      },
    });
    t.value = String(this.values[f.key] ?? "");
    t.addEventListener("input", () => this.changed(f.key, t.value));
    this.setters.set(f.key, (v) => {
      t.value = String(v ?? "");
    });
    return t;
  }

  private select(
    f: Extract<Field, { kind: "select" }>,
    id: string
  ): HTMLElement {
    const s = el("select", { attrs: { id } });
    for (const [value, label] of f.options) {
      s.append(el("option", { attrs: { value }, text: label }));
    }
    s.value = String(this.values[f.key] ?? f.options[0]?.[0] ?? "");
    s.addEventListener("change", () => this.changed(f.key, s.value));
    this.setters.set(f.key, (v) => {
      s.value = String(v);
    });
    return s;
  }

  private number(
    f: Extract<Field, { kind: "number" }>,
    id: string
  ): HTMLElement {
    const input = el("input", {
      attrs: { id, inputmode: "decimal", type: "number" },
    });
    if (f.min !== undefined) {
      input.min = String(f.min);
    }
    if (f.max !== undefined) {
      input.max = String(f.max);
    }
    input.step = String(f.step ?? 1);
    input.value = String(this.values[f.key] ?? "");
    input.addEventListener("input", () => {
      const n = Number(input.value);
      if (input.value !== "" && Number.isFinite(n)) {
        const lo = f.min ?? -Infinity;
        const hi = f.max ?? Infinity;
        this.changed(f.key, Math.min(hi, Math.max(lo, n)));
      }
    });
    this.setters.set(f.key, (v) => {
      input.value = String(v);
    });
    return f.unit
      ? el(
          "span",
          { class: "with-unit" },
          input,
          el("span", { class: "unit", text: f.unit })
        )
      : input;
  }

  private text(
    f: Extract<Field, { kind: "text" | "password" | "pages" }>,
    id: string
  ): HTMLElement {
    const input = el("input", {
      attrs: {
        autocomplete: f.kind === "password" ? "new-password" : "off",
        id,
        placeholder:
          f.kind === "pages"
            ? "All pages, or 1-3, 5, 8-"
            : (f.placeholder ?? ""),
        spellcheck: "false",
        type: f.kind === "password" ? "password" : "text",
      },
    });
    input.value = String(this.values[f.key] ?? "");
    input.addEventListener("input", () => this.changed(f.key, input.value));
    this.setters.set(f.key, (v) => {
      input.value = String(v ?? "");
    });
    return input;
  }

  private seg(f: Extract<Field, { kind: "seg" }>, id: string): HTMLElement {
    const seg = el("div", {
      attrs: { "aria-label": f.label, id, role: "group" },
      class: "seg",
    });
    const sync = () => {
      for (const b of seg.querySelectorAll("button")) {
        const on = b.dataset.value === String(this.values[f.key]);
        b.classList.toggle("active", on);
        b.setAttribute("aria-pressed", String(on));
      }
    };
    for (const [value, label] of f.options) {
      const b = el("button", {
        attrs: { "data-value": value, type: "button" },
        text: label,
      });
      b.addEventListener("click", () => {
        this.changed(f.key, value);
        sync();
      });
      seg.append(b);
    }
    sync();
    this.setters.set(f.key, sync);
    return seg;
  }

  private range(f: Extract<Field, { kind: "range" }>, id: string): HTMLElement {
    const input = el("input", {
      attrs: {
        id,
        max: String(f.max),
        min: String(f.min),
        step: String(f.step),
        type: "range",
      },
    });
    const out = el("output", { attrs: { for: id } });
    const show = () => {
      out.textContent = f.format(Number(input.value));
    };
    input.value = String(this.values[f.key] ?? f.min);
    show();
    input.addEventListener("input", () => {
      show();
      this.changed(f.key, Number(input.value));
    });
    this.setters.set(f.key, (v) => {
      input.value = String(v);
      show();
    });
    return el("span", { class: "with-output" }, input, out);
  }

  private file(f: Extract<Field, { kind: "file" }>, id: string): HTMLElement {
    const input = el("input", {
      attrs: { accept: f.accept, hidden: "", id, type: "file" },
    });
    const name = el("span", { class: "file-name", text: "None chosen" });
    const pick = el("button", { attrs: { type: "button" }, text: "Choose…" });
    pick.addEventListener("click", () => input.click());
    const show = (v: Value) => {
      name.textContent = v && typeof v === "object" ? v.name : "None chosen";
    };
    show(this.values[f.key] ?? null);
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      input.value = "";
      if (file) {
        const value: FileValue = {
          bytes: new Uint8Array(await file.arrayBuffer()),
          mime: file.type,
          name: file.name,
        };
        show(value);
        this.changed(f.key, value);
      }
    });
    this.setters.set(f.key, show);
    return el("span", { class: "file-pick" }, pick, name, input);
  }

  private position(
    f: Extract<Field, { kind: "position" }>,
    id: string
  ): HTMLElement {
    const grid = el("div", {
      attrs: { "aria-label": f.label, id, role: "radiogroup" },
      class: "positions",
    });
    const sync = () => {
      for (const b of grid.querySelectorAll("button")) {
        const on = b.dataset.value === this.values[f.key];
        b.classList.toggle("active", on);
        b.setAttribute("aria-checked", String(on));
      }
    };
    for (const [value, label] of POSITIONS) {
      const b = el("button", {
        attrs: {
          "aria-label": label,
          "data-value": value,
          role: "radio",
          type: "button",
        },
        title: label,
      });
      b.append(el("span"));
      b.addEventListener("click", () => {
        this.changed(f.key, value);
        sync();
      });
      grid.append(b);
    }
    sync();
    this.setters.set(f.key, sync);
    return grid;
  }
}

/** The values that differ from the defaults, for a Deep Link: files and secrets left out. */
export const encodeValues = (
  values: Values,
  defaults: Values,
  skip: Set<string>
): string => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(values)) {
    if (
      skip.has(k) ||
      v === null ||
      typeof v === "object" ||
      v === defaults[k]
    ) {
      continue;
    }
    params.set(k, String(v));
  }
  return params.toString();
};

/** Values from a Deep Link, each read as the type its default has; unknown keys are ignored. */
export const decodeValues = (
  query: string,
  defaults: Values,
  skip: Set<string>
): Values => {
  const out: Values = { ...defaults };
  for (const [k, raw] of new URLSearchParams(query)) {
    if (!(k in defaults) || skip.has(k)) {
      continue;
    }
    const d = defaults[k];
    if (typeof d === "number") {
      const n = Number(raw);
      if (Number.isFinite(n)) {
        out[k] = n;
      }
    } else if (typeof d === "boolean") {
      out[k] = raw === "true";
    } else {
      out[k] = raw;
    }
  }
  return out;
};
