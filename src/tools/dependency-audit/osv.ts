// OSV.dev: the batch query that names which records affect each Package, the
// per-record fetch, and the merge of records that alias each other into one
// Advisory. Network access goes through an injectable fetcher so the logic is
// testable without a browser.
import { bandOfLabel, bandOfScore, cvss3BaseScore, BAND_ORDER, type Band } from "./cvss";
import { compareLoose, normalizePyPiName, type Ecosystem, type Package } from "./lockfiles";

export const OSV_API = "https://api.osv.dev/v1";
/** The most queries OSV accepts in one querybatch call. */
export const BATCH_LIMIT = 1000;
export const REQUEST_TIMEOUT_MS = 20000;

/** Errors from the OSV helpers: a message fit to show as-is. */
export class AuditError extends Error {}

export interface JsonResponse {
  status: number;
  json: unknown;
}

/** GET or POST returning parsed JSON. Rejects with AuditError on transport failure; rethrows an abort. */
export type JsonFetch = (url: string, body: unknown | undefined, signal: AbortSignal) => Promise<JsonResponse>;

function timeoutSignal(parent: AbortSignal, ms: number): AbortSignal {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException("Timed out after " + ms / 1000 + " s", "TimeoutError")), ms);
  parent.addEventListener("abort", () => { clearTimeout(timer); ctrl.abort(parent.reason); }, { once: true });
  ctrl.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  return ctrl.signal;
}

