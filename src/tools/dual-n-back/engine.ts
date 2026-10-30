// The n-back task itself: Modes, Sessions' trial sequences, Scores, and Level
// changes. Pure: no DOM, no clock, randomness passed in, so it is unit tested.

export type Rand = () => number;

/** What the player picks: the Modalities to watch and listen to, and the Variants. */
export interface Mode {
  position: boolean;
  color: boolean;
  shape: boolean;
  sound: boolean;
  combination: boolean;
  arithmetic: boolean;
  /** Objects on the grid at once, each with its own Position. */
  multi: 1 | 2 | 3 | 4;
  crab: boolean;
  variable: boolean;
  selfPaced: boolean;
}

/** One stream the player answers for, with its own key. */
export type Modality =
  | "position1"
  | "position2"
  | "position3"
  | "position4"
  | "vis1"
  | "vis2"
  | "vis3"
  | "vis4"
  | "color"
  | "shape"
  | "visvis"
  | "visaudio"
  | "audiovis"
  | "arithmetic"
  | "sound";

export const DUAL: Mode = {
  arithmetic: false,
  color: false,
  combination: false,
  crab: false,
  multi: 1,
  position: true,
  selfPaced: false,
  shape: false,
  sound: true,
  variable: false,
};

/** The item at `i`, where the logic around it guarantees there is one. */
export const itemAt = <T>(items: readonly T[], i: number): T => {
  const item = items[i];
  if (item === undefined) {
    throw new RangeError(`No item at ${i} of ${items.length}`);
  }
  return item;
};

/* ---------------- Modes ---------------- */

const BASE_LETTERS = [
  ["position", "p"],
  ["color", "c"],
  ["shape", "s"],
  ["sound", "a"],
  ["combination", "x"],
  ["arithmetic", "m"],
] as const;

/** Mode key: the base letters (`pcsaxm` order), then `-` and the Variants (multi digit, r crab, v variable, t self-paced). Dual is `pa`. */
export const modeKey = (m: Mode): string => {
  const base = BASE_LETTERS.filter(([k]) => m[k])
    .map(([, l]) => l)
    .join("");
  const flags =
    (m.multi > 1 ? String(m.multi) : "") +
    (m.crab ? "r" : "") +
    (m.variable ? "v" : "") +
    (m.selfPaced ? "t" : "");
  return flags ? `${base}-${flags}` : base;
};

/** The toggles a Mode is made of. */
export type Toggle =
  | "position"
  | "color"
  | "shape"
  | "sound"
  | "combination"
  | "arithmetic";

/** Turns off what conflicts with a toggle the player just turned on. */
const applyTurnedOn = (m: Mode, changed: Toggle | "multi" | null) => {
  const on = (t: Toggle) => changed === t && m[t];
  if (on("combination")) {
    Object.assign(m, {
      arithmetic: false,
      multi: 1,
      shape: false,
      sound: true,
    });
  }
  if (on("arithmetic")) {
    Object.assign(m, {
      combination: false,
      multi: 1,
      shape: false,
      sound: false,
    });
  }
  if (on("shape")) {
    Object.assign(m, { arithmetic: false, combination: false });
    if (m.multi > 1 && m.color) {
      m.color = false;
    }
  }
  if (on("color") && m.multi > 1 && m.shape) {
    m.shape = false;
  }
  if (on("sound")) {
    m.arithmetic = false;
  }
};

/** Settles the toggle the player just changed: the ones turned off, then the ones turned on, then multi. */
const applyChange = (m: Mode, changed: Toggle | "multi" | null) => {
  if (changed === "sound" && !m.sound) {
    m.combination = false;
  }
  applyTurnedOn(m, changed);
  if (changed === "multi" && m.multi > 1) {
    Object.assign(m, { arithmetic: false, combination: false, position: true });
    if (m.color && m.shape) {
      m.shape = false;
    }
  }
  if (changed === "position" && !m.position) {
    m.multi = 1;
  }
};

