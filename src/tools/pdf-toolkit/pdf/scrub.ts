// What is left to clean once MuPDF has redacted a page. None of it shows,
// and all of it could tell what was under a box: text standing in for
// content (ActualText, Alt, E) on marked content and on the structure tree,
// the page's thumbnail, settings that no longer paint anything (a soft mask
// whose group draws the redacted text, a pattern no fill uses), and fonts,
// patterns, and forms the page no longer names at all.
//
// The stand-in text goes from every marked-content sequence of a redacted
// page, not only those a box touched: MuPDF rewrites the page whole, so
// which sequences lost content cannot be told afterwards. The page reads
// the same; only what assistive technology and copying are offered in
// place of its content goes.

import type { PDFDocument, PDFObject, PDFPage } from "mupdf";

import { pageContents } from "./compose";
import { copyDict, keysOf, textOf } from "./objects";
import { applyEdits, asciiBytes, concat, parseContent } from "./tokens";
import type { Edit, Op, Operand } from "./tokens";

/** Keys that carry text standing in for content: replacement, alternate, and expansion text. */
const STAND_IN_KEYS = ["ActualText", "Alt", "E"];

/** The resource kinds pruned to what the content still names. */
const CATEGORIES = [
  "ExtGState",
  "Font",
  "Pattern",
  "Properties",
  "Shading",
  "XObject",
] as const;
type Category = (typeof CATEGORIES)[number];

interface Usage {
  names: Record<Category, Set<string>>;
  /** Something draws with these resources that this pass cannot read: prune nothing. */
  keepAll: boolean;
}

const emptyUsage = (): Usage => ({
  keepAll: false,
  names: {
    ExtGState: new Set(),
    Font: new Set(),
    Pattern: new Set(),
    Properties: new Set(),
    Shading: new Set(),
    XObject: new Set(),
  },
});

const merge = (into: Usage, from: Usage) => {
  into.keepAll ||= from.keepAll;
  for (const c of CATEGORIES) {
    for (const n of from.names[c]) {
      into.names[c].add(n);
    }
  }
};

/** Operators that put marks on the page. */
const PAINT = new Set([
  "S",
  "s",
  "f",
  "F",
  "f*",
  "B",
  "B*",
  "b",
  "b*",
  "Tj",
  "TJ",
  "'",
  '"',
  "Do",
  "sh",
  "BI",
]);

const nameAt = (op: Op, index: number): string | null => {
  const o = index < 0 ? op.operands.at(index) : op.operands[index];
  return o?.kind === "name" ? o.name : null;
};

/** The resource a graphics-state operator selects, which only matters if something is painted after it. */
const stateResource = (op: Op): [Category, string] | null => {
  const pick = (c: Category, name: string | null): [Category, string] | null =>
    name === null ? null : [c, name];
  switch (op.operator) {
    case "gs": {
      return pick("ExtGState", nameAt(op, 0));
    }
    case "Tf": {
      return pick("Font", nameAt(op, 0));
    }
    case "scn":
    case "SCN": {
      return pick("Pattern", nameAt(op, -1));
    }
    default: {
      return null;
    }
  }
};

/** A resource an operator names however it is used. */
const namedResource = (op: Op): [Category, string] | null => {
  const name =
    op.operator === "BDC" || op.operator === "DP"
      ? nameAt(op, 1)
      : nameAt(op, 0);
  if (name === null) {
    return null;
  }
  switch (op.operator) {
    case "Do": {
      return ["XObject", name];
    }
    case "sh": {
      return ["Shading", name];
    }
    case "BDC":
    case "DP": {
      return ["Properties", name];
    }
    default: {
      return null;
    }
  }
};

/**
 * Graphics-state operators nothing is painted under: each is undone by a Q
 * (or the stream's end) before any painting operator runs.
 */
const deadStateOps = (ops: Op[]): Set<Op> => {
  const dead = new Set<Op>();
  const levels: Op[][] = [[]];
  for (const op of ops) {
    if (op.operator === "q") {
      levels.push([]);
    } else if (op.operator === "Q") {
      if (levels.length > 1) {
        for (const o of levels.pop() ?? []) {
          dead.add(o);
        }
      }
    } else if (stateResource(op)) {
      levels.at(-1)?.push(op);
    } else if (PAINT.has(op.operator)) {
      for (const level of levels) {
        level.length = 0;
      }
    }
  }
  for (const o of levels.flat()) {
    dead.add(o);
  }
  return dead;
};

const SPACE = asciiBytes(" ");

