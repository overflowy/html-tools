// The History: every finished Session, kept in this browser, with the
// queries the Tool shows (today, the last 24 hours, the Level per Mode) and
// the way in and out (JSON).

import { parseModeKey, startingN, type Level, type Modality, type Tally } from "./engine";

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

export function dayKey(at: number): string {
  const d = new Date(at - ROLLOVER_HOURS * 3600_000);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

export function today(sessions: Session[], now: number): Session[] {
  const key = dayKey(now);
  return sessions.filter((s) => dayKey(s.at) === key);
}

export function lastDay(sessions: Session[], now: number): Session[] {
  return sessions.filter((s) => s.at > now - 24 * 3600_000 && s.at <= now);
}

export function totalSeconds(sessions: Session[]): number {
  return sessions.reduce((sum, s) => sum + s.seconds, 0);
}

/** Where a Mode stands: the Level after its last non-Manual Session, or its starting N. */
export function levelFor(sessions: Session[], key: string): Level {
  for (let i = sessions.length - 1; i >= 0; i--) {
    const s = sessions[i]!;
    if (s.mode === key && !s.manual && s.level) return s.level;
  }
  const m = parseModeKey(key);
  return { n: m ? startingN(m) : 2, strikes: 0 };
}

/* ---------------- storage ---------------- */

const KEY = "html-tools:dual-n-back:history";

function valid(s: unknown): s is Session {
  if (!s || typeof s !== "object") return false;
  const o = s as Record<string, unknown>;
  return typeof o.at === "number" && typeof o.mode === "string" && parseModeKey(o.mode) !== null &&
    typeof o.n === "number" && o.n >= 1 && typeof o.score === "number" && typeof o.seconds === "number" &&
    typeof o.trials === "number" && typeof o.trialMs === "number" && typeof o.pct === "object" && o.pct !== null;
}

export function load(): Session[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter(valid).toSorted((a, b) => a.at - b.at) : [];
  } catch {
    return [];
  }
}

/** False when the browser refused to store it (storage full or off). */
export function save(sessions: Session[]): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(sessions));
    return true;
  } catch {
    return false;
  }
}

/* ---------------- export and import ---------------- */

export const FORMAT = "html-tools/dual-n-back";

export function exportJson(sessions: Session[]): string {
  return JSON.stringify({ format: FORMAT, version: 1, sessions }, null, 1);
}

/** Adds imported Sessions to the History, dropping any already there (same end time, Mode, and N). */
export function merge(existing: Session[], incoming: Session[]): { sessions: Session[]; added: number } {
  const id = (s: Session) => s.at + "|" + s.mode + "|" + s.n;
  const seen = new Set(existing.map(id));
  const fresh: Session[] = [];
  for (const s of incoming) {
    if (seen.has(id(s))) continue;
    seen.add(id(s));
    fresh.push(s);
  }
  return { sessions: existing.concat(fresh).toSorted((a, b) => a.at - b.at), added: fresh.length };
}

/** Our own export, or null when the text is not one. */
export function parseJson(text: string): Session[] | null {
  try {
    const o = JSON.parse(text);
    if (!o || o.format !== FORMAT || !Array.isArray(o.sessions)) return null;
    return o.sessions.filter(valid);
  } catch {
    return null;
  }
}
