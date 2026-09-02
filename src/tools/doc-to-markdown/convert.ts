// One conversion, end to end: decide what the Document is, fetch the engines
// it needs, run them, and assemble the Markdown. Office documents go to the
// converter in the worker; PDFs are read page by page, text pages converted
// structurally and Scanned Pages rendered and recognized; images go straight to
// OCR. Everything here reports progress by phase and stops on cancel.

import { createWorker, type Worker as TessWorker } from "tesseract.js";
import { detect, type ImageFormat, type OfficeFormat } from "./detect";
import { ENGINES, getEngine, languageAsset, pdfjsAsset, type EngineAsset, type Progress } from "./engines";
import { languageName } from "./languages";
import { gateByConfidence, ocrBody, ocrMarkdown, type OcrLine, type OcrParagraph } from "./ocr-text";
import { joinPages, markPage, paragraphsFromTextItems, splitByMarkers, type TextItem } from "./pages";
import { scriptBlobUrl, scriptDataUrl } from "./script-url";
import { ConvertError, ConvertWorker } from "./worker-client";

export interface Phase {
  text: string;
  /** 0..1 when measurable, null for an indeterminate sweep. */
  fraction: number | null;
}

export interface ConvertOptions {
  languages: string[];
  /** Page Markers: announce every PDF page (and an OCR'd image) with a comment. */
  pageMarkers: boolean;
  onPhase(p: Phase): void;
}

export interface ConvertOutcome {
  markdown: string;
  /** What the pane head says: format, page counts, OCR languages. */
  summary: string;
  /** A remark worth showing above the result, if any. */
  note?: string;
}

const CANCELLED = "The conversion was cancelled.";

/** Rendering resolution for OCR: 300 dpi, capped so a poster page does not exhaust memory. */
const OCR_DPI = 300;
const OCR_MAX_EDGE = 4000;

function formatBytes(n: number) {
  return n < 1024 * 1024 ? (n / 1024).toFixed(0) + " KB" : (n / 1024 / 1024).toFixed(1) + " MB";
}

const FORMAT_NAMES: Record<OfficeFormat, string> = {
  doc: "Word", docx: "Word", odt: "OpenDocument text", pdf: "PDF", ppt: "PowerPoint", pptx: "PowerPoint",
  rtf: "RTF", epub: "EPUB", xlsx: "Excel", ods: "OpenDocument spreadsheet", odp: "OpenDocument presentation", csv: "CSV",
};

/* ---------------- the run in progress ---------------- */

interface Run {
  signal: AbortSignal;
  abort: AbortController;
  onPhase(p: Phase): void;
}

let active: Run | null = null;
let convertWorker: ConvertWorker | null = null;
let tess: { key: string; worker: TessWorker } | null = null;

/** Stop whatever is running. Engines already cached stay cached; the workers are thrown away and respawned next time. */
export function cancelConversion() {
  const run = active;
  if (!run) return;
  active = null;
  run.abort.abort();
  convertWorker?.terminate();
  convertWorker = null;
  if (tess) {
    // A hard terminate is the only way to interrupt a synchronous recognize.
    tess.worker.terminate();
    tess = null;
  }
}

function checkCancelled(run: Run) {
  if (run.signal.aborted) throw new Error(CANCELLED);
}

/** Fetch one engine with the phase line following its download. */
async function engine(run: Run, asset: EngineAsset): Promise<ArrayBuffer> {
  const onProgress = (p: Progress) => {
    if (p.fromCache) return;
    run.onPhase({ text: `Downloading ${p.asset.label} (${formatBytes(p.loaded)} of ${formatBytes(p.total)})`, fraction: p.total ? p.loaded / p.total : null });
  };
  const bytes = await getEngine(asset, (p) => {
    if (active === run) onProgress(p);
  });
  checkCancelled(run);
  return bytes;
}

async function engineText(run: Run, asset: EngineAsset): Promise<string> {
  return new TextDecoder().decode(await engine(run, asset));
}

/* ---------------- converter worker ---------------- */

