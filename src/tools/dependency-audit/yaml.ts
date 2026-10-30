// A YAML reader for the subset pnpm-lock.yaml uses: block mappings and
// sequences, one-line flow mappings and sequences, plain and quoted scalars,
// comments. Every plain scalar stays a string except true/false/null, so a
// version like 1.10 is never turned into the number 1.1. Block scalars (| and >)
// and anchors are rejected with a message rather than misread.

export class YamlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YamlError";
  }
}

interface Line {
  indent: number;
  text: string;
  no: number;
}

const stripComment = (text: string): string => {
  let quote = "";
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === quote) {
        if (quote === "'" && text[i + 1] === "'") {
          i += 1;
          continue;
        }
        quote = "";
      } else if (quote === '"' && c === "\\") {
        i += 1;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === "#" && (i === 0 || text[i - 1] === " " || text[i - 1] === "\t")) {
      return text.slice(0, i);
    }
  }
  return text;
};

const toLines = (src: string): Line[] => {
  const out: Line[] = [];
  for (const [k, rawLine] of src.split("\n").entries()) {
    const t = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const groups = /^(?<spaces> *)(?<rest>.*)$/u.exec(t)?.groups;
    if (!groups) {
      throw new YamlError(`Unreadable line ${k + 1}`);
    }
    const { spaces = "", rest = "" } = groups;
    const text = stripComment(rest).trimEnd();
    if (!text) {
      continue;
    }
    if (
      spaces.length === 0 &&
      (text === "---" || text === "..." || text.startsWith("%"))
    ) {
      continue;
    }
    out.push({ indent: spaces.length, no: k + 1, text });
  }
  return out;
};

/** Reads a quoted scalar starting at `pos` (on the quote). Returns the value and the index after the closing quote. */
const readQuoted = (s: string, pos: number, no: number): [string, number] => {
  const q = s[pos];
  let out = "";
  let i = pos + 1;
  for (;;) {
    if (i >= s.length) {
      throw new YamlError(`Unterminated string at line ${no}`);
    }
    const c = s[i];
    if (c === q) {
      if (q === "'" && s[i + 1] === "'") {
        out += "'";
        i += 2;
        continue;
      }
      return [out, i + 1];
    }
    if (q === '"' && c === "\\") {
      const e = s[i + 1];
      i += 2;
      switch (e) {
        case "n": {
          out += "\n";
          break;
        }
        case "t": {
          out += "\t";
          break;
        }
        case "r": {
          out += "\r";
          break;
        }
        case '"': {
          out += '"';
          break;
        }
        case "\\": {
          out += "\\";
          break;
        }
        case "/": {
          out += "/";
          break;
        }
        case "0": {
          out += "\0";
          break;
        }
        case "u": {
          out += String.fromCodePoint(Number.parseInt(s.slice(i, i + 4), 16));
          i += 4;
          break;
        }
        default: {
          out += e ?? "";
        }
      }
      continue;
    }
    out += c;
    i += 1;
  }
};

const plainValue = (s: string): unknown => {
  if (s === "true") {
    return true;
  }
  if (s === "false") {
    return false;
  }
  if (s === "null" || s === "~" || s === "") {
    return null;
  }
  return s;
};

/** Reads one flow value at `start`; returns it and the index just past it. */
type FlowReader = (s: string, start: number, no: number) => [unknown, number];

const skipSpaces = (s: string, start: number): number => {
  let pos = start;
  while (s[pos] === " ") {
    pos += 1;
  }
  return pos;
};

/** The key of a flow mapping entry starting at `start`, and the index of the ':' after it. */
const readFlowKey = (
  s: string,
  start: number,
  no: number
): [string, number] => {
  let key: string;
  let pos: number;
  if (s[start] === "'" || s[start] === '"') {
    [key, pos] = readQuoted(s, start, no);
  } else {
    const end = s.indexOf(":", start);
    if (end === -1) {
      throw new YamlError(`Expected ':' in flow mapping at line ${no}`);
    }
    key = s.slice(start, end).trim();
    pos = end;
  }
  pos = skipSpaces(s, pos);
  if (s[pos] !== ":") {
    throw new YamlError(`Expected ':' in flow mapping at line ${no}`);
  }
  return [key, pos];
};

/** A flow mapping whose opening brace ends just before `start`; `readValue` reads each value, which may nest. */
const readFlowMapping = (
  s: string,
  start: number,
  no: number,
  readValue: FlowReader
): [Record<string, unknown>, number] => {
  const out: Record<string, unknown> = {};
  let pos = start;
  for (;;) {
    pos = skipSpaces(s, pos);
    if (s[pos] === "}") {
      return [out, pos + 1];
    }
    const [key, colon] = readFlowKey(s, pos, no);
    const [value, end] = readValue(s, colon + 1, no);
    out[key] = value;
    pos = skipSpaces(s, end);
    if (s[pos] === ",") {
      pos += 1;
      continue;
    }
    if (s[pos] === "}") {
      return [out, pos + 1];
    }
    throw new YamlError(`Expected ',' or '}' in flow mapping at line ${no}`);
  }
};

