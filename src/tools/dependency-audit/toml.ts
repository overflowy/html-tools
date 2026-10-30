// A TOML reader for the subset that uv.lock uses: tables, arrays of tables,
// dotted keys, strings, numbers, booleans, arrays, and inline tables. Anything
// else (dates, multi-line strings with line-ending backslashes) is rejected
// with a message rather than misread.

export class TomlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TomlError";
  }
}

export type TomlTable = Record<string, unknown>;

/** Whether `c` may appear in a bare key. */
const isBareKeyChar = (c: string | undefined): boolean =>
  c !== undefined && /[A-Za-z0-9_-]/u.test(c);

/** Whether `c` ends a bare value token (number, boolean, date). */
const endsToken = (c: string | undefined): boolean =>
  c === undefined || /[\s,\]}#]/u.test(c);

/** A bare token as a boolean, number, or date string; undefined when it is none of these. */
const scalarValue = (tok: string): unknown => {
  if (tok === "true") {
    return true;
  }
  if (tok === "false") {
    return false;
  }
  if (/^[+-]?(?:0|[1-9](?:_?[0-9])*)$/u.test(tok)) {
    return Number(tok.replaceAll("_", ""));
  }
  if (
    /^[+-]?(?:0|[1-9](?:_?[0-9])*)(?:\.[0-9](?:_?[0-9])*)?(?:[eE][+-]?[0-9]+)?$/u.test(
      tok
    )
  ) {
    return Number(tok.replaceAll("_", ""));
  }
  if (/^[+-]?(?:inf|nan)$/u.test(tok)) {
    if (tok.endsWith("nan")) {
      return Number.NaN;
    }
    return tok.startsWith("-") ? -Infinity : Infinity;
  }
  if (/^0x[0-9A-Fa-f_]+$/u.test(tok)) {
    return Number.parseInt(tok.slice(2).replaceAll("_", ""), 16);
  }
  if (/^0o[0-7_]+$/u.test(tok)) {
    return Number.parseInt(tok.slice(2).replaceAll("_", ""), 8);
  }
  if (/^0b[01_]+$/u.test(tok)) {
    return Number.parseInt(tok.slice(2).replaceAll("_", ""), 2);
  }
  if (/^\d{4}-\d{2}-\d{2}/u.test(tok) || /^\d{2}:\d{2}:\d{2}/u.test(tok)) {
    return tok;
  }
  return undefined;
};

