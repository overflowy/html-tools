// Passwords and permissions (through qpdf, which takes any password,
// commas and all), redaction that removes what is under the box, a
// sanitize pass that strips what a document carries besides its pages, and
// removing digital signatures.

import type { PDFDocument, PDFObject, PDFPage } from "mupdf";

import { openPdf, savePdf } from "./doc";
import type { Env } from "./doc";
import { intersect, normalize } from "./geometry";
import type { Rect } from "./geometry";
import { dig, itemsOf, keysOf, nameTree, textOf } from "./objects";
import { scrubPage, scrubStructTree } from "./scrub";
import type { Quad } from "./text";

/* ---------------- passwords ---------------- */

export interface ProtectOptions {
  /** Needed to open the file; empty for none. */
  userPassword: string;
  /** Needed to change permissions; empty makes a random one nobody knows. */
  ownerPassword: string;
  bits: 256 | 128;
  print: "full" | "low" | "none";
  copy: boolean;
  modify: boolean;
  annotate: boolean;
  forms: boolean;
  assemble: boolean;
  accessibility: boolean;
}

const yn = (b: boolean) => (b ? "y" : "n");

/** A password nobody will guess or need: what an empty owner password becomes. */
const randomPassword = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
};

export const protectArgs = (
  input: string,
  output: string,
  o: ProtectOptions
): string[] => [
  input,
  "--encrypt",
  `--user-password=${o.userPassword}`,
  `--owner-password=${o.ownerPassword || randomPassword()}`,
  `--bits=${o.bits}`,
  ...(o.bits === 128 ? ["--use-aes=y"] : []),
  `--print=${o.print}`,
  `--extract=${yn(o.copy)}`,
  `--modify-other=${yn(o.modify)}`,
  `--annotate=${yn(o.annotate)}`,
  `--form=${yn(o.forms)}`,
  `--assemble=${yn(o.assemble)}`,
  `--accessibility=${yn(o.accessibility)}`,
  "--",
  output,
];

export const protect = (
  env: Env,
  bytes: Uint8Array,
  o: ProtectOptions
): Uint8Array => {
  const input = "/in/protect.pdf";
  const output = "/out/protect.pdf";
  return env.qpdf.produce(
    "Could not encrypt the PDF",
    { [input]: bytes },
    protectArgs(input, output, o),
    output
  ).bytes;
};

/** The PDF without encryption, opened with `password` (or none, for one that only restricts). */
export const unlock = (
  env: Env,
  bytes: Uint8Array,
  password: string
): Uint8Array => {
  const input = "/in/unlock.pdf";
  const output = "/out/unlock.pdf";
  return env.qpdf.produce(
    "Could not remove the password",
    { [input]: bytes },
    [`--password=${password}`, "--decrypt", input, output],
    output
  ).bytes;
};

/* ---------------- shared ---------------- */

/** Remove `key` from `dict` if present; 1 if it was. */
const drop = (dict: PDFObject | null, key: string): number => {
  if (!dict?.isDictionary() || dict.get(key).isNull()) {
    return 0;
  }
  dict.delete(key);
  return 1;
};

const sameObject = (a: PDFObject, b: PDFObject) =>
  a.isIndirect() && b.isIndirect() && a.asIndirect() === b.asIndirect();

/** Take `target` out of a field tree; returns whether anything was removed. */
const pruneField = (list: PDFObject, target: PDFObject): boolean => {
  let removed = false;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const item = list.get(i);
    if (sameObject(item, target)) {
      list.delete(i);
      removed = true;
      continue;
    }
    const kids = item.get("Kids");
    if (kids.isArray() && pruneField(kids, target)) {
      removed = true;
      if (kids.length === 0) {
        list.delete(i);
      }
    }
  }
  return removed;
};

/* ---------------- redaction ---------------- */

export interface RedactMark {
  page: number;
  /** A box drawn by the user, in display space. */
  rect?: Rect;
  /** Text found by a search or a PII scan. */
  quads?: Quad[];
}

export interface RedactOptions {
  marks: RedactMark[];
  /** Fill each redacted area black, or leave it blank. */
  black: boolean;
  /** Images under a box: blank only the pixels under it, remove the whole image, or leave images alone. */
  images: "pixels" | "remove" | "none";
  /**
   * Drawings (lines, shapes) under a box: "keep" leaves them all; "covered"
   * removes those a box covers entirely, leaving one that crosses its edge
   * whole, the covered part included; "touched" removes every one a box
   * touches, its parts outside the box too.
   */
  lineArt: "keep" | "covered" | "touched";
}