/** Whatever is left over from an older state, settled without a preference. */
const settleLeftovers = (m: Mode) => {
  if (m.combination && (!m.sound || m.shape || m.arithmetic)) {
    m.combination = false;
  }
  if (m.arithmetic && (m.sound || m.shape)) {
    m.arithmetic = false;
  }
  if (m.multi > 1 && (!m.position || m.combination || m.arithmetic)) {
    m.multi = 1;
  }
  if (m.multi > 1 && m.color && m.shape) {
    m.shape = false;
  }
};

/**
 * Makes a Mode playable, keeping the toggle the player just changed the way
 * they set it: Combination needs Sound and excludes Shape and Arithmetic;
 * Arithmetic speaks its operations, so it excludes Sound and Shape;
 * Multi-stimulus needs Position, and not
 * both Color and Shape, Combination, or Arithmetic.
 */
export const normalize = (
  input: Mode,
  changed: Toggle | "multi" | null
): Mode => {
  const m = { ...input };
  applyChange(m, changed);
  settleLeftovers(m);
  if (!m.position && !m.color && !m.shape && !m.sound && !m.arithmetic) {
    return { ...DUAL };
  }
  return m;
};

/** The Mode a key names, or null when the key is not one `normalize` would produce. */
export const parseModeKey = (key: string): Mode | null => {
  const groups =
    /^(?<base>[pcsaxm]+)(?:-(?<multi>[234]?)(?<crab>r?)(?<variable>v?)(?<selfPaced>t?))?$/u.exec(
      key
    )?.groups;
  if (!groups) {
    return null;
  }
  const { base, multi, crab, variable, selfPaced } = groups;
  const m: Mode = { ...DUAL };
  for (const [k, l] of BASE_LETTERS) {
    m[k] = base.includes(l);
  }
  m.multi = (Number(multi) || 1) as Mode["multi"];
  m.crab = Boolean(crab);
  m.variable = Boolean(variable);
  m.selfPaced = Boolean(selfPaced);
  // Only the key `modeKey` writes for the Mode it settles to: no stray `-`, no letters out of order, nothing it would change.
  return modeKey(normalize(m, null)) === key ? m : null;
};

/** The Modalities of a Mode, in the order their buttons are laid out. */
export const modalities = (m: Mode): Modality[] => {
  const out: Modality[] = [];
  if (m.position) {
    for (let i = 1; i <= m.multi; i += 1) {
      out.push(`position${i}` as Modality);
    }
  }
  if (m.multi > 1 && (m.color || m.shape)) {
    for (let i = 1; i <= m.multi; i += 1) {
      out.push(`vis${i}` as Modality);
    }
  } else {
    if (m.color) {
      out.push("color");
    }
    if (m.shape) {
      out.push("shape");
    }
  }
  if (m.combination) {
    out.push("visvis", "visaudio", "audiovis");
  }
  if (m.arithmetic) {
    out.push("arithmetic");
  }
  if (m.sound) {
    out.push("sound");
  }
  return out;
};

const COUNT_NAMES = ["", "", "Dual", "Triple", "Quad"];
const SINGLE_NAMES: Record<"position" | "color" | "shape" | "sound", string> = {
  color: "Color",
  position: "Position",
  shape: "Shape",
  sound: "Sound",
};
const ARITHMETIC_NAMES = ["Arithmetic", "Dual Arithmetic", "Triple Arithmetic"];
const MULTI_NAMES = ["", "", "Double-stim", "Triple-stim", "Quad-stim"];

const combinationName = (m: Mode): string => {
  if (m.position && m.color) {
    return "Quad Combination";
  }
  if (m.position || m.color) {
    return "Tri Combination";
  }
  return "Dual Combination";
};

/** The name from the Modalities alone, before any Variant. */
const baseName = (m: Mode): string => {
  if (m.combination) {
    return combinationName(m);
  }
  if (m.arithmetic) {
    return itemAt(ARITHMETIC_NAMES, Number(m.position) + Number(m.color));
  }
  const on = (["position", "color", "shape", "sound"] as const).filter(
    (k) => m[k]
  );
  const [only] = on;
  return on.length === 1 && only
    ? SINGLE_NAMES[only]
    : itemAt(COUNT_NAMES, on.length);
};