async function converter(run: Run, which: "anydoc" | "pdf-inspector"): Promise<ConvertWorker> {
  if (!convertWorker) convertWorker = new ConvertWorker();
  const w = convertWorker;
  if (!w.loaded.has(which)) {
    const [glue, wasm] = which === "anydoc"
      ? [await engineText(run, ENGINES.anydocJs), await engine(run, ENGINES.anydocWasm)]
      : [await engineText(run, ENGINES.pdfInspectorJs), await engine(run, ENGINES.pdfInspectorWasm)];
    run.onPhase({ text: "Starting " + which, fraction: null });
    await w.load(which, glue, wasm);
    checkCancelled(run);
  }
  return w;
}

function explain(e: unknown): Error {
  if (e instanceof ConvertError) {
    switch (e.code) {
      case "encrypted": return new Error("The document is password protected; remove the password first.");
      case "malformed": return new Error("The file is damaged or not what its extension says: " + e.message);
      case "unsupported": return new Error("Unsupported content: " + e.message);
      case "resourceLimit": return new Error("The document is too large for the converter: " + e.message);
    }
    return new Error(e.message);
  }
  if (e instanceof Error) {
    if (/encrypted/i.test(e.message)) return new Error("The PDF is password protected; remove the password first.");
    return e;
  }
  return new Error(String(e));
}

/* ---------------- tesseract ---------------- */

const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
const hasSimd = (() => {
  try {
    return WebAssembly.validate(SIMD_PROBE);
  } catch {
    return false;
  }
})();

/**
 * tesseract.js 7.0.0 reads `l.data` where it means `l.code` when languages are
 * given as bytes (upstream PR #1052). The worker script is ours to patch; a
 * release that has fixed it simply has nothing to replace.
 */
function patchTesseractWorker(src: string): string {
  return src.replace('"string"==typeof t?t:t.data', '"string"==typeof t?t:t.code');
}

async function ocrWorker(run: Run, languages: string[]): Promise<TessWorker> {
  const key = languages.join("+");
  if (tess && tess.key === key) return tess.worker;
  if (tess) {
    tess.worker.terminate();
    tess = null;
  }
  const workerSrc = patchTesseractWorker(await engineText(run, ENGINES.tesseractWorker));
  const coreSrc = await engineText(run, hasSimd ? ENGINES.tesseractCore : ENGINES.tesseractCoreNoSimd);
  const models: { code: string; data: Uint8Array }[] = [];
  for (const code of languages) {
    models.push({ code, data: new Uint8Array(await engine(run, languageAsset(code))) });
  }
  run.onPhase({ text: "Starting OCR (" + languages.map(languageName).join(", ") + ")", fraction: null });

  // One classic worker that first defines TesseractCore from the single-file
  // core build, then runs the worker script; with the core global already
  // present, the script never consults corePath. tesseract.js spawns the
  // worker itself and messages it at once, so the bootstrap must import
  // synchronously with both URLs embedded: a blob: URL (see script-url.ts).
  // The core writes its complaints about unreadable input ("Line cannot be
  // recognized!!") to stderr, which Emscripten maps to console.error; on a
  // figure page that is expected, not an error, so route it to a warning.
  const bootUrl = scriptBlobUrl(
    `importScripts(${JSON.stringify(scriptDataUrl(coreSrc))}, ${JSON.stringify(scriptDataUrl(workerSrc))});
    const core = TesseractCore;
    TesseractCore = (m = {}) => core({ printErr: (s) => console.warn("tesseract: " + s), ...m });`,
  );
  let failed: ((e: Error) => void) | null = null;
  const failure = new Promise<never>((_, reject) => (failed = reject));
  try {
    const worker = await Promise.race([
      createWorker(models as unknown as string[], 1, {
        workerPath: bootUrl,
        workerBlobURL: false,
        cacheMethod: "none",
        errorHandler: (e: unknown) => failed?.(new Error("OCR could not start: " + (e instanceof Error ? e.message : String(e)))),
      }),
      failure,
    ]);
    checkCancelled(run);
    tess = { key, worker };
    return worker;
  } finally {
    URL.revokeObjectURL(bootUrl);
  }
}

interface TessBlocks {
  blocks?: { paragraphs: { lines: { text: string; confidence: number }[] }[] }[] | null;
  text: string;
}