export interface RedactResult {
  bytes: Uint8Array;
  /** Comments (annotations other than form fields) removed for lying under a mark. */
  annotations: number;
  /** Form fields removed for lying under a mark. */
  fields: number;
}

const IMAGE_METHOD = { none: 0, pixels: 2, remove: 1 } as const;
const LINE_ART_METHOD = { covered: 1, keep: 0, touched: 2 } as const;
/** MuPDF's PDFPage.REDACT_TEXT_REMOVE. */
const TEXT_REMOVE = 0;

/** The marks of each page that has any, by 0-based page; marks off the document are dropped. */
const marksByPage = (
  marks: RedactMark[],
  pages: number
): Map<number, RedactMark[]> => {
  const byPage = new Map<number, RedactMark[]>();
  for (const m of marks) {
    if (m.page >= 0 && m.page < pages) {
      byPage.set(m.page, [...(byPage.get(m.page) ?? []), m]);
    }
  }
  return byPage;
};

/** The areas a mark covers, in display space: its box, or the bounds of each quad. */
const markAreas = (m: RedactMark): Rect[] => {
  if (m.quads?.length) {
    return m.quads.map((q) => {
      const xs = [q[0], q[2], q[4], q[6]];
      const ys = [q[1], q[3], q[5], q[7]];
      return [
        Math.min(...xs),
        Math.min(...ys),
        Math.max(...xs),
        Math.max(...ys),
      ];
    });
  }
  return m.rect ? [normalize(m.rect)] : [];
};

const overlapsAny = (r: Rect, areas: Rect[]) =>
  areas.some((a) => intersect(normalize(r), a) !== null);

/** The field a widget belongs to: the widget itself when it carries the name, else its parent. */
const fieldOf = (widget: PDFObject): PDFObject =>
  widget.get("T").isNull() && widget.get("Parent").isDictionary()
    ? widget.get("Parent")
    : widget;

/** Object numbers of every field still in the form's tree. */
const fieldNumbers = (list: PDFObject, out = new Set<number>(), depth = 0) => {
  for (const item of itemsOf(list)) {
    if (item.isIndirect() && !out.has(item.asIndirect()) && depth < 32) {
      out.add(item.asIndirect());
      fieldNumbers(item.get("Kids"), out, depth + 1);
    }
  }
  return out;
};

/**
 * After fields were taken out of the form: the calculation order lists only
 * fields still there (it would keep a removed one, and its value, in the
 * file), and XFA, which keeps every field's value in its own XML, goes.
 */
const tidyForm = (form: PDFObject) => {
  const order = form.get("CO");
  if (order.isArray()) {
    const live = fieldNumbers(form.get("Fields"));
    for (let i = order.length - 1; i >= 0; i -= 1) {
      const f = order.get(i);
      if (!(f.isIndirect() && live.has(f.asIndirect()))) {
        order.delete(i);
      }
    }
  }
  drop(form, "XFA");
};

interface Removed {
  annotations: number;
  /** Object numbers of the fields whose widgets were removed. */
  fields: Set<number>;
}

/**
 * Remove the comments and form fields that lie under any of `areas`: they
 * are drawn over the page, so a box on the page would not hide them, and
 * MuPDF's redaction leaves most kinds in place. A comment's pop-up goes with
 * it. A field shown in several places loses only the widgets under a box;
 * its value stays for the others, as they show it anyway.
 */
const removeCovered = (
  doc: PDFDocument,
  page: PDFPage,
  areas: Rect[],
  removed: Removed
) => {
  // Chosen first, deleted after: MuPDF hands back its own list, and deleting splices it.
  const comments = page
    .getAnnotations()
    .filter(
      (a) => a.getType() !== "Redact" && overlapsAny(a.getBounds(), areas)
    );
  for (const annot of comments) {
    page.deleteAnnotation(annot);
    removed.annotations += 1;
  }
  const form = doc.getTrailer().get("Root").get("AcroForm");
  const widgets = page
    .getWidgets()
    .filter((w) => overlapsAny(w.getBounds(), areas));
  for (const widget of widgets) {
    const obj = widget.getObject();
    const field = fieldOf(obj);
    removed.fields.add(field.isIndirect() ? field.asIndirect() : -1);
    if (form.isDictionary() && form.get("Fields").isArray()) {
      pruneField(form.get("Fields"), obj);
    }
    page.deleteAnnotation(widget);
  }
  if (widgets.length > 0 && form.isDictionary()) {
    tidyForm(form);
  }
};

const addRedaction = (page: PDFPage, m: RedactMark) => {
  const annot = page.createAnnotation("Redact");
  if (m.quads?.length) {
    annot.setQuadPoints(m.quads);
  } else if (m.rect) {
    annot.setRect(m.rect);
  }
  annot.update();
};

