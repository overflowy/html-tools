// Main-thread handle on the conversion worker: spawns it from the bundled
// source (as a data: URL, see script-url.ts), feeds it engines, and turns its
// messages back into promises.
// Cancel is `terminate()`; the next conversion spawns a fresh worker and
// reloads the engines from the cache, which is cheap.

import type { OfficeFormat } from "./detect";
import { scriptDataUrl } from "./script-url";
import type { WorkerRequest, WorkerResponse } from "./worker";

export class ConvertError extends Error {
  code?: string;
  pages?: number[];
  pageCount?: number;
  constructor(r: Extract<WorkerResponse, { type: "error" }>) {
    super(r.message);
    this.code = r.code;
    this.pages = r.pages;
    this.pageCount = r.pageCount;
  }
}

export interface PdfResult {
  markdown: string | undefined;
  pdfType: string;
  pageCount: number;
  pagesNeedingOcr: number[];
}

type Pending = { resolve: (r: WorkerResponse) => void; reject: (e: Error) => void };

export class ConvertWorker {
  private worker: Worker;
  private pending = new Map<number, Pending>();
  private loads = new Map<string, Pending>();
  private loading = new Map<string, Promise<void>>();
  private nextId = 1;
  readonly loaded = new Set<"anydoc" | "pdf-inspector">();
  private dead = false;

  constructor() {
    this.worker = new Worker(scriptDataUrl(DOC_WORKER_SRC), { type: "module" });
    this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => this.receive(ev.data);
    this.worker.onerror = (ev) => {
      this.failAll(new Error("The conversion worker crashed: " + (ev.message || "unknown error")));
    };
  }

  private receive(msg: WorkerResponse) {
    if (msg.type === "loaded") {
      this.loaded.add(msg.engine);
      const p = this.loads.get(msg.engine);
      this.loads.delete(msg.engine);
      p?.resolve(msg);
      return;
    }
    if (msg.type === "error" && msg.id === null) {
      // A load failed: reject whichever load is waiting.
      for (const [k, p] of this.loads) {
        this.loads.delete(k);
        p.reject(new ConvertError(msg));
      }
      return;
    }
    const id = msg.id as number;
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (msg.type === "error") p.reject(new ConvertError(msg));
    else p.resolve(msg);
  }

  private failAll(e: Error) {
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
    for (const p of this.loads.values()) p.reject(e);
    this.loads.clear();
  }

  private send(msg: WorkerRequest, transfer: Transferable[] = []) {
    if (this.dead) throw new Error("The conversion was cancelled.");
    this.worker.postMessage(msg, transfer);
  }

  /** Hand an engine's glue and wasm to the worker. Idempotent per engine. */
  load(engine: "anydoc" | "pdf-inspector", glue: string, wasm: ArrayBuffer): Promise<void> {
    if (this.loaded.has(engine)) return Promise.resolve();
    const inFlight = this.loading.get(engine);
    if (inFlight) return inFlight;
    const p = new Promise<void>((resolve, reject) => {
      this.loads.set(engine, { resolve: () => resolve(), reject });
      try {
        // Copy the wasm: the cache's buffer must survive for the next worker.
        this.send({ type: "load", engine, glue, wasm: wasm.slice(0) });
      } catch (e) {
        this.loads.delete(engine);
        reject(e as Error);
      }
    });
    this.loading.set(engine, p);
    p.then(() => this.loading.delete(engine), () => this.loading.delete(engine));
    return p;
  }

  private ask(msg: Extract<WorkerRequest, { id: number }>, transfer: Transferable[]): Promise<WorkerResponse> {
    return new Promise((resolve, reject) => {
      this.pending.set(msg.id, { resolve, reject });
      try {
        this.send(msg, transfer);
      } catch (e) {
        this.pending.delete(msg.id);
        reject(e as Error);
      }
    });
  }

  async office(bytes: ArrayBuffer, format: OfficeFormat): Promise<string> {
    const r = await this.ask({ type: "office", id: this.nextId++, bytes, format }, [bytes]);
    return (r as Extract<WorkerResponse, { type: "office" }>).markdown;
  }

  async pdf(bytes: ArrayBuffer, pages: number[]): Promise<PdfResult> {
    const r = await this.ask({ type: "pdf", id: this.nextId++, bytes, pages }, [bytes]);
    const { markdown, pdfType, pageCount, pagesNeedingOcr } = r as Extract<WorkerResponse, { type: "pdf" }>;
    return { markdown, pdfType, pageCount, pagesNeedingOcr };
  }

  terminate() {
    this.dead = true;
    this.worker.terminate();
    this.failAll(new Error("The conversion was cancelled."));
  }
}
