// Every Operation the worker can run, by name: what options it takes and
// what it gives back. An Operation takes one PDF (the Current Document) and
// gives back a new PDF, files to download, a report, or several of those.
// The Tool's main thread imports only the types from here; the code runs in
// the worker.

import { annotate, listAnnots } from "./pdf/annotate";
import type { AnnotateOptions } from "./pdf/annotate";
import {
  editAttachments,
  extractAttachments,
  listAttachments,
} from "./pdf/attachments";
import type { AttachOptions } from "./pdf/attachments";
import { openPdf, savePdf } from "./pdf/doc";
import type { Env, OutFile } from "./pdf/doc";
import { findElsewhere } from "./pdf/elsewhere";
import type { Place } from "./pdf/elsewhere";
import { addFields, fillFields, flatten, readFields } from "./pdf/forms";
import type { FillOptions, FlattenOptions, NewField } from "./pdf/forms";
import { compress, extractImages } from "./pdf/images";
import type { CompressOptions, ExtractImagesOptions } from "./pdf/images";
import {
  info,
  linearize,
  readMetadata,
  repair,
  validate,
  writeMetadata,
} from "./pdf/inspect";
import type { MetadataOptions } from "./pdf/inspect";
import {
  booklet,
  crop,
  nup,
  poster,
  scalePages,
  splitSpreads,
  stitch,
} from "./pdf/layout";
import type {
  BookletOptions,
  CropOptions,
  NupOptions,
  PosterOptions,
  ScaleOptions,
  SpreadOptions,
  StitchOptions,
} from "./pdf/layout";
import { addTextLayers } from "./pdf/ocr";
import type { TextLayer } from "./pdf/ocr";
import { readOutline, writeOutline } from "./pdf/outline";
import type { Bookmark } from "./pdf/outline";
import { scanPii } from "./pdf/pii";
import type { PiiKind } from "./pdf/pii";
import {
  protect,
  redact,
  removeSignatures,
  sanitize,
  unlock,
} from "./pdf/security";
import type {
  ProtectOptions,
  RedactOptions,
  SanitizeOptions,
  UnsignOptions,
} from "./pdf/security";
import { verifySignatures } from "./pdf/signatures";
import { split } from "./pdf/split";
import type { Part } from "./pdf/split";
import {
  imageStamp,
  marginText,
  overlay,
  recolor,
  watermark,
} from "./pdf/stamp";
import type {
  ImageStampOptions,
  MarginTextOptions,
  OverlayOptions,
  RecolorOptions,
  WatermarkOptions,
} from "./pdf/stamp";
import { extractText, queryRegExp, search } from "./pdf/text";
import type { SearchOptions } from "./pdf/text";

/** The options of an Operation that takes none. */
export type NoOptions = Record<string, never>;

/** What an Operation gives back. `bytes` is a new PDF. */
export interface OpOutput<R = undefined> {
  bytes?: Uint8Array;
  files?: OutFile[];
  report?: R;
}

/** Read the input once, closing it after: for Operations that only look. */
const reading = <T>(
  env: Env,
  bytes: Uint8Array,
  body: (doc: ReturnType<typeof openPdf>) => T
): T => {
  const doc = openPdf(env, bytes);
  try {
    return body(doc);
  } finally {
    doc.destroy();
  }
};

const pdf = (bytes: Uint8Array): OpOutput => ({ bytes });

