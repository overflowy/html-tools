import { describe, expect, test } from "bun:test";

import {
  DUAL,
  JAEGGI,
  STANDARD,
  crabBack,
  defaultTrialSeconds,
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
import type { GenerateOptions, Mode, Response, Toggle, Trial } from "./engine";
import { dayKey, exportJson, levelFor, merge, parseJson } from "./history";
import type { Session } from "./history";

const U32 = 2 ** 32;

/** An integer as the unsigned 32-bit value with the same low bits, like `>>> 0`. */
const u32 = (x: number) => ((x % U32) + U32) % U32;

/** Combines two unsigned 32-bit values a bit at a time, keeping a bit where `keep` says so. */
const bitwise = (
  a: number,
  b: number,
  keep: (x: boolean, y: boolean) => boolean
) => {
  let out = 0;
  for (let bit = 1; bit < U32; bit *= 2) {
    if (keep(Math.floor(a / bit) % 2 === 1, Math.floor(b / bit) % 2 === 1)) {
      out += bit;
    }
  }
  return out;
};
const xor = (a: number, b: number) => bitwise(a, b, (x, y) => x !== y);
const or = (a: number, b: number) => bitwise(a, b, (x, y) => x || y);
/** `a >>> k` for an unsigned 32-bit `a`. */
const shr = (a: number, k: number) => Math.floor(a / 2 ** k);

/**
 * mulberry32: a seeded generator, so a failing case can be replayed. The state
 * is kept as an unsigned 32-bit value; `Math.imul` reads it as the same bits.
 */
const seeded = (seed: number) => {
  let state = u32(seed);
  return () => {
    state = u32(state + 0x6d_2b_79_f5);
    let t = state;
    t = u32(Math.imul(xor(t, shr(t, 15)), or(t, 1)));
    t = xor(t, u32(t + Math.imul(xor(t, shr(t, 7)), or(t, 61))));
    return xor(t, shr(t, 14)) / U32;
  };
};

/** The element at `i`, for arrays a test has just filled. */
const at = <T>(items: T[], i: number): T => {
  const item = items[i];
  if (item === undefined) {
    throw new Error(`Nothing at index ${i}`);
  }
  return item;
};

const mode = (patch: Partial<Mode>): Mode => ({ ...DUAL, ...patch });

const options = (patch: Partial<GenerateOptions>): GenerateOptions => ({
  arithmetic: {
    max: 12,
    negatives: false,
    ops: ["add", "subtract", "multiply", "divide"],
  },
  jaeggi: false,
  lureChance: 0.125,
  matchChance: 0.125,
  mode: DUAL,
  n: 2,
  rand: seeded(1),
  trials: 24,
  ...patch,
});

/** A short fingerprint of a long text, to pin output recorded from earlier code. */
const hash = (text: string) => {
  let h = 0;
  for (const ch of text) {
    h = (h * 31 + (ch.codePointAt(0) ?? 0)) % 1_000_000_007;
  }
  return h;
};

const TOGGLES: Toggle[] = [
  "position",
  "color",
  "shape",
  "sound",
  "combination",
  "arithmetic",
];

describe("seeded generator", () => {
  // Recorded from the original bitwise mulberry32, as 32-bit integers.
  test("replays the same sequence for a seed", () => {
    const expected: [number, number[]][] = [
      [
        0,
        [
          1_144_304_738, 1_416_247, 958_946_056, 627_933_444, 2_007_157_716,
          2_340_967_985,
        ],
      ],
      [
        1,
        [
          2_693_262_067, 11_749_833, 2_265_367_787, 4_213_581_821,
          4_159_151_403, 1_207_330_352,
        ],
      ],
      [
        2,
        [
          3_153_583_793, 1_395_857_638, 1_225_337_227, 2_310_499_808,
          3_759_333_107, 2_709_408_573,
        ],
      ],
      [
        7,
        [
          50_271_532, 266_108_690, 4_195_786_334, 3_002_305_430, 2_239_590_375,
          1_741_702_388,
        ],
      ],
      [
        -1,
        [
          3_850_105_811, 813_802_916, 3_073_704_848, 4_054_706_436,
          3_630_262_831, 2_315_588_663,
        ],
      ],
      [
        2_147_483_647,
        [
          1_842_962_257, 546_041_740, 1_654_754_255, 1_702_490_205, 513_796_057,
          4_093_909_556,
        ],
      ],
      [
        4_294_967_295,
        [
          3_850_105_811, 813_802_916, 3_073_704_848, 4_054_706_436,
          3_630_262_831, 2_315_588_663,
        ],
      ],
      [
        123_456_789,
        [
          1_107_202_814, 4_169_434_471, 3_372_958_138, 885_470_128,
          1_301_683_845, 3_208_624_240,
        ],
      ],
    ];
    for (const [seed, values] of expected) {
      const rand = seeded(seed);
      expect(values.map(() => rand() * U32)).toEqual(values);
    }
  });

  test("a long run hashes to the recorded value", () => {
    const rand = seeded(42);
    let digest = 0;
    for (let i = 0; i < 100_000; i += 1) {
      digest = (digest * 31 + rand() * U32) % 1_000_000_007;
    }
    expect(digest).toBe(930_245_090);
  });
});

describe("characterization", () => {
  // The hashes were recorded from the engine before it was restructured, so
  // any change to what a Mode settles to, or to a seeded sequence, shows up.
  test("every Mode settles, names, and keys the same way", () => {
    const describeMode = (m: Mode) =>
      [
        modeKey(m),
        modeName(m),
        modeCode(m),
        modalities(m).join(","),
        defaultTrialSeconds(m),
        ...TOGGLES.map((t) => m[t]),
        m.multi,
        m.crab,
        m.variable,
        m.selfPaced,
      ].join("|");
    const lines: string[] = [];
    for (let bits = 0; bits < 64; bits += 1) {
      for (const multi of [1, 2, 3, 4] as const) {
        for (const crab of [false, true]) {
          for (const variable of [false, true]) {
            const m = mode({
              crab,
              multi,
              selfPaced: bits % 3 === 0,
              variable,
            });
            for (const [i, t] of TOGGLES.entries()) {
              m[t] = Math.floor(bits / 2 ** i) % 2 === 1;
            }
            for (const changed of [null, ...TOGGLES, "multi"] as const) {
              lines.push(describeMode(normalize(m, changed)));
            }
            const key = modeKey(m);
            const parsed = parseModeKey(key);
            lines.push(key, parsed ? describeMode(parsed) : "null");
          }
        }
      }
    }
    expect(lines).toHaveLength(10_240);
    expect(hash(lines.join("\n"))).toBe(483_256_351);
  });

  test("seeded Sessions come out the same", () => {
    const canon = (trials: Trial[]) =>
      JSON.stringify(
        trials.map((t) => [
          t.back,
          t.positions,
          t.vis,
          t.color,
          t.shape,
          t.letter,
          t.sound,
          t.number,
          t.op,
          t.answer,
        ])
      );
    const cases: [Partial<GenerateOptions>, number][] = [
      [{ rand: seeded(1), trials: 500 }, 570_733_276],
      [{ jaeggi: true, n: 3, rand: seeded(4), trials: 23 }, 760_606_914],
      [
        {
          lureChance: 0.5,
          mode: mode({ color: true, multi: 4 }),
          n: 3,
          rand: seeded(9),
          trials: 500,
        },
        218_008_554,
      ],
      [
        {
          lureChance: 0.5,
          mode: mode({ multi: 3 }),
          n: 2,
          rand: seeded(10),
          trials: 500,
        },
        859_777_097,
      ],
      [
        {
          mode: mode({ color: true, crab: true, shape: true }),
          n: 3,
          rand: seeded(12),
          trials: 500,
        },
        281_652_275,
      ],
      [
        {
          lureChance: 0.4,
          mode: mode({ variable: true }),
          n: 4,
          rand: seeded(13),
          trials: 500,
        },
        585_312_716,
      ],
      [
        {
          mode: mode({ color: true, combination: true }),
          n: 2,
          rand: seeded(14),
          trials: 500,
        },
        596_025_758,
      ],
      [
        {
          arithmetic: {
            max: 20,
            negatives: true,
            ops: ["add", "subtract", "multiply", "divide"],
          },
          mode: mode({ arithmetic: true, sound: false }),
          n: 2,
          rand: seeded(15),
          trials: 500,
        },
        148_909_635,
      ],
      [
        {
          arithmetic: { max: 9, negatives: false, ops: [] },
          mode: mode({ arithmetic: true, color: true, sound: false }),
          n: 1,
          rand: seeded(16),
          trials: 200,
        },
        172_908_790,
      ],
      [{ lureChance: 0.9, n: 1, rand: seeded(17), trials: 300 }, 282_178_805],
    ];
    for (const [patch, expected] of cases) {
      expect(hash(canon(generate(options(patch))))).toBe(expected);
    }
  });
});

describe("modes", () => {
  test("keys round-trip", () => {
    for (const m of [
      DUAL,
      mode({ color: true, shape: true }),
      mode({ crab: true, multi: 3, selfPaced: true, variable: true }),
      mode({ arithmetic: true, sound: false }),
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
      combination: true,
      sound: true,
    });
    expect(
      normalize(mode({ combination: true, sound: false }), "sound")
    ).toMatchObject({ combination: false, sound: false });
    expect(
      normalize(mode({ color: true, multi: 2, shape: true }), "multi")
    ).toMatchObject({ color: true, multi: 2, shape: false });
    expect(
      normalize(mode({ multi: 3, position: false }), "position")
    ).toMatchObject({ multi: 1, position: false });
    expect(normalize(mode({ position: false, sound: false }), "sound")).toEqual(
      DUAL
    );
  });

  test("names", () => {
    expect(modeName(DUAL)).toBe("Dual");
    expect(modeName(mode({ color: true, shape: true }))).toBe("Quad");
    expect(modeName(mode({ sound: false }))).toBe("Position");
    expect(modeName(mode({ combination: true, position: false }))).toBe(
      "Dual Combination"
    );
    expect(modeName(mode({ crab: true, multi: 2 }))).toBe(
      "Crab Double-stim Dual"
    );
    expect(modeCode(mode({ color: true, multi: 2 }))).toBe("2P·C·A");
  });

  test("multi-stimulus turns Color into one stream per object", () => {
    expect(modalities(mode({ color: true, multi: 2 }))).toEqual([
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
    const trials = generate(options({ rand: seeded(7), trials: 20_000 }));
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
      options({ mode: mode({ multi: 4 }), rand: seeded(3), trials: 2000 })
    );
    for (const t of trials) {
      expect(new Set(t.positions).size).toBe(4);
    }
  });

  test("Jaeggi's sequence has exactly 6 position, 6 sound, and 2 dual matches", () => {
    for (let seed = 1; seed < 20; seed += 1) {
      const n = 1 + (seed % 4);
      const trials = generate(
        options({ jaeggi: true, n, rand: seeded(seed), trials: 20 + n })
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
        rand: seeded(11),
        trials: 5000,
      })
    );
    const backs = new Set(trials.slice(4).map((t) => t.back));
    expect([...backs].toSorted()).toEqual([1, 2, 3, 4]);
  });

  test("arithmetic answers come out whole or at an accepted decimal", () => {
    const trials = generate(
      options({
        mode: mode({ arithmetic: true, sound: false }),
        n: 1,
        rand: seeded(5),
        trials: 3000,
      })
    );
    for (let t = 1; t < trials.length; t += 1) {
      const tr = at(trials, t);
      expect(tr.op).not.toBeNull();
      if (tr.op === "divide") {
        expect(tr.number).not.toBe(0);
        // A missing answer becomes NaN, which is close to nothing.
        const answer = tr.answer ?? Number.NaN;
        expect(Math.round(answer * 1000) / 1000).toBeCloseTo(answer, 9);
      }
    }
    expect(at(trials, 0).op).toBeNull();
  });
});

describe("scoring", () => {
  // Position matches at trials 2 and 4; the player hits trial 2, misses 4, and presses wrongly at 3.
  const trials = generate(
    options({ lureChance: 0, matchChance: 0, rand: seeded(2), trials: 6 })
  );
  const firstPositions = [0, 1, 0, 2, 0, 3];
  for (const [i, t] of trials.entries()) {
    t.positions = [at(firstPositions, i), 7, 7, 7];
  }
  const responses: Response[] = trials.map(() => ({ answer: "", pressed: {} }));
  at(responses, 2).pressed.position1 = 400;
  at(responses, 3).pressed.position1 = 500;

  test("tally", () => {
    expect(tally(trials, responses, "position1", 2)).toEqual({
      correctRejections: 1,
      falseAlarms: 1,
      hits: 1,
      misses: 1,
      rt: 400,
    });
  });

  test("standard scoring is hits over hits and errors, pooled", () => {
    const t = tally(trials, responses, "position1", 2);
    expect(percent(t, { jaeggi: false })).toBe(33);
    expect(percent(t, { jaeggi: true })).toBe(50);
    const perfect = {
      correctRejections: 2,
      falseAlarms: 0,
      hits: 2,
      misses: 0,
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
    jaeggi: false,
    manual: false,
    mode: "pa",
    n: 2,
    pct: {},
    score: 60,
    seconds: 72,
    tallies: {},
    trialMs: 3000,
    trials: 24,
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
    const back = parseJson(exportJson(sessions));
    if (back === null) {
      throw new Error("The export did not read back");
    }
    expect(back).toEqual(sessions);
    expect(merge([], back)).toEqual({ added: 2, sessions });
    expect(merge(sessions, back).added).toBe(0);
    expect(parseJson("{}")).toBeNull();
    expect(parseJson("not json")).toBeNull();
  });

  test("an export keeps its field order, whatever order the objects were built in", () => {
    const tallied = s({
      level: { n: 3, strikes: 0 },
      tallies: {
        position1: {
          correctRejections: 4,
          falseAlarms: 3,
          hits: 1,
          misses: 2,
          rt: null,
        },
      },
    });
    const o = JSON.parse(exportJson([tallied]));
    expect(Object.keys(o)).toEqual(["format", "version", "sessions"]);
    expect(Object.keys(o.sessions[0])).toEqual([
      "at",
      "mode",
      "n",
      "manual",
      "jaeggi",
      "trials",
      "trialMs",
      "seconds",
      "score",
      "pct",
      "tallies",
      "level",
    ]);
    expect(Object.keys(o.sessions[0].tallies.position1)).toEqual([
      "hits",
      "misses",
      "falseAlarms",
      "correctRejections",
      "rt",
    ]);
  });
});
