// Files embedded in a PDF: the document-level ones (the EmbeddedFiles name
// tree, which readers list as attachments) and the ones pinned to a page as
// annotations. Listed, saved out, added, and removed.

import type { PDFDocument, PDFObject } from "mupdf";

import { openPdf, savePdf } from "./doc";
import type { Env, OutFile } from "./doc";
import { textOf } from "./objects";

export interface AttachmentInfo {
  /** The name it is stored under; what Remove and Save take. */
  key: string;
  filename: string;
  mime: string;
  bytes: number;
  description: string;
  modified: string | null;
  /** 1-based page, for one pinned to a page; null for a document attachment. */
  page: number | null;
}

const describe = (
  doc: PDFDocument,
  key: string,
  spec: PDFObject,
  page: number | null
): AttachmentInfo => {
  let params: ReturnType<PDFDocument["getFilespecParams"]> | null = null;
  try {
    params = doc.getFilespecParams(spec);
  } catch {
    params = null;
  }
  const contents = doc.getEmbeddedFileContents(spec);
  const modified = params?.modificationDate;
  return {
    bytes: contents?.getLength() ?? 0,
    description: textOf(spec.resolve().get("Desc")),
    filename: params?.filename || key,
    key,
    mime: params?.mimetype ?? "",
    modified:
      modified && !Number.isNaN(modified.getTime())
        ? modified.toISOString()
        : null,
    page,
  };
};

/** Every embedded file with the filespec it is read from. */
const allFiles = (
  doc: PDFDocument
): { info: AttachmentInfo; spec: PDFObject }[] => {
  const out: { info: AttachmentInfo; spec: PDFObject }[] = [];
  for (const [key, spec] of Object.entries(doc.getEmbeddedFiles())) {
    out.push({ info: describe(doc, key, spec, null), spec });
  }
  const n = doc.countPages();
  for (let i = 0; i < n; i += 1) {
    for (const [j, a] of doc.loadPage(i).getAnnotations().entries()) {
      if (a.getType() === "FileAttachment" && a.hasFilespec()) {
        const spec = a.getFileSpec();
        out.push({ info: describe(doc, `page:${i}:${j}`, spec, i + 1), spec });
      }
    }
  }
  return out;
};

export const listAttachments = (doc: PDFDocument): AttachmentInfo[] =>
  allFiles(doc).map((f) => f.info);

export const extractAttachments = (
  env: Env,
  bytes: Uint8Array,
  keys: string[]
): OutFile[] => {
  const doc = openPdf(env, bytes);
  try {
    const wanted = new Set(keys);
    const out: OutFile[] = [];
    for (const { info, spec } of allFiles(doc)) {
      if (wanted.has(info.key)) {
        const contents = doc.getEmbeddedFileContents(spec);
        out.push({
          bytes: new Uint8Array(contents?.asUint8Array() ?? []),
          mime: info.mime || "application/octet-stream",
          name: info.filename,
        });
      }
    }
    return out;
  } finally {
    doc.destroy();
  }
};

export interface AttachOptions {
  add: { name: string; mime: string; bytes: Uint8Array; modified: number }[];
  /** Keys of document attachments to remove, and of page ones (their annotation goes). */
  remove: string[];
}

export const editAttachments = (
  env: Env,
  bytes: Uint8Array,
  o: AttachOptions
): Uint8Array => {
  const doc = openPdf(env, bytes);
  try {
    const removing = new Set(o.remove);
    for (const key of removing) {
      const pinned = /^page:(?<p>\d+):(?<i>\d+)$/u.exec(key)?.groups;
      if (!pinned) {
        doc.deleteEmbeddedFile(key);
      }
    }
    // Page ones by index, highest first, so earlier removals do not move later ones.
    const pinnedKeys = [...removing]
      .map((k) => /^page:(?<p>\d+):(?<i>\d+)$/u.exec(k)?.groups)
      .filter((g) => g !== undefined)
      .map((g) => [Number(g.p), Number(g.i)] as const)
      .toSorted((a, b) => a[0] - b[0] || b[1] - a[1]);
    for (const [p, i] of pinnedKeys) {
      const page = doc.loadPage(p);
      const annot = page.getAnnotations()[i];
      if (annot) {
        page.deleteAnnotation(annot);
      }
    }
    const taken = new Set(Object.keys(doc.getEmbeddedFiles()));
    for (const f of o.add) {
      let { name } = f;
      for (let n = 2; taken.has(name); n += 1) {
        const dot = f.name.lastIndexOf(".");
        name =
          dot > 0
            ? `${f.name.slice(0, dot)} (${n})${f.name.slice(dot)}`
            : `${f.name} (${n})`;
      }
      taken.add(name);
      const when = new Date(f.modified);
      const spec = doc.addEmbeddedFile(
        name,
        f.mime || "application/octet-stream",
        f.bytes,
        when,
        when
      );
      doc.insertEmbeddedFile(name, spec);
    }
    return savePdf(env, doc);
  } finally {
    doc.destroy();
  }
};
