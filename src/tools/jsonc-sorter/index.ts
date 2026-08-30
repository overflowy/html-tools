import "./tool.css";
import type { Tool } from "../../shell/types";

/* ---------------- tokenizer ---------------- */

type Tok = {
  type: "comment" | "string" | "punct" | "atom";
  text?: string;
  raw?: string;
  inner?: string;
  quote?: string;
  line: number;
};

function tokenize(src: string): Tok[] {
  const tokens: Tok[] = [];
  let i = 0, line = 1;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (c === "\n") { line++; i++; continue; }
    if (c === " " || c === "\t" || c === "\r" || c === "\f" || c === "\v" || c === " ") { i++; continue; }

    if (c === "/" && src[i + 1] === "/") {
      let j = i;
      while (j < n && src[j] !== "\n") j++;
      tokens.push({ type: "comment", text: src.slice(i, j), line });
      i = j;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      let j = i + 2;
      while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j++;
      if (j >= n) throw new SyntaxError("Unterminated block comment starting at line " + line);
      const text = src.slice(i, j + 2);
      tokens.push({ type: "comment", text, line });
      line += (text.match(/\n/g) || []).length;
      i = j + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === "\\") j++;
        if (src[j] === "\n") throw new SyntaxError("Unterminated string at line " + line);
        j++;
      }
      if (j >= n) throw new SyntaxError("Unterminated string at line " + line);
      tokens.push({ type: "string", raw: src.slice(i, j + 1), inner: src.slice(i + 1, j), quote: c, line });
      i = j + 1;
      continue;
    }
    if ("{}[]:,".includes(c)) {
      tokens.push({ type: "punct", text: c, line });
      i++;
      continue;
    }
    // number / true / false / null / anything atom-like
    let j = i;
    while (j < n && !/[\s{}\[\]:,"'\/]/.test(src[j]!)) j++;
    if (j === i) throw new SyntaxError("Unexpected character " + JSON.stringify(c) + " at line " + line);
    tokens.push({ type: "atom", text: src.slice(i, j), line });
    i = j;
  }
  return tokens;
}

/* ---------------- parser (comment-attaching) ---------------- */

type Node = any;

function parse(tokens: Tok[]) {
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function collectComments(): Tok[] {
    const out: Tok[] = [];
    while (peek() && peek()!.type === "comment") out.push(next()!);
    return out;
  }
  function takeSameLine(lineNo: number): Tok[] {
    const out: Tok[] = [];
    while (peek() && peek()!.type === "comment" && peek()!.line === lineNo) out.push(next()!);
    return out;
  }
  function expectPunct(ch: string): Tok {
    const t = next();
    if (!t || t.type !== "punct" || t.text !== ch) {
      const where = t ? "line " + t.line : "end of input";
      throw new SyntaxError("Expected '" + ch + "' at " + where);
    }
    return t;
  }

  function parseValue(): Node {
    const t = peek();
    if (!t) throw new SyntaxError("Unexpected end of input");
    if (t.type === "punct" && t.text === "{") return parseObject();
    if (t.type === "punct" && t.text === "[") return parseArray();
    if (t.type === "string") { next(); return { kind: "string", raw: t.raw, inner: t.inner, endLine: t.line }; }
    if (t.type === "atom") { next(); return { kind: "literal", raw: t.text, endLine: t.line }; }
    throw new SyntaxError("Unexpected token '" + t.text + "' at line " + t.line);
  }

  function parseObject(): Node {
    expectPunct("{");
    const props: Node[] = [];
    const dangling: Tok[] = [];
    let endLine;
    for (;;) {
      const leading = collectComments();
      const t = peek();
      if (!t) throw new SyntaxError("Unclosed object (missing '}')");
      if (t.type === "punct" && t.text === "}") {
        next();
        dangling.push(...leading);
        endLine = t.line;
        break;
      }
      if (t.type !== "string") throw new SyntaxError("Expected a quoted key at line " + t.line);
      const keyTok = next()!;
      leading.push(...collectComments());   // comments between key and ':' get kept, moved above the key
      expectPunct(":");
      leading.push(...collectComments());   // comments between ':' and value
      const value = parseValue();

      const trailing = takeSameLine(value.endLine);
      let hasComma = false;
      if (peek() && peek()!.type === "punct" && peek()!.text === ",") {
        const comma = next()!;
        hasComma = true;
        trailing.push(...takeSameLine(comma.line));
      }
      props.push({
        keyRaw: keyTok.raw,
        keyValue: decodeKey(keyTok),
        leading, trailing, value
      });
      if (!hasComma) {
        const dc = collectComments();
        const close = peek();
        if (close && close.type === "punct" && close.text === "}") {
          next();
          dangling.push(...dc);
          endLine = close.line;
          break;
        }
        const where = close ? "line " + close.line : "end of input";
        throw new SyntaxError("Expected ',' or '}' at " + where);
      }
    }
    return { kind: "object", props, dangling, endLine };
  }

  function parseArray(): Node {
    expectPunct("[");
    const items: Node[] = [];
    const dangling: Tok[] = [];
    let endLine;
    for (;;) {
      const leading = collectComments();
      const t = peek();
      if (!t) throw new SyntaxError("Unclosed array (missing ']')");
      if (t.type === "punct" && t.text === "]") {
        next();
        dangling.push(...leading);
        endLine = t.line;
        break;
      }
      const value = parseValue();
      const trailing = takeSameLine(value.endLine);
      let hasComma = false;
      if (peek() && peek()!.type === "punct" && peek()!.text === ",") {
        const comma = next()!;
        hasComma = true;
        trailing.push(...takeSameLine(comma.line));
      }
      items.push({ leading, trailing, value });
      if (!hasComma) {
        const dc = collectComments();
        const close = peek();
        if (close && close.type === "punct" && close.text === "]") {
          next();
          dangling.push(...dc);
          endLine = close.line;
          break;
        }
        const where = close ? "line " + close.line : "end of input";
        throw new SyntaxError("Expected ',' or ']' at " + where);
      }
    }
    return { kind: "array", items, dangling, endLine };
  }

  const leadingDoc = collectComments();
  const root = parseValue();
  const trailingDoc = collectComments();
  if (peek()) throw new SyntaxError("Unexpected token '" + (peek()!.text || peek()!.raw) + "' after end of document (line " + peek()!.line + ")");
  return { leadingDoc, root, trailingDoc };
}

