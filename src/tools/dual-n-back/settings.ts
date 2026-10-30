// The Tool's State: the Mode and every option that changes the game. Kept in
// the Deep Link (only what differs from the defaults) and remembered across
// visits.

import {
  DUAL,
  JAEGGI,
  STANDARD,
  modeKey,
  normalize,
  parseModeKey,
} from "./engine";
import type { ArithmeticOptions, Mode, Op, Thresholds } from "./engine";
import type { ShapeSetId } from "./stimuli";

export interface Settings {
  mode: Mode;
  manual: boolean;
  /** N in Manual; the History decides it otherwise. */
  manualN: number;
  jaeggi: boolean;
  /** Trials before the N-dependent part: a Session is this plus N² (plus N in Jaeggi mode). */
  baseTrials: number;
  /** Seconds per trial, or null for the Mode's own. */
  trialSeconds: number | null;
  /** Chance of a Lure, in eighths. */
  lureEighths: number;
  feedback: boolean;
  gridLines: boolean;
  shapes: ShapeSetId | "either";
  arithmetic: ArithmeticOptions;
  thresholds: Thresholds;
}

export const DEFAULTS: Settings = {
  mode: DUAL,
  manual: false,
  manualN: 2,
  jaeggi: false,
  baseTrials: 20,
  trialSeconds: null,
  lureEighths: 1,
  feedback: true,
  gridLines: true,
  shapes: "shapes",
  arithmetic: {
    max: 12,
    negatives: false,
    ops: ["add", "subtract", "multiply", "divide"],
  },
  thresholds: STANDARD,
};

export const LIMITS = {
  n: [1, 20],
  baseTrials: [5, 100],
  trialSeconds: [1, 10],
  max: [1, 99],
  percent: [0, 100],
  strikes: [1, 10],
} as const;

const OPS: [Op, string][] = [
  ["add", "a"],
  ["subtract", "s"],
  ["multiply", "m"],
  ["divide", "d"],
];

export const clamp = (v: number, [lo, hi]: readonly [number, number]) =>
  Math.min(hi, Math.max(lo, v));

export function clone(s: Settings): Settings {
  return {
    ...s,
    mode: { ...s.mode },
    arithmetic: { ...s.arithmetic, ops: [...s.arithmetic.ops] },
    thresholds: { ...s.thresholds },
  };
}

/** The Settings a Session is played with: Jaeggi mode fixes the Mode, the scoring, and the feedback. */
export function effective(
  s: Settings
): Settings & { thresholdsInForce: Thresholds } {
  const e = clone(s);
  if (e.jaeggi) {
    e.mode = { ...DUAL };
    e.feedback = false;
  }
  return { ...e, thresholdsInForce: e.jaeggi ? JAEGGI : e.thresholds };
}

/** The Deep Link payload: `key=value` pairs for whatever differs from the defaults, "" when nothing does. */
export function encode(s: Settings): string {
  const p = new URLSearchParams();
  const d = DEFAULTS;
  const key = modeKey(s.mode);
  if (key !== modeKey(d.mode)) {
    p.set("mode", key);
  }
  if (s.manual) {
    p.set("manual", "1");
    p.set("n", String(s.manualN));
  }
  if (s.jaeggi) {
    p.set("jaeggi", "1");
  }
  if (s.baseTrials !== d.baseTrials) {
    p.set("trials", String(s.baseTrials));
  }
  if (s.trialSeconds !== null) {
    p.set("secs", String(s.trialSeconds));
  }
  if (s.lureEighths !== d.lureEighths) {
    p.set("lures", String(s.lureEighths));
  }
  if (!s.feedback) {
    p.set("feedback", "0");
  }
  if (!s.gridLines) {
    p.set("grid", "0");
  }
  if (s.shapes !== d.shapes) {
    p.set("shapes", s.shapes);
  }
  if (s.arithmetic.max !== d.arithmetic.max) {
    p.set("max", String(s.arithmetic.max));
  }
  if (s.arithmetic.negatives) {
    p.set("neg", "1");
  }
  const ops = OPS.filter(([op]) => s.arithmetic.ops.includes(op))
    .map(([, l]) => l)
    .join("");
  if (ops !== "asmd") {
    p.set("ops", ops);
  }
  if (s.thresholds.advance !== d.thresholds.advance) {
    p.set("raise", String(s.thresholds.advance));
  }
  if (s.thresholds.fallback !== d.thresholds.fallback) {
    p.set("lower", String(s.thresholds.fallback));
  }
  if (s.thresholds.strikes !== d.thresholds.strikes) {
    p.set("strikes", String(s.thresholds.strikes));
  }
  return p.toString();
}

/** A whole number from the payload, or one with a decimal place where `tenths`. */
function num(
  p: URLSearchParams,
  name: string,
  limits: readonly [number, number],
  fallback: number,
  tenths = false
): number {
  const raw = p.get(name);
  if (raw === null || raw.trim() === "") {
    return fallback;
  }
  const v = Number(raw);
  return Number.isFinite(v)
    ? clamp(tenths ? Math.round(v * 10) / 10 : Math.round(v), limits)
    : fallback;
}

/** Settings from a Deep Link payload: anything missing or unreadable takes its default. */
export function decode(payload: string): Settings {
  let p: URLSearchParams;
  try {
    p = new URLSearchParams(payload);
  } catch {
    p = new URLSearchParams();
  }
  const d = DEFAULTS;
  const parsed = parseModeKey(p.get("mode") ?? "");
  const shapes = p.get("shapes");
  const opsRaw = p.get("ops");
  const ops =
    opsRaw === null
      ? d.arithmetic.ops
      : OPS.filter(([, l]) => opsRaw.includes(l)).map(([op]) => op);
  const secs = p.get("secs");
  return {
    mode: parsed ? normalize(parsed, null) : { ...d.mode },
    manual: p.get("manual") === "1",
    manualN: num(p, "n", LIMITS.n, d.manualN),
    jaeggi: p.get("jaeggi") === "1",
    baseTrials: num(p, "trials", LIMITS.baseTrials, d.baseTrials),
    trialSeconds:
      secs === null ? null : num(p, "secs", LIMITS.trialSeconds, 3, true),
    lureEighths: num(p, "lures", [0, 8], d.lureEighths),
    feedback: p.get("feedback") !== "0",
    gridLines: p.get("grid") !== "0",
    shapes: shapes === "pentominoes" || shapes === "either" ? shapes : "shapes",
    arithmetic: {
      max: num(p, "max", LIMITS.max, d.arithmetic.max),
      negatives: p.get("neg") === "1",
      ops: ops.length ? ops : ["add"],
    },
    thresholds: {
      advance: num(p, "raise", LIMITS.percent, d.thresholds.advance),
      fallback: num(p, "lower", LIMITS.percent, d.thresholds.fallback),
      strikes: num(p, "strikes", LIMITS.strikes, d.thresholds.strikes),
    },
  };
}
