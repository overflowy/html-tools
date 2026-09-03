// The Engines the Markdown Editor fetches: the math typesetter (KaTeX, with
// its stylesheet and fonts), the diagram renderer (Mermaid), and the
// formatter (Prettier with its Markdown plugin). None is fetched before it
// is needed: math reads as its source and a mermaid fence is an ordinary
// code block until then, and the formatter arrives on the first Format.

import { getEngine, type EngineAsset, type Progress } from "../../shared/engines";

export const KATEX_VERSION = "0.18.5";
export const MERMAID_VERSION = "11.17.2";
export const PRETTIER_VERSION = "3.9.6";

const NPM = "https://cdn.jsdelivr.net/npm/";
const KATEX = `${NPM}katex@${KATEX_VERSION}/dist/`;

export const ENGINES = {
  katex: {
    id: "katex", label: "KaTeX", version: KATEX_VERSION,
    url: `${KATEX}katex.min.js`, approxBytes: 272_000,
  },
  katexCss: {
    id: "katex-css", label: "KaTeX styles", version: KATEX_VERSION,
    url: `${KATEX}katex.min.css`, approxBytes: 23_000,
  },
  mermaid: {
    id: "mermaid", label: "Mermaid", version: MERMAID_VERSION,
    url: `${NPM}mermaid@${MERMAID_VERSION}/dist/mermaid.min.js`, approxBytes: 3_570_000,
  },
  prettier: {
    id: "prettier", label: "Prettier", version: PRETTIER_VERSION,
    url: `${NPM}prettier@${PRETTIER_VERSION}/standalone.mjs`, approxBytes: 82_000,
  },
  prettierMarkdown: {
    id: "prettier-markdown", label: "Prettier Markdown plugin", version: PRETTIER_VERSION,
    url: `${NPM}prettier@${PRETTIER_VERSION}/plugins/markdown.mjs`, approxBytes: 292_000,
  },
} satisfies Record<string, EngineAsset>;

/** One of KaTeX's fonts, named as its stylesheet names it. */
function katexFont(name: string): EngineAsset {
  return {
    id: "katex-font-" + name, label: "KaTeX font " + name, version: KATEX_VERSION,
    url: `${KATEX}fonts/${name}.woff2`, approxBytes: 13_000,
  };
}

export interface KatexApi {
  renderToString(tex: string, options: { displayMode?: boolean; throwOnError?: boolean }): string;
}

export interface MermaidApi {
  initialize(config: { startOnLoad: boolean; securityLevel: string; theme: string; fontFamily: string }): void;
  render(id: string, text: string): Promise<{ svg: string }>;
}

/** Formats Markdown source in Prettier's style. */
export type Formatter = (src: string) => Promise<string>;

/** Bytes loaded so far across everything one Engine needs, for a status line. */
export type LoadProgress = (loaded: number, total: number) => void;

const globals = globalThis as unknown as { katex?: KatexApi; mermaid?: MermaidApi };

export const katex = () => globals.katex ?? null;
export const mermaid = () => globals.mermaid ?? null;

/** Runs a classic script from its bytes. A blob: URL keeps the source out of a data: URL's size limits. */
async function runScript(bytes: ArrayBuffer): Promise<void> {
  const url = URL.createObjectURL(new Blob([bytes], { type: "text/javascript" }));
  try {
    await new Promise<void>((resolve, reject) => {
      const s = document.createElement("script");
      s.src = url;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("The script could not be run."));
      document.head.appendChild(s);
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Progress across several assets fetched together, summed for one status line. */
function combined(onProgress?: LoadProgress) {
  const seen = new Map<string, Progress>();
  return (p: Progress) => {
    seen.set(p.asset.id, p);
    let loaded = 0, total = 0;
    for (const q of seen.values()) {
      loaded += q.loaded;
      total += q.total;
    }
    onProgress?.(loaded, total);
  };
}

let mathLoading: Promise<KatexApi> | null = null;

/**
 * KaTeX, its stylesheet, and its fonts. The stylesheet points at the fonts by
 * relative URL, which means nothing inside a single file; each font is fetched
 * and registered with the document directly, and the stylesheet goes in with
 * its @font-face rules removed.
 */
export function loadMath(onProgress?: LoadProgress): Promise<KatexApi> {
  const ready = katex();
  if (ready) return Promise.resolve(ready);
  if (mathLoading) return mathLoading;
  const report = combined(onProgress);
  mathLoading = (async () => {
    const [js, cssBytes] = await Promise.all([getEngine(ENGINES.katex, report), getEngine(ENGINES.katexCss, report)]);
    let css = new TextDecoder().decode(cssBytes);
    const faces: { family: string; style: string; weight: string; file: string }[] = [];
    css = css.replace(/@font-face\{([^}]*)\}/g, (_m, body: string) => {
      const family = /font-family:([^;]+)/.exec(body)?.[1];
      const file = /url\(fonts\/([\w-]+)\.woff2\)/.exec(body)?.[1];
      if (family && file) {
        faces.push({
          family,
          style: /font-style:([^;]+)/.exec(body)?.[1] ?? "normal",
          weight: /font-weight:([^;]+)/.exec(body)?.[1] ?? "400",
          file,
        });
      }
      return "";
    });
    const fonts = await Promise.all(faces.map((f) => getEngine(katexFont(f.file), report)));
    faces.forEach((f, i) => {
      document.fonts.add(new FontFace(f.family, fonts[i]!, { style: f.style, weight: f.weight, display: "block" }));
    });
    const style = document.createElement("style");
    style.dataset.engine = "katex";
    style.textContent = css;
    document.head.appendChild(style);
    await runScript(js);
    const api = katex();
    if (!api) throw new Error("KaTeX did not load.");
    return api;
  })();
  mathLoading.catch(() => (mathLoading = null));
  return mathLoading;
}

let diagramsLoading: Promise<MermaidApi> | null = null;

export function loadDiagrams(onProgress?: LoadProgress): Promise<MermaidApi> {
  const ready = mermaid();
  if (ready) return Promise.resolve(ready);
  if (diagramsLoading) return diagramsLoading;
  diagramsLoading = (async () => {
    await runScript(await getEngine(ENGINES.mermaid, combined(onProgress)));
    const api = mermaid();
    if (!api) throw new Error("Mermaid did not load.");
    return api;
  })();
  diagramsLoading.catch(() => (diagramsLoading = null));
  return diagramsLoading;
}

/** Imports an ES module from its bytes. */
async function importModule<T>(bytes: ArrayBuffer): Promise<T> {
  const url = URL.createObjectURL(new Blob([bytes], { type: "text/javascript" }));
  try {
    return (await import(url)) as T;
  } finally {
    URL.revokeObjectURL(url);
  }
}

interface PrettierModule {
  format(src: string, options: { parser: string; plugins: unknown[] }): Promise<string>;
}

let formatterLoading: Promise<Formatter> | null = null;

export function loadFormatter(onProgress?: LoadProgress): Promise<Formatter> {
  if (formatterLoading) return formatterLoading;
  const report = combined(onProgress);
  formatterLoading = (async () => {
    const [core, plugin] = await Promise.all([getEngine(ENGINES.prettier, report), getEngine(ENGINES.prettierMarkdown, report)]);
    const [prettier, markdown] = await Promise.all([importModule<PrettierModule>(core), importModule<unknown>(plugin)]);
    return (src) => prettier.format(src, { parser: "markdown", plugins: [markdown] });
  })();
  formatterLoading.catch(() => (formatterLoading = null));
  return formatterLoading;
}