function decodeKey(tok: Tok): string {
  if (tok.quote === '"') {
    try { return JSON.parse(tok.raw!); } catch { /* fall through */ }
  }
  return tok.inner!;
}

/* ---------------- sorting ---------------- */

const BRACKET_KEY = /^(\[[^\[\]]+\])+$/;

function cmpKeys(a: string, b: string) {
  return a.localeCompare(b, "en", { numeric: true, sensitivity: "variant" });
}

function sortTree(node: Node, order: string, sortBrackets: boolean) {
  if (node.kind === "object") {
    for (const p of node.props) {
      if (sortBrackets && BRACKET_KEY.test(p.keyValue)) {
        const segs = p.keyValue.match(/\[[^\[\]]+\]/g);
        const sorted = segs.slice().sort(cmpKeys);
        if (sorted.join("") !== p.keyValue) {
          p.keyValue = sorted.join("");
          p.keyRaw = JSON.stringify(p.keyValue);
        }
      }
      sortTree(p.value, order, sortBrackets);
    }
    node.props.sort((a: Node, b: Node) => cmpKeys(a.keyValue, b.keyValue) * (order === "desc" ? -1 : 1));
  } else if (node.kind === "array") {
    for (const it of node.items) sortTree(it.value, order, sortBrackets);
  }
}

/* ---------------- serializer ---------------- */