/** The Mode's name without N: "Dual", "Crab Triple", "Double-stim Dual", "Variable Arithmetic". */
export const modeName = (m: Mode): string => {
  const prefix = [
    m.selfPaced ? "Self-paced" : "",
    m.variable ? "Variable" : "",
    m.crab ? "Crab" : "",
    m.multi > 1 ? MULTI_NAMES[m.multi] : "",
  ].filter(Boolean);
  return [...prefix, baseName(m)].join(" ");
};

/** The Modalities' initials, for the narrow places a name does not fit: "P·A", "P·C·S·A". */
export const modeCode = (m: Mode): string => {
  const parts: string[] = [];
  if (m.position) {
    parts.push(m.multi > 1 ? `${m.multi}P` : "P");
  }
  if (m.color) {
    parts.push("C");
  }
  if (m.shape) {
    parts.push("S");
  }
  if (m.combination) {
    parts.push("X");
  }
  if (m.arithmetic) {
    parts.push("M");
  }
  if (m.sound) {
    parts.push("A");
  }
  return parts.join("·");
};

/** The N a Mode starts at with no History: 1 where every trial is harder (Combination, Arithmetic), 2 otherwise. */
export const startingN = (m: Mode): number =>
  m.combination || m.arithmetic ? 1 : 2;

/** Seconds per trial for one object. */
const baseTrialSeconds = (m: Mode): number => {
  if (m.arithmetic) {
    return 4;
  }
  if (m.combination) {
    return 3.5;
  }
  return 3;
};

/** Seconds per trial when the player has not set one: more where there is more to take in. */
export const defaultTrialSeconds = (m: Mode): number =>
  baseTrialSeconds(m) + (m.multi - 1) * 0.5;

/** How long the visual stimulus stays up, in seconds: a tenth longer per extra object. */
export const stimulusSeconds = (m: Mode): number => 0.5 + (m.multi - 1) * 0.1;

export const trialCount = (n: number, base: number, jaeggi: boolean): number =>
  base + (jaeggi ? n : n * n);

/* ---------------- Trials ---------------- */

export type Op = "add" | "subtract" | "multiply" | "divide";
export const OP_SYMBOL: Record<Op, string> = {
  add: "+",
  divide: "÷",
  multiply: "×",
  subtract: "−",
};

/** Everything one trial shows and plays. Stimulus values are 0..7; positions index the eight outer cells. */
export interface Trial {
  /** How far back this trial is compared: N, unless Variable or Crab. */
  back: number;
  positions: number[];
  vis: number[];
  color: number;
  shape: number;
  /** The letter shown in the cell in Combination: an index into the Sound sample. */
  letter: number;
  sound: number;
  number: number;
  /** Arithmetic's operation, from the first trial with a number N back. */
  op: Op | null;
  /** Arithmetic's answer: the number N back, op, this one. */
  answer: number | null;
}

export interface ArithmeticOptions {
  max: number;
  negatives: boolean;
  ops: Op[];
}

export interface GenerateOptions {
  mode: Mode;
  n: number;
  trials: number;
  /** Chance a trial is forced to match, per Modality. */
  matchChance: number;
  /** Chance a trial that is not forced to match is made a Lure, per Modality. */
  lureChance: number;
  arithmetic: ArithmeticOptions;
  /** Jaeggi's fixed sequence: exactly 4 position-only, 4 sound-only, and 2 dual matches. */
  jaeggi: boolean;
  rand: Rand;
}

const int = (rand: Rand, n: number) => Math.floor(rand() * n);

const shuffle = <T>(a: T[], rand: Rand): T[] => {
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = int(rand, i + 1);
    [a[i], a[j]] = [itemAt(a, j), itemAt(a, i)];
  }
  return a;
};

