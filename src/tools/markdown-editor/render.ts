// Markdown to a Rendered Document: GitHub-Flavored Markdown with footnotes,
// callouts, syntax highlighting, math, and diagrams, sanitized so untrusted
// Markdown cannot run script. Math and diagrams need Engines; until those are
// loaded, math reads as its source and a mermaid fence is a code block, and
// the result says which Engine the Draft is waiting for.

import { Marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { extractMath, injectMath, type MathItem } from "./math";
import { katex, mermaid } from "./engines";

export interface RenderOptions {
  /** Light Document: diagrams bake their palette into the SVG, so they need to know. */
  light: boolean;
}

export interface RenderResult {
  /** The Draft has math but the typesetter is not loaded. */
  needsMath: boolean;
  /** The Draft has a diagram but the renderer is not loaded. */
  needsDiagrams: boolean;
  /** Settles when every diagram is drawn; printing waits for it. */
  diagrams: Promise<void>;
}

export function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/* ---- footnotes ----
   marked has none, and [^1] references are common in specs and papers. A
   reference with no definition stays literal text. Definition bodies are
   rendered by a second, hook-free instance so they can never re-enter the
   main parse. */

const plain = new Marked({ gfm: true });
let fnDefs = new Map<string, string>();
let fnOrder: string[] = [];

const md = new Marked({ gfm: true, breaks: false });
md.use({
  hooks: {
    preprocess(src) {
      fnDefs = new Map();
      fnOrder = [];
      // "[^label]: body", continued by indented lines
      return src.replace(/^\[\^([^\]\n]+)\]:[ \t]*([^\n]*(?:\n(?:[ \t]{2,}|\t)[^\n]*)*)/gm, (_m, label: string, body: string) => {
        fnDefs.set(label.trim(), body.replace(/\n[ \t]+/g, "\n").trim());
        return "";
      });
    },
    postprocess(html) {
      if (!fnOrder.length) return html;
      let out = '<section class="footnotes"><ol>';
      fnOrder.forEach((label, i) => {
        const n = i + 1;
        out += '<li id="fn-' + n + '">' + (plain.parseInline(fnDefs.get(label) ?? "") as string) +
          ' <a class="fn-back" href="#fnref-' + n + '" title="Back to text">&#8617;</a></li>';
      });
      return html + out + "</ol></section>";
    },
  },
  extensions: [{
    name: "footnoteRef",
    level: "inline",
    start(src) {
      return src.indexOf("[^");
    },
    tokenizer(src) {
      const m = /^\[\^([^\]\n]+)\]/.exec(src);
      if (!m) return undefined;
      const label = m[1]!.trim();
      if (!fnDefs.has(label)) return undefined;
      return { type: "footnoteRef", raw: m[0], label };
    },
    renderer(token) {
      let i = fnOrder.indexOf(token.label as string);
      if (i === -1) {
        fnOrder.push(token.label as string);
        i = fnOrder.length - 1;
      }
      const n = i + 1;
      return '<sup class="fn-ref" id="fnref-' + n + '"><a href="#fn-' + n + '">' + n + "</a></sup>";
    },
  }],
});

/* ---- callouts: > [!NOTE] and its kin ---- */

// Callout icons on a 16px grid: a bookmark, a sparkle, a framed mark, a diamond mark, a barred disc.
const CO = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
const CALLOUTS: Record<string, [string, string]> = {
  note: ["Note", CO + '<path d="M4 2h8v12l-4-3-4 3z"/></svg>'],
  tip: ["Tip", CO + '<path d="M8 2l1.5 4.5L14 8l-4.5 1.5L8 14l-1.5-4.5L2 8l4.5-1.5z"/></svg>'],
  important: ["Important", CO + '<rect x="2" y="2" width="12" height="12" rx="3"/><path d="M8 5v4M8 11.5v.01"/></svg>'],
  warning: ["Warning", CO + '<path d="M8 1.5l6.5 6.5-6.5 6.5L1.5 8z"/><path d="M8 5v3.5M8 11v.01"/></svg>'],
  caution: ["Caution", CO + '<circle cx="8" cy="8" r="6"/><path d="M3.8 3.8l8.4 8.4"/></svg>'],
};

function transformCallouts(root: HTMLElement) {
  root.querySelectorAll("blockquote").forEach((bq) => {
    const p = bq.firstElementChild;
    const first = p?.firstChild;
    if (!p || p.tagName !== "P" || !first || first.nodeType !== Node.TEXT_NODE) return;
    const m = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i.exec(first.nodeValue ?? "");
    if (!m) return;
    const kind = m[1]!.toLowerCase();
    first.nodeValue = (first.nodeValue ?? "").slice(m[0].length);
    if (!first.nodeValue) first.remove();
    if (p.firstChild && p.firstChild.nodeName === "BR") p.firstChild.remove();
    if (!p.hasChildNodes()) p.remove();
    bq.classList.add("callout", "callout-" + kind);
    const title = document.createElement("div");
    title.className = "callout-title";
    title.innerHTML = CALLOUTS[kind]![1] + CALLOUTS[kind]![0];
    bq.prepend(title);
  });
}