function serialize(doc: Node, indentStr: string): string {
  const out: string[] = [];
  const pad = (d: number) => indentStr.repeat(d);

  function pushComment(c: Tok, depth: number) {
    const ls = c.text!.split("\n");
    out.push(pad(depth) + ls[0]!.trim());
    for (let k = 1; k < ls.length; k++) {
      const t = ls[k]!.trim();
      out.push(pad(depth) + (t.startsWith("*") ? " " + t : t));
    }
  }
  function trailingStr(comments: Tok[]) {
    if (!comments.length) return "";
    return " " + comments.map((c) => c.text!.replace(/\s*\n\s*/g, " ").trim()).join(" ");
  }
  function inlineValue(v: Node): string | null {
    if (v.kind === "string" || v.kind === "literal") return v.raw;
    if (v.kind === "array" && v.items.length === 0 && v.dangling.length === 0) return "[]";
    if (v.kind === "object" && v.props.length === 0 && v.dangling.length === 0) return "{}";
    return null;
  }
  function tryInlineArray(node: Node, headLen: number): string | null {
    if (node.dangling.length) return null;
    const parts: string[] = [];
    for (const it of node.items) {
      if (it.leading.length || it.trailing.length) return null;
      const s = inlineValue(it.value);
      if (s === null) return null;
      parts.push(s);
    }
    const str = "[" + parts.join(", ") + "]";
    return headLen + str.length <= 80 ? str : null;
  }

  function writeValue(node: Node, depth: number, head: string, tail: string) {
    if (node.kind === "object") {
      if (node.props.length === 0 && node.dangling.length === 0) {
        out.push(head + "{}" + tail);
        return;
      }
      out.push(head + "{");
      node.props.forEach((p: Node, idx: number) => {
        const isLast = idx === node.props.length - 1;
        for (const c of p.leading) pushComment(c, depth + 1);
        const propTail = (isLast ? "" : ",") + trailingStr(p.trailing);
        writeValue(p.value, depth + 1, pad(depth + 1) + p.keyRaw + ": ", propTail);
      });
      for (const c of node.dangling) pushComment(c, depth + 1);
      out.push(pad(depth) + "}" + tail);
    } else if (node.kind === "array") {
      if (node.items.length === 0 && node.dangling.length === 0) {
        out.push(head + "[]" + tail);
        return;
      }
      const inline = tryInlineArray(node, head.length);
      if (inline !== null) {
        out.push(head + inline + tail);
        return;
      }
      out.push(head + "[");
      node.items.forEach((it: Node, idx: number) => {
        const isLast = idx === node.items.length - 1;
        for (const c of it.leading) pushComment(c, depth + 1);
        const itemTail = (isLast ? "" : ",") + trailingStr(it.trailing);
        writeValue(it.value, depth + 1, pad(depth + 1), itemTail);
      });
      for (const c of node.dangling) pushComment(c, depth + 1);
      out.push(pad(depth) + "]" + tail);
    } else {
      out.push(head + node.raw + tail);
    }
  }

  for (const c of doc.leadingDoc) pushComment(c, 0);
  writeValue(doc.root, 0, "", "");
  for (const c of doc.trailingDoc) pushComment(c, 0);
  return out.join("\n") + "\n";
}

/* ---------------- highlighter ---------------- */