/** Variable N-Back's backs: from Beta(N/2, 1), so 1..N leaning towards N. */
const variableBacks = (n: number, count: number, rand: Rand): number[] =>
  // Beta(a, 1) is U^(1/a).
  Array.from({ length: count }, () =>
    Math.min(n, Math.floor(rand() ** (2 / n) * n) + 1)
  );

/** The back of trial `t` (0-based) under Crab-Back: 1, 3, 5, ... within each block of N, so a block is matched against the previous one reversed. */
export const crabBack = (t: number, n: number): number => 1 + 2 * (t % n);

/** Decimals division may come out at: one place, the eighths, and the odd twentieths. */
const DECIMALS = [
  0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.125, 0.25, 0.375, 0.625, 0.75,
  0.875, 0.15, 0.35, 0.45, 0.55, 0.65, 0.85, 0.95,
];

export const compute = (a: number, op: Op, b: number): number => {
  switch (op) {
    case "add": {
      return a + b;
    }
    case "subtract": {
      return a - b;
    }
    case "multiply": {
      return a * b;
    }
    case "divide": {
      return a / b;
    }
    default: {
      const unknown: never = op;
      throw new Error(`Unknown operation: ${String(unknown)}`);
    }
  }
};

const acceptableDivisor = (a: number, b: number): boolean => {
  if (b === 0) {
    return false;
  }
  if (a % b === 0) {
    return true;
  }
  const frac = Math.abs(a / b) % 1;
  return DECIMALS.some((d) => Math.abs(frac - d) < 1e-9);
};

/** Where a Modality reads its value now, and where it reads the value it is compared with. */
type Stream =
  | "pos1"
  | "pos2"
  | "pos3"
  | "pos4"
  | "vis1"
  | "vis2"
  | "vis3"
  | "vis4"
  | "color"
  | "shape"
  | "letter"
  | "sound";

const STREAMS: Partial<Record<Modality, [now: Stream, back: Stream]>> = {
  audiovis: ["sound", "letter"],
  color: ["color", "color"],
  position1: ["pos1", "pos1"],
  position2: ["pos2", "pos2"],
  position3: ["pos3", "pos3"],
  position4: ["pos4", "pos4"],
  shape: ["shape", "shape"],
  sound: ["sound", "sound"],
  vis1: ["vis1", "vis1"],
  vis2: ["vis2", "vis2"],
  vis3: ["vis3", "vis3"],
  vis4: ["vis4", "vis4"],
  visaudio: ["letter", "sound"],
  visvis: ["letter", "letter"],
};

/** The streams a Modality compares. Every Modality but Arithmetic has them. */
const streamsOf = (mod: Modality): [now: Stream, back: Stream] => {
  const streams = STREAMS[mod];
  if (!streams) {
    throw new Error(`${mod} has no streams to compare`);
  }
  return streams;
};

type Values = Record<Stream, number>;

const read = (trial: Trial, s: Stream): number => {
  if (s.startsWith("pos")) {
    return itemAt(trial.positions, Number(s[3]) - 1);
  }
  if (s.startsWith("vis")) {
    return itemAt(trial.vis, Number(s[3]) - 1);
  }
  return trial[s as "color" | "shape" | "letter" | "sound"];
};

const toValues = (trial: Trial): Values => {
  const v = {} as Values;
  for (const s of [
    "pos1",
    "pos2",
    "pos3",
    "pos4",
    "vis1",
    "vis2",
    "vis3",
    "vis4",
    "color",
    "shape",
    "letter",
    "sound",
  ] as Stream[]) {
    v[s] = read(trial, s);
  }
  return v;
};

const fromValues = (v: Values, back: number): Trial => ({
  answer: null,
  back,
  color: v.color,
  letter: v.letter,
  number: 0,
  op: null,
  positions: [v.pos1, v.pos2, v.pos3, v.pos4],
  shape: v.shape,
  sound: v.sound,
  vis: [v.vis1, v.vis2, v.vis3, v.vis4],
});

