// The conversion worker. The converters are synchronous WebAssembly and block
// whichever thread calls them, so they live here, off the main thread, and the
// Tool talks to them by message. Built as its own bundle by build.ts and
// spawned from a blob: URL, which works from file://.
//
// The main thread fetches engine bytes (through the cache) and posts them in;
// the worker never touches the network itself.

import { scriptDataUrl } from "../../shared/script-url";
import type { OfficeFormat } from "./detect";

export type WorkerRequest =
  | {
      type: "load";
      engine: "anydoc" | "pdf-inspector";
      glue: string;
      wasm: ArrayBuffer;
    }
  | { type: "office"; id: number; bytes: ArrayBuffer; format: OfficeFormat }
  /** `pages` restricts the conversion to those pages; absent means every page. Markers are always requested. */
  | { type: "pdf"; id: number; bytes: ArrayBuffer; pages?: number[] };

export type WorkerResponse =
  | { type: "loaded"; engine: "anydoc" | "pdf-inspector" }
  | { type: "office"; id: number; markdown: string }
  | {
      type: "pdf";
      id: number;
      markdown: string | undefined;
      pdfType: string;
      pageCount: number;
      pagesNeedingOcr: number[];
    }
  | {
      type: "error";
      id: number | null;
      message: string;
      code?: string;
      pages?: number[];
      pageCount?: number;
    };

interface AnydocModule {
  default: (init: { module_or_path: ArrayBuffer }) => Promise<unknown>;
  toMarkdownBytes: (bytes: Uint8Array, format?: string | null) => string;
  formatFromBytes: (bytes: Uint8Array) => string | undefined;
}

interface PdfInspectorModule {
  default: (init: { module_or_path: ArrayBuffer }) => Promise<unknown>;
  processPdf: (
    bytes: Uint8Array,
    options?: {
      pages?: number[];
      includePageMarkers?: boolean;
      profile?: string;
    }
  ) => {
    pdfType: string;
    markdown?: string;
    pageCount: number;
    pagesNeedingOcr: number[];
  };
}

let anydoc: AnydocModule | null = null;
let pdfInspector: PdfInspectorModule | null = null;

// A dedicated worker has no targetOrigin to give; the options form of
// postMessage (with nothing to transfer) is the one that applies here.
const post = (msg: WorkerResponse) => self.postMessage(msg, { transfer: [] });

/** Import a module from its source text. The glue never resolves a sibling file when given the wasm bytes directly. */
const importGlue = <T>(glue: string, name: string): Promise<T> =>
  import(scriptDataUrl(glue, name)) as Promise<T>;

const describe = (
  e: unknown
): {
  message: string;
  code?: string;
  pages?: number[];
  pageCount?: number;
} => {
  if (e instanceof Error) {
    const x = e as Error & {
      code?: string;
      pages?: number[];
      pageCount?: number;
    };
    return {
      code: x.code,
      message: e.message,
      pageCount: x.pageCount,
      pages: x.pages,
    };
  }
  return { message: String(e) };
};

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  try {
    if (msg.type === "load") {
      if (msg.engine === "anydoc") {
        const mod = await importGlue<AnydocModule>(msg.glue, "anydoc.js");
        await mod.default({ module_or_path: msg.wasm });
        anydoc = mod;
      } else {
        const mod = await importGlue<PdfInspectorModule>(
          msg.glue,
          "pdf-inspector.js"
        );
        await mod.default({ module_or_path: msg.wasm });
        pdfInspector = mod;
      }
      post({ engine: msg.engine, type: "loaded" });
      return;
    }
    if (msg.type === "office") {
      if (!anydoc) {
        throw new Error("anydoc is not loaded");
      }
      const bytes = new Uint8Array(msg.bytes);
      // The converter's own sniffing wins; the format we detected only fills in
      // for content it cannot recognize (CSV has no signature).
      const format = anydoc.formatFromBytes(bytes) ?? msg.format;
      post({
        id: msg.id,
        markdown: anydoc.toMarkdownBytes(bytes, format),
        type: "office",
      });
      return;
    }
    if (msg.type === "pdf") {
      if (!pdfInspector) {
        throw new Error("pdf-inspector is not loaded");
      }
      const res = pdfInspector.processPdf(new Uint8Array(msg.bytes), {
        includePageMarkers: true,
        pages: msg.pages,
      });
      post({
        id: msg.id,
        markdown: res.markdown,
        pageCount: res.pageCount,
        pagesNeedingOcr: res.pagesNeedingOcr,
        pdfType: res.pdfType,
        type: "pdf",
      });
    }
  } catch (error) {
    post({
      id: "id" in msg ? msg.id : null,
      type: "error",
      ...describe(error),
    });
  }
};