/** An inline marked-content dictionary without its stand-in text, or null if it has none. */
const strippedDict = (
  bytes: Uint8Array,
  dict: Operand | undefined
): Edit | null => {
  if (dict?.kind !== "dict") {
    return null;
  }
  const kept = dict.entries.filter((e) => !STAND_IN_KEYS.includes(e.key));
  if (kept.length === dict.entries.length) {
    return null;
  }
  const parts: Uint8Array[] = [asciiBytes("<<")];
  for (const e of kept) {
    parts.push(bytes.subarray(e.start, e.end), SPACE);
  }
  parts.push(asciiBytes(">>"));
  return { end: dict.end, start: dict.start, text: concat(parts) };
};

/** The entry `name` of the resource sub-dictionary `category`, or null. */
const resourceOf = (
  resources: PDFObject | null,
  category: Category,
  name: string
): PDFObject | null => {
  if (!resources?.isDictionary()) {
    return null;
  }
  const sub = resources.get(category);
  if (!sub.isDictionary()) {
    return null;
  }
  const value = sub.get(name);
  return value.isNull() ? null : value;
};

/** Whether `obj` draws with the resources of whoever uses it, having none of its own. */
const borrowsResources = (obj: PDFObject): boolean =>
  !obj.get("Resources").isDictionary();

/** A marked-content property list without its stand-in text: a copy, so its other users keep theirs. */
const strippedProperty = (doc: PDFDocument, value: PDFObject): PDFObject => {
  const dict = value.resolve();
  if (!dict.isDictionary()) {
    return value;
  }
  if (!STAND_IN_KEYS.some((k) => !dict.get(k).isNull())) {
    return value;
  }
  const copy = copyDict(doc, dict);
  for (const k of STAND_IN_KEYS) {
    copy.delete(k);
  }
  return copy;
};

const ASCII_LIMIT = 128;
const isAscii = (s: string) =>
  [...s].every((c) => (c.codePointAt(0) ?? ASCII_LIMIT) < ASCII_LIMIT);

/**
 * A copy of `resources` keeping only what `usage` names, in each kind this
 * pass prunes. A copy, never an edit: the dictionaries may be shared with
 * pages and forms that still need them. A name this pass could not have
 * read faithfully (one outside ASCII) is kept.
 */
const prunedResources = (
  doc: PDFDocument,
  resources: PDFObject,
  usage: Usage
): PDFObject => {
  const copy = copyDict(doc, resources);
  for (const c of CATEGORIES) {
    const sub = resources.get(c);
    if (!sub.isDictionary()) {
      continue;
    }
    const kept = doc.newDictionary();
    for (const key of keysOf(sub)) {
      if (usage.keepAll || usage.names[c].has(key) || !isAscii(key)) {
        const value = sub.get(key);
        kept.put(
          key,
          c === "Properties" ? strippedProperty(doc, value) : value
        );
      }
    }
    copy.put(c, kept);
  }
  return copy;
};

/** One redacted page's content cleaned, and every form it draws, each once. */
class PageScrubber {
  readonly doc: PDFDocument;
  /** Forms already cleaned, by object number: what each borrowed from its user's resources, or null if it has its own. */
  readonly seen = new Map<number, Usage | null>();

  constructor(doc: PDFDocument) {
    this.doc = doc;
  }

  /**
   * One content stream cleaned: graphics state nothing is painted under
   * goes, stand-in text goes from inline marked-content dictionaries, and
   * every resource still named is noted in `usage`, with what the forms it
   * draws borrow from `resources`.
   */
  content(
    bytes: Uint8Array,
    resources: PDFObject | null,
    usage: Usage
  ): Uint8Array {
    const ops = parseContent(bytes);
    const dead = deadStateOps(ops);
    const local = emptyUsage();
    const edits: Edit[] = [];
    for (const op of ops) {
      if (dead.has(op)) {
        edits.push({ end: op.end, start: op.start, text: SPACE });
        continue;
      }
      const used = stateResource(op) ?? namedResource(op);
      if (used) {
        local.names[used[0]].add(used[1]);
      }
      const marked = op.operator === "BDC" || op.operator === "DP";
      const stripped = marked ? strippedDict(bytes, op.operands[1]) : null;
      if (stripped) {
        edits.push(stripped);
      }
    }
    merge(usage, local);
    this.follow(resources, local, usage);
    return edits.length > 0 ? applyEdits(bytes, edits) : bytes;
  }

  /**
   * What this stream draws with that has content of its own: forms are
   * cleaned in turn; a pattern or a Type3 font that borrows these resources
   * is not read here, so they are all kept.
   */
  private follow(resources: PDFObject | null, local: Usage, usage: Usage) {
    for (const name of local.names.XObject) {
      const x = resourceOf(resources, "XObject", name);
      if (x?.isStream() && textOf(x.get("Subtype")) === "Form") {
        this.form(x, resources, usage);
      }
    }
    for (const name of local.names.Pattern) {
      const p = resourceOf(resources, "Pattern", name);
      if (p?.isStream() && borrowsResources(p)) {
        usage.keepAll = true;
      }
    }
    for (const name of local.names.Font) {
      const f = resourceOf(resources, "Font", name);
      if (f && textOf(f.get("Subtype")) === "Type3" && borrowsResources(f)) {
        usage.keepAll = true;
      }
    }
  }

