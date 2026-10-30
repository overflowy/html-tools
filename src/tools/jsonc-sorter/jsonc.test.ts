// Unit tests for the JSONC tokenizer, parser, sorter, serializer and highlighter. Run: bun test
import { describe, expect, test } from "bun:test";

import {
  countStats,
  highlight,
  parse,
  serialize,
  sortTree,
  tokenize,
} from "./jsonc";

/** Sort and reformat like the tool does with its default options. */
const format = (
  src: string,
  { order = "asc", brackets = true, indent = "  " } = {}
): string => {
  const doc = parse(tokenize(src));
  sortTree(doc.root, order, brackets);
  return serialize(doc, indent);
};

const lines = (...rows: string[]) => `${rows.join("\n")}\n`;

const stats = (src: string) =>
  countStats(parse(tokenize(src)).root, { comments: 0, keys: 0 });

describe("tokenize", () => {
  test("emits typed tokens with their line numbers", () => {
    expect(tokenize("{\"a\":1}\n// x\n'b'")).toEqual([
      { line: 1, text: "{", type: "punct" },
      { inner: "a", line: 1, quote: '"', raw: '"a"', type: "string" },
      { line: 1, text: ":", type: "punct" },
      { line: 1, text: "1", type: "atom" },
      { line: 1, text: "}", type: "punct" },
      { line: 2, text: "// x", type: "comment" },
      { inner: "b", line: 3, quote: "'", raw: "'b'", type: "string" },
    ]);
  });

  test("counts lines inside block comments", () => {
    expect(() => tokenize('{\n/* a\nb */\n"a" 1}')).not.toThrow();
    expect(() => format('{\n/* a\nb */\n"a" 1}')).toThrow(
      "Expected ':' at line 4"
    );
  });

  test("rejects unterminated strings and comments", () => {
    expect(() => tokenize('{"a": "x')).toThrow("Unterminated string at line 1");
    expect(() => tokenize('{"a": "x\ny"}')).toThrow(
      "Unterminated string at line 1"
    );
    expect(() => tokenize("/* open")).toThrow(
      "Unterminated block comment starting at line 1"
    );
  });
});

describe("sorting", () => {
  test("ascending and descending", () => {
    expect(format('{"b": 1, "a": 2}')).toBe(
      lines("{", '  "a": 2,', '  "b": 1', "}")
    );
    expect(format('{"b": 1, "a": 2}', { order: "desc" })).toBe(
      lines("{", '  "b": 1,', '  "a": 2', "}")
    );
  });

  test("numeric-aware, lowercase before uppercase on ties", () => {
    expect(format('{"item10": 1, "item2": 2, "Item1": 3, "item1": 4}')).toBe(
      lines(
        "{",
        '  "item1": 4,',
        '  "Item1": 3,',
        '  "item2": 2,',
        '  "item10": 1',
        "}"
      )
    );
  });

  test("bracket segments sort inside keys made only of them", () => {
    expect(format('{"[b][a]": 1, "[c]": 2, "x[b][a]": 3}')).toBe(
      lines("{", '  "[a][b]": 1,', '  "[c]": 2,', '  "x[b][a]": 3', "}")
    );
    expect(format('{"[b][a]": 1, "[c]": 2}', { brackets: false })).toBe(
      lines("{", '  "[b][a]": 1,', '  "[c]": 2', "}")
    );
  });

  test("keys sort by decoded value and keep their raw spelling", () => {
    expect(format("{'single': 'q', \"u\\u0041\": 1}")).toBe(
      lines("{", "  'single': 'q',", '  "u\\u0041": 1', "}")
    );
  });

  test("arrays keep their order; objects inside them are sorted", () => {
    expect(format('[3, 1, {"b": 1, "a": 2}]', { indent: "\t" })).toBe(
      lines("[", "\t3,", "\t1,", "\t{", '\t\t"a": 2,', '\t\t"b": 1', "\t}", "]")
    );
  });
});

