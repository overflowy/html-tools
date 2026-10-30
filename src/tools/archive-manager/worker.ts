// The 7-Zip worker. JS7z's single-threaded build runs a command to the end
// before returning, blocking whichever thread calls it, so it lives here,
// off the main thread. Built as its own bundle by build.ts.
//
// The main thread fetches the engine's bytes (through the cache) and posts
// them in; the worker never touches the network. Each command gets a fresh
// instance: an Emscripten program's main() is not safe to run twice, and
// JS7z refuses to. The wasm is compiled once and every instance reuses it,
// so a fresh one costs a few milliseconds.
//
// The files a command reads are mounted read-only under /in with WORKERFS,
// which reads a File or Blob in place, so a gigabyte archive is never copied
// into memory. What the command writes lands in memory under /out and comes
// back as Blobs.

import { scriptDataUrl } from "../../shared/script-url";
import { IN, OUT } from "./commands";

/** A file or folder a command reads, mounted under IN. */
export interface Input {
  /** Path under IN, `/`-separated. */
  path: string;
  /** The contents; absent for a folder. */
  blob?: Blob;
  /** Milliseconds; the mount's time when absent. */
  mtime?: number;
  /** Unix permission bits; 0o644 for a file and 0o755 for a folder when absent. */
  mode?: number;
}

/** A file or folder a command wrote under OUT. */
export interface Output {
  /** Path under OUT, `/`-separated. */
  path: string;
  /** The contents; absent for a folder. */
  blob?: Blob;
  mtime: number;
  mode: number;
}

export type WorkerRequest =
  | { type: "load"; glue: string; wasm: ArrayBuffer }
  | {
      type: "run";
      args: string[];
      cwd: string;
      inputs: Input[];
      /** Whether to send back what the command wrote under OUT. */
      collect: boolean;
    };

export type WorkerResponse =
  | { type: "loaded" }
  /** Bytes read from the inputs so far. */
  | { type: "progress"; read: number }
  | {
      type: "ran";
      code: number;
      stdout: string[];
      stderr: string[];
      outputs: Output[];
    }
  | { type: "error"; message: string };

/** The parts of an Emscripten FS node the worker touches. */
interface FsNode {
  mode: number;
  contents: unknown;
}

interface FsStream {
  path?: string;
}

interface Stat {
  mode: number;
  mtime: Date | number;
}

/** The parts of a JS7z instance the worker uses. */
interface Js7z {
  callMain: (args: string[]) => number;
  FS: {
    mkdir: (path: string) => void;
    mount: (type: unknown, opts: object, path: string) => void;
    chdir: (path: string) => void;
    readdir: (path: string) => string[];
    stat: (path: string) => Stat;
    isDir: (mode: number) => boolean;
    readFile: (path: string) => Uint8Array<ArrayBuffer>;
    utime: (path: string, atime: number, mtime: number) => void;
    chmod: (path: string, mode: number) => void;
    lookupPath: (path: string) => { node: FsNode };
    read: (
      stream: FsStream,
      buffer: Uint8Array,
      offset: number,
      length: number,
      position?: number
    ) => number;
  };
  WORKERFS: {
    DIR_MODE: number;
    createNode: (
      parent: FsNode,
      name: string,
      mode: number,
      dev: number
    ) => FsNode;
  };
}

interface Hooks {
  print: (s: string) => void;
  printErr: (s: string) => void;
  onExit: (code: number) => void;
  onAbort: (reason: unknown) => void;
  instantiateWasm: (
    imports: WebAssembly.Imports,
    receive: (
      instance: WebAssembly.Instance,
      module: WebAssembly.Module
    ) => void
  ) => object;
}

type Factory = (hooks: Hooks) => Promise<Js7z>;

/** How often progress is posted while a command runs. */
const PROGRESS_MS = 100;
const FILE_MODE = 0o644;
const DIR_MODE = 0o755;
/** Mode bits below the file type: permissions, setuid, setgid, sticky. */
const MODE_SPAN = 2 ** 12;

// A dedicated worker has no targetOrigin to give.
const post = (msg: WorkerResponse) => self.postMessage(msg, { transfer: [] });

let factory: Factory | null = null;
let compiled: WebAssembly.Module | null = null;

const load = async (msg: Extract<WorkerRequest, { type: "load" }>) => {
  // The glue is a classic script defining JS7z; a line at its end makes it a module.
  const mod = (await import(
    scriptDataUrl(`${msg.glue}\nexport default JS7z;`, "js7z.js")
  )) as { default: Factory };
  compiled = await WebAssembly.compile(msg.wasm);
  factory = mod.default;
};