/** Whether trial `t` (0-based) is a Match for `mod`. The first N trials never are: nothing is N back of them. */
export const isMatch = (
  trials: Trial[],
  t: number,
  mod: Modality,
  n: number
): boolean => {
  if (t < n || mod === "arithmetic") {
    return false;
  }
  const [now, back] = streamsOf(mod);
  const trial = itemAt(trials, t);
  return read(trial, now) === read(itemAt(trials, t - trial.back), back);
};

const addArithmetic = (
  trials: Trial[],
  n: number,
  a: ArithmeticOptions,
  rand: Rand
) => {
  const ops = a.ops.length ? a.ops : (["add"] as Op[]);
  const draw = () =>
    a.negatives ? int(rand, 2 * a.max + 1) - a.max : int(rand, a.max + 1);
  for (const [t, trial] of trials.entries()) {
    if (t < n) {
      trial.number = draw();
      continue;
    }
    const op = itemAt(ops, int(rand, ops.length));
    const prev = itemAt(trials, t - trial.back).number;
    let b = draw();
    if (op === "divide") {
      const candidates: number[] = [];
      for (let x = a.negatives ? -a.max : 0; x <= a.max; x += 1) {
        if (acceptableDivisor(prev, x)) {
          candidates.push(x);
        }
      }
      b = itemAt(candidates, int(rand, candidates.length));
    }
    trial.number = b;
    trial.op = op;
    trial.answer = compute(prev, op, b);
  }
};

const generateJaeggi = (o: GenerateOptions): Trial[] => {
  const { n, rand } = o;
  const scored = shuffle(
    Array.from({ length: o.trials - n }, (_, i) => i + n),
    rand
  );
  const both = new Set(scored.slice(0, 2));
  const posOnly = new Set(scored.slice(2, 6));
  const soundOnly = new Set(scored.slice(6, 10));
  const other = (avoid: number) => (avoid + 1 + int(rand, 7)) % 8;
  const trials: Trial[] = [];
  for (let t = 0; t < o.trials; t += 1) {
    // Drawn in this order so a seed replays the same Session.
    const pos1 = int(rand, 8);
    const sound = int(rand, 8);
    const v: Values = {
      color: 0,
      letter: 0,
      pos1,
      pos2: 0,
      pos3: 0,
      pos4: 0,
      shape: 0,
      sound,
      vis1: 0,
      vis2: 0,
      vis3: 0,
      vis4: 0,
    };
    if (t >= n) {
      const before = toValues(itemAt(trials, t - n));
      v.pos1 = both.has(t) || posOnly.has(t) ? before.pos1 : other(before.pos1);
      v.sound =
        both.has(t) || soundOnly.has(t) ? before.sound : other(before.sound);
    }
    trials.push(fromValues(v, n));
  }
  return trials;
};

/** How far back trial `t` is compared. */
const trialBack = (
  t: number,
  n: number,
  mode: Mode,
  backs: number[]
): number => {
  if (t < n) {
    return n;
  }
  if (mode.crab) {
    return crabBack(t, n);
  }
  if (mode.variable) {
    return itemAt(backs, t - n);
  }
  return n;
};

/** A trial's values before any Match or Lure: distinct positions, everything else at random. */
const randomValues = (rand: Rand): Values => {
  const positions = shuffle([0, 1, 2, 3, 4, 5, 6, 7], rand);
  // Drawn in this order so a seed replays the same Session.
  const [vis1, vis2, vis3, vis4, color, shape, letter, sound] = Array.from(
    { length: 8 },
    () => int(rand, 8)
  );
  return {
    color,
    letter,
    pos1: itemAt(positions, 0),
    pos2: itemAt(positions, 1),
    pos3: itemAt(positions, 2),
    pos4: itemAt(positions, 3),
    shape,
    sound,
    vis1,
    vis2,
    vis3,
    vis4,
  };
};