describe("comments", () => {
  const src = `// head
{
  // lead b
  "b": 1, // trail b
  /* block
   * more
   */
  "a": [1, 2, "x"], // trail a
  "c" /* k */ : /* v */ {"z": null, "y": true,},
  // dangling
}
// tail`;

  test("travel with their keys, dangling ones stay at the end", () => {
    expect(format(src)).toBe(
      lines(
        "// head",
        "{",
        "  /* block",
        "   * more",
        "   */",
        '  "a": [1, 2, "x"], // trail a',
        "  // lead b",
        '  "b": 1, // trail b',
        "  /* k */",
        "  /* v */",
        '  "c": {',
        '    "y": true,',
        '    "z": null',
        "  }",
        "  // dangling",
        "}",
        "// tail"
      )
    );
  });

  test("are counted with the keys", () => {
    expect(stats(src)).toEqual({ comments: 7, keys: 5 });
    expect(stats('{"a": 1}')).toEqual({ comments: 0, keys: 1 });
  });

  test("alone in a container keep it open", () => {
    expect(format('{"a": [ /* only */ ], "b": { // only\n }}')).toBe(
      lines(
        "{",
        '  "a": [',
        "    /* only */",
        "  ],",
        '  "b": {',
        "    // only",
        "  }",
        "}"
      )
    );
  });
});

describe("layout", () => {
  test("empty containers, nested arrays, and commented items", () => {
    expect(
      format('{"a": {}, "b": [], "c": [[1, 2], {"d": 1}], "e": [1, // c\n 2]}')
    ).toBe(
      lines(
        "{",
        '  "a": {},',
        '  "b": [],',
        '  "c": [',
        "    [1, 2],",
        "    {",
        '      "d": 1',
        "    }",
        "  ],",
        '  "e": [',
        "    1, // c",
        "    2",
        "  ]",
        "}"
      )
    );
  });

  test("arrays over 80 columns break one item per line", () => {
    expect(
      format(
        '{"long": ["aaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbb", "cccccccccccccccccccc", "ddddd"]}'
      )
    ).toBe(
      lines(
        "{",
        '  "long": [',
        '    "aaaaaaaaaaaaaaaaaaaa",',
        '    "bbbbbbbbbbbbbbbbbbbb",',
        '    "cccccccccccccccccccc",',
        '    "ddddd"',
        "  ]",
        "}"
      )
    );
  });

  test("trailing commas are dropped, scalars and atoms pass through", () => {
    expect(format('{"a": 1,}')).toBe(lines("{", '  "a": 1', "}"));
    expect(format('"just a string"')).toBe(lines('"just a string"'));
    expect(format("@")).toBe(lines("@"));
  });
});

describe("parse errors", () => {
  const cases: [string, string][] = [
    ["{", "Unclosed object (missing '}')"],
    ["[", "Unclosed array (missing ']')"],
    ['{"a" 1}', "Expected ':' at line 1"],
    ['{"a": 1 "b": 2}', "Expected ',' or '}' at line 1"],
    ["[1 2]", "Expected ',' or ']' at line 1"],
    ["{a: 1}", "Expected a quoted key at line 1"],
    ["{]", "Expected a quoted key at line 1"],
    ["{} {}", "Unexpected token '{' after end of document (line 1)"],
    ["{} extra", "Unexpected token 'extra' after end of document (line 1)"],
    ["", "Unexpected end of input"],
  ];
  for (const [src, message] of cases) {
    test(JSON.stringify(src), () => {
      expect(() => format(src)).toThrow(new SyntaxError(message));
    });
  }
});

describe("highlight", () => {
  test("wraps comments, keys, strings, numbers and keywords; escapes the rest", () => {
    expect(
      highlight(
        '// c\n{"k": "v", "n": -1.5e+3, "t": true, "f": false, "z": null, /* b\n */ "s": "a\\"b", x: <&>}'
      )
    ).toBe(
      '<span class="c">// c</span>\n{<span class="k">"k"</span>: <span class="s">"v"</span>, <span class="k">"n"</span>: <span class="n">-1.5e+3</span>, <span class="k">"t"</span>: <span class="b">true</span>, <span class="k">"f"</span>: <span class="b">false</span>, <span class="k">"z"</span>: <span class="b">null</span>, <span class="c">/* b\n */</span> <span class="k">"s"</span>: <span class="s">"a\\"b"</span>, x: &lt;&amp;&gt;}'
    );
  });
});
