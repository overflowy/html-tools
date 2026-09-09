// Main-thread handle on a Project's Interpreter: spawns the worker from the
// bundled source, hands it Pyodide's bytes from the Engine cache, serves its
// Wheel requests from the Wheel Cache, and turns its messages into promises
// and events. Stop is `terminate()`; the Project then boots a new one.

import { scriptDataUrl } from "../../shared/script-url";
import { loadPyodideAssets, PYODIDE_BASE, type LoadProgress } from "./engines";
import type { EnvironmentResult, FileEntry, PyRequest, PyResponse, ReplResult, RunOptions, RunResult } from "./py-worker";
import { getWheel, putWheel } from "./store";

export interface InterpreterEvents {
  onOutput(stream: "stdout" | "stderr", bytes: Uint8Array): void;
  /** Python is waiting for a line; answer with `replyInput`. */
  onInputRequest(id: number): void;
  /** Python asked for a line where the browser cannot block for one. */
  onInputUnavailable(): void;
  onFigure(png: Uint8Array): void;
  onProgress(message: string): void;
  /** The worker died on its own (an uncaught error). */
  onCrash(message: string): void;
}

export interface BootInfo {
  python: string;
  /** Whether interactive input works: JSPI is available and Pyodide uses it. */
  jspi: boolean;
}

type Pending = { resolve: (r: unknown) => void; reject: (e: Error) => void };

export class Interpreter {
  private worker: Worker;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private dead = false;
  /** Bytes fetched from the network for the Wheel Cache during this boot, for the Status Bar. */
  downloaded = 0;

  constructor(private events: InterpreterEvents) {
    this.worker = new Worker(scriptDataUrl(PYIDE_PY_WORKER_SRC), { type: "module", name: "python-interpreter" });
    this.worker.onmessage = (ev: MessageEvent<PyResponse>) => this.receive(ev.data);
    this.worker.onerror = (ev) => {
      // Firefox can report an empty worker exception while terminate() tears
      // Pyodide down. It is expected, and must not reach the page console.
      ev.preventDefault();
      if (this.dead) return;
      const message = "The interpreter crashed: " + (ev.message || "unknown error");
      this.failAll(new Error(message));
      this.events.onCrash(message);
    };
  }

  private receive(msg: PyResponse) {
    switch (msg.type) {
      case "fetch":
        this.serveWheel(msg.id, msg.url);
        return;
      case "out":
        this.events.onOutput(msg.stream, msg.bytes);
        return;
      case "inputRequest":
        this.events.onInputRequest(msg.id);
        return;
      case "inputUnavailable":
        this.events.onInputUnavailable();
        return;
      case "figure":
        this.events.onFigure(msg.png);
        return;
      case "progress":
        this.events.onProgress(msg.message);
        return;
      case "done":
      case "fail": {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.type === "fail") p.reject(new Error(msg.message));
        else p.resolve(msg.result);
      }
    }
  }

  /** A Wheel from the cache, or from the network once and then the cache. */
  private async serveWheel(id: number, url: string) {
    try {
      const cached = await getWheel(url);
      let bytes = cached?.bytes;
      if (!bytes) {
        this.events.onProgress("Downloading " + url.slice(url.lastIndexOf("/") + 1));
        const res = await fetch(url);
        if (!res.ok) {
          this.send({ type: "fetched", id, ok: false, status: res.status, error: "HTTP " + res.status });
          return;
        }
        bytes = await res.arrayBuffer();
        this.downloaded += bytes.byteLength;
        await putWheel({ url, bytes, storedAt: Date.now() });
      }
      // The cache keeps its copy; the worker gets one to own.
      const copy = bytes.slice(0);
      this.send({ type: "fetched", id, ok: true, bytes: copy }, [copy]);
    } catch (e) {
      this.send({ type: "fetched", id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  private failAll(e: Error) {
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }

  private send(msg: PyRequest, transfer: Transferable[] = []) {
    if (this.dead) throw new Error("The interpreter was stopped.");
    this.worker.postMessage(msg, transfer);
  }

  private ask<T>(msg: Extract<PyRequest, { id: number }>, transfer: Transferable[] = []): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.set(msg.id, { resolve: resolve as (r: unknown) => void, reject });
      try {
        this.send(msg, transfer);
      } catch (e) {
        this.pending.delete(msg.id);
        reject(e as Error);
      }
    });
  }

  /**
   * Boots Python with the Environment described by `lock` and `packages`
   * (the catalog and nothing, for a Project without a Lock yet).
   */
  async boot(lock: string | null, packages: string[], onProgress?: LoadProgress): Promise<BootInfo> {
    const assets = await loadPyodideAssets(onProgress);
    // Copies: the Engine cache's buffers must survive for the next boot.
    const loader = assets.loader.slice(0), factory = assets.factory.slice(0), wasm = assets.wasm.slice(0), stdlib = assets.stdlib.slice(0);
    return this.ask<BootInfo>(
      { type: "boot", id: this.nextId++, cdnBase: PYODIDE_BASE, loader, factory, wasm, stdlib, lock: lock ?? assets.lock, packages },
      [loader, factory, wasm, stdlib],
    );
  }

  /** Removes files and folders, then makes folders and writes files, in the Project directory; buffers are transferred. */
  writeFiles(files: FileEntry[], removed: string[] = [], folders: string[] = [], removedFolders: string[] = []): Promise<void> {
    const transfer = files.map((f) => f.data).filter((d): d is ArrayBuffer => typeof d !== "string");
    return this.ask<void>({ type: "files", id: this.nextId++, files, removed, folders, removedFolders }, transfer);
  }

  run(opts: RunOptions): Promise<RunResult> {
    return this.ask<RunResult>({ type: "run", id: this.nextId++, ...opts });
  }

  install(specs: string[]): Promise<EnvironmentResult> {
    return this.ask<EnvironmentResult>({ type: "install", id: this.nextId++, specs });
  }

  uninstall(names: string[]): Promise<EnvironmentResult> {
    return this.ask<EnvironmentResult>({ type: "uninstall", id: this.nextId++, names });
  }

  environment(): Promise<EnvironmentResult> {
    return this.ask<EnvironmentResult>({ type: "environment", id: this.nextId++ });
  }

  mirror(): Promise<Record<string, string>> {
    return this.ask<Record<string, string>>({ type: "mirror", id: this.nextId++ });
  }

  repl(line: string): Promise<ReplResult> {
    return this.ask<ReplResult>({ type: "repl", id: this.nextId++, line });
  }

  complete(source: string): Promise<{ completions: string[]; start: number }> {
    return this.ask({ type: "complete", id: this.nextId++, source });
  }

  resetRepl(): Promise<void> {
    return this.ask<void>({ type: "resetRepl", id: this.nextId++ });
  }

  replyInput(id: number, line: string | null) {
    if (!this.dead) this.send({ type: "inputReply", id, line });
  }

  resize(cols: number, rows: number) {
    if (!this.dead) this.send({ type: "resize", cols, rows });
  }

  get alive(): boolean {
    return !this.dead;
  }

  terminate() {
    if (this.dead) return;
    this.dead = true;
    this.worker.terminate();
    this.failAll(new Error("The interpreter was stopped."));
  }
}
