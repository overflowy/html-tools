/* oxlint-disable unicorn/require-post-message-target-origin -- dedicated workers take no targetOrigin */
// The Checker: basedpyright in its browser build, driving Monaco through
// Monaco's own LSP client. basedpyright wants two workers (it asks for the
// second one with a `browser/newWorker` message, handing over a port), a
// custom boot message before any JSON-RPC, and its files in
// `initializationOptions.files`; Monaco's client knows none of that, so the
// transport between them rewrites `initialize`, spawns the background
// worker, answers the server's configuration requests, and keeps the
// server's chatter (logs, progress) away from the client. Restarted, never
// patched, when the Environment or the Mirror changes.

import type * as Monaco from "monaco-editor";
import { scriptDataUrl } from "../../shared/script-url";

type Json = Record<string, unknown>;

interface Message {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

type Listener = (message: Message) => void;

/** Server-to-client requests answered here rather than by Monaco's client. */
const ANSWERED: Record<string, (params: unknown) => unknown> = {
  "workspace/configuration": () => [],
  "window/workDoneProgress/create": () => null,
  "workspace/diagnostic/refresh": () => null,
};

/** Notifications Monaco's client has no use for. */
const DROPPED = new Set([
  "window/logMessage",
  "window/showMessage",
  "telemetry/event",
  "$/progress",
  "pyright/beginProgress",
  "pyright/reportProgress",
  "pyright/endProgress",
]);

const PYTHON_FILE = /\.pyi?$/i;

/** Requests whose answers point at files: those files need Monaco models before the client sees them. */
const LOCATING = new Set(["textDocument/definition", "textDocument/typeDefinition", "textDocument/declaration", "textDocument/implementation", "textDocument/references"]);

export interface CheckerOptions {
  /** Absolute virtual paths to text: the Project's text files, the Mirror, the stubs. */
  files: Record<string, string>;
  /** The contents of /project/pyrightconfig.json. */
  config: Json;
}

export const PROJECT_URI = "file:///project";

/**
 * What each Pyright worker starts as: a module worker that imports the real
 * script when told where it is, holding any message that arrives meanwhile
 * and replaying it once the script has installed its own listener.
 */
const BOOTSTRAP = `
const held = [];
let loading = false;
self.onmessage = (e) => {
  if (!loading && e.data && e.data.load) {
    loading = true;
    import(e.data.load).then(() => {
      self.onmessage = null;
      for (const h of held) self.dispatchEvent(new MessageEvent("message", { data: h.data, ports: [...h.ports] }));
    }, (err) => self.postMessage({ type: "browser/bootstrapError", message: String(err) }));
    return;
  }
  held.push(e);
};
`;
const BOOTSTRAP_URL = scriptDataUrl(BOOTSTRAP);

export class Checker {
  private workers: Worker[] = [];
  private listener: Listener | undefined;
  private closed = false;
  private features: { dispose(): void } | null = null;
  private client: Monaco.lsp.MonacoLspClient | null = null;
  /** Ids of in-flight requests in LOCATING. */
  private locating = new Set<number | string>();
  private initId: number | string | null = null;
  private resolveReady: (() => void) | null = null;
  /** Resolves when the server answered `initialize`. */
  readonly ready = new Promise<void>((resolve) => (this.resolveReady = resolve));
  isReady = false;
  /** Resolves on the foreground worker's first message: its script has been evaluated. */
  private started: Promise<void>;
  private resolveStarted: (() => void) | null = null;
  /** Lowercased URI to the real one: Monaco's client lowercases, Pyright's filesystem does not. */
  private realUris = new Map<string, string>();

  /** `script` is the worker script as a data: URL (see loadPyrightScript). */
  constructor(private monaco: typeof Monaco, private script: string, private options: CheckerOptions) {
    this.started = new Promise((resolve) => (this.resolveStarted = resolve));
  }

  start() {
    const foreground = this.spawn("pyright-foreground");
    foreground.addEventListener("message", (ev: MessageEvent) => this.receive(foreground, ev.data));
    foreground.postMessage({ type: "browser/boot", mode: "foreground" });

    for (const path of Object.keys(this.options.files)) {
      const uri = "file://" + path;
      this.realUris.set(uri.toLowerCase(), uri);
    }

    const transport = {
      state: { value: { state: "open" as const }, onChange: () => ({ dispose() {} }) },
      send: (message: Message) => {
        this.send(foreground, message);
        return Promise.resolve();
      },
      setListener: (listener: Listener | undefined) => {
        this.listener = listener;
      },
      toString: () => "basedpyright",
    };

    const Base = this.monaco.lsp.MonacoLspClient;
    // The client registers its Monaco providers in the constructor and keeps
    // no handle on them; a restart would register a second set. Catch the
    // disposable on the way past.
    const capture = (features: { dispose(): void }) => (this.features = features);
    class Client extends Base {
      protected override createFeatures() {
        const features = super.createFeatures();
        capture(features);
        return features;
      }
    }
    this.client = new Client(transport as unknown as ConstructorParameters<typeof Base>[0]);
  }

  private spawn(name: string): Worker {
    const worker = new Worker(BOOTSTRAP_URL, { type: "module", name });
    this.workers.push(worker);
    worker.postMessage({ load: this.script });
    return worker;
  }

