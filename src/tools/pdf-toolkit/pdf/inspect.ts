// What a document is and holds: its version, pages, fonts, images, forms,
// and the rest (Info); its document information (Metadata), read and
// written; and how sound its structure is (Validate), as two engines see
// it: qpdf's structural check, and MuPDF's warnings while it reads and
// interprets every page.

import type { PDFDocument, PDFObject } from "mupdf";

import { openPdf, savePdf } from "./doc";
import type { Env } from "./doc";
import { describeSize } from "./geometry";
import { dig, itemsOf, keysOf, nameTree, textOf } from "./objects";
import { countBookmarks, readOutline } from "./outline";

/* ---------------- fonts ---------------- */

export interface FontInfo {
  name: string;
  type: string;
  embedded: boolean;
  subset: boolean;
  /** Pages it is used on (as a resource), 1-based. */
  pages: number[];
}

const SUBSET_PREFIX = /^[A-Z]{6}\+/u;

const fontInfo = (font: PDFObject): Omit<FontInfo, "pages"> => {
  const f = font.resolve();
  const type = textOf(f.get("Subtype"));
  const base =
    textOf(f.get("BaseFont")) || textOf(f.get("Name")) || "(unnamed)";
  const descendant =
    type === "Type0" ? itemsOf(f.get("DescendantFonts"))[0]?.resolve() : null;
  const descriptor = (descendant ?? f).get("FontDescriptor");
  const embedded =
    type === "Type3" ||
    (descriptor.isDictionary() &&
      ["FontFile", "FontFile2", "FontFile3"].some(
        (k) => !descriptor.get(k).isNull()
      ));
  return {
    embedded,
    name: base.replace(SUBSET_PREFIX, ""),
    subset: SUBSET_PREFIX.test(base),
    type: descendant ? `${type} (${textOf(descendant.get("Subtype"))})` : type,
  };
};

/** Every font and image a page uses, through the forms it draws, each object once. */
export const walkResources = (
  resources: PDFObject | null,
  visit: { font?: (f: PDFObject) => void; image: (i: PDFObject) => void },
  seen: Set<number>,
  depth = 0
) => {
  if (!resources || depth > 16) {
    return;
  }
  const fonts = dig(resources, "Font");
  for (const key of fonts ? keysOf(fonts) : []) {
    const f = fonts?.get(key);
    if (f && !f.isNull()) {
      visit.font?.(f);
    }
  }
  const xobjects = dig(resources, "XObject");
  for (const key of xobjects ? keysOf(xobjects) : []) {
    const x = xobjects?.get(key);
    if (!x || x.isNull()) {
      continue;
    }
    if (x.isIndirect()) {
      if (seen.has(x.asIndirect())) {
        continue;
      }
      seen.add(x.asIndirect());
    }
    const subtype = textOf(x.resolve().get("Subtype"));
    if (subtype === "Image") {
      visit.image(x);
    } else if (subtype === "Form") {
      walkResources(dig(x.resolve(), "Resources"), visit, seen, depth + 1);
    }
  }
};

/* ---------------- metadata ---------------- */

export interface Metadata {
  title: string;
  author: string;
  subject: string;
  keywords: string;
  creator: string;
  producer: string;
  /** As the document has them: PDF dates, "D:YYYYMMDDHHmmSS...". */
  created: string;
  modified: string;
  /** The document's language, as a language tag. */
  language: string;
}

const INFO_KEYS = {
  author: "info:Author",
  created: "info:CreationDate",
  creator: "info:Creator",
  keywords: "info:Keywords",
  modified: "info:ModDate",
  producer: "info:Producer",
  subject: "info:Subject",
  title: "info:Title",
} as const;

export const readMetadata = (doc: PDFDocument): Metadata => {
  const get = (k: keyof typeof INFO_KEYS) =>
    doc.getMetaData(INFO_KEYS[k]) ?? "";
  return {
    author: get("author"),
    created: get("created"),
    creator: get("creator"),
    keywords: get("keywords"),
    // As written: MuPDF's own reading keeps only the primary language ("en" of "en-GB").
    language: textOf(doc.getTrailer().get("Root").get("Lang")),
    modified: get("modified"),
    producer: get("producer"),
    subject: get("subject"),
    title: get("title"),
  };
};

/* ---------------- info ---------------- */

export interface InfoReport {
  version: string;
  pages: number;
  /** Page sizes, each with how many pages have it, most common first. */
  sizes: { size: string; count: number }[];
  bytes: number;
  metadata: Metadata;
  fonts: FontInfo[];
  images: number;
  /** Annotations by type. */
  annotations: Record<string, number>;
  fields: number;
  signatures: number;
  attachments: number;
  javascript: boolean;
  layers: number;
  bookmarks: number;
  tagged: boolean;
  linearized: boolean;
  /** "PDF/A-2b" and the like, when the document says it conforms. */
  pdfa: string | null;
  pageLabels: boolean;
  objects: number;
}

