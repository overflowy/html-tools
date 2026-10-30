import { describe, expect, test } from "bun:test";

import {
  formatDuration,
  formatRemaining,
  parseDuration,
  secondsLeft,
} from "./countdown";
import { DEFAULTS, decode, encode } from "./state";
import type { Settings } from "./state";
import { hasCountdown, parse, slideAt } from "./text";

/** `v`, failing the test where it is missing. */
const present = <T>(v: T | undefined): T => {
  if (v === undefined) {
    throw new Error("Expected a value, got undefined.");
  }
  return v;
};

/** The first Slide's blocks, as `[level, inline]` pairs. */
const blocks = (message: string) =>
  present(parse(message)[0]).blocks.map((b) => [b.level, b.inline]);
const one = (message: string) =>
  present(present(parse(message)[0]).blocks[0]).inline;

describe("message", () => {
  test("plain text, with its line breaks", () => {
    expect(blocks("Hello\nworld")).toEqual([[0, ["Hello\nworld"]]]);
  });

  test("bold, italic, both, strike, code", () => {
    expect(one("**a** *b* ***c*** ~~d~~ `e*f*`")).toEqual([
      { children: ["a"], tag: "strong" },
      " ",
      { children: ["b"], tag: "em" },
      " ",
      { children: [{ children: ["c"], tag: "em" }], tag: "strong" },
      " ",
      { children: ["d"], tag: "del" },
      " ",
      { tag: "code", text: "e*f*" },
    ]);
    expect(one("__a__ _b_")).toEqual([
      { children: ["a"], tag: "strong" },
      " ",
      { children: ["b"], tag: "em" },
    ]);
  });

  test("nesting", () => {
    expect(one("**a *b* c**")).toEqual([
      { children: ["a ", { children: ["b"], tag: "em" }, " c"], tag: "strong" },
    ]);
  });

  test("unmatched and spaced markers show as typed", () => {
    expect(one("**a")).toEqual(["**a"]);
    expect(one("a * b * c")).toEqual(["a * b * c"]);
    expect(one("~a~ ~~~b~~~")).toEqual(["~a~ ~~~b~~~"]);
    expect(one("****")).toEqual(["****"]);
  });

  test("underscores inside words are literal", () => {
    expect(one("snake_case_name")).toEqual(["snake_case_name"]);
    expect(one("a_b _c_")).toEqual(["a_b ", { children: ["c"], tag: "em" }]);
  });

  test("escapes make the next character literal", () => {
    expect(one("\\*a\\* \\|| \\{countdown} \\# x")).toEqual([
      "*a* || {countdown} # x",
    ]);
    expect(blocks("\\# not a heading")).toEqual([[0, ["# not a heading"]]]);
    expect(one("a\\")).toEqual(["a\\"]);
  });

  test("code spans keep everything literal, on one line", () => {
    expect(one("`**a** || {countdown}`")).toEqual([
      { tag: "code", text: "**a** || {countdown}" },
    ]);
    expect(parse("`a\nb` || c")).toHaveLength(2);
    expect(one("``")).toEqual(["``"]);
  });

  test("headings, and a blank line between blocks", () => {
    expect(blocks("# Big\n## Less\nplain\n\nmore")).toEqual([
      [1, ["Big"]],
      [2, ["Less"]],
      [0, ["plain"]],
      [0, []],
      [0, ["more"]],
    ]);
    expect(blocks("#nospace ### three")).toEqual([[0, ["#nospace ### three"]]]);
  });

  test("emphasis spans lines, but a blank line or heading ends it", () => {
    expect(one("**a\nb**")).toEqual([{ children: ["a\nb"], tag: "strong" }]);
    expect(blocks("**a\n\nb**")).toEqual([
      [0, ["**a"]],
      [0, []],
      [0, ["b**"]],
    ]);
  });

  test("slides split on ||, trimmed, and may be empty", () => {
    const slides = parse("One ||\nTwo\n||  || Three");
    expect(slides.map((s) => s.blocks.map((b) => b.inline))).toEqual([
      [["One"]],
      [["Two"]],
      [],
      [["Three"]],
    ]);
  });

  test("countdown placement", () => {
    const [a, b] = parse("Starts in **{countdown}** || Welcome");
    expect(present(a).hasCountdown).toBe(true);
    expect(present(b).hasCountdown).toBe(false);
    expect(one("{countdown}")).toEqual([{ tag: "countdown" }]);
    expect(hasCountdown("x `{countdown}`")).toBe(false);
    expect(hasCountdown("x {countdown}")).toBe(true);
  });

  test("the Slide under the caret", () => {
    const m = "a || b `||` c || d";
    expect(slideAt(m, 0)).toBe(0);
    expect(slideAt(m, m.indexOf("b"))).toBe(1);
    expect(slideAt(m, m.indexOf("c"))).toBe(1);
    expect(slideAt(m, m.length)).toBe(2);
  });

  test("CRLF is one line break", () => {
    expect(blocks("a\r\nb")).toEqual([[0, ["a\nb"]]]);
  });
});

