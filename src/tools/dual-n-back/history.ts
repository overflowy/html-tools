// The History: every finished Session, kept in this browser, with the
// queries the Tool shows (today, the last 24 hours, the Level per Mode) and
// the way in and out (JSON).

import { parseModeKey, startingN } from "./engine";
import type { Level, Modality, Tally } from "./engine";

export interface Session {
  /** When it ended, ms since the epoch. */
  at: number;
  /** Mode key. */
  mode: string;
  n: number;
  manual: boolean;
  /** Scored the Jaeggi way. */
  jaeggi: boolean;
  trials: number;
  trialMs: number;
  seconds: number;
  score: number;
  /** Each Modality's percentage. */
  pct: Partial<Record<Modality, number>>;
  /** Each Modality's tally. */
  tallies: Partial<Record<Modality, Tally>>;
  /** The Level after this Session; absent for Manual ones, which never change it. */
  level?: Level;
}

/** Days start at 4 in the morning, so a session after midnight still counts for the evening it belongs to. */
const ROLLOVER_HOURS = 4;

export const dayKey = (at: number): string => {
  const d = new Date(at - ROLLOVER_HOURS * 3_600_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
    2,
    "0"
  )}-${String(d.getDate()).padStart(2, "0")}`;
};

export const today = (sessions: Session[], now: number): Session[] => {
  const key = dayKey(now);
  return sessions.filter((s) => dayKey(s.at) === key);
};

export const lastDay = (sessions: Session[], now: number): Session[] =>
  sessions.filter((s) => s.at > now - 24 * 3_600_000 && s.at <= now);

export const totalSeconds = (sessions: Session[]): number =>
  sessions.reduce((sum, s) => sum + s.seconds, 0);

/** Where a Mode stands: the Level after its last non-Manual Session, or its starting N. */
export const levelFor = (sessions: Session[], key: string): Level => {
  const last = sessions.findLast((s) => s.mode === key && !s.manual && s.level);
  if (last?.level) {
    return last.level;
  }
  const m = parseModeKey(key);
  return { n: m ? startingN(m) : 2, strikes: 0 };
};

/* ---------------- storage ---------------- */

const KEY = "html-tools:dual-n-back:history";

const valid = (s: unknown): s is Session => {
  if (!s || typeof s !== "object") {
    return false;
  }
  const o = s as Record<string, unknown>;
  return (
    typeof o.at === "number" &&
    typeof o.mode === "string" &&
    parseModeKey(o.mode) !== null &&
    typeof o.n === "number" &&
    o.n >= 1 &&
    typeof o.score === "number" &&
    typeof o.seconds === "number" &&
    typeof o.trials === "number" &&
    typeof o.trialMs === "number" &&
    typeof o.pct === "object" &&
    o.pct !== null
  );
};

export const load = (): Session[] => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(raw)
      ? raw.filter(valid).toSorted((a, b) => a.at - b.at)
      : [];
  } catch {
    return [];
  }
};

// The order a Session's and a Tally's fields are written in. The objects are
// built with their keys sorted, so stored and exported JSON is laid out from
// these lists instead, the way it always has been.
const SESSION_FIELDS = [
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
];
const TALLY_FIELDS = [
  "hits",
  "misses",
  "falseAlarms",
  "correctRejections",
  "rt",
];

/** A copy of `o` with `fields` first, in that order, then any other keys as they were. */
const ordered = (o: object, fields: string[]): Record<string, unknown> => {
  const entries = Object.entries(o);
  return Object.fromEntries([
    ...fields.flatMap((f) => entries.filter(([k]) => k === f)),
    ...entries.filter(([k]) => !fields.includes(k)),
  ]);
};

const forJson = (s: Session): Record<string, unknown> =>
  ordered(
    {
      ...s,
      tallies: Object.fromEntries(
        Object.entries(s.tallies).map(([mod, t]) => [
          mod,
          ordered(t, TALLY_FIELDS),
        ])
      ),
    },
    SESSION_FIELDS
  );

/** False when the browser refused to store it (storage full or off). */
export const save = (sessions: Session[]): boolean => {
  try {
    localStorage.setItem(KEY, JSON.stringify(sessions.map(forJson)));
    return true;
  } catch {
    return false;
  }
};

/* ---------------- export and import ---------------- */

export const FORMAT = "html-tools/dual-n-back";

export const exportJson = (sessions: Session[]): string =>
  JSON.stringify(
    // Entries rather than a literal, to keep the envelope's field order.
    Object.fromEntries([
      ["format", FORMAT],
      ["version", 1],
      ["sessions", sessions.map(forJson)],
    ]),
    null,
    1
  );

/** Adds imported Sessions to the History, dropping any already there (same end time, Mode, and N). */
export const merge = (
  existing: Session[],
  incoming: Session[]
): { sessions: Session[]; added: number } => {
  const id = (s: Session) => `${s.at}|${s.mode}|${s.n}`;
  const seen = new Set(existing.map(id));
  const fresh: Session[] = [];
  for (const s of incoming) {
    if (seen.has(id(s))) {
      continue;
    }
    seen.add(id(s));
    fresh.push(s);
  }
  return {
    added: fresh.length,
    sessions: [...existing, ...fresh].toSorted((a, b) => a.at - b.at),
  };
};

/** Our own export, or null when the text is not one. */
export const parseJson = (text: string): Session[] | null => {
  try {
    const o = JSON.parse(text);
    if (!o || o.format !== FORMAT || !Array.isArray(o.sessions)) {
      return null;
    }
    return o.sessions.filter(valid);
  } catch {
    return null;
  }
};
