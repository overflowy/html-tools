import { describe, expect, test } from "bun:test";

import { extractMath } from "./math";

const PH = /M\d+/gu;

/** The source with each placeholder shown as `<index>`. */
const shown = (src: string) =>
  src.replaceAll(/M(?<index>\d+)/gu, "<$<index>>");

describe("extractMath", () => {
  test("inline and display delimiters", () => {
    const { src, math } = extractMath(
      "Inline $a_1 * b$ then \\(x\\) and \\[y\\]\n$$\nz\n$$\nafter"
    );
    expect(math.map((m) => [m.tex, m.display])).toEqual([
      ["a_1 * b", false],
      ["x", false],
      ["y", true],
      ["\nz\n", true],
    ]);
    expect(src.match(PH)).toHaveLength(4);
    expect(src).not.toContain("$");
  });

  test("keeps the source text for the fallback", () => {
    const { math } = extractMath("A $x^2$ and $$y$$.");
    expect(math.map((m) => m.raw)).toEqual(["$x^2$", "$$y$$"]);
  });

  test("leaves code alone", () => {
    const { src, math } = extractMath(
      "`$x$` and\n\n```\n$y$\n```\n\n~~~\n$z$\n~~~\n"
    );
    expect(math).toEqual([]);
    expect(src).toContain("`$x$`");
    expect(src).toContain("$y$");
  });

  test("currency and spaced dollars are not math", () => {
    const { src, math } = extractMath(
      "Costs $5.00 or $ 7 $ and $12,000$ total"
    );
    expect(math).toEqual([]);
    expect(src).toBe("Costs $5.00 or $ 7 $ and $12,000$ total");
  });

  test("an unterminated display block is restored verbatim", () => {
    const text = "before\n$$\na + b\nstill open";
    expect(extractMath(text)).toEqual({ math: [], src: text });
  });

  test("a closing dollar after a backslash or a space does not close", () => {
    const { math } = extractMath("$a \\$ b$ and $c $");
    expect(math.map((m) => m.tex)).toEqual(["a \\$ b"]);
  });

  test("an unclosed code span or bracket leaves later math alone", () => {
    expect(shown(extractMath("a `` $x$ ` $y$").src)).toBe("a `` <0> ` <1>");
    expect(shown(extractMath("\\(open $z$").src)).toBe("\\(open <0>");
  });

  test("a display block opened mid-line keeps the text around it", () => {
    const { src, math } = extractMath("pre $$a\nb$$ post");
    expect(shown(src)).toBe("pre <0> post");
    expect(math).toEqual([{ display: true, raw: "$$a\nb$$", tex: "a\nb" }]);
  });

  test("only the opening fence character closes a fence", () => {
    const { src, math } = extractMath("```\n~~~\n$q$\n```\n$r$");
    expect(shown(src)).toBe("```\n~~~\n$q$\n```\n<0>");
    expect(math.map((m) => m.tex)).toEqual(["r"]);
  });
});
