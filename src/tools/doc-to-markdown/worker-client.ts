// Main-thread handle on the conversion worker: spawns it from the bundled
// source (as a data: URL, see script-url.ts), feeds it engines, and turns its
// messages back into promises.
// Cancel is `terminate()`; the next conversion spawns a fresh worker and
// reloads the engines from the cache, which is cheap.

import { scriptDataUrl } from "../../shared/script-url";
import { ConvertError } from "./convert-error";
import type { OfficeFormat } from "./detect";
import type { WorkerRequest, WorkerResponse } from "./worker";

export interface PdfResult {
  markdown: string | undefined;
  pdfType: string;
  pageCount: number;
  pagesNeedingOcr: number[];
}

interface Pending {
  resolve: (r: WorkerResponse) => void;
  reject: (e: Error) => void;
}

export class ConvertWorker {
  private worker: Worker;
  private pending = new Map<number, Pending>();
  private loads = new Map<string, Pending>();
  private loading = new Map<string, Promise<void>>();
  private nextId = 1;
  readonly loaded = new Set<"anydoc" | "pdf-inspector">();
  private dead = false;

  constructor() {
    this.worker = new Worker(scriptDataUrl(DOC_WORKER_SRC, "doc-worker.js"), {
      type: "module",
    });
    this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) =>
      this.receive(ev.data);
    this.worker.onerror = (ev) => {
      this.failAll(
        new Error(
          `The conversion worker crashed: ${ev.message || "unknown error"}`
        )
      );
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
    if (!p) {
      return;
    }
    this.pending.delete(id);
    if (msg.type === "error") {
      p.reject(new ConvertError(msg));
    } else {
      p.resolve(msg);
    }
  }

  private failAll(e: Error) {
    for (const p of this.pending.values()) {
      p.reject(e);
    }
    this.pending.clear();
    for (const p of this.loads.values()) {
      p.reject(e);
    }
    this.loads.clear();
  }

  private send(msg: WorkerRequest, transfer: Transferable[] = []) {
    if (this.dead) {
      throw new Error("The conversion was cancelled.");
    }
    this.worker.postMessage(msg, transfer);
  }

  /** Hand an engine's glue and wasm to the worker. Idempotent per engine. */
  load(
    engine: "anydoc" | "pdf-inspector",
    glue: string,
    wasm: ArrayBuffer
  ): Promise<void> {
    if (this.loaded.has(engine)) {
      return Promise.resolve();
    }
    const inFlight = this.loading.get(engine);
    if (inFlight) {
      return inFlight;
    }
    const { promise: p, resolve, reject } = Promise.withResolvers<undefined>();
    this.loads.set(engine, { reject, resolve: () => resolve(undefined) });
    try {
      // Copy the wasm: the cache's buffer must survive for the next worker.
      this.send({ engine, glue, type: "load", wasm: structuredClone(wasm) });
    } catch (error) {
      this.loads.delete(engine);
      reject(error as Error);
    }
    this.loading.set(engine, p);
    p.then(() => this.loading.delete(engine)).catch(() =>
      this.loading.delete(engine)
    );
    return p;
  }

  private ask(
    msg: Extract<WorkerRequest, { id: number }>,
    transfer: Transferable[]
  ): Promise<WorkerResponse> {
    const { promise, resolve, reject } =
      Promise.withResolvers<WorkerResponse>();
    this.pending.set(msg.id, { reject, resolve });
    try {
      this.send(msg, transfer);
    } catch (error) {
      this.pending.delete(msg.id);
      reject(error as Error);
    }
    return promise;
  }

  async office(bytes: ArrayBuffer, format: OfficeFormat): Promise<string> {
    const id = this.nextId;
    this.nextId += 1;
    const r = await this.ask({ bytes, format, id, type: "office" }, [bytes]);
    return (r as Extract<WorkerResponse, { type: "office" }>).markdown;
  }

  async pdf(bytes: ArrayBuffer, pages?: number[]): Promise<PdfResult> {
    const id = this.nextId;
    this.nextId += 1;
    const r = await this.ask({ bytes, id, pages, type: "pdf" }, [bytes]);
    const { markdown, pdfType, pageCount, pagesNeedingOcr } = r as Extract<
      WorkerResponse,
      { type: "pdf" }
    >;
    return { markdown, pageCount, pagesNeedingOcr, pdfType };
  }

  terminate() {
    this.dead = true;
    this.worker.terminate();
    this.failAll(new Error("The conversion was cancelled."));
  }
}