describe("countdown", () => {
  test("durations", () => {
    expect(parseDuration("90")).toBe(90);
    expect(parseDuration("1h30m")).toBe(5400);
    expect(parseDuration("30m 1h")).toBe(5400);
    expect(parseDuration("2d12h")).toBe(216_000);
    expect(parseDuration("5:00")).toBe(300);
    expect(parseDuration("1:30:00")).toBe(5400);
    expect(parseDuration("1:00:00:00")).toBe(86_400);
    for (const bad of ["", "0", "1h1h", "5:60", "1x", "100d", "-5"]) {
      expect(parseDuration(bad)).toBeNull();
    }
  });

  test("canonical spelling round-trips", () => {
    for (const secs of [1, 59, 60, 5400, 90_061, 99 * 86_400]) {
      expect(parseDuration(formatDuration(secs))).toBe(secs);
    }
    expect(formatDuration(5400)).toBe("1h30m");
  });

  test("labels drop leading zero units and never wrap", () => {
    const nb = (s: string) => s.replaceAll(" ", "\u00A0");
    expect(formatRemaining(3605, "label")).toBe(nb("1h 0m 5s"));
    expect(formatRemaining(300, "label")).toBe(nb("5m 0s"));
    expect(formatRemaining(90_061, "label")).toBe(nb("1d 1h 1m 1s"));
    expect(formatRemaining(0, "label")).toBe("0s");
  });

  test("clock", () => {
    expect(formatRemaining(3605, "clock")).toBe("1:00:05");
    expect(formatRemaining(300, "clock")).toBe("5:00");
    expect(formatRemaining(9, "clock")).toBe("0:09");
    expect(formatRemaining(0, "clock")).toBe("0:00");
    expect(formatRemaining(90_061, "clock")).toBe("1:01:01:01");
  });

  test("seconds left round up, and stop at zero", () => {
    expect(secondsLeft(10_000, 0)).toBe(10);
    expect(secondsLeft(10_000, 1)).toBe(10);
    expect(secondsLeft(10_000, 9001)).toBe(1);
    expect(secondsLeft(10_000, 10_000)).toBe(0);
    expect(secondsLeft(10_000, 20_000)).toBe(0);
  });
});

describe("deep link", () => {
  test("defaults make an empty link", () => {
    expect(encode(DEFAULTS)).toBe("");
    expect(decode("")).toEqual({ settings: DEFAULTS, show: false });
  });

  test("everything round-trips", () => {
    const s: Settings = {
      bg: "#00ff00",
      countdown: { at: Date.UTC(2026, 11, 31, 23), kind: "until" },
      end: "text",
      endText: "Happy new year",
      fg: "#ff0000",
      font: "mono",
      message: "Hi & bye || **#1** {countdown}",
      pad: 12,
      scroll: true,
      secs: 2.5,
      speed: "fast",
      style: "clock",
      transition: "slide",
      wrap: false,
    };
    expect(decode(encode(s, true))).toEqual({ settings: s, show: true });
    const timer: Settings = {
      ...DEFAULTS,
      countdown: { kind: "timer", secs: 5400 },
      message: "x",
    };
    expect(encode(timer)).toBe("m=x&timer=1h30m");
    expect(decode(encode(timer)).settings).toEqual(timer);
  });

  test("until is written in UTC to the second", () => {
    expect(
      encode({
        ...DEFAULTS,
        countdown: { at: Date.UTC(2026, 0, 2, 3, 4, 5), kind: "until" },
      })
    ).toBe("until=2026-01-02T03%3A04%3A05Z");
  });

  test("bad values fall back to defaults", () => {
    const { settings } = decode(
      "font=comic&fg=red&pad=99&secs=0&trans=spin&timer=forever&end=explode&speed=warp"
    );
    expect(settings).toEqual({ ...DEFAULTS, pad: 40, secs: 0.5 });
  });
});