/** The value a Modality is forced to: the one `back` trials ago for a Match, a near miss for a Lure, or null to leave it random. */
const forcedValue = (
  o: GenerateOptions,
  past: (k: number) => Values,
  t: number,
  back: number,
  from: Stream
): number | null => {
  const { mode, n, rand } = o;
  const r1 = rand();
  const r2 = rand() * (mode.multi > 1 ? 1.5 : 1);
  if (r1 < o.matchChance) {
    return past(back)[from];
  }
  if (r2 < o.lureChance && n > 1) {
    // A Lure: the value from one before or one after the right trial, or from 2N back.
    const offsets = shuffle(
      [back - 1, back + 1, back + n].filter(
        (k) => k >= 1 && k <= t && !(k === back - 1 && back < 3)
      ),
      rand
    );
    const target = past(back)[from];
    for (const k of offsets) {
      if (past(k)[from] !== target) {
        return past(k)[from];
      }
    }
  }
  return null;
};

/** Sets a stream's value. Objects never share a cell: whoever has the value takes this one's. */
const place = (v: Values, now: Stream, value: number) => {
  if (now.startsWith("pos")) {
    const other = (["pos1", "pos2", "pos3", "pos4"] as const).find(
      (p) => p !== now && v[p] === value
    );
    if (other) {
      v[other] = v[now];
    }
  }
  v[now] = value;
};

/** Multi-stimulus Lure: the right positions (or visuals), handed to the wrong objects. */
const multiLure = (o: GenerateOptions, v: Values, before: () => Values) => {
  const { mode, rand } = o;
  if (mode.multi > 1 && rand() < o.lureChance / 3) {
    const visual = (mode.color || mode.shape) && rand() < 0.5;
    const prefix = visual ? "vis" : "pos";
    const offset = 1 + int(rand, mode.multi - 1);
    const values = before();
    for (let i = 0; i < mode.multi; i += 1) {
      v[(prefix + (i + 1)) as Stream] =
        values[(prefix + (((i + offset) % mode.multi) + 1)) as Stream];
    }
  }
};

/** A Session's trials. */
export const generate = (o: GenerateOptions): Trial[] => {
  if (o.jaeggi) {
    return generateJaeggi(o);
  }
  const { mode, n, rand } = o;
  const mods = modalities(mode).filter((m) => m !== "arithmetic");
  const backs = mode.variable ? variableBacks(n, o.trials, rand) : [];
  const trials: Trial[] = [];
  for (let t = 0; t < o.trials; t += 1) {
    const back = trialBack(t, n, mode, backs);
    const v = randomValues(rand);
    if (t >= n) {
      const past = (k: number) => toValues(itemAt(trials, t - k));
      for (const mod of mods) {
        const [now, from] = streamsOf(mod);
        const value = forcedValue(o, past, t, back, from);
        if (value !== null) {
          place(v, now, value);
        }
      }
      multiLure(o, v, () => past(back));
    }
    trials.push(fromValues(v, back));
  }
  if (mode.arithmetic) {
    addArithmetic(trials, n, o.arithmetic, rand);
  }
  return trials;
};

/* ---------------- Scores ---------------- */

/** What the player did on one trial: the Modalities they pressed, and the answer they typed. */
export interface Response {
  pressed: Partial<Record<Modality, number>>;
  /** As typed: "" counts as 0. */
  answer: string;
}

/** One Modality's tally over the scored trials. Arithmetic counts right answers as hits and wrong ones as misses. */
export interface Tally {
  hits: number;
  misses: number;
  falseAlarms: number;
  correctRejections: number;
  /** Mean milliseconds from the trial's start to a hit's press, when there was one. */
  rt: number | null;
}

export interface Scoring {
  /** Jaeggi scoring: a correct rejection counts as right, and the Session's Score is the lowest Modality's. */
  jaeggi: boolean;
}

export const answerRight = (trial: Trial, typed: string): boolean => {
  const value = typed === "" || typed === "-" ? 0 : Number(typed);
  return (
    trial.answer !== null &&
    Number.isFinite(value) &&
    Math.abs(value - trial.answer) < 1e-9
  );
};