/**
 * Remove what lies under the marks: text, images (as `images` says),
 * drawings (as `lineArt` says), and the comments and form fields over them.
 * Then what does not show but could tell what was there: stand-in text,
 * thumbnails, resources nothing uses (see scrub.ts), and glyphs of fonts no
 * remaining text draws.
 */
export const redact = (
  env: Env,
  bytes: Uint8Array,
  o: RedactOptions
): RedactResult => {
  const doc = openPdf(env, bytes);
  try {
    const removed: Removed = { annotations: 0, fields: new Set() };
    const pages: PDFPage[] = [];
    for (const [index, marks] of marksByPage(o.marks, doc.countPages())) {
      const page = doc.loadPage(index);
      removeCovered(doc, page, marks.flatMap(markAreas), removed);
      for (const m of marks) {
        addRedaction(page, m);
      }
      page.applyRedactions(
        o.black,
        IMAGE_METHOD[o.images],
        LINE_ART_METHOD[o.lineArt],
        TEXT_REMOVE
      );
      scrubPage(doc, page);
      pages.push(page);
    }
    scrubStructTree(doc, pages);
    // Everything removed goes from the file too, not just from the pages.
    return {
      annotations: removed.annotations,
      bytes: savePdf(env, doc, {
        extra: ["garbage=deduplicate"],
        subset: true,
      }),
      fields: removed.fields.size,
    };
  } finally {
    doc.destroy();
  }
};

/* ---------------- sanitize ---------------- */

export interface SanitizeOptions {
  metadata: boolean;
  attachments: boolean;
  javascript: boolean;
  /** Links that leave the document: web addresses, other files, programs. */
  links: boolean;
  thumbnails: boolean;
  /** What editing programs keep for themselves (PieceInfo). */
  privateData: boolean;
}

export interface SanitizeReport {
  metadata: number;
  attachments: number;
  scripts: number;
  links: number;
  thumbnails: number;
  privateData: number;
}

/** Actions that run something, send something, or open something outside the document. */
const RISKY_ACTIONS = new Set([
  "GoToE",
  "ImportData",
  "JavaScript",
  "Launch",
  "Rendition",
  "RichMediaExecute",
  "SubmitForm",
]);
const EXTERNAL_ACTIONS = new Set(["GoToR", "Launch", "URI"]);

/** Whether an action, or any it chains to, is one of `kinds`. */
const actionIs = (
  action: PDFObject,
  kinds: Set<string>,
  depth = 0
): boolean => {
  if (depth > 32 || !action.isDictionary()) {
    return false;
  }
  if (kinds.has(textOf(action.get("S")))) {
    return true;
  }
  const next = action.get("Next");
  const chained = next.isArray() ? itemsOf(next) : [next];
  return chained.some(
    (a) => !a.isNull() && actionIs(a.resolve(), kinds, depth + 1)
  );
};

const sanitizeCatalog = (
  doc: PDFDocument,
  o: SanitizeOptions,
  r: SanitizeReport
) => {
  const trailer = doc.getTrailer();
  const root = trailer.get("Root");
  const names = dig(root, "Names");
  if (o.metadata) {
    // The trailer cannot be written to; its Info dictionary can be emptied.
    const infoDict = dig(trailer, "Info");
    const keys = infoDict ? keysOf(infoDict) : [];
    for (const key of keys) {
      infoDict?.delete(key);
    }
    r.metadata += (keys.length > 0 ? 1 : 0) + drop(root, "Metadata");
  }
  if (o.attachments) {
    r.attachments += Object.keys(doc.getEmbeddedFiles()).length;
    drop(names, "EmbeddedFiles");
    // Files associated with the document (PDF 2.0) are attachments too.
    drop(root, "AF");
  }
  if (o.javascript) {
    r.scripts += Object.keys(nameTree(doc, "JavaScript")).length;
    drop(names, "JavaScript");
    r.scripts += drop(root, "AA");
    const open = root.get("OpenAction");
    if (open.isDictionary() && actionIs(open.resolve(), RISKY_ACTIONS)) {
      r.scripts += drop(root, "OpenAction");
    }
    // XFA forms carry their scripts in XML; the AcroForm fields stay.
    r.scripts += drop(dig(root, "AcroForm"), "XFA");
  }
  if (o.privateData) {
    r.privateData += drop(root, "PieceInfo") + drop(root, "SpiderInfo");
  }
};

