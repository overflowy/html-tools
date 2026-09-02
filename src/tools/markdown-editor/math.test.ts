import { describe, expect, test } from "bun:test";
import { extractMath } from "./math";

const PH = /M\d+/g;

describe("extractMath", () => {
  test("inline and display delimiters", () => {
    const { src, math } = extractMath("Inline $a_1 * b$ then \\(x\\) and \\[y\\]\n$$\nz\n$$\nafter");
    expect(math.map((m) => [m.tex, m.display])).toEqual([["a_1 * b", false], ["x", false], ["y", true], ["\nz\n", true]]);
    expect(src.match(PH)!.length).toBe(4);
    expect(src).not.toContain("$");
  });

  test("keeps the source text for the fallback", () => {
    const { math } = extractMath("A $x^2$ and $$y$$.");
    expect(math.map((m) => m.raw)).toEqual(["$x^2$", "$$y$$"]);
  });

  test("leaves code alone", () => {
    const { src, math } = extractMath("`$x$` and\n\n```\n$y$\n```\n\n~~~\n$z$\n~~~\n");
    expect(math).toEqual([]);
    expect(src).toContain("`$x$`");
    expect(src).toContain("$y$");
  });

  test("currency and spaced dollars are not math", () => {
    const { src, math } = extractMath("Costs $5.00 or $ 7 $ and $12,000$ total");
    expect(math).toEqual([]);
    expect(src).toBe("Costs $5.00 or $ 7 $ and $12,000$ total");
  });

  test("an unterminated display block is restored verbatim", () => {
    const text = "before\n$$\na + b\nstill open";
    expect(extractMath(text)).toEqual({ src: text, math: [] });
  });

  test("a closing dollar after a backslash or a space does not close", () => {
    const { math } = extractMath("$a \\$ b$ and $c $");
    expect(math.map((m) => m.tex)).toEqual(["a \\$ b"]);
  });
});
