// The PDF worker. MuPDF and qpdf are synchronous WebAssembly and block the
// thread they run on, so they live here, and the Tool talks to them by
// message: one request, one reply, each with an id. Built as its own bundle
// by build.ts and spawned from a data: URL, which works from file://.
//
// The worker keeps every document it has been given or has made, by id:
// the Sources, the Current Document assembled from them, and Results. The
// main thread keeps a copy of each too, so a worker thrown away to cancel a
// long Operation can be given them again.

import type { PDFDocument } from "mupdf";

import { scriptDataUrl } from "../../shared/script-url";
import { loadMupdf } from "./engine/load";
import type { MupdfModule } from "./engine/load";
import { Qpdf, QpdfError, isPasswordError } from "./engine/qpdf";
import { OPS } from "./ops";
import type { OpName, OpOptions } from "./ops";
import { selectText } from "./pdf/annotate";
import { assemble, isIdentity } from "./pdf/assemble";
import type { AssemblySource, PageRef } from "./pdf/assemble";
import { toPdf } from "./pdf/convert";
import type { Env, OutFile } from "./pdf/doc";
import type { Point } from "./pdf/geometry";
import { imagesToPdf } from "./pdf/images";
import type { ImagePagesOptions } from "./pdf/images";
import { readOutline } from "./pdf/outline";
import type { Bookmark } from "./pdf/outline";
import { unlock } from "./pdf/security";
import { hasText } from "./pdf/text";
import type { Quad } from "./pdf/text";

export interface PageSize {
  w: number;
  h: number;
}

/** A document the worker holds. */
export interface DocInfo {
  id: string;
  pages: PageSize[];
  size: number;
}

export type OpenResult =
  | {
      status: "ok";
      doc: DocInfo;
      /** The bytes the worker keeps: decrypted, or converted to PDF. */
      bytes: Uint8Array;
      /** The file had a password or restrictions; the copy kept has neither. */
      encrypted: boolean;
      /** What the file did not allow, before it was unlocked. */
      restrictions: string[];
      repaired: boolean;
      outline: Bookmark[];
    }
  | { status: "password" | "wrong-password" };

export interface RunResult {
  doc?: DocInfo & { bytes: Uint8Array };
  files?: OutFile[];
  report?: unknown;
}

export interface Rendered {
  width: number;
  height: number;
  /** RGBA, as an ImageData wants it. */
  pixels: Uint8ClampedArray<ArrayBuffer>;
}

/** A file as it was opened, encrypted, and the password that opened it. */
export interface Original {
  bytes: Uint8Array;
  password: string;
}

interface Held {
  bytes: Uint8Array;
  /** The file as opened, when `bytes` differ from it (it was decrypted): its signatures are over these. */
  original: Original | null;
  doc: PDFDocument | null;
  /** Where qpdf has it, once it has been written there. */
  path: string | null;
  outline: Bookmark[] | null;
  name: string;
}

let mupdf: MupdfModule | null = null;
let env: Env | null = null;
const held = new Map<string, Held>();
/** Ids name the worker too: one started after Cancel never reuses an id the Tool may still hold. */
let idPrefix = "d";
let nextId = 1;

const ready = (): Env => {
  if (!env) {
    throw new Error("The engines are not loaded.");
  }
  return env;
};

const entry = (id: string): Held => {
  const h = held.get(id);
  if (!h) {
    throw new Error(`The document ${id} is gone.`);
  }
  return h;
};

const opened = (h: Held): PDFDocument => {
  if (!h.doc) {
    const doc = ready()
      .mupdf.Document.openDocument(h.bytes, "application/pdf")
      .asPDF();
    if (!doc) {
      throw new Error("Not a PDF.");
    }
    h.doc = doc;
  }
  return h.doc;
};

const sizes = (doc: PDFDocument): PageSize[] => {
  const out: PageSize[] = [];
  const n = doc.countPages();
  for (let i = 0; i < n; i += 1) {
    const [x0, y0, x1, y1] = doc.loadPage(i).getBounds();
    out.push({ h: y1 - y0, w: x1 - x0 });
  }
  return out;
};

