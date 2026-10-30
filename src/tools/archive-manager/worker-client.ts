// Main-thread handle on the 7-Zip worker: spawns it from the bundled source
// (as a data: URL, see script-url.ts), hands it the engine, and turns its
// messages back into promises. The worker runs one command at a time and
// answers in order, so each request waits at the back of one queue. Cancel
// is `terminate()`; the next operation spawns a fresh worker and reloads
// the engine from the cache, which takes a moment.

import { scriptDataUrl } from "../../shared/script-url";
import type { Input, Output, WorkerRequest, WorkerResponse } from "./worker";

export const CANCELLED = "The operation was cancelled.";

export interface RunResult {
  code: number;
  stdout: string[];
  stderr: string[];
  outputs: Output[];
}

export interface RunRequest {
  args: string[];
  cwd: string;
  inputs: Input[];
  collect: boolean;
}

interface Waiter {
  /** Handles one message; true when it was the request's last. */
  take: (msg: WorkerResponse) => boolean;
  fail: (e: Error) => void;
}

export class ArchiveWorker {
  private worker: Worker;
  private queue: Waiter[] = [];
  private dead = false;
  private loading: Promise<void> | null = null;

  constructor() {
    this.worker = new Worker(
      scriptDataUrl(ARCHIVE_WORKER_SRC, "archive-worker.js"),
      { type: "module" }
    );
    this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const [head] = this.queue;
      if (!head) {
        return;
      }
      if (ev.data.type === "error") {
        this.queue.shift();
        head.fail(new Error(ev.data.message));
      } else if (head.take(ev.data)) {
        this.queue.shift();
      }
    };
    this.worker.onerror = (ev) => {
      this.failAll(
        new Error(`The 7-Zip worker crashed: ${ev.message || "unknown error"}`)
      );
    };
  }

  private failAll(e: Error) {
    const waiting = this.queue;
    this.queue = [];
    for (const w of waiting) {
      w.fail(e);
    }
  }

  private ask<T>(
    msg: WorkerRequest,
    take: (msg: WorkerResponse, resolve: (v: T) => void) => boolean
  ): Promise<T> {
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    if (this.dead) {
      reject(new Error(CANCELLED));
      return promise;
    }
    const waiter: Waiter = { fail: reject, take: (m) => take(m, resolve) };
    this.queue.push(waiter);
    try {
      // Nothing transferred: the inputs are Blobs, which cross by reference.
      this.worker.postMessage(msg, []);
    } catch (error) {
      // As a Promise executor would: a message that cannot be sent rejects,
      // and waits for no answer, which would be the next request's.
      this.queue = this.queue.filter((w) => w !== waiter);
      reject(error);
    }
    return promise;
  }

  /** Hand the engine to the worker. Idempotent. */
  load(glue: string, wasm: ArrayBuffer): Promise<void> {
    // A copy: the cache's buffer must survive for the next worker.
    this.loading ??= this.ask<undefined>(
      { glue, type: "load", wasm: structuredClone(wasm) },
      (m, resolve) => {
        if (m.type !== "loaded") {
          return false;
        }
        resolve(undefined);
        return true;
      }
    );
    return this.loading;
  }

  /** One 7-Zip command; `onRead` hears how many input bytes it has read so far. */
  run(req: RunRequest, onRead?: (bytes: number) => void): Promise<RunResult> {
    return this.ask<RunResult>({ ...req, type: "run" }, (m, resolve) => {
      if (m.type === "progress") {
        onRead?.(m.read);
        return false;
      }
      if (m.type !== "ran") {
        return false;
      }
      resolve({
        code: m.code,
        outputs: m.outputs,
        stderr: m.stderr,
        stdout: m.stdout,
      });
      return true;
    });
  }

  terminate() {
    this.dead = true;
    this.worker.terminate();
    this.failAll(new Error(CANCELLED));
  }
}