/** Recognize one image; resolves to the confident paragraphs of lines. Cancel terminates the worker, so race it. */
async function recognize(run: Run, worker: TessWorker, image: HTMLCanvasElement | Uint8Array, label: string): Promise<OcrParagraph[]> {
  run.onPhase({ text: "OCR " + label, fraction: null });
  const cancelled = new Promise<never>((_, reject) => run.signal.addEventListener("abort", () => reject(new Error(CANCELLED)), { once: true }));
  const res = await Promise.race([worker.recognize(image as never, {}, { text: true, blocks: true }), cancelled]);
  checkCancelled(run);
  const data = res.data as unknown as TessBlocks;
  if (!data.blocks) {
    // No layout came back: keep the plain text, ungated, rather than nothing.
    return data.text ? data.text.split(/\n{2,}/).map((p) => p.split("\n")) : [];
  }
  const paragraphs: OcrLine[][] = [];
  for (const b of data.blocks) for (const p of b.paragraphs) paragraphs.push(p.lines.map((l) => ({ text: l.text.replace(/\n$/, ""), confidence: l.confidence })));
  return gateByConfidence(paragraphs);
}

/* ---------------- images ---------------- */

/** Browser-decoded formats go through a canvas (honours EXIF orientation); TIFF cannot, so its bytes go in as they are. */
async function imageInput(bytes: ArrayBuffer, format: ImageFormat): Promise<HTMLCanvasElement | Uint8Array> {
  if (format === "tiff") return new Uint8Array(bytes);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes]));
  } catch {
    return new Uint8Array(bytes);
  }
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas;
}

async function convertImage(run: Run, bytes: ArrayBuffer, format: ImageFormat, languages: string[], markers: boolean): Promise<ConvertOutcome> {
  const worker = await ocrWorker(run, languages);
  const input = await imageInput(bytes, format);
  const paragraphs = await recognize(run, worker, input, "image");
  return {
    markdown: ocrMarkdown(markers ? "image" : null, paragraphs),
    summary: format + " · OCR " + languages.join("+"),
  };
}

/* ---------------- office ---------------- */

async function convertOffice(run: Run, bytes: ArrayBuffer, format: OfficeFormat): Promise<ConvertOutcome> {
  const w = await converter(run, "anydoc");
  run.onPhase({ text: "Converting " + FORMAT_NAMES[format], fraction: null });
  let markdown: string;
  try {
    markdown = await w.office(bytes, format);
  } catch (e) {
    throw explain(e);
  }
  checkCancelled(run);
  if (!markdown.endsWith("\n")) markdown += "\n";
  return { markdown, summary: FORMAT_NAMES[format] };
}

/* ---------------- pdf ---------------- */

interface PdfJs {
  PDFWorker: new (o: { port: MessagePort }) => { destroy(): void };
  getDocument(params: object): { promise: Promise<PdfDocument>; destroy(): Promise<void> };
}
interface PdfDocument {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
}
interface PdfPage {
  getViewport(o: { scale: number }): { width: number; height: number };
  getTextContent(): Promise<{ items: (TextItem | { type: string })[] }>;
  render(o: { canvas: HTMLCanvasElement; canvasContext: CanvasRenderingContext2D; viewport: unknown }): { promise: Promise<void> };
  cleanup(): void;
}

let pdfjsModule: Promise<{ lib: PdfJs; workerUrl: string }> | null = null;

/** The pdf.js library, imported once, plus the data: URL its worker is imported from per document. */
function pdfjs(run: Run): Promise<{ lib: PdfJs; workerUrl: string }> {
  if (pdfjsModule) return pdfjsModule;
  const p = (async () => {
    const lib = await engineText(run, ENGINES.pdfjs);
    const worker = await engineText(run, ENGINES.pdfjsWorker);
    const url = scriptBlobUrl(lib);
    try {
      return { lib: (await import(url)) as PdfJs, workerUrl: scriptDataUrl(worker) };
    } finally {
      URL.revokeObjectURL(url);
    }
  })();
  pdfjsModule = p;
  p.catch(() => (pdfjsModule = null));
  return p;
}