export const browserFetch: JsonFetch = async (url, body, signal) => {
  let res: Response;
  try {
    res = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: timeoutSignal(signal, REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    if (signal.aborted) throw e;
    if (e instanceof DOMException && e.name === "TimeoutError") throw new AuditError(e.message);
    throw new AuditError("Could not reach " + new URL(url).host + ". " + (e as Error).message);
  }
  let json: unknown = null;
  try { json = await res.json(); } catch { /* not JSON, status tells the story */ }
  return { status: res.status, json };
};

/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/* ---------------- querybatch ---------------- */

export interface OsvQuery {
  package: { name: string; ecosystem: Ecosystem };
  version: string;
}

/** The name OSV knows a Package by: PyPI names normalized, npm names as they are. */
export function queryFor(p: Package): OsvQuery {
  return { package: { name: p.ecosystem === "PyPI" ? normalizePyPiName(p.name) : p.name, ecosystem: p.ecosystem }, version: p.version };
}

export function queryKey(q: OsvQuery): string {
  return q.package.ecosystem + ":" + q.package.name + "@" + q.version;
}

interface BatchResult {
  vulns?: { id: string; modified?: string }[];
  next_page_token?: string;
}

function explainStatus(status: number, json: unknown): string {
  const msg = json && typeof json === "object" && typeof (json as { message?: unknown }).message === "string" ? ": " + (json as { message: string }).message : "";
  return "OSV.dev answered HTTP " + status + msg;
}

/**
 * Asks OSV which records affect each query, in chunks of BATCH_LIMIT, following
 * per-query page tokens. Returns one id list per query, in query order.
 */
export async function queryBatch(queries: OsvQuery[], fetcher: JsonFetch, signal: AbortSignal, onProgress?: (done: number, total: number) => void): Promise<string[][]> {
  const ids: string[][] = queries.map(() => []);
  let pending: { index: number; pageToken?: string }[] = queries.map((_, index) => ({ index }));
  let done = 0;
  while (pending.length) {
    const chunk = pending.slice(0, BATCH_LIMIT);
    pending = pending.slice(BATCH_LIMIT);
    const body = {
      queries: chunk.map((p) => {
        const q = queries[p.index]!;
        return p.pageToken ? { ...q, page_token: p.pageToken } : q;
      }),
    };
    const res = await fetcher(OSV_API + "/querybatch", body, signal);
    if (res.status !== 200) throw new AuditError(explainStatus(res.status, res.json));
    const results = (res.json as { results?: BatchResult[] } | null)?.results;
    if (!Array.isArray(results) || results.length !== chunk.length) throw new AuditError("OSV.dev returned an unexpected batch response.");
    results.forEach((r, k) => {
      const index = chunk[k]!.index;
      for (const v of r.vulns ?? []) if (v && typeof v.id === "string") ids[index]!.push(v.id);
      if (r.next_page_token) pending.push({ index, pageToken: r.next_page_token });
      else done++;
    });
    onProgress?.(done, queries.length);
  }
  return ids;
}

/* ---------------- records ---------------- */

export interface OsvAffected {
  package?: { ecosystem?: string; name?: string };
  ranges?: { type?: string; events?: Record<string, string>[] }[];
  versions?: string[];
  database_specific?: Record<string, unknown>;
}

export interface OsvRecord {
  id: string;
  summary?: string;
  details?: string;
  aliases?: string[];
  related?: string[];
  modified?: string;
  published?: string;
  withdrawn?: string;
  affected?: OsvAffected[];
  severity?: { type?: string; score?: string }[];
  database_specific?: Record<string, unknown>;
  references?: { type?: string; url?: string }[];
}

export async function fetchRecord(id: string, fetcher: JsonFetch, signal: AbortSignal): Promise<OsvRecord> {
  const res = await fetcher(OSV_API + "/vulns/" + encodeURIComponent(id), undefined, signal);
  if (res.status !== 200) throw new AuditError(explainStatus(res.status, res.json));
  const rec = res.json as OsvRecord | null;
  if (!rec || typeof rec.id !== "string") throw new AuditError("OSV.dev returned an unexpected record for " + id + ".");
  return rec;
}

/* ---------------- advisories ---------------- */

export interface Severity {
  band: Band;
  /** Computed CVSS 3.x base score, when a vector allowed it. */
  score: number | null;
  /** The vector the band or score came from, or a CVSS 4 vector shown unscored. */
  vector: string | null;
  /** Where the band came from: the database's label, a computed score, or nowhere. */
  source: "label" | "cvss3" | "none";
}

/** One vulnerability as OSV knows it: every record that aliases into it, shown under one id. */
export interface Advisory {
  id: string;
  ids: string[];
  aliases: string[];
  summary: string;
  details: string;
  severity: Severity;
  withdrawn: boolean;
  published: string | null;
  modified: string | null;
  references: string[];
  records: OsvRecord[];
  /** Ids whose record could not be fetched; the Advisory is a stub for them. */
  failed: string[];
}

const ID_RANK = ["GHSA", "CVE", "PYSEC", "RUSTSEC", "GO", "OSV", "MAL"];

function idRank(id: string): number {
  const prefix = id.split("-")[0]!.toUpperCase();
  const r = ID_RANK.indexOf(prefix);
  return r < 0 ? ID_RANK.length : r;
}

/** Picks the id an Advisory is shown under: GHSA first (it carries the severity label), then by database rank. */
export function displayId(ids: string[]): string {
  return ids.toSorted((a, b) => idRank(a) - idRank(b) || a.localeCompare(b))[0]!;
}

export function severityOf(records: OsvRecord[]): Severity {
  // The database's own label wins, GHSA's in particular.
  for (const r of records.toSorted((a, b) => idRank(a.id) - idRank(b.id))) {
    const band = bandOfLabel(r.database_specific?.severity);
    if (band) {
      const v3 = r.severity?.find((s) => s.type === "CVSS_V3" && typeof s.score === "string")?.score ?? null;
      return { band, score: v3 ? cvss3BaseScore(v3) : null, vector: v3, source: "label" };
    }
  }
  let best: Severity | null = null;
  for (const r of records) {
    for (const s of r.severity ?? []) {
      if (typeof s.score !== "string") continue;
      const score = cvss3BaseScore(s.score);
      if (score === null) continue;
      if (!best || score > best.score!) best = { band: bandOfScore(score), score, vector: s.score, source: "cvss3" };
    }
  }
  if (best) return best;
  const v4 = records.flatMap((r) => r.severity ?? []).find((s) => s.type === "CVSS_V4" && typeof s.score === "string")?.score ?? null;
  return { band: "unknown", score: null, vector: v4, source: "none" };
}

/** Groups records that alias each other (directly or through a shared CVE) into Advisories. */
export function mergeAdvisories(records: Map<string, OsvRecord | null>): Map<string, Advisory> {
  // Union-find over every id and alias mentioned.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x);
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(x) !== r) { const next = parent.get(x)!; parent.set(x, r); x = next; }
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  for (const [id, rec] of records) {
    find(id);
    for (const alias of rec?.aliases ?? []) union(id, alias);
  }
  const groups = new Map<string, string[]>();
  for (const id of records.keys()) {
    const root = find(id);
    groups.set(root, [...(groups.get(root) ?? []), id]);
  }
  const out = new Map<string, Advisory>();
  for (const ids of groups.values()) {
    const recs = ids.map((id) => records.get(id)).filter((r): r is OsvRecord => r !== null && r !== undefined);
    const failed = ids.filter((id) => !records.get(id));
    const aliasSet = new Set<string>();
    for (const r of recs) for (const a of r.aliases ?? []) if (!ids.includes(a)) aliasSet.add(a);
    const primary = recs.toSorted((a, b) => idRank(a.id) - idRank(b.id))[0];
    const refs = new Set<string>();
    for (const r of recs) for (const ref of r.references ?? []) if (ref.url) refs.add(ref.url);
    const advisory: Advisory = {
      id: displayId(ids),
      ids: ids.toSorted((a, b) => idRank(a) - idRank(b) || a.localeCompare(b)),
      aliases: [...aliasSet].toSorted((a, b) => idRank(a) - idRank(b) || a.localeCompare(b)),
      summary: recs.map((r) => r.summary).find((s): s is string => typeof s === "string" && s.length > 0) ?? (primary?.details?.split("\n")[0] ?? ""),
      details: primary?.details ?? "",
      severity: severityOf(recs),
      withdrawn: recs.length > 0 && recs.every((r) => typeof r.withdrawn === "string"),
      published: recs.map((r) => r.published).filter((p): p is string => typeof p === "string").toSorted()[0] ?? null,
      modified: recs.map((r) => r.modified).filter((p): p is string => typeof p === "string").toSorted().at(-1) ?? null,
      references: [...refs],
      records: recs,
      failed,
    };
    for (const id of ids) out.set(id, advisory);
  }
  return out;
}