/** A fresh instance, its output going to the given sinks. */
const boot = (
  stdout: string[],
  stderr: string[],
  exit: { code: number | null }
): Promise<Js7z> => {
  const make = factory;
  const wasm = compiled;
  if (!make || !wasm) {
    throw new Error("7-Zip is not loaded.");
  }
  const { promise: failed, reject } = Promise.withResolvers<never>();
  const ready = make({
    instantiateWasm: (imports, receive) => {
      const start = async () => {
        try {
          receive(await WebAssembly.instantiate(wasm, imports), wasm);
        } catch (error) {
          reject(error);
        }
      };
      void start();
      return {};
    },
    onAbort: (reason) => reject(new Error(`7-Zip stopped: ${String(reason)}`)),
    onExit: (code) => {
      exit.code = code;
    },
    print: (s) => stdout.push(s),
    printErr: (s) => stderr.push(s),
  });
  return Promise.race([ready, failed]);
};

const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";

/**
 * Mount the inputs under IN. WORKERFS makes a file's folders as it places
 * the file, but has no way to make a folder with nothing in it, so those
 * are made with its own node constructor. Times and modes are set after,
 * on every node, since WORKERFS gives each file 0777 and the mount's time.
 */
const mountInputs = (m: Js7z, inputs: Input[]) => {
  m.FS.mkdir(IN);
  const blobs = inputs.flatMap((i) =>
    i.blob ? [{ data: i.blob, name: i.path }] : []
  );
  m.FS.mount(m.WORKERFS, { blobs }, IN);
  const dirs = inputs
    .filter((i) => !i.blob)
    .toSorted((a, b) => a.path.length - b.path.length);
  for (const d of dirs) {
    const parts = d.path.split("/");
    for (const [n, name] of parts.entries()) {
      const at = `${IN}/${parts.slice(0, n + 1).join("/")}`;
      try {
        m.FS.stat(at);
      } catch {
        const parent = m.FS.lookupPath(parentOf(at)).node;
        m.WORKERFS.createNode(parent, name, m.WORKERFS.DIR_MODE, 0);
      }
    }
  }
  for (const i of inputs) {
    const at = `${IN}/${i.path}`;
    m.FS.chmod(at, i.mode ?? (i.blob ? FILE_MODE : DIR_MODE));
    if (i.mtime !== undefined) {
      m.FS.utime(at, i.mtime, i.mtime);
    }
  }
};

/** Everything under OUT, folders included, as Outputs. */
const collect = (m: Js7z): Output[] => {
  const out: Output[] = [];
  const walk = (dir: string, rel: string) => {
    let names: string[];
    try {
      names = m.FS.readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === "." || name === "..") {
        continue;
      }
      const at = `${dir}/${name}`;
      const path = rel ? `${rel}/${name}` : name;
      const st = m.FS.stat(at);
      const mtime = new Date(st.mtime).getTime();
      const mode = st.mode % MODE_SPAN;
      if (m.FS.isDir(st.mode)) {
        out.push({ mode, mtime, path });
        walk(at, path);
      } else {
        // A copy: the instance's memory goes when the command is done.
        out.push({ blob: new Blob([m.FS.readFile(at)]), mode, mtime, path });
      }
    }
  };
  walk(OUT, "");
  return out;
};

const run = async (msg: Extract<WorkerRequest, { type: "run" }>) => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exit: { code: number | null } = { code: null };
  const m = await boot(stdout, stderr, exit);
  mountInputs(m, msg.inputs);
  m.FS.mkdir(OUT);
  m.FS.chdir(msg.cwd);

  // Progress is the share of the inputs read: 7-Zip reads an archive, or
  // the files it packs, front to back, and prints nothing a worker could
  // use until the end.
  let read = 0;
  let posted = 0;
  const original = m.FS.read.bind(m.FS);
  m.FS.read = (stream, buffer, offset, length, position) => {
    const n = original(stream, buffer, offset, length, position);
    if (stream.path?.startsWith(`${IN}/`)) {
      read += n;
      const now = performance.now();
      if (now - posted > PROGRESS_MS) {
        posted = now;
        post({ read, type: "progress" });
      }
    }
    return n;
  };

  // callMain puts the program name in front of the array it is given.
  let code: number;
  try {
    code = m.callMain([...msg.args]);
  } catch (error) {
    stderr.push(
      `ERROR: ${error instanceof Error ? error.message : String(error)}`
    );
    code = 2;
  }
  post({
    code: exit.code ?? code,
    outputs: msg.collect ? collect(m) : [],
    stderr,
    stdout,
    type: "ran",
  });
};

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  try {
    if (msg.type === "load") {
      await load(msg);
      post({ type: "loaded" });
    } else {
      await run(msg);
    }
  } catch (error) {
    post({
      message: error instanceof Error ? error.message : String(error),
      type: "error",
    });
  }
};