export const tally = (
  trials: Trial[],
  responses: Response[],
  mod: Modality,
  n: number
): Tally => {
  const out: Tally = {
    correctRejections: 0,
    falseAlarms: 0,
    hits: 0,
    misses: 0,
    rt: null,
  };
  let rtSum = 0;
  let rtCount = 0;
  for (let t = n; t < trials.length; t += 1) {
    const r = responses[t];
    if (mod === "arithmetic") {
      if (answerRight(itemAt(trials, t), r?.answer ?? "")) {
        out.hits += 1;
      } else {
        out.misses += 1;
      }
      continue;
    }
    const match = isMatch(trials, t, mod, n);
    const at = r?.pressed[mod];
    const pressed = at !== undefined;
    if (match && pressed) {
      out.hits += 1;
      rtSum += at;
      rtCount += 1;
    } else if (match) {
      out.misses += 1;
    } else if (pressed) {
      out.falseAlarms += 1;
    } else {
      out.correctRejections += 1;
    }
  }
  out.rt = rtCount ? Math.round(rtSum / rtCount) : null;
  return out;
};

const rights = (t: Tally, s: Scoring) =>
  t.hits + (s.jaeggi ? t.correctRejections : 0);
const wrongs = (t: Tally) => t.misses + t.falseAlarms;

/** A Modality's percentage, truncated: rights over rights and wrongs, 0 when there was nothing to get right or wrong. */
export const percent = (t: Tally, s: Scoring): number => {
  const r = rights(t, s);
  const w = wrongs(t);
  return r + w === 0 ? 0 : Math.floor((r * 100) / (r + w));
};

/** The Session's Score: rights over rights and wrongs pooled across Modalities, or the lowest Modality's under Jaeggi scoring. */
export const sessionScore = (tallies: Tally[], s: Scoring): number => {
  if (s.jaeggi) {
    return Math.min(...tallies.map((t) => percent(t, s)));
  }
  let r = 0;
  let w = 0;
  for (const t of tallies) {
    r += rights(t, s);
    w += wrongs(t);
  }
  return r + w === 0 ? 0 : Math.floor((r * 100) / (r + w));
};

/* ---------------- Levels ---------------- */

export interface Thresholds {
  /** Raise N at a Score of at least this. */
  advance: number;
  /** A Strike at a Score below this. */
  fallback: number;
  /** Strikes at one N that lower it. */
  strikes: number;
}

export const STANDARD: Thresholds = { advance: 80, fallback: 50, strikes: 3 };
export const JAEGGI: Thresholds = { advance: 90, fallback: 75, strikes: 1 };

export interface Level {
  n: number;
  strikes: number;
}

/** The Level after a Session at `level` scoring `score`. Scores between the thresholds keep the Strikes. */
export const nextLevel = (
  level: Level,
  score: number,
  th: Thresholds
): Level => {
  if (score >= th.advance) {
    return { n: level.n + 1, strikes: 0 };
  }
  if (level.n > 1 && score < th.fallback) {
    const strikes = level.strikes + 1;
    return strikes >= th.strikes
      ? { n: level.n - 1, strikes: 0 }
      : { n: level.n, strikes };
  }
  return level;
};

/** The line under a finished Session's Score. */
export const verdict = (score: number, th: Thresholds): string => {
  if (score >= 100) {
    return "Perfect score!";
  }
  if (score >= th.advance) {
    return "Awesome score!";
  }
  if (score >= Math.floor((th.advance + th.fallback) / 2)) {
    return "Great score!";
  }
  if (score >= th.fallback) {
    return "Not bad!";
  }
  return "Keep trying. You're getting there!";
};

/** A Session's Score on the chart's level scale: N at the lower threshold, N + 1 at the upper. */
export const levelScore = (n: number, score: number, th: Thresholds): number =>
  n + (score - th.fallback) / (th.advance - th.fallback);
