// CVSS v3.0 and v3.1 base scores from a vector string, per the specification's
// formula. v4 vectors are recognized but not scored; the caller shows them as-is.

export type Band = "critical" | "high" | "moderate" | "low" | "unknown";

export const BAND_ORDER: Record<Band, number> = {
  critical: 4,
  high: 3,
  low: 1,
  moderate: 2,
  unknown: 0,
};

const AV: Record<string, number> = { A: 0.62, L: 0.55, N: 0.85, P: 0.2 };
const AC: Record<string, number> = { H: 0.44, L: 0.77 };
const PR_U: Record<string, number> = { H: 0.27, L: 0.62, N: 0.85 };
const PR_C: Record<string, number> = { H: 0.5, L: 0.68, N: 0.85 };
const UI: Record<string, number> = { N: 0.85, R: 0.62 };
const CIA: Record<string, number> = { H: 0.56, L: 0.22, N: 0 };

/** CVSS v3.1 "Roundup": to one decimal, upward, with the float-safety the spec prescribes. */
const roundUp = (x: number): number => {
  const i = Math.round(x * 100_000);
  return i % 10_000 === 0 ? i / 100_000 : (Math.floor(i / 10_000) + 1) / 10;
};

/** A metric's weight from its table, or undefined when the metric is missing or unknown. */
const weight = (
  table: Record<string, number>,
  metric: string | undefined
): number | undefined => (metric === undefined ? undefined : table[metric]);

interface Weights {
  av: number;
  ac: number;
  pr: number;
  ui: number;
  c: number;
  i: number;
  a: number;
}

/** The specification's base score formula, for an unchanged or a changed scope. */
const baseScore = (changed: boolean, w: Weights): number => {
  const iss = 1 - (1 - w.c) * (1 - w.i) * (1 - w.a);
  const impact = changed
    ? 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15
    : 6.42 * iss;
  const exploitability = 8.22 * w.av * w.ac * w.pr * w.ui;
  if (impact <= 0) {
    return 0;
  }
  return changed
    ? roundUp(Math.min(1.08 * (impact + exploitability), 10))
    : roundUp(Math.min(impact + exploitability, 10));
};

/** The base score for a CVSS:3.0 or CVSS:3.1 vector, or null when the vector is not one this scores. */
export const cvss3BaseScore = (vector: string): number | null => {
  const body = /^CVSS:3\.[01]\/(?<body>.+)$/u.exec(vector.trim())?.groups?.body;
  if (body === undefined) {
    return null;
  }
  const metrics: Record<string, string> = {};
  for (const part of body.split("/")) {
    const [k, v] = part.split(":");
    if (k && v) {
      metrics[k] = v;
    }
  }
  const scope = metrics.S;
  const av = weight(AV, metrics.AV);
  const ac = weight(AC, metrics.AC);
  const ui = weight(UI, metrics.UI);
  const pr = weight(scope === "C" ? PR_C : PR_U, metrics.PR);
  const c = weight(CIA, metrics.C);
  const i = weight(CIA, metrics.I);
  const a = weight(CIA, metrics.A);
  if (
    av === undefined ||
    ac === undefined ||
    pr === undefined ||
    ui === undefined ||
    c === undefined ||
    i === undefined ||
    a === undefined ||
    (scope !== "U" && scope !== "C")
  ) {
    return null;
  }
  return baseScore(scope === "C", { a, ac, av, c, i, pr, ui });
};

/** The qualitative band for a score, on the CVSS v3 scale. */
export const bandOfScore = (score: number): Band => {
  if (score >= 9) {
    return "critical";
  }
  if (score >= 7) {
    return "high";
  }
  if (score >= 4) {
    return "moderate";
  }
  return "low";
};

/** A database's own label (GHSA says LOW/MODERATE/HIGH/CRITICAL) as a band, or null when unrecognized. */
export const bandOfLabel = (label: unknown): Band | null => {
  if (typeof label !== "string") {
    return null;
  }
  const l = label.toLowerCase();
  if (l === "critical" || l === "high" || l === "low") {
    return l;
  }
  if (l === "moderate" || l === "medium") {
    return "moderate";
  }
  return null;
};
