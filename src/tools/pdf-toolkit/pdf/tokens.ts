// A content stream read as operators and their operands, each with where it
// starts and ends, so a pass can drop an operator or rewrite an operand and
// leave every other byte as it was. Strings (escapes, nested parentheses),
// hex strings, dictionaries, arrays, comments, and inline images
// (BI ... ID data EI) are each stepped over whole: nothing inside one is
// ever taken for an operator.

export interface Span {
  start: number;
  end: number;
}

export interface DictEntry extends Span {
  key: string;
  value: Operand;
}

export type Operand =
  | (Span & { kind: "name"; name: string })
  | (Span & { kind: "array"; items: Operand[] })
  | (Span & { kind: "dict"; entries: DictEntry[] })
  /** A number, a string, a hex string, true, false, or null. */
  | (Span & { kind: "scalar" });

export interface Op extends Span {
  operator: string;
  operands: Operand[];
}

type Token = Span &
  (
    | { t: "name"; name: string }
    | { t: "scalar" }
    | { t: "open" | "close"; c: string }
    | { t: "keyword"; word: string }
  );

const BYTE = {
  BACKSLASH: 92,
  CR: 13,
  E: 69,
  GT: 62,
  I: 73,
  LF: 10,
  LPAREN: 40,
  LT: 60,
  PERCENT: 37,
  RPAREN: 41,
  SLASH: 47,
} as const;

const WHITE = new Set([0, 9, 10, 12, 13, 32]);
const DELIMITERS = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);
const SCALAR_WORDS = new Set(["true", "false", "null"]);
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)$/u;
const HEX_PAIR = /^[0-9A-Fa-f]{2}$/u;

const isWhite = (b: number | undefined) => b !== undefined && WHITE.has(b);
const isRegular = (b: number | undefined) =>
  b !== undefined && !WHITE.has(b) && !DELIMITERS.has(b);

const ascii = (bytes: Uint8Array, start: number, end: number): string => {
  let s = "";
  for (let i = start; i < end; i += 1) {
    s += String.fromCodePoint(bytes[i] ?? 0);
  }
  return s;
};

/** A name's text with its #xx escapes undone, one character per byte. */
const decodeName = (raw: string): string =>
  raw.replaceAll(/#(?<hex>..)/gu, (whole, hex: string) =>
    HEX_PAIR.test(hex) ? String.fromCodePoint(Number.parseInt(hex, 16)) : whole
  );

/** Where a literal string that opens at `start` ends (just past its closing parenthesis). */
const stringEnd = (bytes: Uint8Array, start: number): number => {
  let depth = 0;
  for (let i = start; i < bytes.length; i += 1) {
    const b = bytes[i];
    if (b === BYTE.BACKSLASH) {
      i += 1;
    } else if (b === BYTE.LPAREN) {
      depth += 1;
    } else if (b === BYTE.RPAREN) {
      depth -= 1;
      if (depth === 0) {
        return i + 1;
      }
    }
  }
  return bytes.length;
};

const skipToLineEnd = (bytes: Uint8Array, start: number): number => {
  let i = start;
  while (i < bytes.length && bytes[i] !== BYTE.LF && bytes[i] !== BYTE.CR) {
    i += 1;
  }
  return i;
};

const indexOfByte = (bytes: Uint8Array, byte: number, from: number) => {
  const at = bytes.indexOf(byte, from);
  return at === -1 ? bytes.length : at + 1;
};

class Lexer {
  readonly bytes: Uint8Array;
  pos = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  next(): Token | null {
    const { bytes } = this;
    while (this.pos < bytes.length) {
      const b = bytes[this.pos];
      if (isWhite(b)) {
        this.pos += 1;
      } else if (b === BYTE.PERCENT) {
        this.pos = skipToLineEnd(bytes, this.pos);
      } else {
        return this.token(this.pos);
      }
    }
    return null;
  }

  private token(start: number): Token {
    const { bytes } = this;
    const b = bytes[start];
    const two = ascii(bytes, start, start + 2);
    if (two === "<<" || two === ">>") {
      this.pos = start + 2;
      return {
        c: two,
        end: this.pos,
        start,
        t: two === "<<" ? "open" : "close",
      };
    }
    if (b === BYTE.LPAREN) {
      this.pos = stringEnd(bytes, start);
      return { end: this.pos, start, t: "scalar" };
    }
    if (b === BYTE.LT) {
      this.pos = indexOfByte(bytes, BYTE.GT, start);
      return { end: this.pos, start, t: "scalar" };
    }
    if (b === BYTE.SLASH) {
      let i = start + 1;
      while (isRegular(bytes[i])) {
        i += 1;
      }
      this.pos = i;
      const name = decodeName(ascii(bytes, start + 1, i));
      return { end: i, name, start, t: "name" };
    }
    const c = String.fromCodePoint(b ?? 0);
    if (c === "[" || c === "{" || c === "]" || c === "}") {
      this.pos = start + 1;
      return {
        c,
        end: this.pos,
        start,
        t: c === "[" || c === "{" ? "open" : "close",
      };
    }
    if (!isRegular(b)) {
      // A stray ")" or ">": step over it.
      this.pos = start + 1;
      return { end: this.pos, start, t: "scalar" };
    }
    let i = start;
    while (isRegular(bytes[i])) {
      i += 1;
    }
    this.pos = i;
    const word = ascii(bytes, start, i);
    if (NUMBER.test(word) || SCALAR_WORDS.has(word)) {
      return { end: i, start, t: "scalar" };
    }
    return { end: i, start, t: "keyword", word };
  }
}

