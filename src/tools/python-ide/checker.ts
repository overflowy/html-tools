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
import { scriptBlobUrl, scriptDataUrl } from "../../shared/script-url";

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

/** JSON-RPC's code for a failure inside the server, as opposed to a request it refuses. */
const LSP_INTERNAL_ERROR = -32603;

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
 * and replaying it once the script has installed its own listener. Spawned
 * from a blob: URL when the script is one (a blob: import needs a blob:
 * importer, or the origins differ), from a data: URL otherwise.
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
const BOOTSTRAP_DATA_URL = scriptDataUrl(BOOTSTRAP, "pyright-bootstrap.js");
let bootstrapBlobUrl = "";

export class Checker {
  private workers: Worker[] = [];
  private listener: Listener | undefined;
  private closed = false;
  private features: { dispose(): void } | null = null;
  private client: Monaco.lsp.MonacoLspClient | null = null;
  /** Ids of in-flight requests in LOCATING. */
  private locating = new Set<number | string>();
  /** The file each in-flight textDocument request is about, so an answer about a file since closed can be dropped. */
  private about = new Map<number | string, string>();
  /** Where each in-flight completion request was made, for the ranges its items lack. */
  private completing = new Map<number | string, { uri: string; line: number; character: number }>();
  private initId: number | string | null = null;
  private resolveReady: (() => void) | null = null;
  /** Resolves when the server answered `initialize`. */
  readonly ready = new Promise<void>((resolve) => (this.resolveReady = resolve));
  isReady = false;
  /** Resolves on the foreground worker's first message: its script has been evaluated. */
  private started: Promise<void>;
  private resolveStarted: (() => void) | null = null;
  /**
   * The URI Monaco's client uses for a file (`Uri.toString(true)`: spaces
   * and non-ASCII raw, lowercased) to the one Pyright wants (fully encoded,
   * the case as it is). Answers travel the other way through `clientUri`.
   */
  private realUris = new Map<string, string>();

  /** `script` is the worker script's URL, blob: or data: (see loadPyrightScript). */
  constructor(private monaco: typeof Monaco, private script: string, private options: CheckerOptions) {
    this.started = new Promise((resolve) => (this.resolveStarted = resolve));
  }

  start() {
    const foreground = this.spawn("pyright-foreground");
    foreground.addEventListener("message", (ev: MessageEvent) => this.receive(foreground, ev.data));
    foreground.postMessage({ type: "browser/boot", mode: "foreground" });

    for (const path of Object.keys(this.options.files)) this.remember(path);

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
    let url = BOOTSTRAP_DATA_URL;
    if (this.script.startsWith("blob:")) url = bootstrapBlobUrl ||= scriptBlobUrl(BOOTSTRAP);
    const worker = new Worker(url, { type: "module", name });
    this.workers.push(worker);
    worker.postMessage({ load: this.script });
    return worker;
  }

  /** Records a file's URI in both forms; returns the one Pyright wants. */
  private remember(path: string): string {
    const uri = this.monaco.Uri.file(path);
    const real = uri.toString();
    this.realUris.set(uri.toString(true).toLowerCase(), real);
    return real;
  }

  /** A URI as Pyright sent it, in the form Monaco's client knows the model by. */
  private clientUri(uri: string): string {
    try {
      return this.monaco.Uri.parse(uri).toString(true);
    } catch {
      return uri;
    }
  }

  /**
   * Rewrites every URI in a message from Pyright into the client's form:
   * `uri` and `targetUri` values, and the keys of a workspace edit's `changes`.
   */
  private toClient(value: unknown) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const v of value) this.toClient(v);
      return;
    }
    const obj = value as Json;
    for (const key of Object.keys(obj)) {
      const v = obj[key];
      if ((key === "uri" || key === "targetUri") && typeof v === "string") obj[key] = this.clientUri(v);
      else if (key === "changes" && v && typeof v === "object" && !Array.isArray(v)) {
        const changes = v as Json;
        obj[key] = Object.fromEntries(Object.entries(changes).map(([uri, edits]) => {
          this.toClient(edits);
          return [this.clientUri(uri), edits];
        }));
      } else this.toClient(v);
    }
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
      this.toClient(msg.params);
    } else {
      if (msg.id !== undefined && msg.id !== null && this.locating.has(msg.id)) {
        this.locating.delete(msg.id);
        this.ensureModels(msg.result);
      } else if (msg.id !== undefined && msg.id !== null && this.completing.has(msg.id)) {
        this.giveCompletionsRanges(msg.result, this.completing.get(msg.id)!);
        this.completing.delete(msg.id);
      } else if (msg.id !== undefined && msg.id === this.initId) {
        this.isReady = true;
        this.resolveReady?.();
      }
      this.toClient(msg.result);
    }
    if (msg.id !== undefined && msg.id !== null && this.about.has(msg.id)) {
      const uri = this.about.get(msg.id)!;
      this.about.delete(msg.id);
      const error = msg.error as { code?: number; message?: string } | undefined;
      // Monaco's client cannot place an answer about a model that was disposed
      // meanwhile (a file moved or deleted with a request in flight) and throws;
      // it gets nothing instead. The same for Pyright failing inside itself on
      // a request made while the Project changed under it: a code action or a
      // hover that is not there is what the client can take, an exception is not.
      if (!this.monaco.editor.getModel(this.monaco.Uri.parse(uri)) || error?.code === LSP_INTERNAL_ERROR) {
        if (error) console.warn(`Pyright: ${error.message ?? "internal error"} (${uri})`);
        delete msg.error;
        msg.result = null;
      }
    }
    this.listener?.(msg);
  }

  private send(foreground: Worker, message: Message) {
    if (this.closed) return;
    // The client keeps its request's textDocument and uses that URI to place
    // returned ranges. Pyright needs another URI form, so only the copy sent
    // to its worker may be rewritten.
    message = structuredClone(message);
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
        if (message.id !== undefined && message.id !== null) {
          this.about.set(message.id, real);
          const position = (params as { position?: { line: number; character: number } }).position;
          if (message.method === "textDocument/completion" && position) this.completing.set(message.id, { uri: real, ...position });
        }
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
   * A completion item without a text edit is meant to replace the word being
   * typed (VS Code does that); Monaco's client inserts it at the cursor
   * instead, and "import collec" completed to "import colleccollections".
   * Pyright sends most items that way, so each one gets an edit over the
   * word before the cursor, or the list's default range when it has one.
   */
  private giveCompletionsRanges(result: unknown, at: { uri: string; line: number; character: number }) {
    if (!result || typeof result !== "object") return;
    const list = result as { items?: Json[]; itemDefaults?: { editRange?: unknown } };
    const items = Array.isArray(result) ? (result as Json[]) : list.items;
    if (!items) return;
    let range = list.itemDefaults?.editRange;
    if (!range) {
      const model = this.monaco.editor.getModel(this.monaco.Uri.parse(at.uri));
      if (!model) return;
      const word = model.getWordUntilPosition({ lineNumber: at.line + 1, column: at.character + 1 });
      range = { start: { line: at.line, character: word.startColumn - 1 }, end: { line: at.line, character: at.character } };
    }
    for (const item of items) {
      if (item.textEdit) continue;
      item.textEdit = { range, newText: typeof item.insertText === "string" ? item.insertText : (item.textEditText ?? item.label) };
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
    const uri = this.remember(path);
    this.workers[0]?.postMessage({ jsonrpc: "2.0", method: "pyright/createFile", params: { uri } });
  }

  fileDeleted(path: string) {
    const uri = this.monaco.Uri.file(path).toString();
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
