// CVSS v3.0 and v3.1 base scores from a vector string, per the specification's
// formula. v4 vectors are recognized but not scored; the caller shows them as-is.

export type Band = "critical" | "high" | "moderate" | "low" | "unknown";

export const BAND_ORDER: Record<Band, number> = { critical: 4, high: 3, moderate: 2, low: 1, unknown: 0 };

const AV: Record<string, number> = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 };
const AC: Record<string, number> = { L: 0.77, H: 0.44 };
const PR_U: Record<string, number> = { N: 0.85, L: 0.62, H: 0.27 };
const PR_C: Record<string, number> = { N: 0.85, L: 0.68, H: 0.5 };
const UI: Record<string, number> = { N: 0.85, R: 0.62 };
const CIA: Record<string, number> = { H: 0.56, L: 0.22, N: 0 };

/** CVSS v3.1 "Roundup": to one decimal, upward, with the float-safety the spec prescribes. */
function roundUp(x: number): number {
  const i = Math.round(x * 100000);
  return i % 10000 === 0 ? i / 100000 : (Math.floor(i / 10000) + 1) / 10;
}

/** The base score for a CVSS:3.0 or CVSS:3.1 vector, or null when the vector is not one this scores. */
export function cvss3BaseScore(vector: string): number | null {
  const m = /^CVSS:3\.[01]\/(.+)$/.exec(vector.trim());
  if (!m) return null;
  const metrics: Record<string, string> = {};
  for (const part of m[1]!.split("/")) {
    const [k, v] = part.split(":");
    if (k && v) metrics[k] = v;
  }
  const scope = metrics.S;
  const av = AV[metrics.AV ?? ""], ac = AC[metrics.AC ?? ""], ui = UI[metrics.UI ?? ""];
  const pr = (scope === "C" ? PR_C : PR_U)[metrics.PR ?? ""];
  const c = CIA[metrics.C ?? ""], i = CIA[metrics.I ?? ""], a = CIA[metrics.A ?? ""];
  if ([av, ac, pr, ui, c, i, a].some((x) => x === undefined) || (scope !== "U" && scope !== "C")) return null;
  const iss = 1 - (1 - c!) * (1 - i!) * (1 - a!);
  const impact = scope === "U" ? 6.42 * iss : 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15);
  const exploitability = 8.22 * av! * ac! * pr! * ui!;
  if (impact <= 0) return 0;
  return scope === "U" ? roundUp(Math.min(impact + exploitability, 10)) : roundUp(Math.min(1.08 * (impact + exploitability), 10));
}

/** The qualitative band for a score, on the CVSS v3 scale. */
export function bandOfScore(score: number): Band {
  if (score >= 9) return "critical";
  if (score >= 7) return "high";
  if (score >= 4) return "moderate";
  return "low";
}

/** A database's own label (GHSA says LOW/MODERATE/HIGH/CRITICAL) as a band, or null when unrecognized. */
export function bandOfLabel(label: unknown): Band | null {
  if (typeof label !== "string") return null;
  const l = label.toLowerCase();
  if (l === "critical" || l === "high" || l === "low") return l;
  if (l === "moderate" || l === "medium") return "moderate";
  return null;
}
