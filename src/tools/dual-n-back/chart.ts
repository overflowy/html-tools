// The History's chart: one Mode's daily mean and daily best, by calendar day.

import { itemAt, levelScore } from "./engine";
import type { Thresholds } from "./engine";
import { dayKey } from "./history";
import type { Session } from "./history";

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
const value = (
  s: Session,
  metric: Metric,
  th: (s: Session) => Thresholds
): number => (metric === "score" ? s.score : levelScore(s.n, s.score, th(s)));

export const daily = (
  sessions: Session[],
  metric: Metric,
  th: (s: Session) => Thresholds
): DayPoint[] => {
  const days = new Map<string, number[]>();
  for (const s of sessions) {
    const k = dayKey(s.at);
    const list = days.get(k) ?? [];
    list.push(value(s, metric, th));
    days.set(k, list);
  }
  return [...days]
    .map(([day, vs]) => {
      const [y, m, d] = day.split("-").map(Number) as [number, number, number];
      return {
        at: new Date(y, m - 1, d, 12).getTime(),
        best: Math.max(...vs),
        count: vs.length,
        day,
        mean: vs.reduce((a, b) => a + b, 0) / vs.length,
      };
    })
    .toSorted((a, b) => a.at - b.at);
};

const H = 240;
const PAD = { bottom: 26, left: 36, right: 46, top: 14 };
const SERIES = [
  { color: "#c96442", key: "mean", label: "mean" },
  { color: "#5f8ee0", key: "best", label: "best" },
] as const;

const dateFmt = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
});
const longDateFmt = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  weekday: "short",
  year: "numeric",
});

const fmt = (v: number, metric: Metric) =>
  metric === "score" ? `${Math.round(v)}%` : v.toFixed(2);

/** The value axis: Scores always run 0 to 100; Levels span the whole Ns around the values, with finer ticks over a short span. */
const valueAxis = (
  points: DayPoint[],
  metric: Metric
): { lo: number; hi: number; step: number } => {
  if (metric === "score") {
    return { hi: 100, lo: 0, step: 25 };
  }
  const values = points.flatMap((p) => [p.mean, p.best]);
  const lo = Math.floor(Math.min(...values));
  const hi = Math.max(Math.ceil(Math.max(...values)), lo + 1);
  if (hi - lo <= 2) {
    return { hi, lo, step: 0.25 };
  }
  return { hi, lo, step: hi - lo <= 4 ? 0.5 : 1 };
};

/** Which days get a date: left to right, each at least `gap` from the one before; the last day always gets one, at the cost of its neighbour. */
const datedDays = (
  points: DayPoint[],
  x: (at: number) => number,
  gap: number
): number[] => {
  const shown: number[] = [];
  const lastShownAt = () => itemAt(points, itemAt(shown, shown.length - 1)).at;
  for (const [i, p] of points.entries()) {
    if (!shown.length || x(p.at) - x(lastShownAt()) >= gap) {
      shown.push(i);
    }
  }
  const lastIndex = points.length - 1;
  if (shown.at(-1) !== lastIndex) {
    const lastAt = itemAt(points, lastIndex).at;
    while (shown.length > 1 && x(lastAt) - x(lastShownAt()) < gap) {
      shown.pop();
    }
    shown.push(lastIndex);
  }
  return shown;
};

/** Where a date sits against its day: the first and last day's dates stay inside the chart. */
const dateAnchor = (i: number, count: number): string => {
  if (count === 1) {
    return "middle";
  }
  if (i === 0) {
    return "start";
  }
  return i === count - 1 ? "end" : "middle";
};

/** The heights of the direct labels at the lines' right ends, nudged apart when the two lines end close together. */
const labelHeights = (last: DayPoint, y: (v: number) => number): number[] => {
  const mean = y(last.mean);
  const best = y(last.best);
  if (Math.abs(mean - best) < 13) {
    const mid = (mean + best) / 2;
    return last.mean <= last.best ? [mid + 7, mid - 7] : [mid - 7, mid + 7];
  }
  return [mean, best];
};

