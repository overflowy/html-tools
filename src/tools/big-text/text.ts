// The Message: a small Markdown subset, split into Slides on `||`.
// Parsed into plain data, never HTML, so the renderer builds DOM nodes and
// nothing the user types is ever interpreted as markup.

export type Inline =
  | string
  | { tag: "strong" | "em" | "del"; children: Inline[] }
  | { tag: "code"; text: string }
  | { tag: "countdown" };

/** A heading line (level 1 or 2), a blank line, or a run of plain lines. */
export interface Block {
  level: 0 | 1 | 2;
  inline: Inline[];
}

export interface Slide {
  blocks: Block[];
  hasCountdown: boolean;
}

export const COUNTDOWN = "{countdown}";

type Token =
  /** One character; `literal` when it was escaped and can never be markup. */
  | { k: "ch"; c: string; literal: boolean }
  | { k: "code"; text: string }
  | { k: "nl" }
  | { k: "slide"; at: number }
  | { k: "countdown" };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < src.length;) {
    const c = src[i]!;
    const next = src[i + 1];
    if (c === "\\" && next !== undefined && next !== "\n") {
      out.push({ k: "ch", c: next, literal: true });
      i += 2;
    } else if (c === "\n") {
      out.push({ k: "nl" });
      i += 1;
    } else if (c === "`") {
      // A code span opens and closes on one line, and is never empty.
      const end = src.indexOf("`", i + 1);
      const eol = src.indexOf("\n", i + 1);
      if (end > i + 1 && (eol === -1 || end < eol)) {
        out.push({ k: "code", text: src.slice(i + 1, end) });
        i = end + 1;
      } else {
        out.push({ k: "ch", c, literal: false });
        i += 1;
      }
    } else if (c === "|" && next === "|") {
      out.push({ k: "slide", at: i });
      i += 2;
    } else if (src.startsWith(COUNTDOWN, i)) {
      out.push({ k: "countdown" });
      i += COUNTDOWN.length;
    } else {
      out.push({ k: "ch", c, literal: false });
      i += 1;
    }
  }
  return out;
}

const isBlank = (t: Token) =>
  t.k === "nl" || (t.k === "ch" && !t.literal && /\s/.test(t.c));

/* ---------------- emphasis ---------------- */

interface Run {
  c: "*" | "_" | "~";
  n: number;
  open: boolean;
  close: boolean;
}

/** Whitespace, or undefined at either end of the block. */
function charOf(t: Token | undefined): string | undefined {
  if (!t) {
    return undefined;
  }
  if (t.k === "ch") {
    return t.c;
  }
  if (t.k === "nl") {
    return "\n";
  }
  return "x";
}

/**
 * Inline marks for one block. A closing run matches the nearest open run of
 * the same character and length; anything left unmatched is shown as typed.
 * An underscore inside a word is always literal (`snake_case`).
 */
function inlines(tokens: Token[]): Inline[] {
  const out: (Inline | Run)[] = [];
  const stack: number[] = [];
  const space = (c: string | undefined) => c === undefined || /\s/.test(c);
  const word = (c: string | undefined) =>
    c !== undefined && /[\p{L}\p{N}]/u.test(c);

  for (let i = 0; i < tokens.length;) {
    const t = tokens[i]!;
    if (t.k === "code") {
      out.push({ tag: "code", text: t.text });
      i += 1;
      continue;
    }
    if (t.k === "countdown") {
      out.push({ tag: "countdown" });
      i += 1;
      continue;
    }
    if (t.k === "nl") {
      out.push("\n");
      i += 1;
      continue;
    }
    if (t.k !== "ch") {
      i += 1;
      continue;
    }

    const { c } = t;
    if (t.literal || (c !== "*" && c !== "_" && c !== "~")) {
      out.push(c);
      i += 1;
      continue;
    }
    let j = i;
    while (
      j < tokens.length &&
      tokens[j]!.k === "ch" &&
      !(tokens[j] as { literal: boolean }).literal &&
      (tokens[j] as { c: string }).c === c
    ) {
      j += 1;
    }
    const n = j - i;
    const before = charOf(tokens[i - 1]);
    const after = charOf(tokens[j]);
    i = j;

    const usable = c === "~" ? n === 2 : n <= 3;
    let open = usable && !space(after);
    let close = usable && !space(before);
    if (c === "_") {
      open &&= !word(before);
      close &&= !word(after);
    }
    if (close) {
      const at = stack.findLastIndex((s) => {
        const r = out[s] as Run;
        return r.c === c && r.n === n;
      });
      if (at !== -1) {
        const start = stack[at]!;
        const inner = out
          .splice(start)
          .slice(1)
          .map((x) => (isRun(x) ? x.c.repeat(x.n) : x));
        stack.length = at;
        out.push(wrap(c, n, merge(inner)));
        continue;
      }
    }
    if (open) {
      stack.push(out.length);
      out.push({ c, n, open, close });
      continue;
    }
    out.push(c.repeat(n));
  }
  return merge(out.map((x) => (isRun(x) ? x.c.repeat(x.n) : x)));
}