/**
 * pdf.js's own worker spawning fails from file:// (module worker from a blob:
 * URL), so the worker is spawned here from a small data: bootstrap that
 * imports the real script from a data: URL and binds it to one end of a
 * MessageChannel; pdf.js gets the other end.
 */
const PDF_BOOT = `self.onmessage = async (e) => {
  const { url, port } = e.data;
  const m = await import(url);
  m.WorkerMessageHandler.initializeFromPort(port);
  port.start();
};`;

function spawnPdfWorker(lib: PdfJs, workerUrl: string) {
  const worker = new Worker(scriptDataUrl(PDF_BOOT), { type: "module" });
  const channel = new MessageChannel();
  worker.postMessage({ url: workerUrl, port: channel.port2 }, [channel.port2]);
  const pdfWorker = new lib.PDFWorker({ port: channel.port1 });
  channel.port1.start();
  return {
    pdfWorker,
    terminate() {
      pdfWorker.destroy();
      worker.terminate();
      channel.port1.close();
    },
  };
}

/** Serves pdf.js the decoders, CMaps and fonts it asks for by name, through the engine cache. */
function binaryDataFactory(run: Run) {
  return class {
    async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
      const asset = pdfjsAsset(kind, filename);
      if (!asset) throw new Error("pdf.js asked for an unknown file: " + kind + "/" + filename);
      return new Uint8Array(await engine(run, asset));
    }
  };
}

function isTextItem(it: TextItem | { type: string }): it is TextItem {
  return "str" in it;
}

/**
 * Page Markers on an accepted PDF. The converter gives one Markdown string
 * with no page boundaries, so the text is taken again from pdf-inspector,
 * the same engine with markers switched on, and every page is announced,
 * including the ones with nothing on them. If pdf-inspector has no Markdown
 * for the document, the converter's unmarked text stands.
 */
async function markAcceptedPdf(run: Run, bytes: ArrayBuffer, unmarked: string): Promise<ConvertOutcome> {
  const inspector = await converter(run, "pdf-inspector");
  run.onPhase({ text: "Marking pages", fraction: null });
  let result;
  try {
    result = await inspector.pdf(bytes.slice(0));
  } catch (e) {
    throw explain(e);
  }
  checkCancelled(run);
  const total = result.pageCount;
  const summary = `PDF · ${total} page${total === 1 ? "" : "s"}`;
  if (!result.markdown) return { markdown: unmarked, summary, note: "Page markers are not available for this PDF." };
  const byPage = splitByMarkers(result.markdown);
  const segments = Array.from({ length: total }, (_, i) => ({ page: i + 1, markdown: markPage(i + 1, "text", byPage.get(i + 1) ?? "", true) }));
  return { markdown: joinPages(segments), summary };
}

/**
 * A PDF goes to the converter first, like any office document, and its
 * verdict is final: a PDF it accepts has no Scanned Pages, whatever a middle
 * page looks like, so OCR never runs on it and pdf.js is never loaded. Only
 * when it refuses with the pages that need OCR are those pages rendered and
 * recognized, the rest converted structurally, and both spliced in page
 * order.
 */
