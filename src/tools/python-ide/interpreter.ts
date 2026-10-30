// Main-thread handle on a Project's Interpreter: spawns the worker from the
// bundled source, hands it Pyodide's bytes from the Engine cache, serves its
// Wheel requests from the Wheel Cache, and turns its messages into promises
// and events. Stop is `terminate()`; the Project then boots a new one.

import { scriptDataUrl } from "../../shared/script-url";
import { loadPyodideAssets, PYODIDE_BASE } from "./engines";
import type { LoadProgress } from "./engines";
import type {
  EnvironmentResult,
  FileEntry,
  PyRequest,
  PyResponse,
  ReplResult,
  RunOptions,
  RunResult,
} from "./py-worker";
import { getWheel, putWheel } from "./store";

export interface InterpreterEvents {
  onOutput: (stream: "stdout" | "stderr", bytes: Uint8Array) => void;
  /** Python is waiting for a line; answer with `replyInput`. */
  onInputRequest: (id: number) => void;
  /** Python asked for a line where the browser cannot block for one. */
  onInputUnavailable: () => void;
  onFigure: (png: Uint8Array) => void;
  onProgress: (message: string) => void;
  /** The worker died on its own (an uncaught error). */
  onCrash: (message: string) => void;
}

export interface BootInfo {
  python: string;
  /** Whether interactive input works: JSPI is available and Pyodide uses it. */
  jspi: boolean;
}

interface Pending {
  resolve: (r: unknown) => void;
  reject: (e: Error) => void;
}

export class Interpreter {
  private worker: Worker;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private dead = false;
  /** Bytes fetched from the network for the Wheel Cache during this boot, for the Status Bar. */
  downloaded = 0;
  private events: InterpreterEvents;

  constructor(events: InterpreterEvents) {
    this.events = events;
    this.worker = new Worker(
      scriptDataUrl(PYIDE_PY_WORKER_SRC, "py-worker.js"),
      { name: "python-interpreter", type: "module" }
    );
    this.worker.onmessage = (ev: MessageEvent<PyResponse>) =>
      this.receive(ev.data);
    this.worker.onerror = (ev) => {
      // Firefox can report an empty worker exception while terminate() tears
      // Pyodide down. It is expected, and must not reach the page console.
      ev.preventDefault();
      if (this.dead) {
        return;
      }
      const message = `The interpreter crashed: ${ev.message || "unknown error"}`;
      this.failAll(new Error(message));
      this.events.onCrash(message);
    };
  }

  private receive(msg: PyResponse) {
    switch (msg.type) {
      case "fetch": {
        this.serveWheel(msg.id, msg.url);
        return;
      }
      case "out": {
        this.events.onOutput(msg.stream, msg.bytes);
        return;
      }
      case "inputRequest": {
        this.events.onInputRequest(msg.id);
        return;
      }
      case "inputUnavailable": {
        this.events.onInputUnavailable();
        return;
      }
      case "figure": {
        this.events.onFigure(msg.png);
        return;
      }
      case "progress": {
        this.events.onProgress(msg.message);
        return;
      }
      case "done":
      case "fail": {
        const p = this.pending.get(msg.id);
        if (!p) {
          return;
        }
        this.pending.delete(msg.id);
        if (msg.type === "fail") {
          p.reject(new Error(msg.message));
        } else {
          p.resolve(msg.result);
        }
        break;
      }
      default: {
        // Every PyResponse type has its case above.
        break;
      }
    }
  }

  /** A Wheel from the cache, or from the network once and then the cache. */
  private async serveWheel(id: number, url: string) {
    try {
      const cached = await getWheel(url);
      let bytes = cached?.bytes;
      if (!bytes) {
        this.events.onProgress(
          `Downloading ${url.slice(url.lastIndexOf("/") + 1)}`
        );
        const res = await fetch(url);
        if (!res.ok) {
          this.send({
            error: `HTTP ${res.status}`,
            id,
            ok: false,
            status: res.status,
            type: "fetched",
          });
          return;
        }
        bytes = await res.arrayBuffer();
        this.downloaded += bytes.byteLength;
        await putWheel({ bytes, storedAt: Date.now(), url });
      }
      // The cache keeps its copy; the worker gets one to own.
      const copy = structuredClone(bytes);
      this.send({ bytes: copy, id, ok: true, type: "fetched" }, [copy]);
    } catch (error) {
      this.send({
        error: error instanceof Error ? error.message : String(error),
        id,
        ok: false,
        type: "fetched",
      });
    }
  }