/* ---- ids ----
   Everything the document names gets an `md-` prefix, so a heading called
   "Sidebar" can never collide with the Shell's own ids, and links within the
   document are rewritten to match. */

function namespaceIds(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>("[id]").forEach((el) => {
    el.id = "md-" + el.id;
  });
  root.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((a) => {
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("#")) {
      a.setAttribute("href", "#md-" + href.slice(1));
    } else {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
    }
  });
}

function renderMathItem(item: MathItem): Node {
  const api = katex();
  if (!api) return document.createTextNode(item.raw);
  const holder = document.createElement(item.display ? "div" : "span");
  if (item.display) holder.className = "katex-block";
  let html: string;
  try {
    html = api.renderToString(item.tex, { displayMode: item.display, throwOnError: false });
  } catch {
    html = '<span class="math-err">' + escapeHtml(item.tex) + "</span>";
  }
  holder.innerHTML = DOMPurify.sanitize(html, { USE_PROFILES: { html: true, mathMl: true, svg: true } });
  return holder;
}

function highlight(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>("pre > code").forEach((code) => {
    const lang = /language-([\w-]+)/.exec(code.className)?.[1];
    if (!lang || lang === "mermaid" || !hljs.getLanguage(lang)) return;
    try {
      code.innerHTML = hljs.highlight(code.textContent ?? "", { language: lang }).value;
      code.classList.add("hljs");
    } catch {
      // left plain
    }
  });
}

let mermaidSeq = 0;

async function drawDiagrams(jobs: { div: HTMLElement; src: string }[], light: boolean) {
  const api = mermaid();
  if (!api) return;
  api.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: light ? "default" : "dark",
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif",
  });
  for (const { div, src } of jobs) {
    const id = "mmd-" + ++mermaidSeq;
    try {
      const { svg } = await api.render(id, src);
      if (!div.isConnected) return; // a newer render replaced the document meanwhile
      div.innerHTML = svg;
    } catch (e) {
      // mermaid leaves its scratch element behind when a diagram fails to parse
      document.getElementById("d" + id)?.remove();
      const pre = document.createElement("pre");
      pre.className = "mermaid-err";
      pre.textContent = src + "\n\n" + (e instanceof Error ? e.message : "The diagram could not be drawn.");
      div.replaceChildren(pre);
    }
  }
}

/** Renders `src` into `root`, replacing what was there. */
export function renderMarkdown(src: string, root: HTMLElement, opts: RenderOptions): RenderResult {
  const { src: stripped, math } = extractMath(src);
  root.innerHTML = DOMPurify.sanitize(md.parse(stripped) as string);
  namespaceIds(root);
  injectMath(root, math, renderMathItem);
  transformCallouts(root);
  highlight(root);
  root.querySelectorAll('li > input[type="checkbox"]').forEach((cb) => cb.closest("li")?.classList.add("task"));

  const jobs: { div: HTMLElement; src: string }[] = [];
  const fences = root.querySelectorAll<HTMLElement>("pre > code.language-mermaid");
  if (mermaid()) {
    fences.forEach((code) => {
      const div = document.createElement("div");
      div.className = "mermaid-block";
      jobs.push({ div, src: code.textContent ?? "" });
      code.parentElement!.replaceWith(div);
    });
  }
  return {
    needsMath: math.length > 0 && !katex(),
    needsDiagrams: fences.length > 0 && !mermaid(),
    diagrams: jobs.length ? drawDiagrams(jobs, opts.light) : Promise.resolve(),
  };
}

export interface Heading {
  id: string;
  level: number;
  text: string;
}

/** Gives every heading (levels 1 to 4) a stable id and lists them for Contents. */
export function headings(root: HTMLElement): Heading[] {
  const used = new Set<string>();
  const out: Heading[] = [];
  root.querySelectorAll<HTMLHeadingElement>("h1, h2, h3, h4").forEach((h) => {
    const text = (h.textContent ?? "").trim();
    let id = "md-" + (text.toLowerCase().replace(/[^\wÀ-￿]+/g, "-").replace(/^-+|-+$/g, "") || "section");
    while (used.has(id)) id += "-";
    used.add(id);
    h.id = id;
    out.push({ id, level: +h.tagName[1]!, text });
  });
  return out;
}