  /**
   * A Form XObject cleaned like a page. Whatever is done to it holds for
   * every use of it, on this page or another: it drops only what the form
   * itself never paints with, and stand-in text, which costs other uses
   * nothing that shows. (MuPDF draws a redacted page's forms from copies
   * of its own, so the original stays as it was for other pages.)
   */
  private form(
    form: PDFObject,
    userResources: PDFObject | null,
    userUsage: Usage
  ) {
    const key = form.isIndirect() ? form.asIndirect() : -1;
    const before = this.seen.get(key);
    if (before !== undefined) {
      if (before) {
        merge(userUsage, before);
      }
      return;
    }
    const own = form.get("Resources");
    const hasOwn = own.isDictionary();
    const usage = emptyUsage();
    this.seen.set(key, hasOwn ? null : usage);
    const bytes = form.readStream().asUint8Array();
    const cleaned = this.content(bytes, hasOwn ? own : userResources, usage);
    if (cleaned !== bytes) {
      form.writeStream(cleaned);
    }
    if (hasOwn) {
      form.put("Resources", prunedResources(this.doc, own, usage));
    } else {
      merge(userUsage, usage);
    }
  }
}

/** Clean a page MuPDF has just redacted (see the top of this file). */
export const scrubPage = (doc: PDFDocument, page: PDFPage) => {
  const obj = page.getObject();
  obj.delete("Thumb");
  const inherited = obj.getInheritable("Resources");
  const resources = inherited.isDictionary() ? inherited : null;
  const usage = emptyUsage();
  const content = pageContents(obj);
  const cleaned = new PageScrubber(doc).content(content, resources, usage);
  if (cleaned !== content) {
    obj.put("Contents", doc.addStream(cleaned, doc.newDictionary()));
  }
  if (resources) {
    obj.put("Resources", prunedResources(doc, resources, usage));
  }
};

/* ---------------- structure tree ---------------- */

/** Deepest a structure tree is followed. */
const MAX_DEPTH = 256;

interface TreeWalk {
  /** Object numbers of the redacted pages. */
  pages: Set<number>;
  seen: Set<number>;
}

const pageNumberOf = (
  obj: PDFObject,
  inherited: number | null
): number | null => {
  const pg = obj.get("Pg");
  return pg.isIndirect() ? pg.asIndirect() : inherited;
};

/**
 * Whether `node` (a structure element, a marked-content or object
 * reference, an MCID, or an array of them) has content on a redacted page;
 * every structure element that does loses its stand-in text, and so does
 * every element above it, whose text spans its children's.
 */
const touchesRedacted = (
  walk: TreeWalk,
  node: PDFObject,
  page: number | null,
  depth: number
): boolean => {
  if (depth > MAX_DEPTH || node.isNull()) {
    return false;
  }
  if (node.isNumber()) {
    return page !== null && walk.pages.has(page);
  }
  if (node.isArray()) {
    let any = false;
    for (let i = 0; i < node.length; i += 1) {
      any = touchesRedacted(walk, node.get(i), page, depth + 1) || any;
    }
    return any;
  }
  if (!node.isDictionary()) {
    return false;
  }
  if (node.isIndirect()) {
    if (walk.seen.has(node.asIndirect())) {
      return false;
    }
    walk.seen.add(node.asIndirect());
  }
  const own = pageNumberOf(node, page);
  const here = own !== null && walk.pages.has(own);
  const below = touchesRedacted(walk, node.get("K"), own, depth + 1);
  const touched = here || below;
  if (touched && !node.get("S").isNull()) {
    for (const k of STAND_IN_KEYS) {
      node.delete(k);
    }
  }
  return touched;
};

/** Take the stand-in text off every structure element with content on a redacted page, and off those above them. */
export const scrubStructTree = (doc: PDFDocument, pages: PDFPage[]) => {
  const root = doc.getTrailer().get("Root").get("StructTreeRoot");
  if (!root.isDictionary() || pages.length === 0) {
    return;
  }
  const walk: TreeWalk = {
    pages: new Set(
      pages
        .map((p) => p.getObject())
        .filter((o) => o.isIndirect())
        .map((o) => o.asIndirect())
    ),
    seen: new Set(),
  };
  touchesRedacted(walk, root.get("K"), null, 0);
};
