// A YAML reader for the subset pnpm-lock.yaml uses: block mappings and
// sequences, one-line flow mappings and sequences, plain and quoted scalars,
// comments. Every plain scalar stays a string except true/false/null, so a
// version like 1.10 is never turned into the number 1.1. Block scalars (| and >)
// and anchors are rejected with a message rather than misread.

export class YamlError extends Error {}

type Line = { indent: number; text: string; no: number };

function stripComment(text: string): string {
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === quote) {
        if (quote === "'" && text[i + 1] === "'") { i++; continue; }
        quote = "";
      } else if (quote === '"' && c === "\\") {
        i++;
      }
      continue;
    }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === "#" && (i === 0 || text[i - 1] === " " || text[i - 1] === "\t")) return text.slice(0, i);
  }
  return text;
}

function toLines(src: string): Line[] {
  const out: Line[] = [];
  const raw = src.split("\n");
  for (let k = 0; k < raw.length; k++) {
    let t = raw[k]!;
    if (t.endsWith("\r")) t = t.slice(0, -1);
    const m = /^( *)(.*)$/.exec(t)!;
    const text = stripComment(m[2]!).trimEnd();
    if (!text) continue;
    if (m[1]!.length === 0 && (text === "---" || text === "..." || text.startsWith("%"))) continue;
    out.push({ indent: m[1]!.length, text, no: k + 1 });
  }
  return out;
}

/** Reads a quoted scalar starting at `pos` (on the quote). Returns the value and the index after the closing quote. */
function readQuoted(s: string, pos: number, no: number): [string, number] {
  const q = s[pos]!;
  let out = "";
  let i = pos + 1;
  for (;;) {
    if (i >= s.length) throw new YamlError("Unterminated string at line " + no);
    const c = s[i]!;
    if (c === q) {
      if (q === "'" && s[i + 1] === "'") { out += "'"; i += 2; continue; }
      return [out, i + 1];
    }
    if (q === '"' && c === "\\") {
      const e = s[i + 1];
      i += 2;
      switch (e) {
        case "n": out += "\n"; break;
        case "t": out += "\t"; break;
        case "r": out += "\r"; break;
        case '"': out += '"'; break;
        case "\\": out += "\\"; break;
        case "/": out += "/"; break;
        case "0": out += "\0"; break;
        case "u": out += String.fromCodePoint(parseInt(s.slice(i, i + 4), 16)); i += 4; break;
        default: out += e ?? "";
      }
      continue;
    }
    out += c;
    i++;
  }
}

function plainValue(s: string): unknown {
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~" || s === "") return null;
  return s;
}

/** Parses a value that fits on one line: flow collection, quoted, or plain scalar. */
function parseInline(s: string, no: number): unknown {
  const [value, end] = readFlow(s, 0, no);
  if (s.slice(end).trim()) throw new YamlError("Unexpected content after value at line " + no);
  return value;
}

function readFlow(s: string, pos: number, no: number): [unknown, number] {
  while (s[pos] === " ") pos++;
  const c = s[pos];
  if (c === undefined) return [null, pos];
  if (c === "|" || c === ">") throw new YamlError("Block scalars are not supported (line " + no + ")");
  if (c === "&" || c === "*") throw new YamlError("Anchors are not supported (line " + no + ")");
  if (c === "'" || c === '"') return readQuoted(s, pos, no);
  if (c === "{") {
    const out: Record<string, unknown> = {};
    pos++;
    for (;;) {
      while (s[pos] === " ") pos++;
      if (s[pos] === "}") return [out, pos + 1];
      let key: string;
      if (s[pos] === "'" || s[pos] === '"') {
        [key, pos] = readQuoted(s, pos, no);
      } else {
        const end = s.indexOf(":", pos);
        if (end < 0) throw new YamlError("Expected ':' in flow mapping at line " + no);
        key = s.slice(pos, end).trim();
        pos = end;
      }
      while (s[pos] === " ") pos++;
      if (s[pos] !== ":") throw new YamlError("Expected ':' in flow mapping at line " + no);
      pos++;
      let value: unknown;
      [value, pos] = readFlow(s, pos, no);
      out[key] = value;
      while (s[pos] === " ") pos++;
      if (s[pos] === ",") { pos++; continue; }
      if (s[pos] === "}") return [out, pos + 1];
      throw new YamlError("Expected ',' or '}' in flow mapping at line " + no);
    }
  }
  if (c === "[") {
    const out: unknown[] = [];
    pos++;
    for (;;) {
      while (s[pos] === " ") pos++;
      if (s[pos] === "]") return [out, pos + 1];
      let value: unknown;
      [value, pos] = readFlow(s, pos, no);
      out.push(value);
      while (s[pos] === " ") pos++;
      if (s[pos] === ",") { pos++; continue; }
      if (s[pos] === "]") return [out, pos + 1];
      throw new YamlError("Expected ',' or ']' in flow sequence at line " + no);
    }
  }
  // Plain scalar: up to a flow terminator.
  let end = pos;
  while (end < s.length && s[end] !== "," && s[end] !== "}" && s[end] !== "]") end++;
  return [plainValue(s.slice(pos, end).trim()), end];
}

