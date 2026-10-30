// Comment-preserving JSONC tokenizer, parser, key sorter, serializer and highlighter.

/* ---------------- tokenizer ---------------- */

/** A comment, a punctuation mark, or an unquoted atom (number, keyword, anything else). */
export interface TextTok {
  type: "comment" | "punct" | "atom";
  text: string;
  line: number;
}

/** A quoted string, with and without its quotes. */
export interface StringTok {
  type: "string";
  raw: string;
  inner: string;
  quote: string;
  line: number;
}

export type Tok = TextTok | StringTok;

/** A token and the index just past it. */
interface Scanned {
  token: Tok;
  end: number;
}

const WHITESPACE = new Set([" ", "\t", "\r", "\f", "\v", " "]);

const scanLineComment = (src: string, i: number, line: number): Scanned => {
  let j = i;
  while (j < src.length && src[j] !== "\n") {
    j += 1;
  }
  return { end: j, token: { line, text: src.slice(i, j), type: "comment" } };
};

const scanBlockComment = (src: string, i: number, line: number): Scanned => {
  let j = i + 2;
  while (j < src.length && !(src[j] === "*" && src[j + 1] === "/")) {
    j += 1;
  }
  if (j >= src.length) {
    throw new SyntaxError(
      `Unterminated block comment starting at line ${line}`
    );
  }
  const text = src.slice(i, j + 2);
  return { end: j + 2, token: { line, text, type: "comment" } };
};

const scanString = (
  src: string,
  i: number,
  line: number,
  quote: string
): Scanned => {
  let j = i + 1;
  while (j < src.length && src[j] !== quote) {
    if (src[j] === "\\") {
      j += 1;
    }
    if (src[j] === "\n") {
      throw new SyntaxError(`Unterminated string at line ${line}`);
    }
    j += 1;
  }
  if (j >= src.length) {
    throw new SyntaxError(`Unterminated string at line ${line}`);
  }
  return {
    end: j + 1,
    token: {
      inner: src.slice(i + 1, j),
      line,
      quote,
      raw: src.slice(i, j + 1),
      type: "string",
    },
  };
};

