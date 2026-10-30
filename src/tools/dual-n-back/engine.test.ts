import { describe, expect, test } from "bun:test";

import {
  DUAL,
  JAEGGI,
  STANDARD,
  crabBack,
  generate,
  isMatch,
  levelScore,
  modalities,
  modeCode,
  modeKey,
  modeName,
  nextLevel,
  normalize,
  parseModeKey,
  percent,
  sessionScore,
  tally,
  trialCount,
  verdict,
} from "./engine";
import type { GenerateOptions, Mode, Response } from "./engine";
import { dayKey, exportJson, levelFor, merge, parseJson } from "./history";
import type { Session } from "./history";

/** mulberry32: a seeded generator, so a failing case can be replayed. */
function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d_2b_79_f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const mode = (patch: Partial<Mode>): Mode => ({ ...DUAL, ...patch });

function options(patch: Partial<GenerateOptions>): GenerateOptions {
  return {
    mode: DUAL,
    n: 2,
    trials: 24,
    matchChance: 0.125,
    lureChance: 0.125,
    arithmetic: {
      max: 12,
      negatives: false,
      ops: ["add", "subtract", "multiply", "divide"],
    },
    jaeggi: false,
    rand: seeded(1),
    ...patch,
  };
}

describe("modes", () => {
  test("keys round-trip", () => {
    for (const m of [
      DUAL,
      mode({ color: true, shape: true }),
      mode({ multi: 3, crab: true, variable: true, selfPaced: true }),
      mode({ sound: false, arithmetic: true }),
    ]) {
      expect(parseModeKey(modeKey(m))).toEqual(m);
    }
    expect(modeKey(DUAL)).toBe("pa");
  });

  test("keys that no Mode writes are refused", () => {
    for (const k of ["", "ap", "pa-", "pa-1", "sax", "pa-rr", "zz"]) {
      expect(parseModeKey(k)).toBeNull();
    }
  });

  test("normalize keeps the toggle just changed", () => {
    expect(normalize(mode({ arithmetic: true }), "arithmetic")).toMatchObject({
      arithmetic: true,
      sound: false,
    });
    expect(
      normalize(mode({ combination: true, shape: true }), "combination")
    ).toMatchObject({ combination: true, shape: false, sound: true });
    expect(normalize(mode({ combination: true }), "sound")).toMatchObject({
      sound: true,
      combination: true,
    });
    expect(
      normalize(mode({ sound: false, combination: true }), "sound")
    ).toMatchObject({ sound: false, combination: false });
    expect(
      normalize(mode({ multi: 2, color: true, shape: true }), "multi")
    ).toMatchObject({ multi: 2, color: true, shape: false });
    expect(
      normalize(mode({ position: false, multi: 3 }), "position")
    ).toMatchObject({ position: false, multi: 1 });
    expect(normalize(mode({ position: false, sound: false }), "sound")).toEqual(
      DUAL
    );
  });

  test("names", () => {
    expect(modeName(DUAL)).toBe("Dual");
    expect(modeName(mode({ color: true, shape: true }))).toBe("Quad");
    expect(modeName(mode({ sound: false }))).toBe("Position");
    expect(modeName(mode({ position: false, combination: true }))).toBe(
      "Dual Combination"
    );
    expect(modeName(mode({ crab: true, multi: 2 }))).toBe(
      "Crab Double-stim Dual"
    );
    expect(modeCode(mode({ multi: 2, color: true }))).toBe("2P·C·A");
  });

  test("multi-stimulus turns Color into one stream per object", () => {
    expect(modalities(mode({ multi: 2, color: true }))).toEqual([
      "position1",
      "position2",
      "vis1",
      "vis2",
      "sound",
    ]);
  });

  test("trial counts", () => {
    expect(trialCount(3, 20, false)).toBe(29);
    expect(trialCount(3, 20, true)).toBe(23);
  });
});

describe("generation", () => {
  test("about an eighth forced plus an eighth by chance: roughly a quarter of trials match", () => {
    const trials = generate(options({ trials: 20_000, rand: seeded(7) }));
    let matches = 0;
    for (let t = 2; t < trials.length; t += 1) {
      if (isMatch(trials, t, "position1", 2)) {
        matches += 1;
      }
    }
    const rate = matches / (trials.length - 2);
    // 1/8 forced + 7/8 × (lures aside) about 1/8 by chance.
    expect(rate).toBeGreaterThan(0.2);
    expect(rate).toBeLessThan(0.26);
  });

  test("multi-stimulus objects never share a cell", () => {
    const trials = generate(
      options({ mode: mode({ multi: 4 }), trials: 2000, rand: seeded(3) })
    );
    for (const t of trials) {
      expect(new Set(t.positions).size).toBe(4);
    }
  });

  test("Jaeggi's sequence has exactly 6 position, 6 sound, and 2 dual matches", () => {
    for (let seed = 1; seed < 20; seed += 1) {
      const n = 1 + (seed % 4);
      const trials = generate(
        options({ jaeggi: true, n, trials: 20 + n, rand: seeded(seed) })
      );
      let p = 0;
      let a = 0;
      let both = 0;
      for (let t = n; t < trials.length; t += 1) {
        const mp = isMatch(trials, t, "position1", n);
        const ma = isMatch(trials, t, "sound", n);
        p += Number(mp);
        a += Number(ma);
        both += Number(mp && ma);
      }
      expect([p, a, both]).toEqual([6, 6, 2]);
    }
  });

  test("crab-back compares each block with the one before, reversed", () => {
    // 3-back, 0-based: trials 3, 4, 5 look back 1, 3, 5, to trials 2, 1, 0.
    expect([3, 4, 5].map((t) => t - crabBack(t, 3))).toEqual([2, 1, 0]);
    expect([6, 7, 8].map((t) => t - crabBack(t, 3))).toEqual([5, 4, 3]);
  });

  test("variable backs stay within 1..N", () => {
    const trials = generate(
      options({
        mode: mode({ variable: true }),
        n: 4,
        trials: 5000,
        rand: seeded(11),
      })
    );
    const backs = new Set(trials.slice(4).map((t) => t.back));
    expect([...backs].toSorted()).toEqual([1, 2, 3, 4]);
  });

  test("arithmetic answers come out whole or at an accepted decimal", () => {
    const trials = generate(
      options({
        mode: mode({ sound: false, arithmetic: true }),
        n: 1,
        trials: 3000,
        rand: seeded(5),
      })
    );
    for (let t = 1; t < trials.length; t += 1) {
      const tr = trials[t]!;
      expect(tr.op).not.toBeNull();
      if (tr.op === "divide") {
        expect(tr.number).not.toBe(0);
        expect(Math.round(tr.answer! * 1000) / 1000).toBeCloseTo(tr.answer!, 9);
      }
    }
    expect(trials[0]!.op).toBeNull();
  });
});

