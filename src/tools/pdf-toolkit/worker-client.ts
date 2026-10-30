// Main-thread handle on the PDF worker: spawns it from the bundled source
// (as a data: URL, see script-url.ts) and turns its replies back into
// promises, typed by the worker's own methods. Cancel is `terminate()`:
// what was running fails, and the Tool starts a fresh worker and hands it
// its documents again.

import { scriptDataUrl } from "../../shared/script-url";
import type { OpName, OpOptions, OpReport } from "./ops";
import type {
  Methods,
  MethodName,
  RunResult,
  WorkerRequest,
  WorkerResponse,
} from "./worker";

export const CANCELLED = "Cancelled.";

type Reply<K extends MethodName> = Awaited<ReturnType<Methods[K]>>;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class PdfWorker {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private dead = false;

  constructor() {
    this.worker = new Worker(scriptDataUrl(PDF_WORKER_SRC, "pdf-worker.js"), {
      type: "module",
    });
    this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const msg = ev.data;
      const p = this.pending.get(msg.id);
      if (!p) {
        return;
      }
      this.pending.delete(msg.id);
      if (msg.ok) {
        p.resolve(msg.value);
      } else {
        p.reject(new Error(msg.message));
      }
    };
    this.worker.onerror = (ev) => {
      this.failAll(
        new Error(`The PDF worker crashed: ${ev.message || "unknown error"}`)
      );
    };
  }

  get alive(): boolean {
    return !this.dead;
  }

  private failAll(error: Error) {
    for (const p of this.pending.values()) {
      p.reject(error);
    }
    this.pending.clear();
  }

  /** Call a worker method; `transfer` hands buffers over instead of copying them. */
  call<K extends MethodName>(
    method: K,
    args: Parameters<Methods[K]>,
    transfer: Transferable[] = []
  ): Promise<Reply<K>> {
    if (this.dead) {
      return Promise.reject(new Error(CANCELLED));
    }
    const id = this.nextId;
    this.nextId += 1;
    const { promise, resolve, reject } = Promise.withResolvers<Reply<K>>();
    this.pending.set(id, { reject, resolve: resolve as (v: unknown) => void });
    const msg: WorkerRequest = { args, id, method };
    this.worker.postMessage(msg, transfer);
    return promise;
  }

  /** Run an Operation on a held document. */
  async run<K extends OpName>(
    op: K,
    id: string,
    options: OpOptions<K>,
    transfer: Transferable[] = []
  ): Promise<Omit<RunResult, "report"> & { report: OpReport<K> }> {
    const r = await this.call(
      "run",
      [op, id, options] as Parameters<Methods["run"]>,
      transfer
    );
    return r as Omit<RunResult, "report"> & { report: OpReport<K> };
  }

  terminate() {
    this.dead = true;
    this.worker.terminate();
    this.failAll(new Error(CANCELLED));
  }
}
