// Main-thread handle on the hashing worker: spawns it from the bundled
// source (as a data: URL, see script-url.ts) and turns its messages back
// into promises. It hashes one source at a time; each request waits at the
// back of one queue. Cancel is `terminate()`, and the next request spawns
// a fresh worker, which costs nothing worth mentioning.

import { scriptDataUrl } from "../../shared/script-url";
import type { AlgorithmId } from "./algorithms";
import type { WorkerRequest, WorkerResponse } from "./worker";

export const CANCELLED = "Hashing was cancelled.";

export interface HashResult {
  digests: Partial<Record<AlgorithmId, string>>;
  ms: number;
}

interface Waiter {
  /** Handles one message; true when it was the request's last. */
  take: (msg: WorkerResponse) => boolean;
  fail: (e: Error) => void;
}

export class HashWorker {
  private worker: Worker;
  private queue: Waiter[] = [];
  private dead = false;

  constructor() {
    this.worker = new Worker(scriptDataUrl(HASH_WORKER_SRC, "hash-worker.js"), {
      type: "module",
    });
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
        new Error(
          `The hashing worker crashed: ${ev.message || "unknown error"}`
        )
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

  /** Digests of a file or a text; `onRead` hears how many bytes of a file are done. */
  hash(
    source: Blob | string,
    algorithms: AlgorithmId[],
    onRead?: (bytes: number) => void
  ): Promise<HashResult> {
    const { promise, resolve, reject } = Promise.withResolvers<HashResult>();
    if (this.dead) {
      reject(new Error(CANCELLED));
      return promise;
    }
    const waiter: Waiter = {
      fail: reject,
      take: (m) => {
        if (m.type === "progress") {
          onRead?.(m.read);
          return false;
        }
        if (m.type !== "hashed") {
          return false;
        }
        resolve({ digests: m.digests, ms: m.ms });
        return true;
      },
    };
    this.queue.push(waiter);
    const msg: WorkerRequest = { algorithms, source, type: "hash" };
    try {
      // Nothing transferred: a File crosses by reference.
      this.worker.postMessage(msg, []);
    } catch (error) {
      // As a Promise executor would: a message that cannot be sent rejects,
      // and waits for no answer, which would be the next request's.
      this.queue = this.queue.filter((w) => w !== waiter);
      reject(error);
    }
    return promise;
  }

  terminate() {
    this.dead = true;
    this.worker.terminate();
    this.failAll(new Error(CANCELLED));
  }
}
