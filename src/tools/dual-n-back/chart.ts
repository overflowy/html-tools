// The History's chart: one Mode's daily mean and daily best, by calendar day.

import { levelScore, type Thresholds } from "./engine";
import { dayKey, type Session } from "./history";

export type Metric = "level" | "score";

export interface DayPoint {
  day: string;
  /** Local noon of the day, for placing it on the time axis. */
  at: number;
  mean: number;
  best: number;
  count: number;
}

/** A Session's value on the chart: its N plus how far it got from the lower threshold to the upper, or its Score. */
function value(s: Session, metric: Metric, th: (s: Session) => Thresholds): number {
  return metric === "score" ? s.score : levelScore(s.n, s.score, th(s));
}

export function daily(sessions: Session[], metric: Metric, th: (s: Session) => Thresholds): DayPoint[] {
  const days = new Map<string, number[]>();
  for (const s of sessions) {
    const k = dayKey(s.at);
    const list = days.get(k) ?? [];
    list.push(value(s, metric, th));
    days.set(k, list);
  }
  return [...days].map(([day, vs]) => {
    const [y, m, d] = day.split("-").map(Number) as [number, number, number];
    return { day, at: new Date(y, m - 1, d, 12).getTime(), mean: vs.reduce((a, b) => a + b, 0) / vs.length, best: Math.max(...vs), count: vs.length };
  }).toSorted((a, b) => a.at - b.at);
}

const H = 240;
const PAD = { top: 14, right: 46, bottom: 26, left: 36 };
const SERIES = [
  { key: "mean", label: "mean", color: "#c96442" },
  { key: "best", label: "best", color: "#5f8ee0" },
] as const;

const dateFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const longDateFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });

function fmt(v: number, metric: Metric) {
  return metric === "score" ? Math.round(v) + "%" : v.toFixed(2);
}

/** Draws the chart into `host` at its current width, with a crosshair and tooltip that follow the pointer. */
export function draw(host: HTMLElement, points: DayPoint[], metric: Metric) {
  host.replaceChildren();
  const W = Math.max(280, host.clientWidth);
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("width", String(W));
  svg.setAttribute("height", String(H));
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", metric === "score" ? "Daily mean and best Score" : "Daily mean and best Level");

  const values = points.flatMap((p) => [p.mean, p.best]);
  let lo: number, hi: number, step: number;
  if (metric === "score") {
    [lo, hi, step] = [0, 100, 25];
  } else {
    lo = Math.floor(Math.min(...values));
    hi = Math.ceil(Math.max(...values));
    if (hi - lo < 1) hi = lo + 1;
    step = hi - lo <= 2 ? 0.25 : hi - lo <= 4 ? 0.5 : 1;
  }
  const t0 = points[0]!.at;
  const t1 = points[points.length - 1]!.at;
  const x = (at: number) => (t1 === t0 ? (PAD.left + W - PAD.right) / 2 : PAD.left + ((at - t0) / (t1 - t0)) * (W - PAD.left - PAD.right));
  const y = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * (H - PAD.top - PAD.bottom);

  let body = "";
  for (let v = lo; v <= hi + 1e-9; v += step) {
    const whole = Math.abs(v - Math.round(v)) < 1e-9;
    body += `<line class="grid${whole ? " major" : ""}" x1="${PAD.left}" x2="${W - PAD.right}" y1="${y(v)}" y2="${y(v)}"/>`;
    if (whole || step >= 1 || metric === "score") body += `<text class="tick" x="${PAD.left - 8}" y="${y(v) + 4}" text-anchor="end">${metric === "score" ? v + "%" : v}</text>`;
  }
  // Dates under the days, left to right, each at least a label's width from the one before; the last day always gets one, at the cost of its neighbour.
  const GAP = 64;
  const shown: number[] = [];
  points.forEach((p, i) => {
    if (!shown.length || x(p.at) - x(points[shown[shown.length - 1]!]!.at) >= GAP) shown.push(i);
  });
  const lastIndex = points.length - 1;
  if (shown[shown.length - 1] !== lastIndex) {
    while (shown.length > 1 && x(points[lastIndex]!.at) - x(points[shown[shown.length - 1]!]!.at) < GAP) shown.pop();
    shown.push(lastIndex);
  }
  for (const i of shown) {
    const p = points[i]!;
    const anchor = points.length === 1 ? "middle" : i === 0 ? "start" : i === points.length - 1 ? "end" : "middle";
    body += `<text class="tick" x="${x(p.at)}" y="${H - 6}" text-anchor="${anchor}">${dateFmt.format(p.at)}</text>`;
  }
  const markers = points.length <= 60;
  for (const s of SERIES) {
    const d = points.map((p, i) => (i ? "L" : "M") + x(p.at).toFixed(1) + " " + y(p[s.key]).toFixed(1)).join("");
    body += `<path class="line" d="${d}" stroke="${s.color}"/>`;
    if (markers) for (const p of points) body += `<circle class="dot" cx="${x(p.at)}" cy="${y(p[s.key])}" r="4" fill="${s.color}"/>`;
  }
  // Direct labels at the right end, nudged apart when the two lines end close together.
  const last = points[points.length - 1]!;
  let ly = SERIES.map((s) => y(last[s.key]));
  if (Math.abs(ly[0]! - ly[1]!) < 13) {
    const mid = (ly[0]! + ly[1]!) / 2;
    ly = last.mean <= last.best ? [mid + 7, mid - 7] : [mid - 7, mid + 7];
  }
  SERIES.forEach((s, i) => {
    body += `<text class="series-label" x="${x(last.at) + 8}" y="${ly[i]! + 4}">${s.label}</text>`;
  });
  body += `<line class="crosshair" y1="${PAD.top}" y2="${H - PAD.bottom}" visibility="hidden"/>`;
  svg.innerHTML = body;
  host.appendChild(svg);

  const tip = document.createElement("div");
  tip.className = "chart-tip";
  tip.hidden = true;
  host.appendChild(tip);
  const cross = svg.querySelector(".crosshair") as SVGLineElement;

  // The nearest day to the pointer, anywhere over the plot: the hit target is the whole column, not the dot.
  svg.addEventListener("pointermove", (e) => {
    const box = svg.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    let best = points[0]!;
    for (const p of points) if (Math.abs(x(p.at) - px) < Math.abs(x(best.at) - px)) best = p;
    const cx = x(best.at);
    cross.setAttribute("x1", String(cx));
    cross.setAttribute("x2", String(cx));
    cross.setAttribute("visibility", "visible");
    tip.innerHTML = `<div class="tip-day">${longDateFmt.format(best.at)}</div>` +
      SERIES.map((s) => `<div class="tip-row"><span class="tip-key" style="background:${s.color}"></span>${s.label === "mean" ? "Mean" : "Best"}<span class="tip-val">${fmt(best[s.key], metric)}</span></div>`).join("") +
      `<div class="tip-row tip-count">${best.count} session${best.count === 1 ? "" : "s"}</div>`;
    tip.hidden = false;
    const left = (cx / W) * box.width;
    // Right of the crosshair, or left of it where the right would run off the chart.
    tip.style.left = Math.max(4, left + 12 + tip.offsetWidth > box.width - 4 ? left - 12 - tip.offsetWidth : left + 12) + "px";
    tip.style.top = "8px";
  });
  svg.addEventListener("pointerleave", () => {
    cross.setAttribute("visibility", "hidden");
    tip.hidden = true;
  });
}