  /** A fresh request id. */
  private takeId(): number {
    const id = this.nextId;
    this.nextId += 1;
    return id;
  }

  private failAll(e: Error) {
    for (const p of this.pending.values()) {
      p.reject(e);
    }
    this.pending.clear();
  }

  private send(msg: PyRequest, transfer: Transferable[] = []) {
    if (this.dead) {
      throw new Error("The interpreter was stopped.");
    }
    this.worker.postMessage(msg, transfer);
  }

  private ask<T>(
    msg: Extract<PyRequest, { id: number }>,
    transfer: Transferable[] = []
  ): Promise<T> {
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    this.pending.set(msg.id, {
      reject,
      resolve: resolve as (r: unknown) => void,
    });
    try {
      this.send(msg, transfer);
    } catch (error) {
      this.pending.delete(msg.id);
      reject(error as Error);
    }
    return promise;
  }

  /**
   * Boots Python with the Environment described by `lock` and `packages`
   * (the catalog and nothing, for a Project without a Lock yet).
   */
  async boot(
    lock: string | null,
    packages: string[],
    onProgress?: LoadProgress
  ): Promise<BootInfo> {
    const assets = await loadPyodideAssets(onProgress);
    // Copies: the Engine cache's buffers must survive for the next boot.
    const loader = structuredClone(assets.loader);
    const factory = structuredClone(assets.factory);
    const wasm = structuredClone(assets.wasm);
    const stdlib = structuredClone(assets.stdlib);
    return this.ask<BootInfo>(
      {
        cdnBase: PYODIDE_BASE,
        factory,
        id: this.takeId(),
        loader,
        lock: lock ?? assets.lock,
        packages,
        stdlib,
        type: "boot",
        wasm,
      },
      [loader, factory, wasm, stdlib]
    );
  }

  /** Removes files and folders, then makes folders and writes files, in the Project directory; buffers are transferred. */
  writeFiles(
    files: FileEntry[],
    removed: string[] = [],
    folders: string[] = [],
    removedFolders: string[] = []
  ): Promise<void> {
    const transfer = files
      .map((f) => f.data)
      .filter((d): d is ArrayBuffer => typeof d !== "string");
    return this.ask<undefined>(
      {
        files,
        folders,
        id: this.takeId(),
        removed,
        removedFolders,
        type: "files",
      },
      transfer
    );
  }

  run(opts: RunOptions): Promise<RunResult> {
    return this.ask<RunResult>({ id: this.takeId(), type: "run", ...opts });
  }

  install(specs: string[]): Promise<EnvironmentResult> {
    return this.ask<EnvironmentResult>({
      id: this.takeId(),
      specs,
      type: "install",
    });
  }

  uninstall(names: string[]): Promise<EnvironmentResult> {
    return this.ask<EnvironmentResult>({
      id: this.takeId(),
      names,
      type: "uninstall",
    });
  }

  environment(): Promise<EnvironmentResult> {
    return this.ask<EnvironmentResult>({
      id: this.takeId(),
      type: "environment",
    });
  }

  mirror(): Promise<Record<string, string>> {
    return this.ask<Record<string, string>>({
      id: this.takeId(),
      type: "mirror",
    });
  }

  repl(line: string): Promise<ReplResult> {
    return this.ask<ReplResult>({ id: this.takeId(), line, type: "repl" });
  }

  complete(source: string): Promise<{ completions: string[]; start: number }> {
    return this.ask({ id: this.takeId(), source, type: "complete" });
  }

  resetRepl(): Promise<void> {
    return this.ask<undefined>({ id: this.takeId(), type: "resetRepl" });
  }

  replyInput(id: number, line: string | null) {
    if (!this.dead) {
      this.send({ id, line, type: "inputReply" });
    }
  }

  resize(cols: number, rows: number) {
    if (!this.dead) {
      this.send({ cols, rows, type: "resize" });
    }
  }

  get alive(): boolean {
    return !this.dead;
  }

  terminate() {
    if (this.dead) {
      return;
    }
    this.dead = true;
    this.worker.terminate();
    this.failAll(new Error("The interpreter was stopped."));
  }
}