/** What the XMP says the document conforms to, if it says. */
const pdfaClaim = (doc: PDFDocument): string | null => {
  const xmp = dig(doc.getTrailer(), "Root", "Metadata");
  if (!xmp?.isStream()) {
    return null;
  }
  const text = xmp.readStream().asString();
  const part = /pdfaid:part\s*(?:=\s*["'](?<a>\d)|>\s*(?<b>\d))/u.exec(
    text
  )?.groups;
  if (!part) {
    return null;
  }
  const conf = /pdfaid:conformance\s*(?:=\s*["'](?<a>\w)|>\s*(?<b>\w))/u.exec(
    text
  )?.groups;
  const level = (conf?.a ?? conf?.b ?? "").toLowerCase();
  return `PDF/A-${part.a ?? part.b}${level}`;
};

/** Document-level scripts: named ones, ones run on opening, and the catalog's triggers. */
const hasScripts = (doc: PDFDocument): boolean => {
  const root = doc.getTrailer().get("Root");
  const open = dig(root, "OpenAction");
  return (
    Object.keys(nameTree(doc, "JavaScript")).length > 0 ||
    dig(root, "AA") !== null ||
    (open?.isDictionary() === true && textOf(open.get("S")) === "JavaScript")
  );
};

const countAnnotations = (doc: PDFDocument): Record<string, number> => {
  const out: Record<string, number> = {};
  const n = doc.countPages();
  for (let i = 0; i < n; i += 1) {
    for (const a of doc.loadPage(i).getAnnotations()) {
      const t = a.getType();
      out[t] = (out[t] ?? 0) + 1;
    }
  }
  return out;
};

export const info = (env: Env, bytes: Uint8Array): InfoReport => {
  const doc = openPdf(env, bytes);
  try {
    const n = doc.countPages();
    const sizes = new Map<string, number>();
    const fonts = new Map<string, FontInfo>();
    const seen = new Set<number>();
    let images = 0;
    let fields = 0;
    let signatures = 0;
    /** The page the walk is on, 1-based. */
    let pageNo = 0;
    const visitor = {
      font: (f: PDFObject) => {
        const key = f.isIndirect()
          ? `#${f.asIndirect()}`
          : `${pageNo}:${textOf(f.get("BaseFont"))}`;
        const known = fonts.get(key) ?? { ...fontInfo(f), pages: [] };
        if (known.pages.at(-1) !== pageNo) {
          known.pages.push(pageNo);
        }
        fonts.set(key, known);
      },
      image: () => {
        images += 1;
      },
    };
    for (let i = 0; i < n; i += 1) {
      pageNo = i + 1;
      const page = doc.loadPage(i);
      const [x0, y0, x1, y1] = page.getBounds();
      const size = describeSize(x1 - x0, y1 - y0);
      sizes.set(size, (sizes.get(size) ?? 0) + 1);
      walkResources(
        page.getObject().getInheritable("Resources"),
        visitor,
        seen
      );
      for (const w of page.getWidgets()) {
        fields += 1;
        if (w.getFieldType() === "signature") {
          signatures += 1;
        }
      }
    }
    const root = doc.getTrailer().get("Root");
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
    return {
      annotations: countAnnotations(doc),
      attachments: Object.keys(doc.getEmbeddedFiles()).length,
      bookmarks: countBookmarks(readOutline(doc)),
      bytes: bytes.length,
      fields,
      fonts: [...fonts.values()].toSorted((a, b) =>
        a.name.localeCompare(b.name)
      ),
      images,
      javascript: hasScripts(doc),
      layers: doc.countLayers(),
      linearized: head.includes("/Linearized"),
      metadata: readMetadata(doc),
      objects: doc.countObjects(),
      pageLabels: dig(root, "PageLabels") !== null,
      pages: n,
      pdfa: pdfaClaim(doc),
      signatures,
      sizes: [...sizes]
        .map(([size, count]) => ({ count, size }))
        .toSorted((a, b) => b.count - a.count),
      tagged: dig(root, "MarkInfo", "Marked")?.asBoolean() ?? false,
      version: (doc.getVersion() / 10).toFixed(1),
    };
  } finally {
    doc.destroy();
  }
};

/** A Date as a PDF date: D:YYYYMMDDHHmmSS with its UTC offset. */
export const pdfDate = (d: Date): string => {
  const p = (n: number) => String(Math.trunc(Math.abs(n))).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${sign}${p(off / 60)}'${p(off % 60)}'`;
};

/** A PDF date as a Date, or null for one that is not. */
export const parsePdfDate = (s: string): Date | null => {
  const m =
    /^(?:D:)?(?<y>\d{4})(?<mo>\d{2})?(?<d>\d{2})?(?<h>\d{2})?(?<mi>\d{2})?(?<s>\d{2})?(?<z>[+\-Z])?(?<oh>\d{2})?'?(?<om>\d{2})?/u.exec(
      s.trim()
    )?.groups;
  if (!m) {
    return null;
  }
  const n = (v: string | undefined, dflt: number) =>
    v === undefined ? dflt : Number(v);
  const utc = Date.UTC(
    n(m.y, 1970),
    n(m.mo, 1) - 1,
    n(m.d, 1),
    n(m.h, 0),
    n(m.mi, 0),
    n(m.s, 0)
  );
  const sign = m.z === "-" ? -1 : 1;
  const offset = m.z && m.z !== "Z" ? sign * (n(m.oh, 0) * 60 + n(m.om, 0)) : 0;
  const d = new Date(utc - offset * 60_000);
  return Number.isNaN(d.getTime()) ? null : d;
};

export interface MetadataOptions {
  values: Omit<Metadata, "created" | "modified">;
  /** Set the modification date to now. */
  touch: boolean;
}

export const writeMetadata = (
  env: Env,
  bytes: Uint8Array,
  o: MetadataOptions
): Uint8Array => {
  const doc = openPdf(env, bytes);
  try {
    for (const key of [
      "title",
      "author",
      "subject",
      "keywords",
      "creator",
      "producer",
    ] as const) {
      const value = o.values[key].trim();
      if (value) {
        doc.setMetaData(INFO_KEYS[key], value);
      } else {
        // Cleared means gone, not an empty string a reader would still show.
        dig(doc.getTrailer(), "Info")?.delete(
          INFO_KEYS[key].slice("info:".length)
        );
      }
    }
    if (o.touch) {
      doc.setMetaData(INFO_KEYS.modified, pdfDate(new Date()));
    }
    const root = doc.getTrailer().get("Root");
    if (o.values.language.trim()) {
      root.put("Lang", doc.newString(o.values.language.trim()));
    } else {
      root.delete("Lang");
    }
    // An XMP packet would contradict the new values; readers prefer it when present.
    root.delete("Metadata");
    return savePdf(doc);
  } finally {
    doc.destroy();
  }
};

/** Copy the document information of `src` to `dst`, key by key: a trailer cannot be written to directly. */
export const copyMetadata = (src: PDFDocument, dst: PDFDocument) => {
  for (const key of Object.values(INFO_KEYS)) {
    const value = src.getMetaData(key);
    if (value) {
      dst.setMetaData(key, value);
    }
  }
};

/* ---------------- structure ---------------- */

export interface ValidateReport {
  qpdf: { ok: boolean; lines: string[] };
  mupdf: { repaired: boolean; warnings: string[] };
}

export const validate = (env: Env, bytes: Uint8Array): ValidateReport => {
  const input = "/in/check.pdf";
  env.qpdf.write(input, bytes);
  let check;
  try {
    check = env.qpdf.exec(["--check", input]);
  } finally {
    env.qpdf.remove(input);
  }
  env.warnings.length = 0;
  let repaired = false;
  try {
    const doc = openPdf(env, bytes);
    repaired = doc.wasRepaired();
    const n = doc.countPages();
    for (let i = 0; i < n; i += 1) {
      // Interpreting the page's content is where broken content shows.
      doc.loadPage(i).toStructuredText("").destroy();
    }
    doc.destroy();
  } catch (error) {
    env.warnings.push((error as Error).message);
  }
  return {
    mupdf: { repaired, warnings: [...new Set(env.warnings)] },
    qpdf: {
      lines: [...check.out, ...check.err].filter((l) => l.trim() !== ""),
      ok: check.code === 0,
    },
  };
};

/** A clean rewrite by MuPDF, which reads damaged files leniently. */
export const repair = (
  env: Env,
  bytes: Uint8Array
): { bytes: Uint8Array; repaired: boolean; warnings: string[] } => {
  env.warnings.length = 0;
  const doc = openPdf(env, bytes);
  try {
    const repaired = doc.wasRepaired();
    return {
      bytes: savePdf(doc),
      repaired,
      warnings: [...new Set(env.warnings)],
    };
  } finally {
    doc.destroy();
  }
};

export const linearize = (env: Env, bytes: Uint8Array): Uint8Array => {
  const input = "/in/linearize.pdf";
  const output = "/out/linearize.pdf";
  return env.qpdf.produce(
    "Could not linearize the PDF",
    { [input]: bytes },
    [input, "--linearize", output],
    output
  ).bytes;
};
