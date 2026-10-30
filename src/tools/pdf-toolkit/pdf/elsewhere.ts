// Where else some text appears in a document, besides on its pages:
// bookmarks, metadata, comments, form fields, destination names, page
// labels, and attachments. Redaction removes what is under its boxes and
// nothing more; this tells what it does not reach, and changes nothing.

import type { PDFDocument, PDFObject } from "mupdf";

import { dig, itemsOf, keysOf, nameTree, textOf } from "./objects";

export type PlaceKind =
  | "bookmark"
  | "metadata"
  | "comment"
  | "field"
  | "destination"
  | "pageLabel"
  | "attachment";

export interface Place {
  kind: PlaceKind;
  /** 0-based page, for comments, fields, page labels, and attachments pinned to a page. */
  page?: number;
  /** Which one, in a few words: the bookmark's title, the metadata key ("Title", "XMP"), the comment's type, the field's name, the file's name. */
  label: string;
}

/** Most places reported: past this the list is no use to anyone. */
export const PLACES_LIMIT = 1000;

/** Deepest a bookmark tree or page-label tree is followed. */
const MAX_DEPTH = 64;

type Matches = (s: string) => boolean;

/** `re` as a test of a whole string; a global RegExp's test would carry its position from one string to the next. */
const matcher = (re: RegExp): Matches => {
  const once = new RegExp(re.source, re.flags.replaceAll("g", ""));
  return (s) => s !== "" && once.test(s);
};

const bookmarks = (doc: PDFDocument, matches: Matches): Place[] => {
  const out: Place[] = [];
  const seen = new Set<number>();
  const visit = (first: PDFObject, depth: number) => {
    if (depth > MAX_DEPTH) {
      return;
    }
    let item = first;
    while (item.isDictionary()) {
      if (item.isIndirect()) {
        if (seen.has(item.asIndirect())) {
          return;
        }
        seen.add(item.asIndirect());
      }
      const title = textOf(item.get("Title"));
      if (matches(title)) {
        out.push({ kind: "bookmark", label: title });
      }
      visit(item.get("First"), depth + 1);
      item = item.get("Next");
    }
  };
  const outlines = dig(doc.getTrailer(), "Root", "Outlines");
  if (outlines) {
    visit(outlines.get("First"), 0);
  }
  return out;
};

const MAX_CODE_POINT = 0x10_ff_ff;

const ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  quot: '"',
};