/** Splits `key: rest` at the first separator outside quotes; null when the line is not a mapping entry. */
function splitKey(text: string, no: number): [string, string] | null {
  if (text.startsWith("'") || text.startsWith('"')) {
    const [key, end] = readQuoted(text, 0, no);
    const rest = text.slice(end);
    if (rest === ":") return [key, ""];
    if (rest.startsWith(": ")) return [key, rest.slice(2).trim()];
    return null;
  }
  if (text.startsWith("[") || text.startsWith("{")) return null;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== ":") continue;
    if (i === text.length - 1) return [text.slice(0, i).trim(), ""];
    if (text[i + 1] === " ") return [text.slice(0, i).trim(), text.slice(i + 2).trim()];
  }
  return null;
}

function isItem(text: string): boolean {
  return text === "-" || text.startsWith("- ");
}

export function parseYaml(src: string): unknown {
  const lines = toLines(src);
  let idx = 0;

  function parseBlock(indent: number): unknown {
    const first = lines[idx];
    if (!first) return null;
    return isItem(first.text) ? parseSequence(indent) : parseMapping(indent);
  }

  /** The value after `key:` with nothing on the line: a nested block, a sequence at the same indent, or null. */
  function nestedValue(indent: number): unknown {
    const next = lines[idx];
    if (!next) return null;
    if (next.indent > indent) return parseBlock(next.indent);
    if (next.indent === indent && isItem(next.text)) return parseSequence(indent);
    return null;
  }

  function parseMapping(indent: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    while (idx < lines.length) {
      const ln = lines[idx]!;
      if (ln.indent < indent) break;
      if (ln.indent > indent) throw new YamlError("Unexpected indentation at line " + ln.no);
      if (isItem(ln.text)) break;
      const kv = splitKey(ln.text, ln.no);
      if (!kv) throw new YamlError("Expected 'key: value' at line " + ln.no);
      idx++;
      out[kv[0]] = kv[1] === "" ? nestedValue(indent) : parseInline(kv[1], ln.no);
    }
    return out;
  }

  function parseSequence(indent: number): unknown[] {
    const out: unknown[] = [];
    while (idx < lines.length) {
      const ln = lines[idx]!;
      if (ln.indent < indent) break;
      if (ln.indent > indent) throw new YamlError("Unexpected indentation at line " + ln.no);
      if (!isItem(ln.text)) break;
      const content = ln.text.slice(1).trimStart();
      if (!content) {
        idx++;
        const next = lines[idx];
        out.push(next && next.indent > indent ? parseBlock(next.indent) : null);
        continue;
      }
      const offset = ln.text.length - content.length;
      if (splitKey(content, ln.no)) {
        // "- key: value" opens a mapping whose remaining keys sit at the content's column.
        lines[idx] = { indent: indent + offset, text: content, no: ln.no };
        out.push(parseMapping(indent + offset));
      } else {
        idx++;
        out.push(parseInline(content, ln.no));
      }
    }
    return out;
  }

  const value = parseBlock(lines[0]?.indent ?? 0);
  if (idx < lines.length) throw new YamlError("Unexpected content at line " + lines[idx]!.no);
  return value;
}
