// LaTeX math is pulled out of the Markdown before parsing (the parser would
// mangle _ and * inside TeX) and put back into the rendered DOM afterwards.
// Private-use characters make placeholders that survive the parser untouched.

export interface MathItem {
  tex: string;
  display: boolean;
  /** The source text with its delimiters, shown until the typesetter is loaded. */
  raw: string;
}

const PH = (i: number) => `M${i}`;
const PH_RE = /(?<placeholder>M\d+)/u;
const PH_ONE = /^M(?<index>\d+)$/u;

const FENCE_RE = /^\s{0,3}(?<fence>`{3,}|~{3,})/u;
const CURRENCY_RE = /^[\d.,]*$/u;

/** A math span found in a line, and the index just past it. */
interface MathMatch {
  item: MathItem;
  end: number;
}

/**
 * Returns the index just past the code span whose backticks start at `j`, or
 * just past those backticks when no run of the same length closes it.
 */
const skipCodeSpan = (line: string, j: number): number => {
  let k = j;
  while (line[k] === "`") {
    k += 1;
  }
  const run = k - j;
  let m = k;
  while (m < line.length) {
    if (line[m] !== "`") {
      m += 1;
      continue;
    }
    let m2 = m;
    while (line[m2] === "`") {
      m2 += 1;
    }
    if (m2 - m === run) {
      return m2;
    }
    m = m2;
  }
  return k;
};

/** `\(...\)` or `\[...\]` starting at `j`. */
const bracketMath = (line: string, j: number): MathMatch | null => {
  const display = line[j + 1] === "[";
  const closer = display ? "\\]" : "\\)";
  const end = line.indexOf(closer, j + 2);
  if (end === -1) {
    return null;
  }
  return {
    end: end + 2,
    item: {
      display,
      raw: line.slice(j, end + 2),
      tex: line.slice(j + 2, end),
    },
  };
};

/** `$$...$$` closed on the same line, starting at `j`. */
const displayDollarMath = (line: string, j: number): MathMatch | null => {
  const end = line.indexOf("$$", j + 2);
  if (end === -1) {
    return null;
  }
  return {
    end: end + 2,
    item: {
      display: true,
      raw: line.slice(j, end + 2),
      tex: line.slice(j + 2, end),
    },
  };
};

/** The index of the `$` closing inline math opened at `j`, or -1. */
const findInlineClose = (line: string, j: number): number => {
  for (let m = j + 1; m < line.length; m += 1) {
    if (line[m] !== "$") {
      continue;
    }
    // an escaped dollar inside the math
    if (line[m - 1] === "\\") {
      continue;
    }
    return line[m - 1] !== " " && m > j + 1 ? m : -1;
  }
  return -1;
};

/** `$...$` starting at `j`, unless it is spaced or only currency. */
const inlineDollarMath = (line: string, j: number): MathMatch | null => {
  const end = findInlineClose(line, j);
  if (end === -1 || line[j + 1] === " ") {
    return null;
  }
  const tex = line.slice(j + 1, end);
  if (CURRENCY_RE.test(tex)) {
    return null;
  }
  return {
    end: end + 1,
    item: { display: false, raw: line.slice(j, end + 1), tex },
  };
};

const mathAt = (line: string, j: number): MathMatch | null => {
  const c = line[j];
  const next = line[j + 1];
  if (c === "\\" && (next === "(" || next === "[")) {
    return bracketMath(line, j);
  }
  if (c === "$" && next === "$") {
    return displayDollarMath(line, j);
  }
  if (c === "$") {
    return inlineDollarMath(line, j);
  }
  return null;
};

/**
 * Replaces the math in one line outside fenced code with placeholders. When
 * a `$$` opens a display block that does not close on this line, `open` is
 * the rest of the line after it and `text` is what came before it.
 */
const scanLine = (
  line: string,
  math: MathItem[]
): { text: string; open: string | null } => {
  let res = "";
  let j = 0;
  while (j < line.length) {
    const c = line[j];
    if (c === "`") {
      const end = skipCodeSpan(line, j);
      res += line.slice(j, end);
      j = end;
      continue;
    }
    if (c === "$" && line[j + 1] === "$" && !line.includes("$$", j + 2)) {
      return { open: line.slice(j + 2), text: res };
    }
    const found = mathAt(line, j);
    if (found) {
      math.push(found.item);
      res += PH(math.length - 1);
      j = found.end;
      continue;
    }
    res += c;
    j += 1;
  }
  return { open: null, text: res };
};

/**
 * Recognizes `$...$`, `$$...$$` (inline or spanning lines), `\(...\)` and
 * `\[...\]`. Fenced code and code spans are left alone, a `$` followed by a
 * space does not open math, a closing `$` may not follow a space, an escaped
 * `\$` stays inside, and a body that is only digits and punctuation stays
 * currency.
 */
export const extractMath = (src: string): { src: string; math: MathItem[] } => {
  const math: MathItem[] = [];
  const out: string[] = [];
  let inFence = false;
  let fenceCh = "";
  let disp: string[] | null = null;
  let dispPrefix = "";
  for (const line of src.split("\n")) {
    if (disp) {
      const close = line.indexOf("$$");
      if (close === -1) {
        disp.push(line);
        continue;
      }
      disp.push(line.slice(0, close));
      const tex = disp.join("\n");
      math.push({ display: true, raw: `$$${tex}$$`, tex });
      out.push(dispPrefix + PH(math.length - 1) + line.slice(close + 2));
      disp = null;
      dispPrefix = "";
      continue;
    }
    const fm = FENCE_RE.exec(line);
    if (fm) {
      const ch = (fm.groups?.fence ?? "").charAt(0);
      if (!inFence) {
        inFence = true;
        fenceCh = ch;
      } else if (ch === fenceCh) {
        inFence = false;
      }
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    const scan = scanLine(line, math);
    if (scan.open === null) {
      out.push(scan.text);
    } else {
      disp = [scan.open];
      dispPrefix = scan.text;
    }
  }
  // an unterminated $$ is restored verbatim
  if (disp) {
    out.push(`${dispPrefix}$$${disp.join("\n")}`);
  }
  return { math, src: out.join("\n") };
};

/**
 * Replaces each placeholder in the rendered DOM with what `render` returns
 * for it: typeset math, or the source text while the typesetter is not here.
 * Placeholders inside code are left alone (they were never math).
 */
export const injectMath = (
  root: HTMLElement,
  math: MathItem[],
  render: (item: MathItem) => Node
) => {
  if (!math.length) {
    return;
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) {
    if ((n.nodeValue ?? "").includes("")) {
      nodes.push(n as Text);
    }
  }
  for (const node of nodes) {
    if (node.parentElement?.closest("code, pre")) {
      continue;
    }
    const frag = document.createDocumentFragment();
    for (const part of (node.nodeValue ?? "").split(PH_RE)) {
      const m = PH_ONE.exec(part);
      const index = m?.groups?.index;
      const item = index === undefined ? undefined : math[Number(index)];
      if (!item) {
        if (part) {
          frag.append(document.createTextNode(part));
        }
        continue;
      }
      frag.append(render(item));
    }
    node.parentNode?.replaceChild(frag, node);
  }
};