export function compareSeverity(a: Severity, b: Severity): number {
  return BAND_ORDER[b.band] - BAND_ORDER[a.band] || (b.score ?? 0) - (a.score ?? 0);
}

/* ---------------- fixes ---------------- */

export interface FixInfo {
  /** The smallest fixed version above the installed one, when any range says so. */
  fixed: string | null;
  /** The introduced bound of the range the installed version sits in. */
  introduced: string | null;
  /** True when the record lists the version as affected but no range fixes it. */
  unfixed: boolean;
}

function affectsPackage(a: OsvAffected, p: Package): boolean {
  if (a.package?.ecosystem !== p.ecosystem) return false;
  const name = a.package?.name ?? "";
  return p.ecosystem === "PyPI" ? normalizePyPiName(name) === normalizePyPiName(p.name) : name === p.name;
}

/** What the records say about fixing `p`: the version to move to, from the range the installed version falls in. */
export function fixFor(advisory: Advisory, p: Package): FixInfo {
  let fixed: string | null = null;
  let introduced: string | null = null;
  let anyRange = false;
  for (const rec of advisory.records) {
    for (const a of rec.affected ?? []) {
      if (!affectsPackage(a, p)) continue;
      for (const range of a.ranges ?? []) {
        if (range.type === "GIT") continue;
        anyRange = true;
        let intro: string | null = null;
        let inRange = false;
        for (const ev of range.events ?? []) {
          if (typeof ev.introduced === "string") {
            intro = ev.introduced;
            inRange = intro === "0" || compareLoose(p.version, intro) >= 0;
          } else if (typeof ev.fixed === "string") {
            if (inRange && compareLoose(p.version, ev.fixed) < 0) {
              if (!fixed || compareLoose(ev.fixed, fixed) < 0) { fixed = ev.fixed; introduced = intro; }
            }
            inRange = false;
          } else if (typeof ev.last_affected === "string") {
            if (inRange && compareLoose(p.version, ev.last_affected) <= 0) introduced = intro;
            inRange = false;
          }
        }
        if (inRange && !fixed) introduced = intro;
      }
    }
  }
  return { fixed, introduced, unfixed: anyRange && fixed === null };
}
