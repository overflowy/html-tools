// Small things about PDF objects that MuPDF's API leaves to the caller:
// enumerating a dictionary, copying one, reading a rectangle, and giving a
// page resources of its own.

import type { PDFDocument, PDFObject } from "mupdf";

import { normalize } from "./geometry";
import type { Rect } from "./geometry";

/**
 * The keys of a dictionary. MuPDF enumerates a dictionary only through its
 * plain-JavaScript view, which is shallow for what matters here: indirect
 * values come back as "n 0 R" strings and are not followed.
 */
export const keysOf = (dict: PDFObject): string[] => {
  // MuPDF's shared null belongs to no document and cannot be resolved.
  if (dict.isNull()) {
    return [];
  }
  const resolved = dict.resolve();
  if (!resolved.isDictionary()) {
    return [];
  }
  return Object.keys(resolved.asJS() as Record<string, unknown>);
};

/**
 * The object at `path` under `obj`, or null where any step is missing.
 * Stepping through a missing key with `get` would fail: MuPDF's shared null
 * belongs to no document.
 */
export const dig = (
  obj: PDFObject,
  ...path: (string | number)[]
): PDFObject | null => {
  let at = obj;
  for (const key of path) {
    if (at.isNull()) {
      return null;
    }
    at = at.get(key);
  }
  return at.isNull() ? null : at;
};

/**
 * A document-level name tree (JavaScript, EmbeddedFiles, Dests) as a
 * record. MuPDF's own reader steps into /Names without checking it exists.
 */
export const nameTree = (
  doc: PDFDocument,
  tree: string
): Record<string, PDFObject> =>
  dig(doc.getTrailer(), "Root", "Names", tree) ? doc.loadNameTree(tree) : {};

/** The elements of an array; none for anything else. */
export const itemsOf = (arr: PDFObject): PDFObject[] => {
  if (arr.isNull()) {
    return [];
  }
  const resolved = arr.resolve();
  if (!resolved.isArray()) {
    return [];
  }
  const out: PDFObject[] = [];
  for (let i = 0; i < resolved.length; i += 1) {
    out.push(resolved.get(i));
  }
  return out;
};

/** A shallow copy of a dictionary, so a change to it touches no one else's. */
export const copyDict = (doc: PDFDocument, dict: PDFObject): PDFObject => {
  const copy = doc.newDictionary();
  for (const key of keysOf(dict)) {
    copy.put(key, dict.get(key));
  }
  return copy;
};

/** A four-number array as a normalized rectangle, or null. */
export const rectOf = (obj: PDFObject): Rect | null => {
  const items = itemsOf(obj);
  if (items.length < 4 || !items.every((v) => v.isNumber())) {
    return null;
  }
  const [a, b, c, d] = items.map((v) => v.asNumber());
  return normalize([a ?? 0, b ?? 0, c ?? 0, d ?? 0]);
};

export const rectObject = (doc: PDFDocument, r: Rect): PDFObject => {
  const arr = doc.newArray();
  for (const v of r) {
    arr.push(doc.newReal(v));
  }
  return arr;
};

/** A name's text, or a string's, or "" for anything else. */
export const textOf = (obj: PDFObject): string => {
  if (obj.isNull()) {
    return "";
  }
  const r = obj.resolve();
  if (r.isName()) {
    return r.asName();
  }
  if (r.isString()) {
    return r.asString();
  }
  return "";
};

/**
 * The page's own Resources dictionary. One inherited from the page tree, or
 * an indirect one other pages may share, is copied onto the page first, so
 * names added here never appear on another page.
 */
export const ownResources = (doc: PDFDocument, page: PDFObject): PDFObject => {
  const direct = page.get("Resources");
  if (direct.isDictionary() && !direct.isIndirect()) {
    return direct;
  }
  const copy = copyDict(doc, page.getInheritable("Resources"));
  page.put("Resources", copy);
  return page.get("Resources");
};

/** The sub-dictionary `key` (Font, XObject, ExtGState) of resources, made the page's own the same way. */
const ownSubdict = (
  doc: PDFDocument,
  resources: PDFObject,
  key: string
): PDFObject => {
  const sub = resources.get(key);
  if (sub.isDictionary() && !sub.isIndirect()) {
    return sub;
  }
  resources.put(key, copyDict(doc, sub));
  return resources.get(key);
};

/** Put `value` in the page's resources under a fresh name starting with `prefix`; returns the name. */
export const addResource = (
  doc: PDFDocument,
  page: PDFObject,
  kind: "Font" | "XObject" | "ExtGState" | "Pattern",
  prefix: string,
  value: PDFObject
): string => {
  const sub = ownSubdict(doc, ownResources(doc, page), kind);
  let n = 1;
  while (!sub.get(`${prefix}${n}`).isNull()) {
    n += 1;
  }
  const name = `${prefix}${n}`;
  sub.put(name, value);
  return name;
};
