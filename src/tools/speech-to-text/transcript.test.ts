// Unit tests for the Transcript rules: Window cuts, Cues, and the exports. Run: bun test
import { describe, expect, test } from "bun:test";
import { clock, cutWindow, keywordLines, subtitleLines, timestamp, toCues, toJson, toSrt, toText, toVtt, type Word } from "./transcript";

/** Words from "text@start-end" specs, probability 1. */
function words(...specs: string[]): Word[] {
  return specs.map((s) => {
    const [word, times] = s.split("@") as [string, string];
    const [start, end] = times.split("-").map(Number) as [number, number];
    return { word, start, end, probability: 1 };
  });
}

describe("cutWindow", () => {
  test("keeps everything in the last Window", () => {
    const w = words("one@1-2", "two@28.5-29.9");
    expect(cutWindow(w, 30, true)).toEqual({ keep: w, advance: 30 });
  });

  test("an empty Window advances by its whole length", () => {
    expect(cutWindow([], 30, false)).toEqual({ keep: [], advance: 30 });
  });

  test("cuts at the last sentence end clear of the edge, halfway into the gap after it", () => {
    const w = words("First.@1-2", "Second@12-13", "one.@13-14", "Third@20-21", "runs@28-29.5");
    const { keep, advance } = cutWindow(w, 30, false);
    expect(keep.map((x) => x.word)).toEqual(["First.", "Second", "one."]);
    expect(advance).toBe(17);
  });

  test("a sentence end too early to make progress is passed over for the last safe Word", () => {
    const w = words("Hi.@1-2", "and@3-4", "then@15-16", "more@28.6-29.4");
    const { keep, advance } = cutWindow(w, 30, false);
    expect(keep.map((x) => x.word)).toEqual(["Hi.", "and", "then"]);
    expect(advance).toBeCloseTo(22.3);
  });

  test("without a sentence end, drops the Word at the edge so the next Window decodes it whole", () => {
    const w = words("no@1-2", "stops@14-15", "here@25-26", "cut@29.2-30");
    const { keep, advance } = cutWindow(w, 30, false);
    expect(keep.map((x) => x.word)).toEqual(["no", "stops", "here"]);
    expect(advance).toBeCloseTo(27.6);
  });

  test("closing quotes and brackets still end a sentence", () => {
    const w = words("He@10-11", "said,@11-12", "“go.”@12-13", "Then@25-26", "edge@29.5-30");
    expect(cutWindow(w, 30, false).keep.at(-1)!.word).toBe("“go.”");
  });

  test("speech only at the edge starts the next Window just before it", () => {
    const { keep, advance } = cutWindow(words("late@29.3-30"), 30, false);
    expect(keep).toEqual([]);
    expect(advance).toBeCloseTo(29);
  });

  test("always advances at least a second", () => {
    expect(cutWindow(words("a@0-0.2", "b@29.5-30"), 30, false).advance).toBeGreaterThanOrEqual(1);
  });
});

describe("toCues", () => {
  test("one Cue per sentence", () => {
    const cues = toCues(words("Hello@0-0.5", "there.@0.5-1", "How@1.2-1.4", "are@1.4-1.6", "you?@1.6-2"));
    expect(cues.map((c) => c.text)).toEqual(["Hello there.", "How are you?"]);
    expect(cues.map((c) => [c.start, c.end, c.first])).toEqual([[0, 1, 0], [1.2, 2, 2]]);
  });

  test("a long pause starts a new Cue", () => {
    expect(toCues(words("wait@0-1", "for@1-2", "it@4-5")).map((c) => c.text)).toEqual(["wait for", "it"]);
  });

  test("no Cue runs past seven seconds", () => {
    const w = Array.from({ length: 20 }, (_, i) => ({ word: "w" + i, start: i * 0.5, end: i * 0.5 + 0.4, probability: 1 }));
    for (const c of toCues(w)) expect(c.end - c.start).toBeLessThanOrEqual(7);
  });

  test("a sentence too long for one Cue is cut after its last comma, not before its last word", () => {
    const text = "If anything is unclear, ask in the team channel, thank you all, and have a great week.";
    const w = text.split(" ").map((word, i) => ({ word, start: i * 0.35, end: i * 0.35 + 0.3, probability: 1 }));
    const cues = toCues(w);
    expect(cues.map((c) => c.text)).toEqual(["If anything is unclear, ask in the team channel, thank you all,", "and have a great week."]);
    expect(cues.map((c) => c.first)).toEqual([0, 12]);
  });

  test("without a comma, a long sentence is cut before the Word that would overflow", () => {
    const w = Array.from({ length: 12 }, (_, i) => ({ word: "abcdefghi", start: i * 0.3, end: i * 0.3 + 0.2, probability: 1 }));
    expect(toCues(w).map((c) => c.words.length)).toEqual([8, 4]);
  });

  test("no Cue runs past two subtitle lines", () => {
    const w = Array.from({ length: 30 }, (_, i) => ({ word: "word" + i, start: i * 0.2, end: i * 0.2 + 0.1, probability: 1 }));
    for (const c of toCues(w)) expect(c.text.length).toBeLessThanOrEqual(84);
    expect(toCues(w).flatMap((c) => c.words)).toEqual(w);
  });
});

describe("time", () => {
  test("clock", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(65.9)).toBe("1:05");
    expect(clock(3725)).toBe("1:02:05");
  });

  test("timestamp", () => {
    expect(timestamp(3725.0456, ",")).toBe("01:02:05,046");
    expect(timestamp(1.9999, ".")).toBe("00:00:02.000");
  });
});

describe("exports", () => {
  const w = words("Hello@0-0.5", "there.@0.5-1", "Bye.@4-4.5");

  test("SRT", () => {
    expect(toSrt(toCues(w))).toBe("1\n00:00:00,000 --> 00:00:01,000\nHello there.\n\n2\n00:00:04,000 --> 00:00:04,500\nBye.\n");
  });

  test("WebVTT", () => {
    expect(toVtt(toCues(w))).toBe("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello there.\n\n00:00:04.000 --> 00:00:04.500\nBye.\n");
  });

  test("text breaks a paragraph after a sentence and a long pause, not after a pause alone", () => {
    expect(toText(w)).toBe("Hello there.\n\nBye.\n");
    expect(toText(words("um@0-1", "so@5-6"))).toBe("um so\n");
    expect(toText([])).toBe("");
  });

  test("JSON", () => {
    const parsed = JSON.parse(toJson({ language: "en", duration: 4.51234, words: w }));
    expect(parsed.text).toBe("Hello there. Bye.");
    expect(parsed.duration).toBe(4.512);
    expect(parsed.words).toHaveLength(3);
  });

  test("a long line is split in two at the space nearest the middle", () => {
    expect(subtitleLines("short one")).toBe("short one");
    expect(subtitleLines("The quick brown fox jumps over the lazy dog again")).toBe("The quick brown fox jumps\nover the lazy dog again");
  });
});

test("keywords: comma-separated in the field, one per line for the engine", () => {
  expect(keywordLines(" Kubernetes, Dr. Nowak ,,Łódź ")).toBe("Kubernetes\nDr. Nowak\nŁódź");
  expect(keywordLines("  ")).toBe("");
});
