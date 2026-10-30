// Markdown to a Rendered Document: GitHub-Flavored Markdown with footnotes,
// callouts, syntax highlighting, math, and diagrams, sanitized so untrusted
// Markdown cannot run script. Math and diagrams need Engines; until those are
// loaded, math reads as its source and a mermaid fence is a code block, and
// the result says which Engine the Draft is waiting for.

import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import infoIcon from "lucide-static/icons/info.svg";
import lightbulbIcon from "lucide-static/icons/lightbulb.svg";
import messageSquareWarningIcon from "lucide-static/icons/message-square-warning.svg";
import octagonAlertIcon from "lucide-static/icons/octagon-alert.svg";
import triangleAlertIcon from "lucide-static/icons/triangle-alert.svg";
import { Marked } from "marked";

import { katex, mermaid } from "./engines";
import { extractMath, injectMath } from "./math";
import type { MathItem } from "./math";

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

export const escapeHtml = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/* ---- footnotes ----
   marked has none, and [^1] references are common in specs and papers. A
   reference with no definition stays literal text. Definition bodies are
   rendered by a second, hook-free instance so they can never re-enter the
   main parse. */

const plain = new Marked({ gfm: true });
let fnDefs = new Map<string, string>();
let fnOrder: string[] = [];

const md = new Marked({ breaks: false, gfm: true });
md.use({
  extensions: [
    {
      level: "inline",
      name: "footnoteRef",
      renderer(token) {
        let i = fnOrder.indexOf(token.label as string);
        if (i === -1) {
          fnOrder.push(token.label as string);
          i = fnOrder.length - 1;
        }
        const n = i + 1;
        return `<sup class="fn-ref" id="fnref-${n}"><a href="#fn-${n}">${
          n
        }</a></sup>`;
      },
      start(src) {
        return src.indexOf("[^");
      },
      tokenizer(src) {
        const m = /^\[\^(?<label>[^\]\n]+)\]/u.exec(src);
        if (!m) {
          return;
        }
        const label = (m.groups?.label ?? "").trim();
        if (!fnDefs.has(label)) {
          return;
        }
        return { label, raw: m[0], type: "footnoteRef" };
      },
    },
  ],
  hooks: {
    postprocess(html) {
      if (!fnOrder.length) {
        return html;
      }
      let out = '<section class="footnotes"><ol>';
      for (const [i, label] of fnOrder.entries()) {
        const n = i + 1;
        out += `<li id="fn-${n}">${
          plain.parseInline(fnDefs.get(label) ?? "") as string
        } <a class="fn-back" href="#fnref-${
          n
        }" title="Back to text">&#8617;</a></li>`;
      }
      return `${html + out}</ol></section>`;
    },
    preprocess(src) {
      fnDefs = new Map();
      fnOrder = [];
      // "[^label]: body", continued by indented lines
      return src.replaceAll(
        /^\[\^(?<label>[^\]\n]+)\]:[ \t]*(?<body>[^\n]*(?:\n(?:[ \t]{2,}|\t)[^\n]*)*)/gmu,
        (_m, label: string, body: string) => {
          fnDefs.set(label.trim(), body.replaceAll(/\n[ \t]+/gu, "\n").trim());
          return "";
        }
      );
    },
  },
});

/* ---- callouts: > [!NOTE] and its kin ---- */

// Callout icons, the ones GitHub gives each kind: an octagon with a mark for
// caution, a speech bubble with a mark for important, an info disc for note,
// a bulb for tip, a triangle with a mark for warning.
const CALLOUTS: Record<string, [string, string]> = {
  caution: ["Caution", octagonAlertIcon],
  important: ["Important", messageSquareWarningIcon],
  note: ["Note", infoIcon],
  tip: ["Tip", lightbulbIcon],
  warning: ["Warning", triangleAlertIcon],
};

const transformCallout = (bq: HTMLQuoteElement) => {
  const p = bq.firstElementChild;
  const first = p?.firstChild;
  if (!p || p.tagName !== "P" || !first || first.nodeType !== Node.TEXT_NODE) {
    return;
  }
  const m = /^\[!(?<kind>NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/iu.exec(
    first.nodeValue ?? ""
  );
  const kind = m?.groups?.kind?.toLowerCase();
  const callout = kind === undefined ? undefined : CALLOUTS[kind];
  if (!(m && callout)) {
    return;
  }
  first.nodeValue = (first.nodeValue ?? "").slice(m[0].length);
  if (!first.nodeValue) {
    first.remove();
  }
  if (p.firstChild && p.firstChild.nodeName === "BR") {
    p.firstChild.remove();
  }
  if (!p.hasChildNodes()) {
    p.remove();
  }
  bq.classList.add("callout", `callout-${kind}`);
  const title = document.createElement("div");
  title.className = "callout-title";
  const [label, icon] = callout;
  title.innerHTML = icon + label;
  bq.prepend(title);
};

const transformCallouts = (root: HTMLElement) => {
  for (const bq of root.querySelectorAll("blockquote")) {
    transformCallout(bq);
  }
};

/* ---- ids ----
   Everything the document names gets an `md-` prefix, so a heading called
   "Sidebar" can never collide with the Shell's own ids, and links within the
   document are rewritten to match. */

const namespaceIds = (root: HTMLElement) => {
  for (const el of root.querySelectorAll<HTMLElement>("[id]")) {
    el.id = `md-${el.id}`;
  }
  for (const a of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("#")) {
      a.setAttribute("href", `#md-${href.slice(1)}`);
    } else {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
    }
  }
};

const renderMathItem = (item: MathItem): Node => {
  const api = katex();
  if (!api) {
    return document.createTextNode(item.raw);
  }
  const holder = document.createElement(item.display ? "div" : "span");
  if (item.display) {
    holder.className = "katex-block";
  }
  let html: string;
  try {
    html = api.renderToString(item.tex, {
      displayMode: item.display,
      throwOnError: false,
    });
  } catch {
    html = `<span class="math-err">${escapeHtml(item.tex)}</span>`;
  }
  holder.innerHTML = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true, mathMl: true, svg: true },
  });
  return holder;
};