/** The text of an XML document: tags out, the common entities and character references undone. */
const xmlText = (xml: string): string =>
  xml
    .replaceAll(/<[^>]*>/gu, " ")
    .replaceAll(
      /&(?<ref>#x[0-9a-f]+|#\d+|[a-z]+);/giu,
      (whole, ref: string) => {
        if (!ref.startsWith("#")) {
          return ENTITIES[ref] ?? whole;
        }
        const hex = ref[1]?.toLowerCase() === "x";
        const code = hex
          ? Number.parseInt(ref.slice(2), 16)
          : Number(ref.slice(1));
        return Number.isInteger(code) && code <= MAX_CODE_POINT
          ? String.fromCodePoint(code)
          : whole;
      }
    );

const metadata = (doc: PDFDocument, matches: Matches): Place[] => {
  const out: Place[] = [];
  const trailer = doc.getTrailer();
  const infoDict = dig(trailer, "Info");
  if (infoDict) {
    for (const key of keysOf(infoDict)) {
      if (matches(textOf(infoDict.get(key)))) {
        out.push({ kind: "metadata", label: key });
      }
    }
  }
  const xmp = dig(trailer, "Root", "Metadata");
  if (xmp?.isStream()) {
    const xml = new TextDecoder().decode(xmp.readStream().asUint8Array());
    if (matches(xmlText(xml))) {
      out.push({ kind: "metadata", label: "XMP" });
    }
  }
  return out;
};

/** Annotations that are neither form fields nor the pop-ups showing another's text. */
const NOT_COMMENTS = new Set(["Widget", "Popup"]);

const comments = (doc: PDFDocument, matches: Matches): Place[] => {
  const out: Place[] = [];
  const n = doc.countPages();
  for (let page = 0; page < n; page += 1) {
    for (const a of itemsOf(doc.findPage(page).get("Annots"))) {
      const subtype = textOf(a.get("Subtype"));
      const hit = [a.get("Contents"), a.get("T")].some((v) =>
        matches(textOf(v))
      );
      if (!NOT_COMMENTS.has(subtype) && hit) {
        out.push({ kind: "comment", label: subtype, page });
      }
    }
  }
  return out;
};

const fields = (doc: PDFDocument, matches: Matches): Place[] => {
  const out: Place[] = [];
  const seen = new Set<string>();
  const n = doc.countPages();
  for (let page = 0; page < n; page += 1) {
    for (const w of doc.loadPage(page).getWidgets()) {
      const name = w.getName();
      const key = `${page}\n${name}`;
      if (!seen.has(key) && (matches(name) || matches(w.getValue()))) {
        seen.add(key);
        out.push({ kind: "field", label: name, page });
      }
    }
  }
  return out;
};

const destinations = (doc: PDFDocument, matches: Matches): Place[] => {
  // In the name tree (PDF 1.2 on), and in the catalog's older /Dests dictionary.
  const names = Object.keys(nameTree(doc, "Dests"));
  const old = dig(doc.getTrailer(), "Root", "Dests");
  names.push(...(old ? keysOf(old) : []));
  return [...new Set(names)]
    .filter(matches)
    .map((label): Place => ({ kind: "destination", label }));
};

const pageLabels = (doc: PDFDocument, matches: Matches): Place[] => {
  const out: Place[] = [];
  const visit = (node: PDFObject, depth: number) => {
    if (!node.isDictionary() || depth > MAX_DEPTH) {
      return;
    }
    const nums = itemsOf(node.get("Nums"));
    for (let i = 0; i + 1 < nums.length; i += 2) {
      const start = nums[i];
      const label = nums[i + 1];
      const prefix = label?.isDictionary() ? textOf(label.get("P")) : "";
      if (start?.isNumber() && matches(prefix)) {
        out.push({ kind: "pageLabel", label: prefix, page: start.asNumber() });
      }
    }
    for (const kid of itemsOf(node.get("Kids"))) {
      visit(kid, depth + 1);
    }
  };
  const labels = dig(doc.getTrailer(), "Root", "PageLabels");
  if (labels) {
    visit(labels, 0);
  }
  return out;
};

/** What a file specification calls its file and says of it, and the name it is stored under. */
const fileTexts = (
  spec: PDFObject,
  key: string
): { name: string; texts: string[] } => {
  const s = spec.resolve();
  const name = textOf(s.get("UF")) || textOf(s.get("F")) || key;
  return {
    name,
    texts: [key, name, textOf(s.get("F")), textOf(s.get("Desc"))],
  };
};

/** Names and descriptions only: the files' contents are not read, let alone decompressed and searched. */
const attachments = (doc: PDFDocument, matches: Matches): Place[] => {
  const out: Place[] = [];
  for (const [key, spec] of Object.entries(doc.getEmbeddedFiles())) {
    const f = fileTexts(spec, key);
    if (f.texts.some(matches)) {
      out.push({ kind: "attachment", label: f.name });
    }
  }
  const n = doc.countPages();
  for (let page = 0; page < n; page += 1) {
    for (const a of itemsOf(doc.findPage(page).get("Annots"))) {
      const fs = a.get("FS");
      if (textOf(a.get("Subtype")) === "FileAttachment" && fs.isDictionary()) {
        const f = fileTexts(fs, "");
        if (f.texts.some(matches)) {
          out.push({ kind: "attachment", label: f.name, page });
        }
      }
    }
  }
  return out;
};

/** Every place outside the pages' content where text matching `re` appears. */
export const findElsewhere = (doc: PDFDocument, re: RegExp): Place[] => {
  const matches = matcher(re);
  return [
    ...bookmarks(doc, matches),
    ...metadata(doc, matches),
    ...comments(doc, matches),
    ...fields(doc, matches),
    ...destinations(doc, matches),
    ...pageLabels(doc, matches),
    ...attachments(doc, matches),
  ].slice(0, PLACES_LIMIT);
};
