// Settings and their Deep Link form: readable `key=value` pairs, with every
// default left out, so a short message makes a short link.

import { formatDuration, parseDuration } from "./countdown";
import type { CountdownStyle } from "./countdown";

export const FONTS = ["sans", "serif", "mono"] as const;
export const TRANSITIONS = ["fade", "slide", "none"] as const;
export const SPEEDS = ["slow", "normal", "fast"] as const;
export const ENDS = ["freeze", "hide", "text"] as const;

export type Font = (typeof FONTS)[number];
export type Transition = (typeof TRANSITIONS)[number];
export type Speed = (typeof SPEEDS)[number];
/** At zero: stay at zero, drop what shows the Countdown, or show other text there. */
export type End = (typeof ENDS)[number];

export type Countdown =
  | { kind: "none" }
  | { kind: "until"; at: number }
  | { kind: "timer"; secs: number };

export interface Settings {
  message: string;
  font: Font;
  fg: string;
  bg: string;
  /** Margin on every side, in percent of the screen's height (top, bottom) and width (sides). */
  pad: number;
  wrap: boolean;
  scroll: boolean;
  speed: Speed;
  /** Seconds each Slide is shown. */
  secs: number;
  transition: Transition;
  countdown: Countdown;
  style: CountdownStyle;
  end: End;
  endText: string;
}

export const LIMITS = { pad: [0, 40], secs: [0.5, 3600] } as const;

export const DEFAULTS: Settings = {
  message: "",
  font: "sans",
  fg: "#ffffff",
  bg: "#000000",
  pad: 5,
  wrap: true,
  scroll: false,
  speed: "normal",
  secs: 5,
  transition: "fade",
  countdown: { kind: "none" },
  style: "label",
  end: "freeze",
  endText: "",
};

const pick = <T extends string>(
  list: readonly T[],
  v: string | null,
  fallback: T
): T => (list.includes(v as T) ? (v as T) : fallback);

function num(
  v: string | null,
  [lo, hi]: readonly [number, number],
  fallback: number
): number {
  if (v === null || v.trim() === "") {
    return fallback;
  }
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

const hex = (v: string | null, fallback: string) =>
  v && /^[0-9a-f]{6}$/i.test(v) ? `#${v.toLowerCase()}` : fallback;

/** An instant as UTC to the second: `2026-12-31T23:00:00Z`. */
const isoSeconds = (ms: number) =>
  new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** `show` marks a Present Link: it opens straight onto the display. */
export function encode(s: Settings, show = false): string {
  const p = new URLSearchParams();
  const d = DEFAULTS;
  if (s.message) {
    p.set("m", s.message);
  }
  if (s.font !== d.font) {
    p.set("font", s.font);
  }
  if (s.fg !== d.fg) {
    p.set("fg", s.fg.slice(1));
  }
  if (s.bg !== d.bg) {
    p.set("bg", s.bg.slice(1));
  }
  if (s.pad !== d.pad) {
    p.set("pad", String(s.pad));
  }
  if (!s.wrap) {
    p.set("wrap", "0");
  }
  if (s.scroll) {
    p.set("scroll", "1");
  }
  if (s.scroll && s.speed !== d.speed) {
    p.set("speed", s.speed);
  }
  if (s.secs !== d.secs) {
    p.set("secs", String(s.secs));
  }
  if (s.transition !== d.transition) {
    p.set("trans", s.transition);
  }
  const cd = s.countdown;
  if (cd.kind === "until") {
    p.set("until", isoSeconds(cd.at));
  }
  if (cd.kind === "timer") {
    p.set("timer", formatDuration(cd.secs));
  }
  if (cd.kind !== "none") {
    if (s.style !== d.style) {
      p.set("style", s.style);
    }
    if (s.end !== d.end) {
      p.set("end", s.end);
    }
    if (s.end === "text" && s.endText) {
      p.set("endtext", s.endText);
    }
  }
  if (show) {
    p.set("show", "1");
  }
  return p.toString();
}

export function decode(payload: string): { settings: Settings; show: boolean } {
  const p = new URLSearchParams(payload);
  const d = DEFAULTS;
  const until = Date.parse(p.get("until") ?? "");
  const timer = parseDuration(p.get("timer") ?? "");
  const countdown: Countdown = Number.isFinite(until)
    ? { kind: "until", at: until }
    : timer
      ? { kind: "timer", secs: timer }
      : { kind: "none" };
  return {
    settings: {
      message: p.get("m") ?? "",
      font: pick(FONTS, p.get("font"), d.font),
      fg: hex(p.get("fg"), d.fg),
      bg: hex(p.get("bg"), d.bg),
      pad: num(p.get("pad"), LIMITS.pad, d.pad),
      wrap: p.get("wrap") !== "0",
      scroll: p.get("scroll") === "1",
      speed: pick(SPEEDS, p.get("speed"), d.speed),
      secs: num(p.get("secs"), LIMITS.secs, d.secs),
      transition: pick(TRANSITIONS, p.get("trans"), d.transition),
      countdown,
      style: p.get("style") === "clock" ? "clock" : "label",
      end: pick(ENDS, p.get("end"), d.end),
      endText: p.get("endtext") ?? "",
    },
    show: p.get("show") === "1",
  };
}