function isRun(x: Inline | Run): x is Run {
  return typeof x === "object" && "n" in x;
}

function wrap(c: Run["c"], n: number, children: Inline[]): Inline {
  if (c === "~") {
    return { tag: "del", children };
  }
  if (n === 1) {
    return { tag: "em", children };
  }
  if (n === 2) {
    return { tag: "strong", children };
  }
  return { tag: "strong", children: [{ tag: "em", children }] };
}

/** Joins neighbouring strings, so the tree holds one string per text run. */
function merge(xs: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const x of xs) {
    const last = out.at(-1);
    if (typeof x === "string" && typeof last === "string") {
      out[out.length - 1] = last + x;
    } else {
      out.push(x);
    }
  }
  return out;
}

/* ---------------- blocks and slides ---------------- */

function trim(tokens: Token[]): Token[] {
  let a = 0;
  let b = tokens.length;
  while (a < b && isBlank(tokens[a]!)) {
    a += 1;
  }
  while (b > a && isBlank(tokens[b - 1]!)) {
    b -= 1;
  }
  return tokens.slice(a, b);
}

/** `# ` or `## ` at the start of a line, unescaped: the heading level, else 0. */
function headingLevel(line: Token[]): 0 | 1 | 2 {
  const marks = (i: number) =>
    line[i]?.k === "ch" &&
    !(line[i] as { literal: boolean }).literal &&
    (line[i] as { c: string }).c;
  if (marks(0) !== "#") {
    return 0;
  }
  if (marks(1) === " ") {
    return 1;
  }
  if (marks(1) === "#" && marks(2) === " ") {
    return 2;
  }
  return 0;
}

function blocks(tokens: Token[]): Block[] {
  const lines: Token[][] = [[]];
  for (const t of tokens) {
    if (t.k === "nl") {
      lines.push([]);
    } else {
      lines.at(-1)!.push(t);
    }
  }
  const out: Block[] = [];
  let para: Token[] | null = null;
  const flush = () => {
    if (para) {
      out.push({ level: 0, inline: inlines(para) });
    }
    para = null;
  };
  for (const line of lines) {
    const level = headingLevel(line);
    if (level) {
      flush();
      out.push({ level, inline: inlines(trim(line.slice(level + 1))) });
    } else if (line.every(isBlank)) {
      // A blank line keeps its height and ends any emphasis left open.
      flush();
      out.push({ level: 0, inline: [] });
    } else if (para) {
      para.push({ k: "nl" }, ...line);
    } else {
      para = [...line];
    }
  }
  flush();
  return out;
}

function mentionsCountdown(xs: Inline[]): boolean {
  return xs.some(
    (x) =>
      typeof x === "object" &&
      (x.tag === "countdown" ||
        ("children" in x && mentionsCountdown(x.children)))
  );
}

export function parse(message: string): Slide[] {
  const tokens = tokenize(message.replaceAll(/\r\n?/g, "\n"));
  const groups: Token[][] = [[]];
  for (const t of tokens) {
    if (t.k === "slide") {
      groups.push([]);
    } else {
      groups.at(-1)!.push(t);
    }
  }
  return groups.map((g) => {
    const trimmed = trim(g);
    const bs = trimmed.length ? blocks(trimmed) : [];
    return {
      blocks: bs,
      hasCountdown: bs.some((b) => mentionsCountdown(b.inline)),
    };
  });
}

/** Which Slide the character at `offset` belongs to. */
export function slideAt(message: string, offset: number): number {
  return tokenize(message).filter((t) => t.k === "slide" && t.at < offset)
    .length;
}

/** Whether the message has a `{countdown}` that would be shown. */
export function hasCountdown(message: string): boolean {
  return tokenize(message).some((t) => t.k === "countdown");
}