  private receive(foreground: Worker, data: unknown) {
    this.resolveStarted?.();
    if (this.closed || !data || typeof data !== "object") return;
    const msg = data as Message & { type?: string; initialData?: unknown; port?: MessagePort };
    if (msg.type === "browser/bootstrapError") {
      console.error("Pyright could not load: " + (msg as { message?: string }).message);
      return;
    }
    if (msg.type === "browser/newWorker") {
      const background = this.spawn("pyright-background-" + this.workers.length);
      background.postMessage({ type: "browser/boot", mode: "background", initialData: msg.initialData, port: msg.port }, [msg.port as MessagePort]);
      return;
    }
    if (msg.jsonrpc !== "2.0") return;
    if (msg.method !== undefined) {
      if (msg.id !== undefined && msg.method in ANSWERED) {
        foreground.postMessage({ jsonrpc: "2.0", id: msg.id, result: ANSWERED[msg.method]!(msg.params) });
        return;
      }
      if (msg.id === undefined && DROPPED.has(msg.method)) return;
    } else if (msg.id !== undefined && msg.id !== null && this.locating.has(msg.id)) {
      this.locating.delete(msg.id);
      this.ensureModels(msg.result);
    } else if (msg.id !== undefined && msg.id === this.initId) {
      this.isReady = true;
      this.resolveReady?.();
    }
    this.listener?.(msg);
  }

  private send(foreground: Worker, message: Message) {
    if (this.closed) return;
    if (message.method === "initialize") {
      const params = (message.params ?? {}) as Json;
      params.rootUri = PROJECT_URI;
      params.rootPath = "/project";
      params.workspaceFolders = [{ uri: PROJECT_URI, name: "project" }];
      params.initializationOptions = {
        files: { ...this.options.files, "/project/pyrightconfig.json": JSON.stringify(this.options.config) },
      };
      // With pull diagnostics offered, basedpyright answers the pulls only
      // once its background analysis settles, which it never reports here;
      // without them it publishes diagnostics as they come, which is what we want.
      const textDocument = (params.capabilities as { textDocument?: Json } | undefined)?.textDocument;
      if (textDocument) delete textDocument.diagnostic;
      message.params = params;
      this.initId = message.id ?? null;
    } else if (message.method?.startsWith("textDocument/")) {
      const params = message.params as { textDocument?: { uri?: string; languageId?: string } } | undefined;
      const doc = params?.textDocument;
      if (doc?.uri) {
        // Only Python reaches Pyright; the Project's other text files are Monaco's alone.
        const real = this.realUris.get(doc.uri) ?? doc.uri;
        if (!PYTHON_FILE.test(real)) {
          // Answer a request about a non-Python file ourselves, so the client is not left waiting.
          if (message.id !== undefined) queueMicrotask(() => this.listener?.({ jsonrpc: "2.0", id: message.id, result: null }));
          return;
        }
        this.rewriteUris(message.params);
      }
      if (message.id !== undefined && message.id !== null && LOCATING.has(message.method)) this.locating.add(message.id);
    }
    foreground.postMessage(message);
  }

  private rewriteUris(value: unknown) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const v of value) this.rewriteUris(v);
      return;
    }
    const obj = value as Json;
    for (const key of Object.keys(obj)) {
      const v = obj[key];
      if (key === "uri" && typeof v === "string") obj[key] = this.realUris.get(v) ?? v;
      else this.rewriteUris(v);
    }
  }

  /**
   * Monaco's client can only show a location it has a model for. A definition
   * inside the Mirror gets one from the Checker's own copy of the file, and
   * the editor opener then shows it read-only.
   */
  private ensureModels(result: unknown) {
    const uris = new Set<string>();
    const walk = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) return value.forEach(walk);
      for (const [key, v] of Object.entries(value as Json)) {
        if ((key === "uri" || key === "targetUri") && typeof v === "string") uris.add(v);
        else walk(v);
      }
    };
    walk(result);
    for (const uri of uris) {
      const parsed = this.monaco.Uri.parse(uri);
      if (this.monaco.editor.getModel(parsed)) continue;
      const text = this.options.files[parsed.path];
      if (text === undefined) continue;
      this.monaco.editor.createModel(text, "python", parsed);
    }
  }

  /** A file the Project gained after start: tell Pyright it exists, so `import` of it resolves. */
  fileCreated(path: string) {
    const uri = "file://" + path;
    this.realUris.set(uri.toLowerCase(), uri);
    this.workers[0]?.postMessage({ jsonrpc: "2.0", method: "pyright/createFile", params: { uri } });
  }

  fileDeleted(path: string) {
    const uri = "file://" + path;
    this.workers[0]?.postMessage({ jsonrpc: "2.0", method: "pyright/deleteFile", params: { uri } });
  }

  /**
   * Stops the Checker. Monaco stops hearing from it at once; the server is
   * asked to shut down and the workers are terminated only once it has, or
   * after a grace period, and never before the foreground worker has spoken.
   * Firefox crashes its content process when a worker is terminated while
   * its 18 MB script is still being compiled, so a hard stop is the last
   * resort, never the first.
   */
  dispose() {
    this.closed = true;
    this.features?.dispose();
    this.features = null;
    this.client = null;
    const workers = this.workers;
    this.workers = [];
    const foreground = workers[0];
    if (!foreground) return;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      for (const w of workers) w.terminate();
    };
    foreground.addEventListener("message", (ev: MessageEvent) => {
      const msg = ev.data as Message | undefined;
      if (msg?.jsonrpc === "2.0" && msg.id === "shutdown") {
        foreground.postMessage({ jsonrpc: "2.0", method: "exit" });
        // The background worker may still be compiling; give both time to wind down.
        setTimeout(finish, 2000);
      }
    });
    void Promise.race([this.started, new Promise((r) => setTimeout(r, 10000))]).then(() => {
      foreground.postMessage({ jsonrpc: "2.0", id: "shutdown", method: "shutdown" });
      setTimeout(finish, 5000);
    });
  }
}