export const OPS = {
  addFields: (env: Env, b: Uint8Array, o: { fields: NewField[] }) =>
    pdf(addFields(env, b, o.fields)),
  annotate: (env: Env, b: Uint8Array, o: AnnotateOptions) =>
    pdf(annotate(env, b, o)),
  annotations: (env: Env, b: Uint8Array, _o: NoOptions) => ({
    report: reading(env, b, listAnnots),
  }),
  attachments: (env: Env, b: Uint8Array, _o: NoOptions) => ({
    report: reading(env, b, listAttachments),
  }),
  booklet: (env: Env, b: Uint8Array, o: BookletOptions) =>
    pdf(booklet(env, b, o)),
  compress: (env: Env, b: Uint8Array, o: CompressOptions) =>
    compress(env, b, o),
  crop: (env: Env, b: Uint8Array, o: CropOptions) => pdf(crop(env, b, o)),
  editAttachments: (env: Env, b: Uint8Array, o: AttachOptions) =>
    pdf(editAttachments(env, b, o)),
  /** Where the query appears outside the pages' content: what redaction does not reach. */
  elsewhere: (
    env: Env,
    b: Uint8Array,
    o: { query: string; options: SearchOptions }
  ): OpOutput<{ error: string; places: Place[] }> => {
    const re = queryRegExp(o.query, o.options);
    if (typeof re === "string") {
      return { report: { error: re, places: [] } };
    }
    return {
      report: {
        error: "",
        places: reading(env, b, (doc) => findElsewhere(doc, re)),
      },
    };
  },
  extractAttachments: (env: Env, b: Uint8Array, o: { keys: string[] }) => ({
    files: extractAttachments(env, b, o.keys),
  }),
  extractImages: (env: Env, b: Uint8Array, o: ExtractImagesOptions) => {
    const { files, images, unreadable } = extractImages(env, b, o);
    return { files, report: { images, unreadable } };
  },
  fields: (env: Env, b: Uint8Array, _o: NoOptions) => ({
    report: reading(env, b, readFields),
  }),
  fill: (env: Env, b: Uint8Array, o: FillOptions) => pdf(fillFields(env, b, o)),
  flatten: (env: Env, b: Uint8Array, o: FlattenOptions) =>
    pdf(flatten(env, b, o)),
  info: (env: Env, b: Uint8Array, _o: NoOptions) => ({ report: info(env, b) }),
  // Files, not a document to keep working on: MuPDF would rewrite it, unlinearized.
  linearize: (env: Env, b: Uint8Array, o: { name: string }) => ({
    files: [
      { bytes: linearize(env, b), mime: "application/pdf", name: o.name },
    ],
  }),
  margin: (env: Env, b: Uint8Array, o: MarginTextOptions) =>
    pdf(marginText(env, b, o)),
  metadata: (env: Env, b: Uint8Array, _o: NoOptions) => ({
    report: reading(env, b, readMetadata),
  }),
  nup: (env: Env, b: Uint8Array, o: NupOptions) => pdf(nup(env, b, o)),
  outline: (env: Env, b: Uint8Array, _o: NoOptions) => ({
    report: reading(env, b, readOutline),
  }),
  overlay: (env: Env, b: Uint8Array, o: OverlayOptions) =>
    pdf(overlay(env, b, o)),
  pii: (env: Env, b: Uint8Array, o: { kinds: PiiKind[] }) => ({
    report: reading(env, b, (doc) => scanPii(doc, o.kinds)),
  }),
  poster: (env: Env, b: Uint8Array, o: PosterOptions) => pdf(poster(env, b, o)),
  // Files, not a document to keep working on: nothing here could open it without the password.
  protect: (env: Env, b: Uint8Array, o: ProtectOptions & { name: string }) => ({
    files: [
      { bytes: protect(env, b, o), mime: "application/pdf", name: o.name },
    ],
  }),
  recolor: (env: Env, b: Uint8Array, o: RecolorOptions) =>
    pdf(recolor(env, b, o)),
  redact: (env: Env, b: Uint8Array, o: RedactOptions) => {
    const r = redact(env, b, o);
    return {
      bytes: r.bytes,
      report: { annotations: r.annotations, fields: r.fields },
    };
  },
  repair: (env: Env, b: Uint8Array, _o: NoOptions) => {
    const r = repair(env, b);
    return {
      bytes: r.bytes,
      report: { repaired: r.repaired, warnings: r.warnings },
    };
  },
  sanitize: (env: Env, b: Uint8Array, o: SanitizeOptions) =>
    sanitize(env, b, o),
  scale: (env: Env, b: Uint8Array, o: ScaleOptions) =>
    pdf(scalePages(env, b, o)),
  search: (
    env: Env,
    b: Uint8Array,
    o: { query: string; options: SearchOptions }
  ) => {
    const re = queryRegExp(o.query, o.options);
    if (typeof re === "string") {
      return { report: { error: re, hits: [] } };
    }
    return {
      report: { error: "", hits: reading(env, b, (doc) => search(doc, re)) },
    };
  },
  split: (env: Env, b: Uint8Array, o: { parts: Part[] }) => ({
    files: split(env, b, o.parts),
  }),
  spreads: (env: Env, b: Uint8Array, o: SpreadOptions) =>
    pdf(splitSpreads(env, b, o)),
  stamp: (env: Env, b: Uint8Array, o: ImageStampOptions) =>
    pdf(imageStamp(env, b, o)),
  stitch: (env: Env, b: Uint8Array, o: StitchOptions) => pdf(stitch(env, b, o)),
  text: (env: Env, b: Uint8Array, o: { headings: boolean; name: string }) => {
    const text = reading(env, b, (doc) => extractText(doc, o.headings));
    return {
      files: [
        {
          bytes: new TextEncoder().encode(text),
          mime: "text/plain",
          name: o.name,
        },
      ],
      report: text,
    };
  },
  textLayers: (env: Env, b: Uint8Array, o: { layers: TextLayer[] }) =>
    pdf(addTextLayers(env, b, o.layers)),
  unlock: (env: Env, b: Uint8Array, o: { password: string }) =>
    pdf(unlock(env, b, o.password)),
  unsign: (env: Env, b: Uint8Array, o: UnsignOptions) => {
    const r = removeSignatures(env, b, o);
    return { bytes: r.bytes, report: { count: r.count } };
  },
  validate: (env: Env, b: Uint8Array, _o: NoOptions) => ({
    report: validate(env, b),
  }),
  /** `password` opens a signed file kept as it was, encrypted: the worker supplies it, not the panel. */
  verify: async (env: Env, b: Uint8Array, o: { password?: string }) => {
    const doc = openPdf(env, b, o.password);
    try {
      return { report: await verifySignatures(doc, b) };
    } finally {
      doc.destroy();
    }
  },
  watermark: (env: Env, b: Uint8Array, o: WatermarkOptions) =>
    pdf(watermark(env, b, o)),
  writeMetadata: (env: Env, b: Uint8Array, o: MetadataOptions) =>
    pdf(writeMetadata(env, b, o)),
  writeOutline: (env: Env, b: Uint8Array, o: { items: Bookmark[] }) => {
    const doc = openPdf(env, b);
    try {
      writeOutline(doc, o.items);
      return pdf(savePdf(env, doc));
    } finally {
      doc.destroy();
    }
  },
} satisfies Record<
  string,
  (
    env: Env,
    bytes: Uint8Array,
    options: never
  ) => OpOutput<unknown> | Promise<OpOutput<unknown>>
>;

export type OpName = keyof typeof OPS;
export type OpOptions<K extends OpName> = Parameters<(typeof OPS)[K]>[2];
export type OpReport<K extends OpName> =
  Awaited<ReturnType<(typeof OPS)[K]>> extends { report?: infer R } ? R : never;