async function convertPdf(run: Run, bytes: ArrayBuffer, languages: string[], markers: boolean): Promise<ConvertOutcome> {
  const w = await converter(run, "anydoc");
  run.onPhase({ text: "Converting PDF", fraction: null });
  let refusal: ConvertError;
  try {
    let markdown = await w.office(bytes.slice(0), "pdf");
    checkCancelled(run);
    if (!markdown.endsWith("\n")) markdown += "\n";
    if (!markers) return { markdown, summary: "PDF" };
    return await markAcceptedPdf(run, bytes, markdown);
  } catch (e) {
    if (!(e instanceof ConvertError) || e.code !== "needsOcr") throw explain(e);
    refusal = e;
  }
  checkCancelled(run);

  const { lib, workerUrl } = await pdfjs(run);
  run.onPhase({ text: "Opening PDF", fraction: null });
  const spawned = spawnPdfWorker(lib, workerUrl);
  const task = lib.getDocument({ data: new Uint8Array(bytes.slice(0)), worker: spawned.pdfWorker, BinaryDataFactory: binaryDataFactory(run) });
  run.signal.addEventListener("abort", () => spawned.terminate(), { once: true });
  let doc: PdfDocument;
  try {
    doc = await task.promise;
  } catch (e) {
    spawned.terminate();
    throw explain(e);
  }
  checkCancelled(run);

  try {
    const total = doc.numPages;
    // The converter names the Scanned Pages; a refusal without a list means every page.
    const listed = (refusal.pages ?? []).filter((n) => n >= 1 && n <= total);
    const scanned = (listed.length ? [...new Set(listed)] : Array.from({ length: total }, (_, i) => i + 1)).toSorted((a, b) => a - b);
    const scannedSet = new Set(scanned);
    const textPages = Array.from({ length: total }, (_, i) => i + 1).filter((n) => !scannedSet.has(n));

    const segments: { page: number; markdown: string }[] = [];

    if (textPages.length) {
      const inspector = await converter(run, "pdf-inspector");
      run.onPhase({ text: `Converting ${textPages.length} text page${textPages.length === 1 ? "" : "s"}`, fraction: null });
      let result;
      try {
        result = await inspector.pdf(bytes.slice(0), textPages);
      } catch (e) {
        throw explain(e);
      }
      checkCancelled(run);
      const byPage = result.markdown ? splitByMarkers(result.markdown) : new Map<number, string>();
      for (const n of textPages) {
        const md = byPage.get(n);
        if (md !== undefined && md.trim()) {
          segments.push({ page: n, markdown: markPage(n, "text", md, markers) });
        } else {
          // The converter had nothing for a page it did not flag: use the text layer as plain paragraphs.
          const page = await doc.getPage(n);
          const content = await page.getTextContent();
          page.cleanup();
          checkCancelled(run);
          const paragraphs = paragraphsFromTextItems(content.items.filter(isTextItem));
          const body = paragraphs.length ? paragraphs.map((p) => p.join("\n")).join("\n\n") + "\n" : "";
          segments.push({ page: n, markdown: markPage(n, "text", body, markers) });
        }
      }
    }

    const worker = await ocrWorker(run, languages);
    for (let i = 0; i < scanned.length; i++) {
      const n = scanned[i]!;
      run.onPhase({ text: `Rendering page ${n}`, fraction: i / scanned.length });
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.max(1, Math.min(OCR_DPI / 72, OCR_MAX_EDGE / Math.max(base.width, base.height)));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext("2d")!;
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
      page.cleanup();
      checkCancelled(run);
      const paragraphs = await recognize(run, worker, canvas, `page ${n}`);
      canvas.width = canvas.height = 0;
      segments.push({ page: n, markdown: markPage(n, "ocr", ocrBody(paragraphs), markers) });
    }

    const summary = `PDF · ${total} page${total === 1 ? "" : "s"} · ${scanned.length} via OCR (${languages.join("+")})`;
    return { markdown: joinPages(segments), summary };
  } finally {
    task.destroy().catch(() => {}).then(() => spawned.terminate());
  }
}

/* ---------------- entry ---------------- */

export async function convertDocument(bytes: ArrayBuffer, name: string, opts: ConvertOptions): Promise<ConvertOutcome> {
  cancelConversion();
  const abort = new AbortController();
  const run: Run = { abort, signal: abort.signal, onPhase: opts.onPhase };
  active = run;
  try {
    const kind = detect(new Uint8Array(bytes), name);
    if (kind.kind === "unknown") {
      throw new Error(kind.ext
        ? `.${kind.ext} is not a supported format. Word, PowerPoint, Excel, OpenDocument, RTF, EPUB, CSV, PDF, and images are.`
        : "Could not tell what kind of file this is. Give it an extension, or drop a supported document.");
    }
    let out: ConvertOutcome;
    if (kind.kind === "image") out = await convertImage(run, bytes, kind.format, opts.languages, opts.pageMarkers);
    else if (kind.format === "pdf") out = await convertPdf(run, bytes, opts.languages, opts.pageMarkers);
    else out = await convertOffice(run, bytes, kind.format);
    // With markers off, a Document that read as nothing would be a blank pane with no explanation.
    if (!out.markdown.trim() && !out.note) out.note = "No text was found in this document.";
    return out;
  } finally {
    if (active === run) active = null;
  }
}