const highlight = (root: HTMLElement) => {
  for (const code of root.querySelectorAll<HTMLElement>("pre > code")) {
    const lang = /language-(?<lang>[\w-]+)/u.exec(code.className)?.groups?.lang;
    if (!lang || lang === "mermaid" || !hljs.getLanguage(lang)) {
      continue;
    }
    try {
      code.innerHTML = hljs.highlight(code.textContent ?? "", {
        language: lang,
      }).value;
      code.classList.add("hljs");
    } catch {
      // left plain
    }
  }
};

let mermaidSeq = 0;

const drawDiagrams = async (
  jobs: { div: HTMLElement; src: string }[],
  light: boolean
) => {
  const api = mermaid();
  if (!api) {
    return;
  }
  const sans = getComputedStyle(document.documentElement)
    .getPropertyValue("--sans")
    .trim();
  // Mermaid sizes every box to its label as measured now, so the face has to be in.
  await document.fonts.load(`16px ${sans}`);
  api.initialize({
    fontFamily: sans,
    securityLevel: "strict",
    startOnLoad: false,
    theme: light ? "default" : "dark",
  });
  for (const { div, src } of jobs) {
    mermaidSeq += 1;
    const id = `mmd-${mermaidSeq}`;
    try {
      const { svg } = await api.render(id, src);
      // a newer render replaced the document meanwhile
      if (!div.isConnected) {
        return;
      }
      div.innerHTML = svg;
    } catch (error) {
      // mermaid leaves its scratch element behind when a diagram fails to parse
      document.querySelector(`#d${id}`)?.remove();
      const pre = document.createElement("pre");
      pre.className = "mermaid-err";
      pre.textContent = `${src}\n\n${
        error instanceof Error
          ? error.message
          : "The diagram could not be drawn."
      }`;
      div.replaceChildren(pre);
    }
  }
};

/** Renders `src` into `root`, replacing what was there. */
export const renderMarkdown = (
  src: string,
  root: HTMLElement,
  opts: RenderOptions
): RenderResult => {
  const { src: stripped, math } = extractMath(src);
  root.innerHTML = DOMPurify.sanitize(md.parse(stripped) as string);
  namespaceIds(root);
  injectMath(root, math, renderMathItem);
  transformCallouts(root);
  highlight(root);
  for (const cb of root.querySelectorAll('li > input[type="checkbox"]')) {
    cb.closest("li")?.classList.add("task");
  }

  const jobs: { div: HTMLElement; src: string }[] = [];
  const fences = root.querySelectorAll<HTMLElement>(
    "pre > code.language-mermaid"
  );
  if (mermaid()) {
    for (const code of fences) {
      const pre = code.parentElement;
      if (!pre) {
        throw new Error("A mermaid fence is not inside a pre element.");
      }
      const div = document.createElement("div");
      div.className = "mermaid-block";
      jobs.push({ div, src: code.textContent ?? "" });
      pre.replaceWith(div);
    }
  }
  // Every remaining code block gets a Copy button; the click is handled by the Tool.
  for (const pre of root.querySelectorAll<HTMLElement>("pre")) {
    const wrap = document.createElement("div");
    wrap.className = "code-wrap";
    pre.replaceWith(wrap);
    wrap.append(pre);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "copy-btn inline";
    btn.textContent = "Copy";
    btn.title = "Copy this code block";
    wrap.append(btn);
  }
  const needsMath = math.length > 0 && !katex();
  const needsDiagrams = fences.length > 0 && !mermaid();
  return {
    diagrams: jobs.length ? drawDiagrams(jobs, opts.light) : Promise.resolve(),
    needsDiagrams,
    needsMath,
  };
};

export interface Heading {
  id: string;
  level: number;
  text: string;
}

/** Gives every heading (levels 1 to 4) a stable id and lists them for Contents. */
export const headings = (root: HTMLElement): Heading[] => {
  const used = new Set<string>();
  const out: Heading[] = [];
  for (const h of root.querySelectorAll<HTMLHeadingElement>("h1, h2, h3, h4")) {
    const text = (h.textContent ?? "").trim();
    // Astral characters (emoji, math letters) are kept, as are lone surrogates.
    let id = `md-${
      text
        .toLowerCase()
        .replaceAll(/[^\w\u{C0}-\u{10FFFF}]+/gu, "-")
        .replaceAll(/^-+|-+$/gu, "") || "section"
    }`;
    while (used.has(id)) {
      id += "-";
    }
    used.add(id);
    h.id = id;
    out.push({ id, level: Number(h.tagName.charAt(1)), text });
  }
  return out;
};