/** The closing bracket for an opening one. */
const CLOSER: Record<string, string> = { "<<": ">>", "[": "]", "{": "}" };

/** One operand starting at `tok`, reading on through `lex` for arrays and dictionaries. */
const readOperand = (lex: Lexer, tok: Token): Operand => {
  if (tok.t === "name") {
    return { end: tok.end, kind: "name", name: tok.name, start: tok.start };
  }
  if (tok.t !== "open") {
    return { end: tok.end, kind: "scalar", start: tok.start };
  }
  const items: Operand[] = [];
  let end = lex.bytes.length;
  for (let t = lex.next(); t; t = lex.next()) {
    if (t.t === "close") {
      if (t.c === CLOSER[tok.c]) {
        ({ end } = t);
        break;
      }
      continue;
    }
    items.push(readOperand(lex, t));
  }
  if (tok.c !== "<<") {
    return { end, items, kind: "array", start: tok.start };
  }
  const entries: DictEntry[] = [];
  for (let i = 0; i + 1 < items.length; i += 2) {
    const key = items[i];
    const value = items[i + 1];
    if (key?.kind === "name" && value) {
      entries.push({ end: value.end, key: key.name, start: key.start, value });
    }
  }
  return { end, entries, kind: "dict", start: tok.start };
};

/**
 * Where an inline image's data, which starts at `from`, ends: just past its
 * EI. A declared length skips the data, so nothing in it can pass for EI;
 * without one, the first EI standing alone ends it.
 */
const inlineImageEnd = (
  bytes: Uint8Array,
  from: number,
  length: number | null
): number => {
  const start = Math.min(bytes.length, from + (length ?? 0));
  for (let i = start; i + 1 < bytes.length; i += 1) {
    const isEi =
      bytes[i] === BYTE.E &&
      bytes[i + 1] === BYTE.I &&
      (i === start || isWhite(bytes[i - 1])) &&
      !isRegular(bytes[i + 2]);
    if (isEi) {
      return i + 2;
    }
  }
  return bytes.length;
};

/** The data length an inline image's dictionary gives (/L or /Length), if any. */
const declaredLength = (
  bytes: Uint8Array,
  entries: Operand[]
): number | null => {
  for (let i = 0; i + 1 < entries.length; i += 2) {
    const key = entries[i];
    const value = entries[i + 1];
    if (
      key?.kind === "name" &&
      (key.name === "L" || key.name === "Length") &&
      value
    ) {
      const n = Number(ascii(bytes, value.start, value.end));
      return Number.isInteger(n) && n >= 0 ? n : null;
    }
  }
  return null;
};

/** BI's dictionary, its data, and its EI, as one operator spanning them all. */
const readInlineImage = (lex: Lexer, bi: Token): Op => {
  const entries: Operand[] = [];
  for (let t = lex.next(); t; t = lex.next()) {
    if (t.t === "keyword" && t.word === "ID") {
      // One whitespace byte after ID, then the data.
      const from = t.end + 1;
      lex.pos = inlineImageEnd(
        lex.bytes,
        from,
        declaredLength(lex.bytes, entries)
      );
      return { end: lex.pos, operands: [], operator: "BI", start: bi.start };
    }
    entries.push(readOperand(lex, t));
  }
  return {
    end: lex.bytes.length,
    operands: [],
    operator: "BI",
    start: bi.start,
  };
};

/** Every operator of a content stream, in order, with its operands. */
export const parseContent = (bytes: Uint8Array): Op[] => {
  const lex = new Lexer(bytes);
  const ops: Op[] = [];
  let operands: Operand[] = [];
  for (let tok = lex.next(); tok; tok = lex.next()) {
    if (tok.t === "keyword") {
      ops.push(
        tok.word === "BI"
          ? readInlineImage(lex, tok)
          : {
              end: tok.end,
              operands,
              operator: tok.word,
              start: operands[0]?.start ?? tok.start,
            }
      );
      operands = [];
    } else {
      operands.push(readOperand(lex, tok));
    }
  }
  return ops;
};

/** The parts, one after another. */
export const concat = (parts: Uint8Array[]): Uint8Array => {
  let length = 0;
  for (const p of parts) {
    length += p.length;
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

export interface Edit extends Span {
  /** What goes in place of `bytes[start..end)`. */
  text: Uint8Array;
}

/** `bytes` with each edit's span replaced by its text. Edits must not overlap. */
export const applyEdits = (bytes: Uint8Array, edits: Edit[]): Uint8Array => {
  const sorted = edits.toSorted((a, b) => a.start - b.start);
  const parts: Uint8Array[] = [];
  let at = 0;
  for (const e of sorted) {
    parts.push(bytes.subarray(at, e.start), e.text);
    at = e.end;
  }
  parts.push(bytes.subarray(at));
  return concat(parts);
};

/** Bytes for ASCII text (operators, names, numbers). */
export const asciiBytes = (s: string): Uint8Array =>
  Uint8Array.from(s, (c) => c.codePointAt(0) ?? 0);
