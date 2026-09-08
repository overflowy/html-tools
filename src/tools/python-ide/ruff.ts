// Main-thread handle on the Linter: loads Ruff's bytes from the Engine cache
// into its worker and turns format and check into promises. One Linter
// serves every Project; `configure` is called when the open Project's
// [tool.ruff] table changes.

import { scriptDataUrl } from "../../shared/script-url";
import { loadRuffAssets, type LoadProgress } from "./engines";
import type { RuffDiagnostic, RuffRequest, RuffResponse } from "./ruff-worker";

export type { RuffDiagnostic } from "./ruff-worker";

type Pending = { resolve: (r: RuffResponse) => void; reject: (e: Error) => void };

export class Linter {
  private worker: Worker;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private loading: Promise<string> | null = null;
  private onLoaded: Pending | null = null;
  private configured: Promise<void> | null = null;
  version = "";

  constructor() {
    this.worker = new Worker(scriptDataUrl(PYIDE_RUFF_WORKER_SRC), { type: "module", name: "ruff" });
    this.worker.onmessage = (ev: MessageEvent<RuffResponse>) => this.receive(ev.data);
    this.worker.onerror = (ev) => this.failAll(new Error("Ruff crashed: " + (ev.message || "unknown error")));
  }

  private receive(msg: RuffResponse) {
    if (msg.type === "loaded") {
      this.version = msg.version;
      this.onLoaded?.resolve(msg);
      this.onLoaded = null;
      return;
    }
    if (msg.type === "error" && msg.id === null) {
      this.onLoaded?.reject(new Error(msg.message));
      this.onLoaded = null;
      return;
    }
    const id = msg.id as number;
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (msg.type === "error") p.reject(new Error(msg.message));
    else p.resolve(msg);
  }

  private failAll(e: Error) {
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
    this.onLoaded?.reject(e);
    this.onLoaded = null;
  }

  /** Fetches Ruff (through the cache) and starts it. Idempotent. */
  load(onProgress?: LoadProgress): Promise<string> {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const { glue, wasm } = await loadRuffAssets(onProgress);
      const copy = wasm.slice(0);
      return new Promise<string>((resolve, reject) => {
        this.onLoaded = { resolve: () => resolve(this.version), reject };
        // A dedicated worker takes no targetOrigin.
        // oxlint-disable-next-line unicorn/require-post-message-target-origin
        this.worker.postMessage({ type: "load", glue, wasm: copy } satisfies RuffRequest, [copy]);
      });
    })();
    this.loading.catch(() => (this.loading = null));
    return this.loading;
  }

  private ask(msg: Extract<RuffRequest, { id: number }>): Promise<RuffResponse> {
    return new Promise((resolve, reject) => {
      this.pending.set(msg.id, { resolve, reject });
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      this.worker.postMessage(msg);
    });
  }

  async configure(options: unknown): Promise<void> {
    const p = (async () => {
      await this.load();
      await this.ask({ type: "configure", id: this.nextId++, options });
    })();
    this.configured = p;
    p.catch(() => {
      if (this.configured === p) this.configured = null;
    });
    await p;
  }

  /** Waits for Ruff and a settings object; a check before any configure gets Ruff's defaults. */
  private ready(): Promise<void> {
    if (!this.configured) return this.configure({});
    return this.configured;
  }

  async format(source: string): Promise<string> {
    await this.ready();
    const r = await this.ask({ type: "format", id: this.nextId++, source });
    return (r as Extract<RuffResponse, { type: "format" }>).formatted;
  }

  async check(source: string): Promise<RuffDiagnostic[]> {
    await this.ready();
    const r = await this.ask({ type: "check", id: this.nextId++, source });
    return (r as Extract<RuffResponse, { type: "check" }>).diagnostics;
  }

  terminate() {
    this.worker.terminate();
    this.failAll(new Error("Ruff was stopped."));
  }
}
