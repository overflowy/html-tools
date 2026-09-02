// A TOML reader for the subset that uv.lock uses: tables, arrays of tables,
// dotted keys, strings, numbers, booleans, arrays, and inline tables. Anything
// else (dates, multi-line strings with line-ending backslashes) is rejected
// with a message rather than misread.

export class TomlError extends Error {}

export type TomlTable = Record<string, unknown>;

export function parseToml(src: string): TomlTable {
  const root: TomlTable = {};
  let current: TomlTable = root;
  let i = 0;
  const n = src.length;
  let line = 1;

  function fail(msg: string): never {
    throw new TomlError(msg + " at line " + line);
  }

  function skipWs() {
    while (i < n && (src[i] === " " || src[i] === "\t")) i++;
  }

  /** Whitespace, newlines, and comments: what may sit between values inside arrays. */
  function skipBlank() {
    for (;;) {
      skipWs();
      if (src[i] === "#") {
        while (i < n && src[i] !== "\n") i++;
      } else if (src[i] === "\r" || src[i] === "\n") {
        if (src[i] === "\n") line++;
        i++;
      } else {
        return;
      }
    }
  }

  function endOfLine() {
    skipWs();
    if (src[i] === "#") while (i < n && src[i] !== "\n") i++;
    if (i >= n) return;
    if (src[i] === "\r") i++;
    if (src[i] !== "\n") fail("Unexpected " + JSON.stringify(src[i]));
    i++;
    line++;
  }

  function basicString(triple: boolean): string {
    // Opening quotes already consumed.
    let out = "";
    if (triple && src[i] === "\n") { i++; line++; }
    for (;;) {
      if (i >= n) fail("Unterminated string");
      const c = src[i]!;
      if (c === '"') {
        if (!triple) { i++; return out; }
        if (src.startsWith('"""', i)) { i += 3; return out; }
        out += c; i++; continue;
      }
      if (c === "\\") {
        const e = src[i + 1];
        i += 2;
        switch (e) {
          case "n": out += "\n"; break;
          case "t": out += "\t"; break;
          case "r": out += "\r"; break;
          case '"': out += '"'; break;
          case "\\": out += "\\"; break;
          case "b": out += "\b"; break;
          case "f": out += "\f"; break;
          case "u": out += String.fromCodePoint(parseInt(src.slice(i, i + 4), 16)); i += 4; break;
          case "U": out += String.fromCodePoint(parseInt(src.slice(i, i + 8), 16)); i += 8; break;
          default: fail("Unsupported escape \\" + e);
        }
        continue;
      }
      if (c === "\n") {
        if (!triple) fail("Unterminated string");
        line++;
      }
      out += c;
      i++;
    }
  }

  function literalString(triple: boolean): string {
    const close = triple ? "'''" : "'";
    const end = src.indexOf(close, i);
    if (end < 0) fail("Unterminated string");
    let s = src.slice(i, end);
    if (triple && s.startsWith("\n")) s = s.slice(1);
    line += (s.match(/\n/g) || []).length;
    i = end + close.length;
    return s;
  }

  function parseString(): string {
    if (src.startsWith('"""', i)) { i += 3; return basicString(true); }
    if (src.startsWith("'''", i)) { i += 3; return literalString(true); }
    if (src[i] === '"') { i++; return basicString(false); }
    i++;
    return literalString(false);
  }

  function parseKeyPath(): string[] {
    const keys: string[] = [];
    for (;;) {
      skipWs();
      const c = src[i];
      if (c === '"' || c === "'") {
        keys.push(parseString());
      } else {
        let j = i;
        while (j < n && /[A-Za-z0-9_-]/.test(src[j]!)) j++;
        if (j === i) fail("Expected a key");
        keys.push(src.slice(i, j));
        i = j;
      }
      skipWs();
      if (src[i] === ".") { i++; continue; }
      return keys;
    }
  }

  function parseValue(): unknown {
    skipWs();
    const c = src[i];
    if (c === undefined) fail("Expected a value");
    if (c === '"' || c === "'") return parseString();
    if (c === "[") return parseArray();
    if (c === "{") return parseInlineTable();
    let j = i;
    while (j < n && !/[\s,\]}#]/.test(src[j]!)) j++;
    const tok = src.slice(i, j);
    i = j;
    if (tok === "true") return true;
    if (tok === "false") return false;
    if (/^[+-]?(0|[1-9](_?[0-9])*)$/.test(tok)) return Number(tok.replace(/_/g, ""));
    if (/^[+-]?(0|[1-9](_?[0-9])*)(\.[0-9](_?[0-9])*)?([eE][+-]?[0-9]+)?$/.test(tok)) return Number(tok.replace(/_/g, ""));
    if (/^[+-]?(inf|nan)$/.test(tok)) return tok.endsWith("nan") ? NaN : tok.startsWith("-") ? -Infinity : Infinity;
    if (/^0x[0-9A-Fa-f_]+$/.test(tok)) return parseInt(tok.slice(2).replace(/_/g, ""), 16);
    if (/^0o[0-7_]+$/.test(tok)) return parseInt(tok.slice(2).replace(/_/g, ""), 8);
    if (/^0b[01_]+$/.test(tok)) return parseInt(tok.slice(2).replace(/_/g, ""), 2);
    if (/^\d{4}-\d{2}-\d{2}/.test(tok) || /^\d{2}:\d{2}:\d{2}/.test(tok)) return tok;
    fail("Unexpected value " + JSON.stringify(tok));
  }

  function parseArray(): unknown[] {
    i++; // [
    const out: unknown[] = [];
    for (;;) {
      skipBlank();
      if (src[i] === "]") { i++; return out; }
      out.push(parseValue());
      skipBlank();
      if (src[i] === ",") { i++; continue; }
      if (src[i] === "]") { i++; return out; }
      fail("Expected ',' or ']' in array");
    }
  }

  function parseInlineTable(): TomlTable {
    i++; // {
    const out: TomlTable = {};
    skipWs();
    if (src[i] === "}") { i++; return out; }
    for (;;) {
      const keys = parseKeyPath();
      skipWs();
      if (src[i] !== "=") fail("Expected '=' in inline table");
      i++;
      const value = parseValue();
      assign(out, keys, value);
      skipWs();
      if (src[i] === ",") { i++; skipWs(); continue; }
      if (src[i] === "}") { i++; return out; }
      fail("Expected ',' or '}' in inline table");
    }
  }

  /** Walk `keys` from `base`, creating tables as needed; an array on the way means its last element. */
  function resolve(base: TomlTable, keys: string[]): TomlTable {
    let t = base;
    for (const k of keys) {
      let v = t[k];
      if (v === undefined) { v = {}; t[k] = v; }
      if (Array.isArray(v)) v = v[v.length - 1];
      if (typeof v !== "object" || v === null) fail("Key " + k + " is not a table");
      t = v as TomlTable;
    }
    return t;
  }

  function assign(base: TomlTable, keys: string[], value: unknown) {
    const t = resolve(base, keys.slice(0, -1));
    const last = keys[keys.length - 1]!;
    if (last in t) fail("Duplicate key " + last);
    t[last] = value;
  }

  while (i < n) {
    skipBlank();
    if (i >= n) break;
    if (src.startsWith("[[", i)) {
      i += 2;
      const keys = parseKeyPath();
      if (!src.startsWith("]]", i)) fail("Expected ']]'");
      i += 2;
      const parent = resolve(root, keys.slice(0, -1));
      const last = keys[keys.length - 1]!;
      let arr = parent[last];
      if (arr === undefined) { arr = []; parent[last] = arr; }
      if (!Array.isArray(arr)) fail("Key " + last + " is not an array of tables");
      const table: TomlTable = {};
      arr.push(table);
      current = table;
      endOfLine();
      continue;
    }
    if (src[i] === "[") {
      i++;
      const keys = parseKeyPath();
      if (src[i] !== "]") fail("Expected ']'");
      i++;
      current = resolve(root, keys);
      endOfLine();
      continue;
    }
    const keys = parseKeyPath();
    skipWs();
    if (src[i] !== "=") fail("Expected '='");
    i++;
    const value = parseValue();
    assign(current, keys, value);
    endOfLine();
  }
  return root;
}
