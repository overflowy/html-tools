// Interactive forms (AcroForm): reading every field and its value, filling
// them in, adding new text fields and check boxes, and flattening fields and
// annotations into the page. MuPDF fills fields and draws their appearance;
// it has no call to make a new one, so a new field is put together here
// from its dictionaries and MuPDF is asked to draw it.

import type { PDFDocument, PDFObject, PDFPage, PDFWidget } from "mupdf";

import { openPdf, savePdf } from "./doc";
import type { Env } from "./doc";
import { invert, transformRect } from "./geometry";
import type { Matrix, Rect } from "./geometry";
import { dig, keysOf, rectObject } from "./objects";

export type FieldType =
  | "text"
  | "checkbox"
  | "radio"
  | "combobox"
  | "listbox"
  | "signature"
  | "button";

export interface FieldInfo {
  /** Fully qualified name: what a value is filled in by. */
  name: string;
  type: FieldType;
  value: string;
  /** Choices of a list or combo box. */
  options: string[];
  /** The value a check box or radio button has when on. */
  onState: string;
  readOnly: boolean;
  multiline: boolean;
  page: number;
  rect: Rect;
}

const TYPES: Record<string, FieldType> = {
  button: "button",
  checkbox: "checkbox",
  combobox: "combobox",
  listbox: "listbox",
  radiobutton: "radio",
  signature: "signature",
  text: "text",
};

/** The appearance state a check box or radio button shows when on: any state but Off. */
const onStateOf = (w: PDFWidget): string => {
  const normal = dig(w.getObject(), "AP", "N");
  return (normal ? keysOf(normal) : []).find((k) => k !== "Off") ?? "Yes";
};

const describe = (w: PDFWidget, page: number): FieldInfo => {
  const type = TYPES[w.getFieldType()] ?? "text";
  const toggle = type === "checkbox" || type === "radio";
  return {
    multiline: type === "text" && w.isMultiline(),
    name: w.getName(),
    onState: toggle ? onStateOf(w) : "",
    options: type === "combobox" || type === "listbox" ? w.getOptions() : [],
    page,
    readOnly: w.isReadOnly(),
    rect: w.getBounds() as Rect,
    type,
    value: w.getValue(),
  };
};

/** One entry per widget: a radio group, or a field shown on several pages, appears once per button. */
export const readFields = (doc: PDFDocument): FieldInfo[] => {
  const out: FieldInfo[] = [];
  const n = doc.countPages();
  for (let p = 0; p < n; p += 1) {
    for (const w of doc.loadPage(p).getWidgets()) {
      out.push(describe(w, p));
    }
  }
  return out;
};

/** Set one widget to `value` (a check box takes its on-state or "Off"); true if it changed. */
const fillWidget = (w: PDFWidget, value: string): boolean => {
  const type = TYPES[w.getFieldType()] ?? "text";
  if (w.isReadOnly()) {
    return false;
  }
  if (type === "checkbox" || type === "radio") {
    const isOn = w.getValue() === onStateOf(w);
    const wantOn = value === onStateOf(w);
    // A radio button is turned off by turning another on.
    if (isOn !== wantOn && (type === "checkbox" || wantOn)) {
      w.toggle();
      return true;
    }
    return false;
  }
  if (w.getValue() === value) {
    return false;
  }
  if (type === "text") {
    w.setTextValue(value);
  } else if (type === "combobox" || type === "listbox") {
    w.setChoiceValue(value);
  } else {
    return false;
  }
  return true;
};

export interface FillOptions {
  /** Field name to value; a check box's value is its on-state or "Off". */
  values: Record<string, string>;
  /** Make the filled form page content, no longer editable. */
  flatten: boolean;
}

export const fillFields = (
  env: Env,
  bytes: Uint8Array,
  o: FillOptions
): Uint8Array => {
  const doc = openPdf(env, bytes);
  try {
    const n = doc.countPages();
    for (let p = 0; p < n; p += 1) {
      for (const w of doc.loadPage(p).getWidgets()) {
        const value = o.values[w.getName()];
        if (value !== undefined && fillWidget(w, value)) {
          w.update();
        }
      }
    }
    if (o.flatten) {
      doc.bake(false, true);
    }
    return savePdf(env, doc);
  } finally {
    doc.destroy();
  }
};

/* ---------------- new fields ---------------- */

export interface NewField {
  page: number;
  /** Display space. */
  rect: Rect;
  type: "text" | "multiline" | "checkbox" | "combobox";
  name: string;
  /** Initial text, or "Yes" for a check box that starts checked. */
  value: string;
  /** Choices, for a combo box. */
  options: string[];
  /** Font size; 0 fits the text to the field. */
  fontSize: number;
}

/** Field flag bits (Ff): bit 13 of a text field, bit 18 of a choice field. */
const FLAG_MULTILINE = 4096;
const FLAG_COMBO = 131_072;