/** A flow sequence whose opening bracket ends just before `start`; `readValue` reads each item, which may nest. */
const readFlowSequence = (
  s: string,
  start: number,
  no: number,
  readValue: FlowReader
): [unknown[], number] => {
  const out: unknown[] = [];
  let pos = start;
  for (;;) {
    pos = skipSpaces(s, pos);
    if (s[pos] === "]") {
      return [out, pos + 1];
    }
    const [value, end] = readValue(s, pos, no);
    out.push(value);
    pos = skipSpaces(s, end);
    if (s[pos] === ",") {
      pos += 1;
      continue;
    }
    if (s[pos] === "]") {
      return [out, pos + 1];
    }
    throw new YamlError(`Expected ',' or ']' in flow sequence at line ${no}`);
  }
};

const readFlow: FlowReader = (s, start, no) => {
  const pos = skipSpaces(s, start);
  const c = s[pos];
  if (c === undefined) {
    return [null, pos];
  }
  if (c === "|" || c === ">") {
    throw new YamlError(`Block scalars are not supported (line ${no})`);
  }
  if (c === "&" || c === "*") {
    throw new YamlError(`Anchors are not supported (line ${no})`);
  }
  if (c === "'" || c === '"') {
    return readQuoted(s, pos, no);
  }
  if (c === "{") {
    return readFlowMapping(s, pos + 1, no, readFlow);
  }
  if (c === "[") {
    return readFlowSequence(s, pos + 1, no, readFlow);
  }
  // Plain scalar: up to a flow terminator.
  let end = pos;
  while (end < s.length && s[end] !== "," && s[end] !== "}" && s[end] !== "]") {
    end += 1;
  }
  return [plainValue(s.slice(pos, end).trim()), end];
};

/** Parses a value that fits on one line: flow collection, quoted, or plain scalar. */
const parseInline = (s: string, no: number): unknown => {
  const [value, end] = readFlow(s, 0, no);
  if (s.slice(end).trim()) {
    throw new YamlError(`Unexpected content after value at line ${no}`);
  }
  return value;
};

/** Splits `key: rest` at the first separator outside quotes; null when the line is not a mapping entry. */
const splitKey = (text: string, no: number): [string, string] | null => {
  if (text.startsWith("'") || text.startsWith('"')) {
    const [key, end] = readQuoted(text, 0, no);
    const rest = text.slice(end);
    if (rest === ":") {
      return [key, ""];
    }
    if (rest.startsWith(": ")) {
      return [key, rest.slice(2).trim()];
    }
    return null;
  }
  if (text.startsWith("[") || text.startsWith("{")) {
    return null;
  }
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== ":") {
      continue;
    }
    if (i === text.length - 1) {
      return [text.slice(0, i).trim(), ""];
    }
    if (text[i + 1] === " ") {
      return [text.slice(0, i).trim(), text.slice(i + 2).trim()];
    }
  }
  return null;
};

const isItem = (text: string): boolean => text === "-" || text.startsWith("- ");

export const parseYaml = (src: string): unknown => {
  const lines = toLines(src);
  let idx = 0;

  // Block collections nest in each other, so the readers are methods that can
  // call one another regardless of definition order.
  const read = {
    block(indent: number): unknown {
      const first = lines[idx];
      if (!first) {
        return null;
      }
      return isItem(first.text) ? this.sequence(indent) : this.mapping(indent);
    },

    mapping(indent: number): Record<string, unknown> {
      const out: Record<string, unknown> = {};
      while (idx < lines.length) {
        const ln = lines[idx];
        if (ln.indent < indent) {
          break;
        }
        if (ln.indent > indent) {
          throw new YamlError(`Unexpected indentation at line ${ln.no}`);
        }
        if (isItem(ln.text)) {
          break;
        }
        const kv = splitKey(ln.text, ln.no);
        if (!kv) {
          throw new YamlError(`Expected 'key: value' at line ${ln.no}`);
        }
        idx += 1;
        out[kv[0]] =
          kv[1] === "" ? this.nested(indent) : parseInline(kv[1], ln.no);
      }
      return out;
    },

    /** The value after `key:` with nothing on the line: a nested block, a sequence at the same indent, or null. */
    nested(indent: number): unknown {
      const next = lines[idx];
      if (!next) {
        return null;
      }
      if (next.indent > indent) {
        return this.block(next.indent);
      }
      if (next.indent === indent && isItem(next.text)) {
        return this.sequence(indent);
      }
      return null;
    },

    sequence(indent: number): unknown[] {
      const out: unknown[] = [];
      while (idx < lines.length) {
        const ln = lines[idx];
        if (ln.indent < indent) {
          break;
        }
        if (ln.indent > indent) {
          throw new YamlError(`Unexpected indentation at line ${ln.no}`);
        }
        if (!isItem(ln.text)) {
          break;
        }
        const content = ln.text.slice(1).trimStart();
        if (!content) {
          idx += 1;
          const next = lines[idx];
          out.push(
            next && next.indent > indent ? this.block(next.indent) : null
          );
          continue;
        }
        const offset = ln.text.length - content.length;
        if (splitKey(content, ln.no)) {
          // "- key: value" opens a mapping whose remaining keys sit at the content's column.
          lines[idx] = { indent: indent + offset, no: ln.no, text: content };
          out.push(this.mapping(indent + offset));
        } else {
          idx += 1;
          out.push(parseInline(content, ln.no));
        }
      }
      return out;
    },
  };

  const value = read.block(lines[0]?.indent ?? 0);
  const leftover = lines[idx];
  if (leftover) {
    throw new YamlError(`Unexpected content at line ${leftover.no}`);
  }
  return value;
};