/** Clean one annotation; true when it should go altogether. */
const sanitizeAnnot = (
  annot: PDFObject,
  o: SanitizeOptions,
  r: SanitizeReport
): boolean => {
  const subtype = textOf(annot.get("Subtype"));
  if (o.attachments && subtype === "FileAttachment") {
    r.attachments += 1;
    return true;
  }
  const action = annot.get("A");
  if (
    o.links &&
    subtype === "Link" &&
    action.isDictionary() &&
    actionIs(action.resolve(), EXTERNAL_ACTIONS)
  ) {
    r.links += 1;
    return true;
  }
  if (o.javascript) {
    r.scripts += drop(annot, "AA");
    if (action.isDictionary() && actionIs(action.resolve(), RISKY_ACTIONS)) {
      r.scripts += drop(annot, "A");
    }
    // A form field's calculation and format scripts live on its parents too.
    let parent = annot.get("Parent");
    for (let depth = 0; depth < 32 && parent.isDictionary(); depth += 1) {
      r.scripts += drop(parent, "AA");
      parent = parent.get("Parent");
    }
  }
  if (o.metadata) {
    r.metadata += drop(annot, "Metadata");
  }
  return false;
};

const sanitizePage = (page: PDFPage, o: SanitizeOptions, r: SanitizeReport) => {
  const obj = page.getObject();
  if (o.thumbnails) {
    r.thumbnails += drop(obj, "Thumb");
  }
  if (o.javascript) {
    r.scripts += drop(obj, "AA");
  }
  if (o.privateData) {
    r.privateData += drop(obj, "PieceInfo") + drop(obj, "LastModified");
  }
  if (o.metadata) {
    r.metadata += drop(obj, "Metadata");
  }
  const annots = obj.get("Annots");
  if (!annots.isArray()) {
    return;
  }
  for (let i = annots.length - 1; i >= 0; i -= 1) {
    const a = annots.get(i);
    if (a.isDictionary() && sanitizeAnnot(a.resolve(), o, r)) {
      annots.delete(i);
    }
  }
  if (o.metadata || o.privateData) {
    const xobjects = dig(obj, "Resources", "XObject");
    for (const key of xobjects ? keysOf(xobjects) : []) {
      const x = xobjects?.get(key).resolve();
      if (o.metadata) {
        r.metadata += drop(x ?? null, "Metadata");
      }
      if (o.privateData) {
        r.privateData += drop(x ?? null, "PieceInfo");
      }
    }
  }
};

export const sanitize = (
  env: Env,
  bytes: Uint8Array,
  o: SanitizeOptions
): { bytes: Uint8Array; report: SanitizeReport } => {
  const doc = openPdf(env, bytes);
  try {
    const report: SanitizeReport = {
      attachments: 0,
      links: 0,
      metadata: 0,
      privateData: 0,
      scripts: 0,
      thumbnails: 0,
    };
    sanitizeCatalog(doc, o, report);
    const n = doc.countPages();
    for (let i = 0; i < n; i += 1) {
      sanitizePage(doc.loadPage(i), o, report);
    }
    // What was cut loose goes from the file too: a full rewrite keeps only what is still referenced.
    return {
      bytes: savePdf(env, doc, { extra: ["garbage=deduplicate"] }),
      report,
    };
  } finally {
    doc.destroy();
  }
};

/* ---------------- signatures ---------------- */

export interface UnsignOptions {
  /** Remove the signature fields themselves, not just the signatures in them. */
  removeFields: boolean;
}

export const removeSignatures = (
  env: Env,
  bytes: Uint8Array,
  o: UnsignOptions
): { bytes: Uint8Array; count: number } => {
  const doc = openPdf(env, bytes);
  try {
    let count = 0;
    const root = doc.getTrailer().get("Root");
    const form = root.get("AcroForm");
    const n = doc.countPages();
    for (let i = 0; i < n; i += 1) {
      const page = doc.loadPage(i);
      for (const w of page.getWidgets()) {
        if (w.getFieldType() !== "signature") {
          continue;
        }
        const obj = w.getObject();
        // The value sits on the field: the widget itself, or its parent.
        const field =
          obj.get("T").isNull() && obj.get("Parent").isDictionary()
            ? obj.get("Parent")
            : obj;
        const signed = !field.get("V").isNull();
        if (o.removeFields) {
          if (form.isDictionary() && form.get("Fields").isArray()) {
            pruneField(form.get("Fields"), obj);
          }
          page.deleteAnnotation(w);
          count += 1;
        } else if (signed) {
          field.delete("V");
          drop(field, "Lock");
          drop(obj, "AP");
          count += 1;
        }
      }
    }
    // The document-level marks of a certified or signed document.
    drop(root, "Perms");
    drop(form.isDictionary() ? form : null, "SigFlags");
    return {
      bytes: savePdf(env, doc, { extra: ["garbage=deduplicate"] }),
      count,
    };
  } finally {
    doc.destroy();
  }
};
