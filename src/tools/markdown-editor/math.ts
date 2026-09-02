// LaTeX math is pulled out of the Markdown before parsing (the parser would
// mangle _ and * inside TeX) and put back into the rendered DOM afterwards.
// Private-use characters make placeholders that survive the parser untouched.

export interface MathItem {
  tex: string;
  display: boolean;
  /** The source text with its delimiters, shown until the typesetter is loaded. */
  raw: string;
}

const PH = (i: number) => "M" + i + "";
const PH_RE = /(M\d+)/;
const PH_ONE = /^M(\d+)$/;

/**
 * Recognizes `$...$`, `$$...$$` (inline or spanning lines), `\(...\)` and
 * `\[...\]`. Fenced code and code spans are left alone, a `$` followed by a
 * space does not open math, a closing `$` may not follow a space, an escaped
 * `\$` stays inside, and a body that is only digits and punctuation stays
 * currency.
 */
export function extractMath(src: string): { src: string; math: MathItem[] } {
  const math: MathItem[] = [];
  const out: string[] = [];
  let inFence = false, fenceCh = "";
  let disp: string[] | null = null, dispPrefix = "";
  for (const line of src.split("\n")) {
    if (disp) {
      const close = line.indexOf("$$");
      if (close === -1) {
        disp.push(line);
        continue;
      }
      disp.push(line.slice(0, close));
      const tex = disp.join("\n");
      math.push({ tex, display: true, raw: "$$" + tex + "$$" });
      out.push(dispPrefix + PH(math.length - 1) + line.slice(close + 2));
      disp = null;
      dispPrefix = "";
      continue;
    }
    const fm = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fm) {
      if (!inFence) {
        inFence = true;
        fenceCh = fm[1]![0]!;
      } else if (fm[1]![0] === fenceCh) inFence = false;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    let res = "", j = 0, opened = false;
    while (j < line.length) {
      const c = line[j];
      if (c === "`") {
        let k = j;
        while (line[k] === "`") k++;
        const run = k - j;
        let m = k, close = -1;
        while (m < line.length) {
          if (line[m] === "`") {
            let m2 = m;
            while (line[m2] === "`") m2++;
            if (m2 - m === run) {
              close = m2;
              break;
            }
            m = m2;
          } else m++;
        }
        if (close !== -1) {
          res += line.slice(j, close);
          j = close;
        } else {
          res += line.slice(j, k);
          j = k;
        }
        continue;
      }
      if (c === "\\" && (line[j + 1] === "(" || line[j + 1] === "[")) {
        const display = line[j + 1] === "[";
        const closer = display ? "\\]" : "\\)";
        const end = line.indexOf(closer, j + 2);
        if (end !== -1) {
          math.push({ tex: line.slice(j + 2, end), display, raw: line.slice(j, end + 2) });
          res += PH(math.length - 1);
          j = end + 2;
          continue;
        }
        res += c;
        j++;
        continue;
      }
      if (c === "$") {
        if (line[j + 1] === "$") {
          const end = line.indexOf("$$", j + 2);
          if (end !== -1) {
            math.push({ tex: line.slice(j + 2, end), display: true, raw: line.slice(j, end + 2) });
            res += PH(math.length - 1);
            j = end + 2;
            continue;
          }
          disp = [line.slice(j + 2)];
          dispPrefix = res;
          opened = true;
          break;
        }
        let end = -1;
        for (let m = j + 1; m < line.length; m++) {
          if (line[m] !== "$") continue;
          if (line[m - 1] === "\\") continue; // an escaped dollar inside the math
          if (line[m - 1] !== " " && m > j + 1) end = m;
          break;
        }
        if (end !== -1 && line[j + 1] !== " ") {
          const tex = line.slice(j + 1, end);
          if (!/^[\d.,]*$/.test(tex)) {
            math.push({ tex, display: false, raw: line.slice(j, end + 1) });
            res += PH(math.length - 1);
            j = end + 1;
            continue;
          }
        }
        res += c;
        j++;
        continue;
      }
      res += c;
      j++;
    }
    if (!opened) out.push(res);
  }
  // an unterminated $$ is restored verbatim
  if (disp) out.push(dispPrefix + "$$" + disp.join("\n"));
  return { src: out.join("\n"), math };
}

/**
 * Replaces each placeholder in the rendered DOM with what `render` returns
 * for it: typeset math, or the source text while the typesetter is not here.
 * Placeholders inside code are left alone (they were never math).
 */
export function injectMath(root: HTMLElement, math: MathItem[], render: (item: MathItem) => Node) {
  if (!math.length) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) {
    if ((n.nodeValue ?? "").indexOf("") !== -1) nodes.push(n as Text);
  }
  for (const node of nodes) {
    if (node.parentElement?.closest("code, pre")) continue;
    const frag = document.createDocumentFragment();
    for (const part of (node.nodeValue ?? "").split(PH_RE)) {
      const m = PH_ONE.exec(part);
      const item = m ? math[+m[1]!] : undefined;
      if (!item) {
        if (part) frag.appendChild(document.createTextNode(part));
        continue;
      }
      frag.appendChild(render(item));
    }
    node.parentNode?.replaceChild(frag, node);
  }
}