/** Number / true / false / null / anything atom-like, up to the next delimiter. */
const scanAtom = (src: string, i: number, line: number): Scanned => {
  let j = i;
  while (j < src.length && !/[\s{}[\]:,"'/]/u.test(src.charAt(j))) {
    j += 1;
  }
  if (j === i) {
    throw new SyntaxError(
      `Unexpected character ${JSON.stringify(src.charAt(i))} at line ${line}`
    );
  }
  return { end: j, token: { line, text: src.slice(i, j), type: "atom" } };
};

/** The token starting at `i`, which is not whitespace. */
const scanToken = (src: string, i: number, line: number): Scanned => {
  const c = src.charAt(i);
  if (c === "/" && src[i + 1] === "/") {
    return scanLineComment(src, i, line);
  }
  if (c === "/" && src[i + 1] === "*") {
    return scanBlockComment(src, i, line);
  }
  if (c === '"' || c === "'") {
    return scanString(src, i, line, c);
  }
  if ("{}[]:,".includes(c)) {
    return { end: i + 1, token: { line, text: c, type: "punct" } };
  }
  return scanAtom(src, i, line);
};

export const tokenize = (src: string): Tok[] => {
  const tokens: Tok[] = [];
  let i = 0;
  let line = 1;
  while (i < src.length) {
    const c = src.charAt(i);
    if (c === "\n") {
      line += 1;
      i += 1;
    } else if (WHITESPACE.has(c)) {
      i += 1;
    } else {
      const { token, end } = scanToken(src, i, line);
      tokens.push(token);
      if (token.type === "comment") {
        line += token.text.split("\n").length - 1;
      }
      i = end;
    }
  }
  return tokens;
};

/* ---------------- parser (comment-attaching) ---------------- */

interface StringNode {
  kind: "string";
  raw: string;
  inner: string;
  endLine: number;
}

interface LiteralNode {
  kind: "literal";
  raw: string;
  endLine: number;
}

/** An array item: its value and the comments around it. */
interface Item {
  leading: TextTok[];
  trailing: TextTok[];
  value: Node;
}

/** An object member: an item with a key. */
interface Prop extends Item {
  keyRaw: string;
  keyValue: string;
}

interface ObjectNode {
  kind: "object";
  props: Prop[];
  /** Comments after the last member, before the closing brace. */
  dangling: TextTok[];
  endLine: number;
}

interface ArrayNode {
  kind: "array";
  items: Item[];
  /** Comments after the last item, before the closing bracket. */
  dangling: TextTok[];
  endLine: number;
}

export type Node = StringNode | LiteralNode | ObjectNode | ArrayNode;

export interface Doc {
  leadingDoc: TextTok[];
  root: Node;
  trailingDoc: TextTok[];
}

const decodeKey = (tok: StringTok): string => {
  if (tok.quote === '"') {
    try {
      return JSON.parse(tok.raw);
    } catch {
      /* fall through */
    }
  }
  return tok.inner;
};

const tokenText = (t: Tok): string => (t.type === "string" ? t.raw : t.text);

/** Recursive descent over the token list, attaching each comment to the member or item it belongs to. */
class Parser {
  private pos = 0;
  private readonly tokens: Tok[];

  constructor(tokens: Tok[]) {
    this.tokens = tokens;
  }

  document(): Doc {
    const leadingDoc = this.collectComments();
    const root = this.value();
    const trailingDoc = this.collectComments();
    const extra = this.peek();
    if (extra) {
      throw new SyntaxError(
        `Unexpected token '${tokenText(extra)}' after end of document (line ${extra.line})`
      );
    }
    return { leadingDoc, root, trailingDoc };
  }

  private peek(): Tok | undefined {
    return this.tokens[this.pos];
  }

  private take(): Tok | undefined {
    const t = this.tokens[this.pos];
    this.pos += 1;
    return t;
  }

  private collectComments(): TextTok[] {
    const out: TextTok[] = [];
    for (let t = this.peek(); t?.type === "comment"; t = this.peek()) {
      out.push(t);
      this.pos += 1;
    }
    return out;
  }

  private takeSameLine(lineNo: number): TextTok[] {
    const out: TextTok[] = [];
    for (
      let t = this.peek();
      t?.type === "comment" && t.line === lineNo;
      t = this.peek()
    ) {
      out.push(t);
      this.pos += 1;
    }
    return out;
  }

  /** The punctuation token `ch`, if it is next. */
  private takePunct(ch: string): TextTok | undefined {
    const t = this.peek();
    if (t?.type === "punct" && t.text === ch) {
      this.pos += 1;
      return t;
    }
    return undefined;
  }

  private expectPunct(ch: string): void {
    const t = this.take();
    if (!t || t.type !== "punct" || t.text !== ch) {
      const where = t ? `line ${t.line}` : "end of input";
      throw new SyntaxError(`Expected '${ch}' at ${where}`);
    }
  }

  private value(): Node {
    const t = this.peek();
    if (!t) {
      throw new SyntaxError("Unexpected end of input");
    }
    if (t.type === "string") {
      this.pos += 1;
      return { endLine: t.line, inner: t.inner, kind: "string", raw: t.raw };
    }
    if (t.type === "atom") {
      this.pos += 1;
      return { endLine: t.line, kind: "literal", raw: t.text };
    }
    if (t.type === "punct" && t.text === "{") {
      return this.object();
    }
    if (t.type === "punct" && t.text === "[") {
      return this.array();
    }
    throw new SyntaxError(`Unexpected token '${t.text}' at line ${t.line}`);
  }

  /** Comments on the value's last line, plus the comma after it and comments on the comma's line. */
  private afterValue(value: Node): { trailing: TextTok[]; hasComma: boolean } {
    const trailing = this.takeSameLine(value.endLine);
    const comma = this.takePunct(",");
    if (comma) {
      trailing.push(...this.takeSameLine(comma.line));
    }
    return { hasComma: comma !== undefined, trailing };
  }

  /**
   * After a member or item with no comma, only the closing mark may follow.
   * Returns the comments before it and its line.
   */
  private close(ch: string): { dangling: TextTok[]; endLine: number } {
    const dangling = this.collectComments();
    const close = this.takePunct(ch);
    if (close) {
      return { dangling, endLine: close.line };
    }
    const next = this.peek();
    const where = next ? `line ${next.line}` : "end of input";
    throw new SyntaxError(`Expected ',' or '${ch}' at ${where}`);
  }

  private object(): ObjectNode {
    this.expectPunct("{");
    const props: Prop[] = [];
    for (;;) {
      const leading = this.collectComments();
      const t = this.peek();
      if (!t) {
        throw new SyntaxError("Unclosed object (missing '}')");
      }
      if (t.type === "punct" && t.text === "}") {
        this.pos += 1;
        return { dangling: leading, endLine: t.line, kind: "object", props };
      }
      if (t.type !== "string") {
        throw new SyntaxError(`Expected a quoted key at line ${t.line}`);
      }
      this.pos += 1;
      // Comments between the key and ':' are kept, moved above the key
      leading.push(...this.collectComments());
      this.expectPunct(":");
      // Comments between ':' and the value
      leading.push(...this.collectComments());
      const value = this.value();
      const { trailing, hasComma } = this.afterValue(value);
      props.push({
        keyRaw: t.raw,
        keyValue: decodeKey(t),
        leading,
        trailing,
        value,
      });
      if (!hasComma) {
        return { ...this.close("}"), kind: "object", props };
      }
    }
  }

  private array(): ArrayNode {
    this.expectPunct("[");
    const items: Item[] = [];
    for (;;) {
      const leading = this.collectComments();
      const t = this.peek();
      if (!t) {
        throw new SyntaxError("Unclosed array (missing ']')");
      }
      if (t.type === "punct" && t.text === "]") {
        this.pos += 1;
        return { dangling: leading, endLine: t.line, items, kind: "array" };
      }
      const value = this.value();
      const { trailing, hasComma } = this.afterValue(value);
      items.push({ leading, trailing, value });
      if (!hasComma) {
        return { ...this.close("]"), items, kind: "array" };
      }
    }
  }
}

export const parse = (tokens: Tok[]): Doc => new Parser(tokens).document();

/* ---------------- sorting ---------------- */

const BRACKET_KEY = /^(?:\[[^[\]]+\])+$/u;

const cmpKeys = (a: string, b: string) =>
  a.localeCompare(b, "en", { numeric: true, sensitivity: "variant" });

export const sortTree = (node: Node, order: string, sortBrackets: boolean) => {
  if (node.kind === "object") {
    for (const p of node.props) {
      if (sortBrackets && BRACKET_KEY.test(p.keyValue)) {
        const segs = p.keyValue.match(/\[[^[\]]+\]/gu) ?? [];
        const sorted = segs.toSorted(cmpKeys);
        if (sorted.join("") !== p.keyValue) {
          p.keyValue = sorted.join("");
          p.keyRaw = JSON.stringify(p.keyValue);
        }
      }
      sortTree(p.value, order, sortBrackets);
    }
    node.props.sort(
      (a, b) => cmpKeys(a.keyValue, b.keyValue) * (order === "desc" ? -1 : 1)
    );
  } else if (node.kind === "array") {
    for (const it of node.items) {
      sortTree(it.value, order, sortBrackets);
    }
  }
};

/* ---------------- serializer ---------------- */

const trailingStr = (comments: TextTok[]) => {
  if (!comments.length) {
    return "";
  }
  return ` ${comments
    .map((c) => c.text.replaceAll(/\s*\n\s*/gu, " ").trim())
    .join(" ")}`;
};

const inlineValue = (v: Node): string | null => {
  if (v.kind === "string" || v.kind === "literal") {
    return v.raw;
  }
  if (v.kind === "array" && v.items.length === 0 && v.dangling.length === 0) {
    return "[]";
  }
  if (v.kind === "object" && v.props.length === 0 && v.dangling.length === 0) {
    return "{}";
  }
  return null;
};

const tryInlineArray = (node: ArrayNode, headLen: number): string | null => {
  if (node.dangling.length) {
    return null;
  }
  const parts: string[] = [];
  for (const it of node.items) {
    if (it.leading.length || it.trailing.length) {
      return null;
    }
    const s = inlineValue(it.value);
    if (s === null) {
      return null;
    }
    parts.push(s);
  }
  const str = `[${parts.join(", ")}]`;
  return headLen + str.length <= 80 ? str : null;
};

export const serialize = (doc: Doc, indentStr: string): string => {
  const out: string[] = [];
  const pad = (d: number) => indentStr.repeat(d);

  const pushComment = (c: TextTok, depth: number) => {
    const [first, ...rest] = c.text.split("\n");
    out.push(pad(depth) + first.trim());
    for (const line of rest) {
      const t = line.trim();
      out.push(pad(depth) + (t.startsWith("*") ? ` ${t}` : t));
    }
  };

  const writeValue = (
    node: Node,
    depth: number,
    head: string,
    tail: string
  ) => {
    if (node.kind === "object") {
      if (node.props.length === 0 && node.dangling.length === 0) {
        out.push(`${head}{}${tail}`);
        return;
      }
      out.push(`${head}{`);
      for (const [idx, p] of node.props.entries()) {
        const isLast = idx === node.props.length - 1;
        for (const c of p.leading) {
          pushComment(c, depth + 1);
        }
        const propTail = (isLast ? "" : ",") + trailingStr(p.trailing);
        writeValue(
          p.value,
          depth + 1,
          `${pad(depth + 1) + p.keyRaw}: `,
          propTail
        );
      }
      for (const c of node.dangling) {
        pushComment(c, depth + 1);
      }
      out.push(`${pad(depth)}}${tail}`);
    } else if (node.kind === "array") {
      if (node.items.length === 0 && node.dangling.length === 0) {
        out.push(`${head}[]${tail}`);
        return;
      }
      const inline = tryInlineArray(node, head.length);
      if (inline !== null) {
        out.push(head + inline + tail);
        return;
      }
      out.push(`${head}[`);
      for (const [idx, it] of node.items.entries()) {
        const isLast = idx === node.items.length - 1;
        for (const c of it.leading) {
          pushComment(c, depth + 1);
        }
        const itemTail = (isLast ? "" : ",") + trailingStr(it.trailing);
        writeValue(it.value, depth + 1, pad(depth + 1), itemTail);
      }
      for (const c of node.dangling) {
        pushComment(c, depth + 1);
      }
      out.push(`${pad(depth)}]${tail}`);
    } else {
      out.push(head + node.raw + tail);
    }
  };

  for (const c of doc.leadingDoc) {
    pushComment(c, 0);
  }
  writeValue(doc.root, 0, "", "");
  for (const c of doc.trailingDoc) {
    pushComment(c, 0);
  }
  return `${out.join("\n")}\n`;
};

/* ---------------- highlighter ---------------- */

export const highlight = (src: string): string => {
  const esc = (s: string) =>
    s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const span = (cls: string, s: string) =>
    `<span class="${cls}">${esc(s)}</span>`;
  let html = "";
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    let m;
    if ((m = rest.match(/^\/\/[^\n]*/u))) {
      html += span("c", m[0]);
    } else if ((m = rest.match(/^\/\*[\s\S]*?\*\//u))) {
      html += span("c", m[0]);
    } else if ((m = rest.match(/^"(?:[^"\\\n]|\\.)*"/u))) {
      const after = src.slice(i + m[0].length);
      html += span(/^\s*:/u.test(after) ? "k" : "s", m[0]);
    } else if ((m = rest.match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/u))) {
      html += span("n", m[0]);
    } else if ((m = rest.match(/^(?:true|false|null)\b/u))) {
      html += span("b", m[0]);
    } else {
      html += esc(src.charAt(i));
      i += 1;
      continue;
    }
    i += m[0].length;
  }
  return html;
};

/* ---------------- stats ---------------- */

export const countStats = (
  node: Node,
  acc: { keys: number; comments: number }
) => {
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
};