/** Keep `bytes` under a new id. */
const hold = (
  bytes: Uint8Array,
  name: string,
  doc: PDFDocument | null = null,
  original: Original | null = null
): DocInfo => {
  const id = `${idPrefix}${nextId}`;
  nextId += 1;
  const h: Held = { bytes, doc, name, original, outline: null, path: null };
  held.set(id, h);
  return { id, pages: sizes(opened(h)), size: bytes.length };
};

/** Assemble with qpdf, writing each Source into its filesystem the first time. */
const assembleBytes = (pages: PageRef[]): Uint8Array => {
  const e = ready();
  const sources = new Map<string, AssemblySource>();
  for (const id of new Set(pages.map((p) => p.src))) {
    const h = entry(id);
    if (!h.path) {
      h.path = `/src/${id}.pdf`;
      e.qpdf.write(h.path, h.bytes);
    }
    h.outline ??= readOutline(opened(h));
    sources.set(id, { name: h.name, outline: h.outline, path: h.path });
  }
  return assemble(e, pages, sources);
};

const PERMISSIONS = [
  ["print", "printing"],
  ["copy", "copying text"],
  ["edit", "editing"],
  ["annotate", "comments"],
  ["form", "filling in forms"],
  ["assemble", "changing pages"],
] as const;

const methods = {
  /** Take a document the main thread already has (after the worker was restarted). */
  adopt(bytes: Uint8Array, name: string, original: Original | null): DocInfo {
    const info = hold(bytes, name, null, original);
    entry(info.id).outline = readOutline(opened(entry(info.id)));
    return info;
  },

  /** The Page List as one PDF, kept: the first Source itself when nothing about it changed. */
  assemble(pages: PageRef[]): DocInfo {
    const [first] = pages;
    if (!first) {
      throw new Error("There are no pages.");
    }
    const firstDoc = opened(entry(first.src));
    if (isIdentity(pages, firstDoc.countPages())) {
      return {
        id: first.src,
        pages: sizes(firstDoc),
        size: entry(first.src).bytes.length,
      };
    }
    return hold(assembleBytes(pages), entry(first.src).name);
  },

  /** A blank page of the given size, as a document of its own: what the Page List inserts. */
  blank(w: number, h: number): DocInfo {
    const e = ready();
    const doc = new e.mupdf.PDFDocument();
    doc.insertPage(-1, doc.addPage([0, 0, w, h], 0, {}, ""));
    const bytes = new Uint8Array(doc.saveToBuffer("").asUint8Array());
    doc.destroy();
    return hold(bytes, "blank");
  },

  close(id: string) {
    const h = held.get(id);
    if (!h) {
      return;
    }
    h.doc?.destroy();
    if (h.path) {
      env?.qpdf.remove(h.path);
    }
    held.delete(id);
  },

  /** An EPUB, comic book, or other document MuPDF lays out, as a PDF. */
  convert(bytes: Uint8Array, kind: string, name: string): OpenResult {
    return methods.open(toPdf(ready(), bytes, kind), null, name);
  },

  /** The Page List (or part of it) as one PDF's bytes, not kept: what Extract downloads. */
  extract(pages: PageRef[]): Uint8Array {
    return assembleBytes(pages);
  },

  /** Images made into pages, one each. */
  images(
    images: Uint8Array[],
    options: ImagePagesOptions,
    name: string
  ): OpenResult {
    return methods.open(imagesToPdf(ready(), images, options), null, name);
  },

  /** How much of each page is ink, 0..1, from a small rendering; and whether it has text. */
  ink(id: string): { ink: number; text: boolean }[] {
    const e = ready();
    const doc = opened(entry(id));
    const out: { ink: number; text: boolean }[] = [];
    const n = doc.countPages();
    for (let i = 0; i < n; i += 1) {
      const page = doc.loadPage(i);
      const pix = page.toPixmap(
        [0.25, 0, 0, 0.25, 0, 0],
        e.mupdf.ColorSpace.DeviceGray,
        false,
        true
      );
      const px = pix.getPixels();
      let dark = 0;
      for (const v of px) {
        if (v < 230) {
          dark += 1;
        }
      }
      out.push({ ink: px.length ? dark / px.length : 0, text: hasText(page) });
      pix.destroy();
    }
    return out;
  },

  /** Start both engines from their files; `generation` counts the workers the Tool has started. */
  async load(
    files: {
      mupdfLib: string;
      mupdfGlue: string;
      mupdfWasm: ArrayBuffer;
      qpdfGlue: string;
      qpdfWasm: ArrayBuffer;
    },
    generation: number
  ) {
    if (env) {
      return;
    }
    idPrefix = `w${generation}d`;
    mupdf = await loadMupdf(
      files.mupdfLib,
      files.mupdfGlue,
      files.mupdfWasm,
      scriptDataUrl
    );
    const qpdf = await Qpdf.create(
      files.qpdfGlue,
      files.qpdfWasm,
      scriptDataUrl
    );
    const warnings: string[] = [];
    mupdf.setLog({
      error: (m: string) => warnings.push(m),
      warning: (m: string) => warnings.push(m),
    } as never);
    env = { mupdf, qpdf, warnings };
  },

  /** Open a PDF, unlocking it with `password` if it has one; the copy kept is never encrypted. */
  open(bytes: Uint8Array, password: string | null, name: string): OpenResult {
    const e = ready();
    e.warnings.length = 0;
    const first = e.mupdf.Document.openDocument(bytes, "application/pdf");
    const doc = first.asPDF();
    if (!doc) {
      first.destroy();
      throw new Error("This is not a PDF MuPDF can read.");
    }
    if (doc.needsPassword()) {
      if (password === null) {
        doc.destroy();
        return { status: "password" };
      }
      if (doc.authenticatePassword(password) === 0) {
        doc.destroy();
        return { status: "wrong-password" };
      }
    }
    const encrypted = (doc.getMetaData("encryption") ?? "None") !== "None";
    const restrictions = PERMISSIONS.filter(([p]) => !doc.hasPermission(p)).map(
      ([, label]) => label
    );
    const repaired = doc.wasRepaired();
    let kept = bytes;
    let keptDoc: PDFDocument = doc;
    if (encrypted) {
      doc.destroy();
      try {
        kept = unlock(e, bytes, password ?? "");
      } catch (error) {
        if (error instanceof QpdfError && isPasswordError(error.run)) {
          return { status: "wrong-password" };
        }
        throw error;
      }
      const plain = e.mupdf.Document.openDocument(
        kept,
        "application/pdf"
      ).asPDF();
      if (!plain) {
        throw new Error("The unlocked PDF could not be read.");
      }
      keptDoc = plain;
    }
    const info = hold(
      kept,
      name,
      keptDoc,
      encrypted ? { bytes, password: password ?? "" } : null
    );
    const h = entry(info.id);
    h.outline = readOutline(keptDoc);
    // A copy: the reply hands its buffers over, and the worker keeps its own.
    return {
      bytes: new Uint8Array(kept),
      doc: info,
      encrypted,
      outline: h.outline,
      repaired,
      restrictions,
      status: "ok",
    };
  },

  /** A page as PNG, for OCR. */
  png(id: string, index: number, scale: number): Uint8Array {
    const page = opened(entry(id)).loadPage(index);
    const pix = page.toPixmap(
      [scale, 0, 0, scale, 0, 0],
      ready().mupdf.ColorSpace.DeviceRGB,
      false,
      true
    );
    try {
      pix.setResolution(Math.round(72 * scale), Math.round(72 * scale));
      return new Uint8Array(pix.asPNG());
    } finally {
      pix.destroy();
    }
  },

  /** A copy of a document's bytes. */
  read(id: string): Uint8Array {
    return new Uint8Array(entry(id).bytes);
  },

  render(id: string, index: number, scale: number): Rendered {
    const page = opened(entry(id)).loadPage(index);
    const pix = page.toPixmap(
      [scale, 0, 0, scale, 0, 0],
      ready().mupdf.ColorSpace.DeviceRGB,
      false,
      true
    );
    try {
      const width = pix.getWidth();
      const height = pix.getHeight();
      const stride = pix.getStride();
      const rgb = pix.getPixels();
      const pixels = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y += 1) {
        let src = y * stride;
        let dst = y * width * 4;
        for (let x = 0; x < width; x += 1) {
          pixels[dst] = rgb[src] ?? 255;
          pixels[dst + 1] = rgb[src + 1] ?? 255;
          pixels[dst + 2] = rgb[src + 2] ?? 255;
          pixels[dst + 3] = 255;
          src += 3;
          dst += 4;
        }
      }
      return { height, pixels, width };
    } finally {
      pix.destroy();
    }
  },

  async run<K extends OpName>(
    op: K,
    id: string,
    options: OpOptions<K>
  ): Promise<RunResult> {
    const e = ready();
    e.warnings.length = 0;
    const h = entry(id);
    const fn = OPS[op] as (
      env: Env,
      bytes: Uint8Array,
      o: OpOptions<K>
    ) => ReturnType<(typeof OPS)[K]>;
    // Signatures are over the file as it was signed: an encrypted one as opened, not the decrypted copy kept.
    const signedFile = op === "verify" ? h.original : null;
    const out = (await fn(
      e,
      signedFile?.bytes ?? h.bytes,
      signedFile ? { ...options, password: signedFile.password } : options
    )) as {
      bytes?: Uint8Array;
      files?: OutFile[];
      report?: unknown;
    };
    const result: RunResult = { files: out.files, report: out.report };
    if (out.bytes) {
      const info = hold(out.bytes, h.name);
      result.doc = { ...info, bytes: new Uint8Array(out.bytes) };
    }
    return result;
  },

  /** The text a drag from `from` to `to` selects, as quads. */
  select(id: string, page: number, from: Point, to: Point): Quad[] {
    return selectText(opened(entry(id)).loadPage(page), from, to);
  },

  /** Whether each page has text to select. */
  textPages(id: string): boolean[] {
    const doc = opened(entry(id));
    const out: boolean[] = [];
    const n = doc.countPages();
    for (let i = 0; i < n; i += 1) {
      out.push(hasText(doc.loadPage(i)));
    }
    return out;
  },

  /** Each page's plain text. */
  texts(id: string): string[] {
    const doc = opened(entry(id));
    const out: string[] = [];
    const n = doc.countPages();
    for (let i = 0; i < n; i += 1) {
      const stext = doc.loadPage(i).toStructuredText("preserve-whitespace");
      out.push(stext.asText());
      stext.destroy();
    }
    return out;
  },
};

export type Methods = typeof methods;
export type MethodName = keyof Methods;

export interface WorkerRequest {
  id: number;
  method: MethodName;
  args: unknown[];
}
export type WorkerResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; message: string };

/** Every ArrayBuffer in a value, to hand over rather than copy. */
const buffersIn = (
  value: unknown,
  out = new Set<ArrayBuffer>(),
  depth = 0
): ArrayBuffer[] => {
  if (depth > 6 || value === null || typeof value !== "object") {
    return [...out];
  }
  if (ArrayBuffer.isView(value)) {
    if (value.buffer instanceof ArrayBuffer) {
      out.add(value.buffer);
    }
    return [...out];
  }
  for (const v of Array.isArray(value) ? value : Object.values(value)) {
    buffersIn(v, out, depth + 1);
  }
  return [...out];
};

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const { id, method, args } = ev.data;
  try {
    const fn = methods[method] as (...a: unknown[]) => unknown;
    const value = await fn(...args);
    // Everything a reply carries was made for it, so it can be handed over.
    self.postMessage({ id, ok: true, value } satisfies WorkerResponse, {
      transfer: buffersIn(value),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    self.postMessage({ id, message, ok: false } satisfies WorkerResponse, {
      transfer: [],
    });
  }
};
