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

const tokenize = (src: string): Token[] => {
  const out: Token[] = [];
  for (let i = 0; i < src.length;) {
    const c = src.charAt(i);
    const next = src[i + 1];
    if (c === "\\" && next !== undefined && next !== "\n") {
      out.push({ c: next, k: "ch", literal: true });
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
        out.push({ c, k: "ch", literal: false });
        i += 1;
      }
    } else if (c === "|" && next === "|") {
      out.push({ at: i, k: "slide" });
      i += 2;
    } else if (src.startsWith(COUNTDOWN, i)) {
      out.push({ k: "countdown" });
      i += COUNTDOWN.length;
    } else {
      out.push({ c, k: "ch", literal: false });
      i += 1;
    }
  }
  return out;
};

const isBlank = (t: Token) =>
  t.k === "nl" || (t.k === "ch" && !t.literal && /\s/u.test(t.c));

/* ---------------- emphasis ---------------- */

interface Run {
  c: "*" | "_" | "~";
  n: number;
  open: boolean;
  close: boolean;
}

/** Whitespace, or undefined at either end of the block. */
const charOf = (t: Token | undefined): string | undefined => {
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
};

const isRun = (x: Inline | Run): x is Run => typeof x === "object" && "n" in x;

const wrap = (c: Run["c"], n: number, children: Inline[]): Inline => {
  if (c === "~") {
    return { children, tag: "del" };
  }
  if (n === 1) {
    return { children, tag: "em" };
  }
  if (n === 2) {
    return { children, tag: "strong" };
  }
  return { children: [{ children, tag: "em" }], tag: "strong" };
};

/** Joins neighbouring strings, so the tree holds one string per text run. */
const merge = (xs: Inline[]): Inline[] => {
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
};

/** What a token shows as when it is not part of a run of marks; null for none. */
const plainInline = (t: Token): Inline | null => {
  if (t.k === "code") {
    return { tag: "code", text: t.text };
  }
  if (t.k === "countdown") {
    return { tag: "countdown" };
  }
  if (t.k === "nl") {
    return "\n";
  }
  if (t.k === "ch") {
    return t.c;
  }
  return null;
};

const MARKS = new Set(["*", "_", "~"]);

/** An unescaped `*`, `_` or `~`. */
const isMark = (t: Token): t is { k: "ch"; c: Run["c"]; literal: false } =>
  t.k === "ch" && !t.literal && MARKS.has(t.c);

/**
 * The tokens as single tokens and runs of one mark character; a run covers
 * `tokens[start]` up to, not including, `tokens[end]`.
 */
type Unit =
  | { token: Token }
  | { c: Run["c"]; n: number; start: number; end: number };

const units = (tokens: Token[]): Unit[] => {
  const out: Unit[] = [];
  for (const [i, t] of tokens.entries()) {
    const last = out.at(-1);
    if (!isMark(t)) {
      out.push({ token: t });
    } else if (last && "c" in last && last.c === t.c && last.end === i) {
      last.n += 1;
      last.end = i + 1;
    } else {
      out.push({ c: t.c, end: i + 1, n: 1, start: i });
    }
  }
  return out;
};

const isSpace = (c: string | undefined) => c === undefined || /\s/u.test(c);
const isWordChar = (c: string | undefined) =>
  c !== undefined && /[\p{L}\p{N}]/u.test(c);

/** Whether a run of `n` marks `c` between `before` and `after` can open or close emphasis. */
const runSides = (
  c: Run["c"],
  n: number,
  before: string | undefined,
  after: string | undefined
): { open: boolean; close: boolean } => {
  const usable = c === "~" ? n === 2 : n <= 3;
  let open = usable && !isSpace(after);
  let close = usable && !isSpace(before);
  if (c === "_") {
    open &&= !isWordChar(before);
    close &&= !isWordChar(after);
  }
  return { close, open };
};

/**
 * Inline marks for one block. A closing run matches the nearest open run of
 * the same character and length; anything left unmatched is shown as typed.
 * An underscore inside a word is always literal (`snake_case`).
 */
const inlines = (tokens: Token[]): Inline[] => {
  const out: (Inline | Run)[] = [];
  const stack: number[] = [];
  const flat = (x: Inline | Run) => (isRun(x) ? x.c.repeat(x.n) : x);

  for (const u of units(tokens)) {
    if ("token" in u) {
      const x = plainInline(u.token);
      if (x !== null) {
        out.push(x);
      }
      continue;
    }
    const { c, n } = u;
    const { open, close } = runSides(
      c,
      n,
      charOf(tokens[u.start - 1]),
      charOf(tokens[u.end])
    );
    // Stack entries are distinct indexes into `out`, so the nearest match is
    // found by value.
    const start = close
      ? stack.findLast((s) => {
          const r = out[s] as Run;
          return r.c === c && r.n === n;
        })
      : undefined;
    if (start !== undefined) {
      const inner = out.splice(start).slice(1).map(flat);
      stack.splice(stack.indexOf(start));
      out.push(wrap(c, n, merge(inner)));
    } else if (open) {
      stack.push(out.length);
      out.push({ c, close, n, open });
    } else {
      out.push(c.repeat(n));
    }
  }
  return merge(out.map(flat));
};

/* ---------------- blocks and slides ---------------- */

const trim = (tokens: Token[]): Token[] => {
  const first = tokens.findIndex((t) => !isBlank(t));
  if (first === -1) {
    return [];
  }
  const last = tokens.findLastIndex((t) => !isBlank(t));
  return tokens.slice(first, last + 1);
};

/** `# ` or `## ` at the start of a line, unescaped: the heading level, else 0. */
const headingLevel = (line: Token[]): 0 | 1 | 2 => {
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
};

const blocks = (tokens: Token[]): Block[] => {
  let current: Token[] = [];
  const lines: Token[][] = [current];
  for (const t of tokens) {
    if (t.k === "nl") {
      current = [];
      lines.push(current);
    } else {
      current.push(t);
    }
  }
  const out: Block[] = [];
  let para: Token[] | null = null;
  const flush = () => {
    if (para) {
      out.push({ inline: inlines(para), level: 0 });
    }
    para = null;
  };
  for (const line of lines) {
    const level = headingLevel(line);
    if (level) {
      flush();
      out.push({ inline: inlines(trim(line.slice(level + 1))), level });
    } else if (line.every(isBlank)) {
      // A blank line keeps its height and ends any emphasis left open.
      flush();
      out.push({ inline: [], level: 0 });
    } else if (para) {
      para.push({ k: "nl" }, ...line);
    } else {
      para = [...line];
    }
  }
  flush();
  return out;
};

const mentionsCountdown = (xs: Inline[]): boolean =>
  xs.some(
    (x) =>
      typeof x === "object" &&
      (x.tag === "countdown" ||
        ("children" in x && mentionsCountdown(x.children)))
  );

export const parse = (message: string): Slide[] => {
  const tokens = tokenize(message.replaceAll(/\r\n?/gu, "\n"));
  let group: Token[] = [];
  const groups: Token[][] = [group];
  for (const t of tokens) {
    if (t.k === "slide") {
      group = [];
      groups.push(group);
    } else {
      group.push(t);
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
};

/** Which Slide the character at `offset` belongs to. */
export const slideAt = (message: string, offset: number): number =>
  tokenize(message).filter((t) => t.k === "slide" && t.at < offset).length;

/** Whether the message has a `{countdown}` that would be shown. */
export const hasCountdown = (message: string): boolean =>
  tokenize(message).some((t) => t.k === "countdown");
