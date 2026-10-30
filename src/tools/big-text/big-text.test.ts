import { describe, expect, test } from "bun:test";
import { formatDuration, formatRemaining, parseDuration, secondsLeft } from "./countdown";
import { DEFAULTS, decode, encode, type Settings } from "./state";
import { hasCountdown, parse, slideAt } from "./text";

/** The first Slide's blocks, as `[level, inline]` pairs. */
const blocks = (message: string) => parse(message)[0]!.blocks.map((b) => [b.level, b.inline]);
const one = (message: string) => parse(message)[0]!.blocks[0]!.inline;

describe("message", () => {
  test("plain text, with its line breaks", () => {
    expect(blocks("Hello\nworld")).toEqual([[0, ["Hello\nworld"]]]);
  });

  test("bold, italic, both, strike, code", () => {
    expect(one("**a** *b* ***c*** ~~d~~ `e*f*`")).toEqual([
      { tag: "strong", children: ["a"] }, " ",
      { tag: "em", children: ["b"] }, " ",
      { tag: "strong", children: [{ tag: "em", children: ["c"] }] }, " ",
      { tag: "del", children: ["d"] }, " ",
      { tag: "code", text: "e*f*" },
    ]);
    expect(one("__a__ _b_")).toEqual([{ tag: "strong", children: ["a"] }, " ", { tag: "em", children: ["b"] }]);
  });

  test("nesting", () => {
    expect(one("**a *b* c**")).toEqual([{ tag: "strong", children: ["a ", { tag: "em", children: ["b"] }, " c"] }]);
  });

  test("unmatched and spaced markers show as typed", () => {
    expect(one("**a")).toEqual(["**a"]);
    expect(one("a * b * c")).toEqual(["a * b * c"]);
    expect(one("~a~ ~~~b~~~")).toEqual(["~a~ ~~~b~~~"]);
    expect(one("****")).toEqual(["****"]);
  });

  test("underscores inside words are literal", () => {
    expect(one("snake_case_name")).toEqual(["snake_case_name"]);
    expect(one("a_b _c_")).toEqual(["a_b ", { tag: "em", children: ["c"] }]);
  });

  test("escapes make the next character literal", () => {
    expect(one("\\*a\\* \\|| \\{countdown} \\# x")).toEqual(["*a* || {countdown} # x"]);
    expect(blocks("\\# not a heading")).toEqual([[0, ["# not a heading"]]]);
    expect(one("a\\")).toEqual(["a\\"]);
  });

  test("code spans keep everything literal, on one line", () => {
    expect(one("`**a** || {countdown}`")).toEqual([{ tag: "code", text: "**a** || {countdown}" }]);
    expect(parse("`a\nb` || c")).toHaveLength(2);
    expect(one("``")).toEqual(["``"]);
  });

  test("headings, and a blank line between blocks", () => {
    expect(blocks("# Big\n## Less\nplain\n\nmore")).toEqual([
      [1, ["Big"]], [2, ["Less"]], [0, ["plain"]], [0, []], [0, ["more"]],
    ]);
    expect(blocks("#nospace ### three")).toEqual([[0, ["#nospace ### three"]]]);
  });

  test("emphasis spans lines, but a blank line or heading ends it", () => {
    expect(one("**a\nb**")).toEqual([{ tag: "strong", children: ["a\nb"] }]);
    expect(blocks("**a\n\nb**")).toEqual([[0, ["**a"]], [0, []], [0, ["b**"]]]);
  });

  test("slides split on ||, trimmed, and may be empty", () => {
    const slides = parse("One ||\nTwo\n||  || Three");
    expect(slides.map((s) => s.blocks.map((b) => b.inline))).toEqual([[["One"]], [["Two"]], [], [["Three"]]]);
  });

  test("countdown placement", () => {
    const [a, b] = parse("Starts in **{countdown}** || Welcome");
    expect(a!.hasCountdown).toBe(true);
    expect(b!.hasCountdown).toBe(false);
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
    expect(parseDuration("2d12h")).toBe(216000);
    expect(parseDuration("5:00")).toBe(300);
    expect(parseDuration("1:30:00")).toBe(5400);
    expect(parseDuration("1:00:00:00")).toBe(86400);
    for (const bad of ["", "0", "1h1h", "5:60", "1x", "100d", "-5"]) expect(parseDuration(bad)).toBeNull();
  });

  test("canonical spelling round-trips", () => {
    for (const secs of [1, 59, 60, 5400, 90061, 99 * 86400]) expect(parseDuration(formatDuration(secs))).toBe(secs);
    expect(formatDuration(5400)).toBe("1h30m");
  });

  test("labels drop leading zero units and never wrap", () => {
    const nb = (s: string) => s.replaceAll(" ", "\u00a0");
    expect(formatRemaining(3605, "label")).toBe(nb("1h 0m 5s"));
    expect(formatRemaining(300, "label")).toBe(nb("5m 0s"));
    expect(formatRemaining(90061, "label")).toBe(nb("1d 1h 1m 1s"));
    expect(formatRemaining(0, "label")).toBe("0s");
  });

  test("clock", () => {
    expect(formatRemaining(3605, "clock")).toBe("1:00:05");
    expect(formatRemaining(300, "clock")).toBe("5:00");
    expect(formatRemaining(9, "clock")).toBe("0:09");
    expect(formatRemaining(0, "clock")).toBe("0:00");
    expect(formatRemaining(90061, "clock")).toBe("1:01:01:01");
  });

  test("seconds left round up, and stop at zero", () => {
    expect(secondsLeft(10_000, 0)).toBe(10);
    expect(secondsLeft(10_000, 1)).toBe(10);
    expect(secondsLeft(10_000, 9_001)).toBe(1);
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
      message: "Hi & bye || **#1** {countdown}",
      font: "mono", fg: "#ff0000", bg: "#00ff00", pad: 12, wrap: false, scroll: true, speed: "fast",
      secs: 2.5, transition: "slide", countdown: { kind: "until", at: Date.UTC(2026, 11, 31, 23) },
      style: "clock", end: "text", endText: "Happy new year",
    };
    expect(decode(encode(s, true))).toEqual({ settings: s, show: true });
    const timer: Settings = { ...DEFAULTS, message: "x", countdown: { kind: "timer", secs: 5400 } };
    expect(encode(timer)).toBe("m=x&timer=1h30m");
    expect(decode(encode(timer)).settings).toEqual(timer);
  });

  test("until is written in UTC to the second", () => {
    expect(encode({ ...DEFAULTS, countdown: { kind: "until", at: Date.UTC(2026, 0, 2, 3, 4, 5) } })).toBe("until=2026-01-02T03%3A04%3A05Z");
  });

  test("bad values fall back to defaults", () => {
    const { settings } = decode("font=comic&fg=red&pad=99&secs=0&trans=spin&timer=forever&end=explode&speed=warp");
    expect(settings).toEqual({ ...DEFAULTS, pad: 40, secs: 0.5 });
  });
});
