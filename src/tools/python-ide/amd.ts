// A small AMD loader for Monaco's `min/vs` build. Monaco ships chunks that
// each call `define("vs/<id>", [deps], factory)`; its own loader fetches them
// by URL, which is no use for chunks already sitting in the Engine cache. This
// one runs cached chunk sources up front so their defines register, then
// instantiates modules from the registry, and only fetches from the CDN for
// an id nothing registered (a language tokenizer Monaco asks for lazily).
//
// `define` is installed on the global only while chunks are being run: UMD
// libraries the other Tools load look for `define.amd`, and must not find it.

type Factory = (...deps: unknown[]) => unknown;

interface Definition {
  id: string;
  deps: string[];
  factory: Factory | object;
}

interface Plugin {
  load: (
    name: string,
    req: LocalRequire,
    onload: (value: unknown) => void,
    config: object
  ) => void;
}

interface LocalRequire {
  (
    deps: string[],
    callback?: (...mods: unknown[]) => void,
    onError?: (e: unknown) => void
  ): void;
  (dep: string): unknown;
  toUrl: (path: string) => string;
}

export interface AmdOptions {
  /** Where `<id>.js` lives when it is not in the registry. */
  cdnBase: string;
  /** What `require.toUrl` answers for a resolved path such as `vs/editor/editor.main.css`. */
  toUrl: (path: string) => string;
}

const scope = globalThis as unknown as { define?: unknown };

