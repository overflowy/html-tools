// The Countdown: to a moment (Until) or for a length of time (Timer).

const UNITS = [
  ["d", 86_400],
  ["h", 3600],
  ["m", 60],
  ["s", 1],
] as const;

/** The longest Timer: 99 days. */
export const MAX_TIMER = 99 * 86_400;

/**
 * A Timer length in seconds, or null. Accepts plain seconds (`90`), unit
 * amounts in any order (`1h30m`, `2d 12h`), or a clock (`1:30:00`, `5:00`).
 */
export function parseDuration(input: string): number | null {
  const s = input.trim().toLowerCase().replaceAll(/\s+/g, "");
  let secs: number;
  if (/^\d+$/.test(s)) {
    secs = Number(s);
  } else if (/^\d+(:\d{1,2}){1,3}$/.test(s)) {
    const parts = s.split(":").map(Number);
    if (parts.slice(1).some((p) => p > 59)) {
      return null;
    }
    const weights = [86_400, 3600, 60, 1].slice(-parts.length);
    secs = parts.reduce((sum, p, i) => sum + p * weights[i]!, 0);
  } else if (/^(\d+[dhms])+$/.test(s)) {
    const seen = new Set<string>();
    secs = 0;
    for (const [, n, unit] of s.matchAll(/(\d+)([dhms])/g)) {
      if (seen.has(unit!)) {
        return null;
      }
      seen.add(unit!);
      secs += Number(n) * UNITS.find(([u]) => u === unit)![1];
    }
  } else {
    return null;
  }
  return secs > 0 && secs <= MAX_TIMER ? secs : null;
}

/** The canonical spelling of a Timer length, for the Deep Link: `1h30m`. */
export function formatDuration(secs: number): string {
  let rest = secs;
  let out = "";
  for (const [unit, size] of UNITS) {
    const n = Math.floor(rest / size);
    rest -= n * size;
    if (n) {
      out += n + unit;
    }
  }
  return out || "0s";
}

export type CountdownStyle = "label" | "clock";

/**
 * What the Countdown shows with `secs` to go. Leading units at zero drop
 * away: `1h 0m 5s`, `5m 0s`, `0s`; or as a clock, `1:00:05`, `5:00`, `0:00`.
 * Label units are held together by no-break spaces, so the Countdown never
 * wraps across lines.
 */
export function formatRemaining(secs: number, style: CountdownStyle): string {
  const parts: number[] = [];
  let rest = Math.max(0, Math.floor(secs));
  for (const [, size] of UNITS) {
    parts.push(Math.floor(rest / size));
    rest %= size;
  }
  if (style === "clock") {
    const first = Math.min(
      parts.findIndex((p) => p > 0),
      2
    );
    const shown = parts.slice(first === -1 ? 2 : first);
    return shown
      .map((p, i) => (i === 0 ? String(p) : String(p).padStart(2, "0")))
      .join(":");
  }
  const first = parts.findIndex((p) => p > 0);
  if (first === -1) {
    return "0s";
  }
  return parts
    .slice(first)
    .map((p, i) => p + UNITS[first + i]![0])
    .join("\u00A0");
}

/** Whole seconds left until `end` (ms since the epoch), never negative. */
export function secondsLeft(end: number, now: number): number {
  return Math.max(0, Math.ceil((end - now) / 1000));
}