/** Draws the chart into `host` at its current width, with a crosshair and tooltip that follow the pointer. */
export const draw = (host: HTMLElement, points: DayPoint[], metric: Metric) => {
  host.replaceChildren();
  const [first] = points;
  const last = points.at(-1);
  if (!first || !last) {
    throw new Error("The chart needs at least one day to draw");
  }
  const W = Math.max(280, host.clientWidth);
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("width", String(W));
  svg.setAttribute("height", String(H));
  svg.setAttribute("role", "img");
  svg.setAttribute(
    "aria-label",
    metric === "score"
      ? "Daily mean and best Score"
      : "Daily mean and best Level"
  );

  const { lo, hi, step } = valueAxis(points, metric);
  const t0 = first.at;
  const t1 = last.at;
  const x = (at: number) =>
    t1 === t0
      ? (PAD.left + W - PAD.right) / 2
      : PAD.left + ((at - t0) / (t1 - t0)) * (W - PAD.left - PAD.right);
  const y = (v: number) =>
    PAD.top + (1 - (v - lo) / (hi - lo)) * (H - PAD.top - PAD.bottom);

  let body = "";
  for (let v = lo; v <= hi + 1e-9; v += step) {
    const whole = Math.abs(v - Math.round(v)) < 1e-9;
    body += `<line class="grid${whole ? " major" : ""}" x1="${PAD.left}" x2="${W - PAD.right}" y1="${y(v)}" y2="${y(v)}"/>`;
    if (whole || step >= 1 || metric === "score") {
      body += `<text class="tick" x="${PAD.left - 8}" y="${y(v) + 4}" text-anchor="end">${metric === "score" ? `${v}%` : v}</text>`;
    }
  }
  // Dates under the days, each at least a label's width from the one before.
  for (const i of datedDays(points, x, 64)) {
    const p = itemAt(points, i);
    body += `<text class="tick" x="${x(p.at)}" y="${H - 6}" text-anchor="${dateAnchor(i, points.length)}">${dateFmt.format(p.at)}</text>`;
  }
  const markers = points.length <= 60;
  for (const s of SERIES) {
    const d = points
      .map(
        (p, i) =>
          `${(i ? "L" : "M") + x(p.at).toFixed(1)} ${y(p[s.key]).toFixed(1)}`
      )
      .join("");
    body += `<path class="line" d="${d}" stroke="${s.color}"/>`;
    if (markers) {
      for (const p of points) {
        body += `<circle class="dot" cx="${x(p.at)}" cy="${y(p[s.key])}" r="4" fill="${s.color}"/>`;
      }
    }
  }
  const heights = labelHeights(last, y);
  for (const [i, s] of SERIES.entries()) {
    body += `<text class="series-label" x="${x(last.at) + 8}" y="${itemAt(heights, i) + 4}">${s.label}</text>`;
  }
  body += `<line class="crosshair" y1="${PAD.top}" y2="${H - PAD.bottom}" visibility="hidden"/>`;
  svg.innerHTML = body;
  host.append(svg);

  const tip = document.createElement("div");
  tip.className = "chart-tip";
  tip.hidden = true;
  host.append(tip);
  const cross = svg.querySelector(".crosshair") as SVGLineElement;

  // The nearest day to the pointer, anywhere over the plot: the hit target is the whole column, not the dot.
  svg.addEventListener("pointermove", (e) => {
    const box = svg.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    let best = first;
    for (const p of points) {
      if (Math.abs(x(p.at) - px) < Math.abs(x(best.at) - px)) {
        best = p;
      }
    }
    const cx = x(best.at);
    cross.setAttribute("x1", String(cx));
    cross.setAttribute("x2", String(cx));
    cross.setAttribute("visibility", "visible");
    tip.innerHTML = `<div class="tip-day">${longDateFmt.format(best.at)}</div>${SERIES.map(
      (s) =>
        `<div class="tip-row"><span class="tip-key" style="background:${s.color}"></span>${s.label === "mean" ? "Mean" : "Best"}<span class="tip-val">${fmt(best[s.key], metric)}</span></div>`
    ).join(
      ""
    )}<div class="tip-row tip-count">${best.count} session${best.count === 1 ? "" : "s"}</div>`;
    tip.hidden = false;
    const left = (cx / W) * box.width;
    // Right of the crosshair, or left of it where the right would run off the chart.
    tip.style.left = `${Math.max(
      4,
      left + 12 + tip.offsetWidth > box.width - 4
        ? left - 12 - tip.offsetWidth
        : left + 12
    )}px`;
    tip.style.top = "8px";
  });
  svg.addEventListener("pointerleave", () => {
    cross.setAttribute("visibility", "hidden");
    tip.hidden = true;
  });
};