/** `id` resolved against the module `from` when it is relative (`./x`, `../x`). */
const resolveId = (id: string, from?: string): string => {
  if (!from || !(id.startsWith("./") || id.startsWith("../"))) {
    return id;
  }
  const parts = from.split("/");
  parts.pop();
  for (const seg of id.split("/")) {
    if (seg === ".") {
      continue;
    }
    if (seg === "..") {
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.join("/");
};

/**
 * Runs a chunk's source as the body of a sloppy-mode function, as
 * `new Function(src)()` would: its top-level names stay its own, and `this`
 * is the global. An inline script runs synchronously on insertion but
 * reports what it throws as an error event rather than to the caller, so
 * that event is caught and its error thrown here.
 */
const runChunk = (src: string) => {
  const script = document.createElement("script");
  script.textContent = `(function () {\n${src}\n})();`;
  const thrown: unknown[] = [];
  const onError = (e: ErrorEvent) => {
    thrown.push(e.error);
    e.preventDefault();
  };
  window.addEventListener("error", onError);
  try {
    document.head.append(script);
  } finally {
    window.removeEventListener("error", onError);
    script.remove();
  }
  if (thrown.length > 0) {
    throw thrown[0];
  }
};

export class AmdLoader {
  private definitions = new Map<string, Definition>();
  private modules = new Map<string, unknown>();
  private loading = new Map<string, Promise<unknown>>();
  private fetching = new Map<string, Promise<void>>();

  private options: AmdOptions;

  constructor(options: AmdOptions) {
    this.options = options;
  }

  /** Runs chunk sources so their `define` calls register. */
  defineFrom(sources: string[]) {
    this.withDefine(() => {
      for (const src of sources) {
        runChunk(src);
      }
    });
  }

  /** Loads modules by id, the ids resolved relative to `from` when given. */
  require(ids: string[], from?: string): Promise<unknown[]> {
    return Promise.all(ids.map((id) => this.load(resolveId(id, from))));
  }

  private defineUsers = 0;
  private previousDefine: unknown;

  /** Installs `define` for the duration of a chunk run; nested and concurrent uses share one install. */
  private installDefine() {
    this.defineUsers += 1;
    if (this.defineUsers === 1) {
      this.previousDefine = scope.define;
      // `define(id, factory)` leaves out the dependencies.
      scope.define = (
        id: string,
        depsOrFactory: string[] | Factory,
        maybeFactory?: Factory | object
      ) => {
        const noDeps =
          typeof depsOrFactory === "function" ||
          (depsOrFactory && !Array.isArray(depsOrFactory));
        this.definitions.set(id, {
          deps: noDeps ? [] : (depsOrFactory as string[]),
          factory: (noDeps ? depsOrFactory : maybeFactory) as Factory | object,
          id,
        });
      };
    }
    return () => {
      this.defineUsers -= 1;
      if (this.defineUsers === 0) {
        scope.define = this.previousDefine;
      }
    };
  }

  private withDefine(run: () => void) {
    const release = this.installDefine();
    try {
      run();
    } finally {
      release();
    }
  }

  private load(id: string): Promise<unknown> {
    if (this.modules.has(id)) {
      return Promise.resolve(this.modules.get(id));
    }
    const inFlight = this.loading.get(id);
    if (inFlight) {
      return inFlight;
    }
    const p = this.instantiate(id);
    this.loading.set(id, p);
    p.then(() => this.loading.delete(id)).catch(() => this.loading.delete(id));
    return p;
  }

  private async instantiate(id: string): Promise<unknown> {
    const bang = id.indexOf("!");
    if (bang !== -1) {
      const plugin = (await this.load(id.slice(0, bang))) as Plugin;
      const loaded = Promise.withResolvers<unknown>();
      plugin.load(
        id.slice(bang + 1),
        this.localRequire(id),
        loaded.resolve,
        {}
      );
      const value = await loaded.promise;
      this.modules.set(id, value);
      return value;
    }
    if (!this.definitions.has(id)) {
      await this.fetch(id);
    }
    const def = this.definitions.get(id);
    if (!def) {
      throw new Error(`Monaco module ${id} did not define itself.`);
    }
    if (typeof def.factory !== "function") {
      this.modules.set(id, def.factory);
      return def.factory;
    }
    const exports: Record<string, unknown> = {};
    // Registered before the dependencies load, so a cycle sees this object.
    this.modules.set(id, exports);
    const args: unknown[] = [];
    for (const dep of def.deps) {
      if (dep === "exports") {
        args.push(exports);
      } else if (dep === "require") {
        args.push(this.localRequire(id));
      } else if (dep === "module") {
        args.push({ exports, id });
      } else {
        args.push(await this.load(resolveId(dep, id)));
      }
    }
    const result = def.factory(...args);
    if (result !== undefined) {
      this.modules.set(id, result);
    }
    return this.modules.get(id);
  }

  private localRequire(from: string): LocalRequire {
    const req = ((
      deps: string | string[],
      onLoaded?: (...mods: unknown[]) => void,
      onError?: (e: unknown) => void
    ) => {
      if (typeof deps === "string") {
        const id = resolveId(deps, from);
        if (!this.modules.has(id)) {
          throw new Error(`Monaco module ${id} is not loaded yet.`);
        }
        return this.modules.get(id);
      }
      // A throw from onLoaded is not handed to onError.
      const settle = async () => {
        let mods: unknown[];
        try {
          mods = await this.require(deps, from);
        } catch (error) {
          onError?.(error);
          return;
        }
        onLoaded?.(...mods);
      };
      void settle();
    }) as LocalRequire;
    req.toUrl = (path) => this.options.toUrl(resolveId(path, from));
    return req;
  }

  /** A chunk not in the cache: a classic script from the CDN, with `define` live while it runs. */
  private fetch(id: string): Promise<void> {
    const existing = this.fetching.get(id);
    if (existing) {
      return existing;
    }
    const { promise: p, resolve, reject } = Promise.withResolvers<undefined>();
    const release = this.installDefine();
    const s = document.createElement("script");
    const done = () => {
      release();
      s.remove();
    };
    s.src = `${this.options.cdnBase + id}.js`;
    s.onload = () => {
      done();
      resolve(undefined);
    };
    s.onerror = () => {
      done();
      reject(new Error(`Could not load Monaco module ${id} from the CDN.`));
    };
    document.head.append(s);
    this.fetching.set(id, p);
    p.then(() => this.fetching.delete(id)).catch(() =>
      this.fetching.delete(id)
    );
    return p;
  }
}