function highlight(src: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const span = (cls: string, s: string) => '<span class="' + cls + '">' + esc(s) + "</span>";
  let html = "", i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    let m;
    if ((m = rest.match(/^\/\/[^\n]*/))) html += span("c", m[0]);
    else if ((m = rest.match(/^\/\*[\s\S]*?\*\//))) html += span("c", m[0]);
    else if ((m = rest.match(/^"(?:[^"\\\n]|\\.)*"/))) {
      const after = src.slice(i + m[0].length);
      html += span(/^\s*:/.test(after) ? "k" : "s", m[0]);
    }
    else if ((m = rest.match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/))) html += span("n", m[0]);
    else if ((m = rest.match(/^(?:true|false|null)\b/))) html += span("b", m[0]);
    else { html += esc(src[i]!); i++; continue; }
    i += m[0].length;
  }
  return html;
}

/* ---------------- stats ---------------- */

function countStats(node: Node, acc: { keys: number; comments: number }) {
  if (node.kind === "object") {
    acc.keys += node.props.length;
    for (const p of node.props) {
      acc.comments += p.leading.length + p.trailing.length;
      countStats(p.value, acc);
    }
    acc.comments += node.dangling.length;
  } else if (node.kind === "array") {
    for (const it of node.items) {
      acc.comments += it.leading.length + it.trailing.length;
      countStats(it.value, acc);
    }
    acc.comments += node.dangling.length;
  }
  return acc;
}

/* ---------------- UI ---------------- */

const EXAMPLE = `{
  // Zoom level for the whole window
  "window.zoomLevel": 1,
  /* Formatting rules shared
     across web languages */
  "[typescript][json][css][javascript][html][jsonc][typescriptreact]": {
    "editor.tabSize": 2, // spaces, not tabs
    "editor.formatOnSave": true
  },
  "editor.rulers": [80, 120],
  // Files to hide in the explorer
  "files.exclude": {
    "**/node_modules": true, // huge
    "**/.git": true
  },
  "editor.fontSize": 14
  // dangling note stays at the bottom of this object
}`;

const tool: Tool = {
  id: "jsonc-sorter",
  name: "JSONC Key Sorter",
  subtitle: "Sorts keys, keeps every comment where it belongs.",
  keywords: ["json", "jsonc", "sort", "keys", "comments", "settings", "format"],
  mount(el) {
    el.innerHTML = `
      <div class="options">
        <label class="opt">indent
          <select class="opt-indent">
            <option value="2" selected>2 spaces</option>
            <option value="4">4 spaces</option>
            <option value="tab">tab</option>
          </select>
        </label>
        <label class="opt">order
          <select class="opt-order">
            <option value="asc" selected>A to Z</option>
            <option value="desc">Z to A</option>
          </select>
        </label>
        <label class="opt">
          <input type="checkbox" class="opt-brackets" checked>
          sort [bracket] segments in keys
        </label>
      </div>
      <div class="panes">
        <section class="pane">
          <div class="pane-head">
            <span>input.jsonc</span>
            <span class="spacer"></span>
            <button class="btn-example" type="button">Load example</button>
            <button class="btn-clear" type="button">Clear</button>
          </div>
          <textarea class="src" spellcheck="false" autocapitalize="off" autocomplete="off"
            placeholder="Paste JSONC here. Comments (// and /* */) survive the sort."></textarea>
          <div class="statusbar"><span class="dot">&#9679;</span><span class="status-text">Waiting for input</span></div>
        </section>
        <section class="pane">
          <div class="pane-head">
            <span>sorted.jsonc</span>
            <span class="spacer"></span>
            <button class="btn-copy primary" type="button">Copy</button>
          </div>
          <pre class="output"></pre>
        </section>
      </div>`;

    const $input = el.querySelector(".src") as HTMLTextAreaElement;
    const $output = el.querySelector(".output") as HTMLElement;
    const $status = el.querySelector(".statusbar") as HTMLElement;
    const $statusText = el.querySelector(".status-text") as HTMLElement;
    const $optIndent = el.querySelector(".opt-indent") as HTMLSelectElement;
    const $optOrder = el.querySelector(".opt-order") as HTMLSelectElement;
    const $optBrackets = el.querySelector(".opt-brackets") as HTMLInputElement;
    const $btnCopy = el.querySelector(".btn-copy") as HTMLButtonElement;
    const $btnExample = el.querySelector(".btn-example") as HTMLButtonElement;
    const $btnClear = el.querySelector(".btn-clear") as HTMLButtonElement;

    let lastResult = "";

    function setStatus(kind: string, msg: string) {
      $status.className = "statusbar " + kind;
      $statusText.textContent = msg;
    }

    function run() {
      const src = $input.value;
      if (!src.trim()) {
        $output.innerHTML = "";
        lastResult = "";
        setStatus("", "Waiting for input");
        return;
      }
      try {
        const doc = parse(tokenize(src));
        sortTree(doc.root, $optOrder.value, $optBrackets.checked);
        const indent = $optIndent.value === "tab" ? "\t" : " ".repeat(Number($optIndent.value));
        lastResult = serialize(doc, indent);
        $output.innerHTML = highlight(lastResult);
        const s = countStats(doc.root, { keys: 0, comments: 0 });
        setStatus("ok", s.keys + " key" + (s.keys === 1 ? "" : "s") + " sorted · " +
          s.comments + " comment" + (s.comments === 1 ? "" : "s") + " preserved");
      } catch (e) {
        setStatus("error", (e as Error).message);
        // keep last good output visible
      }
    }

    let timer: ReturnType<typeof setTimeout>;
    function schedule() {
      clearTimeout(timer);
      timer = setTimeout(run, 120);
    }

    $input.addEventListener("input", schedule);
    $optIndent.addEventListener("change", run);
    $optOrder.addEventListener("change", run);
    $optBrackets.addEventListener("change", run);

    $btnCopy.addEventListener("click", async () => {
      if (!lastResult) return;
      try {
        await navigator.clipboard.writeText(lastResult);
      } catch {
        const ta = document.createElement("textarea");
        ta.value = lastResult;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
      const old = $btnCopy.textContent;
      $btnCopy.textContent = "Copied";
      setTimeout(() => { $btnCopy.textContent = old; }, 1200);
    });

    $btnClear.addEventListener("click", () => {
      $input.value = "";
      run();
      $input.focus();
    });

    $btnExample.addEventListener("click", () => {
      $input.value = EXAMPLE;
      run();
    });
  },
};

export default tool;