/** The document's form dictionary, made when it has none, with the fonts new fields use. */
const acroForm = (doc: PDFDocument): PDFObject => {
  const root = doc.getTrailer().get("Root");
  let form = root.get("AcroForm");
  if (!form.isDictionary()) {
    form = doc.addObject(doc.newDictionary());
    root.put("AcroForm", form);
  }
  if (!form.get("Fields").isArray()) {
    form.put("Fields", doc.newArray());
  }
  let dr = form.get("DR");
  if (!dr.isDictionary()) {
    form.put("DR", doc.newDictionary());
    dr = form.get("DR");
  }
  let fonts = dr.get("Font");
  if (!fonts.isDictionary()) {
    dr.put("Font", doc.newDictionary());
    fonts = dr.get("Font");
  }
  for (const [name, base] of [
    ["Helv", "Helvetica"],
    ["ZaDb", "ZapfDingbats"],
  ] as const) {
    if (fonts.get(name).isNull()) {
      const f = doc.newDictionary();
      f.put("Type", doc.newName("Font"));
      f.put("Subtype", doc.newName("Type1"));
      f.put("BaseFont", doc.newName(base));
      if (base === "Helvetica") {
        f.put("Encoding", doc.newName("WinAnsiEncoding"));
      }
      fonts.put(name, doc.addObject(f));
    }
  }
  if (form.get("DA").isNull()) {
    form.put("DA", doc.newString("/Helv 0 Tf 0 g"));
  }
  return form;
};

/** A name no field has yet: `name`, or `name 2`, `name 3`... */
const freeName = (taken: Set<string>, name: string): string => {
  const base = name.trim() || "Field";
  let candidate = base;
  let n = 2;
  while (taken.has(candidate)) {
    candidate = `${base} ${n}`;
    n += 1;
  }
  taken.add(candidate);
  return candidate;
};

const fieldDict = (
  doc: PDFDocument,
  page: PDFPage,
  f: NewField,
  name: string
): PDFObject => {
  const w = doc.newDictionary();
  w.put("Type", doc.newName("Annot"));
  w.put("Subtype", doc.newName("Widget"));
  w.put(
    "Rect",
    rectObject(
      doc,
      transformRect(invert(page.getTransform() as Matrix), f.rect)
    )
  );
  // Printed, like a field filled on paper.
  w.put("F", doc.newInteger(4));
  w.put("P", page.getObject());
  w.put("T", doc.newString(name));
  const mk = doc.newDictionary();
  const border = doc.newArray();
  for (const v of [0.6, 0.6, 0.6]) {
    border.push(doc.newReal(v));
  }
  mk.put("BC", border);
  const bs = doc.newDictionary();
  bs.put("W", doc.newInteger(1));
  bs.put("S", doc.newName("S"));
  w.put("BS", bs);
  if (f.type === "checkbox") {
    w.put("FT", doc.newName("Btn"));
    // ZapfDingbats "4" is the check mark.
    mk.put("CA", doc.newString("4"));
    w.put("DA", doc.newString("/ZaDb 0 Tf 0 g"));
    const on = f.value === "Yes";
    w.put("V", doc.newName(on ? "Yes" : "Off"));
    w.put("AS", doc.newName(on ? "Yes" : "Off"));
  } else {
    w.put("FT", doc.newName(f.type === "combobox" ? "Ch" : "Tx"));
    w.put("DA", doc.newString(`/Helv ${f.fontSize} Tf 0 g`));
    // Each bit is set at most once, so adding them is setting them.
    let flags = 0;
    if (f.type === "multiline") {
      flags += FLAG_MULTILINE;
    }
    if (f.type === "combobox") {
      flags += FLAG_COMBO;
      const opts = doc.newArray();
      for (const o of f.options) {
        opts.push(doc.newString(o));
      }
      w.put("Opt", opts);
    }
    if (flags) {
      w.put("Ff", doc.newInteger(flags));
    }
    if (f.value) {
      w.put("V", doc.newString(f.value));
    }
  }
  w.put("MK", mk);
  return w;
};

export const addFields = (
  env: Env,
  bytes: Uint8Array,
  fields: NewField[]
): Uint8Array => {
  const doc = openPdf(env, bytes);
  try {
    const form = acroForm(doc);
    const taken = new Set(readFields(doc).map((f) => f.name));
    const made: { page: number; name: string }[] = [];
    for (const f of fields) {
      if (f.page < 0 || f.page >= doc.countPages()) {
        continue;
      }
      const page = doc.loadPage(f.page);
      const name = freeName(taken, f.name);
      const ref = doc.addObject(fieldDict(doc, page, f, name));
      const pageObj = page.getObject();
      if (!pageObj.get("Annots").isArray()) {
        pageObj.put("Annots", doc.newArray());
      }
      pageObj.get("Annots").push(ref);
      form.get("Fields").push(ref);
      made.push({ name, page: f.page });
    }
    // Loaded afresh, the pages know their new widgets; MuPDF draws each one.
    for (const { page, name } of made) {
      for (const w of doc.loadPage(page).getWidgets()) {
        if (w.getName() === name) {
          w.update();
        }
      }
    }
    return savePdf(env, doc);
  } finally {
    doc.destroy();
  }
};

export interface FlattenOptions {
  forms: boolean;
  annotations: boolean;
}

export const flatten = (
  env: Env,
  bytes: Uint8Array,
  o: FlattenOptions
): Uint8Array => {
  const doc = openPdf(env, bytes);
  try {
    doc.bake(o.annotations, o.forms);
    return savePdf(env, doc);
  } finally {
    doc.destroy();
  }
};