export const parseToml = (src: string): TomlTable => {
  const root: TomlTable = {};
  let current: TomlTable = root;
  let i = 0;
  const n = src.length;
  let line = 1;

  const fail: (msg: string) => never = (msg) => {
    throw new TomlError(`${msg} at line ${line}`);
  };

  const skipWs = () => {
    while (i < n && (src[i] === " " || src[i] === "\t")) {
      i += 1;
    }
  };

  /** Whitespace, newlines, and comments: what may sit between values inside arrays. */
  const skipBlank = () => {
    for (;;) {
      skipWs();
      if (src[i] === "#") {
        while (i < n && src[i] !== "\n") {
          i += 1;
        }
      } else if (src[i] === "\r" || src[i] === "\n") {
        if (src[i] === "\n") {
          line += 1;
        }
        i += 1;
      } else {
        return;
      }
    }
  };

  const endOfLine = () => {
    skipWs();
    if (src[i] === "#") {
      while (i < n && src[i] !== "\n") {
        i += 1;
      }
    }
    if (i >= n) {
      return;
    }
    if (src[i] === "\r") {
      i += 1;
    }
    if (src[i] !== "\n") {
      fail(`Unexpected ${JSON.stringify(src[i])}`);
    }
    i += 1;
    line += 1;
  };

  const basicString = (triple: boolean): string => {
    // Opening quotes already consumed.
    let out = "";
    if (triple && src[i] === "\n") {
      i += 1;
      line += 1;
    }
    for (;;) {
      const c = src[i];
      if (c === undefined) {
        return fail("Unterminated string");
      }
      if (c === '"') {
        if (!triple) {
          i += 1;
          return out;
        }
        if (src.startsWith('"""', i)) {
          i += 3;
          return out;
        }
        out += c;
        i += 1;
        continue;
      }
      if (c === "\\") {
        const e = src[i + 1];
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
          case "b": {
            out += "\b";
            break;
          }
          case "f": {
            out += "\f";
            break;
          }
          case "u": {
            out += String.fromCodePoint(
              Number.parseInt(src.slice(i, i + 4), 16)
            );
            i += 4;
            break;
          }
          case "U": {
            out += String.fromCodePoint(
              Number.parseInt(src.slice(i, i + 8), 16)
            );
            i += 8;
            break;
          }
          default: {
            fail(`Unsupported escape \\${e}`);
          }
        }
        continue;
      }
      if (c === "\n") {
        if (!triple) {
          fail("Unterminated string");
        }
        line += 1;
      }
      out += c;
      i += 1;
    }
  };

  const literalString = (triple: boolean): string => {
    const close = triple ? "'''" : "'";
    const end = src.indexOf(close, i);
    if (end === -1) {
      fail("Unterminated string");
    }
    let s = src.slice(i, end);
    if (triple && s.startsWith("\n")) {
      s = s.slice(1);
    }
    line += (s.match(/\n/gu) || []).length;
    i = end + close.length;
    return s;
  };

  const parseString = (): string => {
    if (src.startsWith('"""', i)) {
      i += 3;
      return basicString(true);
    }
    if (src.startsWith("'''", i)) {
      i += 3;
      return literalString(true);
    }
    if (src[i] === '"') {
      i += 1;
      return basicString(false);
    }
    i += 1;
    return literalString(false);
  };

  const parseKeyPath = (): string[] => {
    const keys: string[] = [];
    for (;;) {
      skipWs();
      const c = src[i];
      if (c === '"' || c === "'") {
        keys.push(parseString());
      } else {
        let j = i;
        while (isBareKeyChar(src[j])) {
          j += 1;
        }
        if (j === i) {
          fail("Expected a key");
        }
        keys.push(src.slice(i, j));
        i = j;
      }
      skipWs();
      if (src[i] === ".") {
        i += 1;
        continue;
      }
      return keys;
    }
  };

  /** Walk `keys` from `base`, creating tables as needed; an array on the way means its last element. */
  const resolve = (base: TomlTable, keys: string[]): TomlTable => {
    let t = base;
    for (const k of keys) {
      let v = t[k];
      if (v === undefined) {
        v = {};
        t[k] = v;
      }
      if (Array.isArray(v)) {
        v = v.at(-1);
      }
      if (typeof v !== "object" || v === null) {
        fail(`Key ${k} is not a table`);
      }
      t = v as TomlTable;
    }
    return t;
  };

  /** The last key of a path; parseKeyPath never returns an empty one. */
  const lastKey = (keys: string[]): string =>
    keys.at(-1) ?? fail("Expected a key");

  const assign = (base: TomlTable, keys: string[], value: unknown) => {
    const t = resolve(base, keys.slice(0, -1));
    const last = lastKey(keys);
    if (last in t) {
      fail(`Duplicate key ${last}`);
    }
    t[last] = value;
  };

  /** An array whose items `parseItem` reads; it is passed in because items may themselves be arrays. */
  const parseArray = (parseItem: () => unknown): unknown[] => {
    // Past the opening [.
    i += 1;
    const out: unknown[] = [];
    for (;;) {
      skipBlank();
      if (src[i] === "]") {
        i += 1;
        return out;
      }
      out.push(parseItem());
      skipBlank();
      if (src[i] === ",") {
        i += 1;
        continue;
      }
      if (src[i] === "]") {
        i += 1;
        return out;
      }
      fail("Expected ',' or ']' in array");
    }
  };

  /** An inline table whose values `parseItem` reads; it is passed in because values may themselves be tables. */
  const parseInlineTable = (parseItem: () => unknown): TomlTable => {
    // Past the opening {.
    i += 1;
    const out: TomlTable = {};
    skipWs();
    if (src[i] === "}") {
      i += 1;
      return out;
    }
    for (;;) {
      const keys = parseKeyPath();
      skipWs();
      if (src[i] !== "=") {
        fail("Expected '=' in inline table");
      }
      i += 1;
      const value = parseItem();
      assign(out, keys, value);
      skipWs();
      if (src[i] === ",") {
        i += 1;
        skipWs();
        continue;
      }
      if (src[i] === "}") {
        i += 1;
        return out;
      }
      fail("Expected ',' or '}' in inline table");
    }
  };

  const parseValue = (): unknown => {
    skipWs();
    const c = src[i];
    if (c === undefined) {
      fail("Expected a value");
    }
    if (c === '"' || c === "'") {
      return parseString();
    }
    if (c === "[") {
      return parseArray(parseValue);
    }
    if (c === "{") {
      return parseInlineTable(parseValue);
    }
    let j = i;
    while (!endsToken(src[j])) {
      j += 1;
    }
    const tok = src.slice(i, j);
    i = j;
    const value = scalarValue(tok);
    if (value === undefined) {
      fail(`Unexpected value ${JSON.stringify(tok)}`);
    }
    return value;
  };

  while (i < n) {
    skipBlank();
    if (i >= n) {
      break;
    }
    if (src.startsWith("[[", i)) {
      i += 2;
      const keys = parseKeyPath();
      if (!src.startsWith("]]", i)) {
        fail("Expected ']]'");
      }
      i += 2;
      const parent = resolve(root, keys.slice(0, -1));
      const last = lastKey(keys);
      let arr = parent[last];
      if (arr === undefined) {
        arr = [];
        parent[last] = arr;
      }
      if (!Array.isArray(arr)) {
        fail(`Key ${last} is not an array of tables`);
      }
      const table: TomlTable = {};
      arr.push(table);
      current = table;
      endOfLine();
      continue;
    }
    if (src[i] === "[") {
      i += 1;
      const keys = parseKeyPath();
      if (src[i] !== "]") {
        fail("Expected ']'");
      }
      i += 1;
      current = resolve(root, keys);
      endOfLine();
      continue;
    }
    const keys = parseKeyPath();
    skipWs();
    if (src[i] !== "=") {
      fail("Expected '='");
    }
    i += 1;
    const value = parseValue();
    assign(current, keys, value);
    endOfLine();
  }
  return root;
};
