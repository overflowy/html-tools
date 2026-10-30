// Main-thread handle on the transcription worker: spawns it from the bundled
// source (as a data: URL, see script-url.ts), hands it the engine, and turns
// its messages back into promises. The worker answers requests in the order
// they were sent, so each request waits at the back of one queue for its
// answer. Cancel is `terminate()`; the next run spawns a fresh worker and
// reloads the engine from the cache, which takes a moment.

import { scriptDataUrl } from "../../shared/script-url";
import type { Word } from "./transcript";
import type { WorkerRequest, WorkerResponse } from "./worker";

export const CANCELLED = "The transcription was cancelled.";

interface Waiter {
  /** Handles one message; true when it was the request's last. */
  take: (msg: WorkerResponse) => boolean;
  fail: (e: Error) => void;
}

export class SpeechWorker {
  private worker: Worker;
  private queue: Waiter[] = [];
  private dead = false;
  private loading: Promise<void> | null = null;

  constructor() {
    this.worker = new Worker(
      scriptDataUrl(STT_WORKER_SRC, "speech-worker.js"),
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
        new Error(
          `The transcription worker crashed: ${ev.message || "unknown error"}`
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

  private ask<T>(
    msg: WorkerRequest,
    take: (msg: WorkerResponse, resolve: (v: T) => void) => boolean,
    transfer: Transferable[] = []
  ): Promise<T> {
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    if (this.dead) {
      reject(new Error(CANCELLED));
      return promise;
    }
    const waiter: Waiter = { fail: reject, take: (m) => take(m, resolve) };
    this.queue.push(waiter);
    try {
      this.worker.postMessage(msg, transfer);
    } catch (error) {
      // As a Promise executor would: a message that cannot be sent rejects,
      // and waits for no answer, which would be the next request's.
      this.queue = this.queue.filter((w) => w !== waiter);
      reject(error);
    }
    return promise;
  }

  /** Hand the engine to the worker. Idempotent. */
  load(glue: string, wasm: ArrayBuffer, model: ArrayBuffer): Promise<void> {
    // Copies: the cache's buffers must survive for the next worker.
    this.loading ??= this.ask<undefined>(
      {
        glue,
        model: structuredClone(model),
        type: "load",
        wasm: structuredClone(wasm),
      },
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

  /** A whole clip; `onWindow` receives each Window's Words as it is done. */
  transcribe(
    pcm: Float32Array,
    language: string,
    keywords: string,
    onWindow: (words: Word[], language: string, done: number) => void
  ): Promise<{ language: string; ms: number }> {
    const copy = new Float32Array(pcm);
    return this.ask(
      { keywords, language, pcm: copy, type: "transcribe" },
      (m, resolve) => {
        if (m.type === "window") {
          onWindow(m.words, m.language, m.done);
          return false;
        }
        if (m.type !== "transcribed") {
          return false;
        }
        resolve({ language: m.language, ms: m.ms });
        return true;
      },
      [copy.buffer]
    );
  }

  /** The next piece of a Recording; resolves with what this pass committed. */
  feed(
    pcm: Float32Array,
    language: string,
    keywords: string
  ): Promise<{ words: Word[]; pending: string; language: string }> {
    return this.ask(
      { keywords, language, pcm, type: "feed" },
      (m, resolve) => {
        if (m.type !== "fed") {
          return false;
        }
        resolve({ language: m.language, pending: m.pending, words: m.words });
        return true;
      },
      [pcm.buffer]
    );
  }

  /** End the Recording; resolves with the Words that were still pending. */
  finish(): Promise<{ words: Word[]; language: string }> {
    return this.ask({ type: "finish" }, (m, resolve) => {
      if (m.type !== "finished") {
        return false;
      }
      resolve({ language: m.language, words: m.words });
      return true;
    });
  }

  terminate() {
    this.dead = true;
    this.worker.terminate();
    this.failAll(new Error(CANCELLED));
  }
}