describe("scoring", () => {
  // Position matches at trials 2 and 4; the player hits trial 2, misses 4, and presses wrongly at 3.
  const trials = generate(
    options({ trials: 6, matchChance: 0, lureChance: 0, rand: seeded(2) })
  );
  trials.forEach((t, i) => (t.positions = [[0, 1, 0, 2, 0, 3][i]!, 7, 7, 7]));
  const responses: Response[] = trials.map(() => ({ pressed: {}, answer: "" }));
  responses[2]!.pressed.position1 = 400;
  responses[3]!.pressed.position1 = 500;

  test("tally", () => {
    expect(tally(trials, responses, "position1", 2)).toEqual({
      hits: 1,
      misses: 1,
      falseAlarms: 1,
      correctRejections: 1,
      rt: 400,
    });
  });

  test("standard scoring is hits over hits and errors, pooled", () => {
    const t = tally(trials, responses, "position1", 2);
    expect(percent(t, { jaeggi: false })).toBe(33);
    expect(percent(t, { jaeggi: true })).toBe(50);
    const perfect = {
      hits: 2,
      misses: 0,
      falseAlarms: 0,
      correctRejections: 2,
      rt: null,
    };
    expect(sessionScore([t, perfect], { jaeggi: false })).toBe(60);
    expect(sessionScore([t, perfect], { jaeggi: true })).toBe(50);
  });
});

describe("levels", () => {
  test("advance at the upper threshold, three strikes at one N lower it", () => {
    expect(nextLevel({ n: 2, strikes: 1 }, 80, STANDARD)).toEqual({
      n: 3,
      strikes: 0,
    });
    let l = { n: 3, strikes: 0 };
    l = nextLevel(l, 40, STANDARD);
    l = nextLevel(l, 65, STANDARD);
    expect(l).toEqual({ n: 3, strikes: 1 });
    l = nextLevel(l, 40, STANDARD);
    l = nextLevel(l, 49, STANDARD);
    expect(l).toEqual({ n: 2, strikes: 0 });
    expect(nextLevel({ n: 1, strikes: 0 }, 0, STANDARD)).toEqual({
      n: 1,
      strikes: 0,
    });
    expect(nextLevel({ n: 4, strikes: 0 }, 74, JAEGGI)).toEqual({
      n: 3,
      strikes: 0,
    });
  });

  test("verdicts and the chart's level scale", () => {
    expect(verdict(100, STANDARD)).toBe("Perfect score!");
    expect(verdict(65, STANDARD)).toBe("Great score!");
    expect(verdict(49, STANDARD)).toBe("Keep trying. You're getting there!");
    expect(levelScore(3, 80, STANDARD)).toBe(4);
    expect(levelScore(3, 50, STANDARD)).toBe(3);
  });
});

describe("history", () => {
  const s = (patch: Partial<Session>): Session => ({
    at: 0,
    mode: "pa",
    n: 2,
    manual: false,
    jaeggi: false,
    trials: 24,
    trialMs: 3000,
    seconds: 72,
    score: 60,
    pct: {},
    tallies: {},
    ...patch,
  });

  test("days start at 4 in the morning", () => {
    expect(dayKey(new Date(2026, 9, 30, 3, 59).getTime())).toBe("2026-10-29");
    expect(dayKey(new Date(2026, 9, 30, 4, 0).getTime())).toBe("2026-10-30");
  });

  test("the Level is the last non-Manual Session's, or the Mode's starting N", () => {
    expect(levelFor([], "pa")).toEqual({ n: 2, strikes: 0 });
    expect(levelFor([], "pax")).toEqual({ n: 1, strikes: 0 });
    const sessions = [
      s({ at: 1, level: { n: 3, strikes: 0 } }),
      s({ at: 2, manual: true, n: 7 }),
    ];
    expect(levelFor(sessions, "pa")).toEqual({ n: 3, strikes: 0 });
  });

  test("an export reads back, and merging it again adds nothing", () => {
    const sessions = [
      s({ at: 1, level: { n: 3, strikes: 0 } }),
      s({ at: 2, manual: true, n: 5 }),
    ];
    const back = parseJson(exportJson(sessions))!;
    expect(back).toEqual(sessions);
    expect(merge([], back)).toEqual({ sessions, added: 2 });
    expect(merge(sessions, back).added).toBe(0);
    expect(parseJson("{}")).toBeNull();
    expect(parseJson("not json")).toBeNull();
  });
});
