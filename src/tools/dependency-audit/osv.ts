// OSV.dev: the batch query that names which records affect each Package, the
// per-record fetch, and the merge of records that alias each other into one
// Advisory. Network access goes through an injectable fetcher so the logic is
// testable without a browser.
import { bandOfLabel, bandOfScore, cvss3BaseScore, BAND_ORDER } from "./cvss";
import type { Band } from "./cvss";
import { compareLoose, normalizePyPiName } from "./lockfiles";
import type { Ecosystem, Package } from "./lockfiles";

export const OSV_API = "https://api.osv.dev/v1";
/** The most queries OSV accepts in one querybatch call. */
export const BATCH_LIMIT = 1000;
export const REQUEST_TIMEOUT_MS = 20_000;

/** Errors from the OSV helpers: a message fit to show as-is. */
export class AuditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditError";
  }
}

export interface JsonResponse {
  status: number;
  json: unknown;
}

/** GET or POST returning parsed JSON. Rejects with AuditError on transport failure; rethrows an abort. */
export type JsonFetch = (
  url: string,
  body: unknown | undefined,
  signal: AbortSignal
) => Promise<JsonResponse>;

/** `items[i]`, for an index the caller knows is in range. */
const itemAt = <T>(items: readonly T[], i: number): T => {
  const item = items[i];
  if (item === undefined) {
    throw new RangeError(`Index ${i} is outside a list of ${items.length}.`);
  }
  return item;
};

const timeoutSignal = (parent: AbortSignal, ms: number): AbortSignal => {
  const ctrl = new AbortController();
  const timer = setTimeout(
    () =>
      ctrl.abort(
        new DOMException(`Timed out after ${ms / 1000} s`, "TimeoutError")
      ),
    ms
  );
  parent.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);
      ctrl.abort(parent.reason);
    },
    { once: true }
  );
  ctrl.signal.addEventListener("abort", () => clearTimeout(timer), {
    once: true,
  });
  return ctrl.signal;
};

export const browserFetch: JsonFetch = async (url, body, signal) => {
  let res: Response;
  try {
    res = await fetch(url, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      method: body === undefined ? "GET" : "POST",
      signal: timeoutSignal(signal, REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new AuditError(error.message);
    }
    throw new AuditError(
      `Could not reach ${new URL(url).host}. ${(error as Error).message}`
    );
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    /* not JSON, status tells the story */
  }
  return { json, status: res.status };
};

/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
export const pool = async <T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> => {
  const results: R[] = Array.from({ length: items.length });
  // One iterator shared by every worker, so each item is taken exactly once.
  const queue = items.entries();
  const worker = async () => {
    for (const [i, item] of queue) {
      results[i] = await fn(item, i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
  return results;
};

/* ---------------- querybatch ---------------- */

export interface OsvQuery {
  package: { name: string; ecosystem: Ecosystem };
  version: string;
}

/** The name OSV knows a Package by: PyPI names normalized, npm names as they are. */
export const queryFor = (p: Package): OsvQuery => ({
  package: {
    ecosystem: p.ecosystem,
    name: p.ecosystem === "PyPI" ? normalizePyPiName(p.name) : p.name,
  },
  version: p.version,
});

export const queryKey = (q: OsvQuery): string =>
  `${q.package.ecosystem}:${q.package.name}@${q.version}`;

interface BatchResult {
  vulns?: { id: string; modified?: string }[];
  next_page_token?: string;
}

const explainStatus = (status: number, json: unknown): string => {
  const msg =
    json &&
    typeof json === "object" &&
    typeof (json as { message?: unknown }).message === "string"
      ? `: ${(json as { message: string }).message}`
      : "";
  return `OSV.dev answered HTTP ${status}${msg}`;
};

interface PendingQuery {
  index: number;
  pageToken?: string;
}

/** One querybatch call for `chunk`; the results line up with it. */
const fetchChunk = async (
  queries: OsvQuery[],
  chunk: PendingQuery[],
  fetcher: JsonFetch,
  signal: AbortSignal
): Promise<BatchResult[]> => {
  const body = {
    queries: chunk.map((p) => {
      const q = itemAt(queries, p.index);
      return p.pageToken ? { ...q, page_token: p.pageToken } : q;
    }),
  };
  const res = await fetcher(`${OSV_API}/querybatch`, body, signal);
  if (res.status !== 200) {
    throw new AuditError(explainStatus(res.status, res.json));
  }
  const results = (res.json as { results?: BatchResult[] } | null)?.results;
  if (!Array.isArray(results) || results.length !== chunk.length) {
    throw new AuditError("OSV.dev returned an unexpected batch response.");
  }
  return results;
};

/**
 * Asks OSV which records affect each query, in chunks of BATCH_LIMIT, following
 * per-query page tokens. Returns one id list per query, in query order.
 */
export const queryBatch = async (
  queries: OsvQuery[],
  fetcher: JsonFetch,
  signal: AbortSignal,
  onProgress?: (done: number, total: number) => void
): Promise<string[][]> => {
  const ids: string[][] = queries.map(() => []);
  let pending: PendingQuery[] = queries.map((_, index) => ({ index }));
  let done = 0;
  while (pending.length) {
    const chunk = pending.slice(0, BATCH_LIMIT);
    pending = pending.slice(BATCH_LIMIT);
    const results = await fetchChunk(queries, chunk, fetcher, signal);
    for (const [k, r] of results.entries()) {
      const { index } = itemAt(chunk, k);
      const list = itemAt(ids, index);
      for (const v of r.vulns ?? []) {
        if (v && typeof v.id === "string") {
          list.push(v.id);
        }
      }
      if (r.next_page_token) {
        pending.push({ index, pageToken: r.next_page_token });
      } else {
        done += 1;
      }
    }
    onProgress?.(done, queries.length);
  }
  return ids;
};

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

export const fetchRecord = async (
  id: string,
  fetcher: JsonFetch,
  signal: AbortSignal
): Promise<OsvRecord> => {
  const res = await fetcher(
    `${OSV_API}/vulns/${encodeURIComponent(id)}`,
    undefined,
    signal
  );
  if (res.status !== 200) {
    throw new AuditError(explainStatus(res.status, res.json));
  }
  const rec = res.json as OsvRecord | null;
  if (!rec || typeof rec.id !== "string") {
    throw new AuditError(`OSV.dev returned an unexpected record for ${id}.`);
  }
  return rec;
};

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

const idRank = (id: string): number => {
  const [prefix = ""] = id.split("-");
  const r = ID_RANK.indexOf(prefix.toUpperCase());
  return r === -1 ? ID_RANK.length : r;
};

const byIdRank = (a: string, b: string): number =>
  idRank(a) - idRank(b) || a.localeCompare(b);

/** Picks the id an Advisory is shown under: GHSA first (it carries the severity label), then by database rank. */
export const displayId = (ids: string[]): string => {
  const [first] = ids.toSorted(byIdRank);
  if (first === undefined) {
    throw new RangeError("An Advisory needs at least one id.");
  }
  return first;
};

export const severityOf = (records: OsvRecord[]): Severity => {
  // The database's own label wins, GHSA's in particular.
  for (const r of records.toSorted((a, b) => idRank(a.id) - idRank(b.id))) {
    const band = bandOfLabel(r.database_specific?.severity);
    if (band) {
      const v3 =
        r.severity?.find(
          (s) => s.type === "CVSS_V3" && typeof s.score === "string"
        )?.score ?? null;
      return {
        band,
        score: v3 ? cvss3BaseScore(v3) : null,
        source: "label",
        vector: v3,
      };
    }
  }
  let best: Severity | null = null;
  let bestScore = 0;
  for (const r of records) {
    for (const s of r.severity ?? []) {
      if (typeof s.score !== "string") {
        continue;
      }
      const score = cvss3BaseScore(s.score);
      if (score === null) {
        continue;
      }
      if (!best || score > bestScore) {
        bestScore = score;
        best = {
          band: bandOfScore(score),
          score,
          source: "cvss3",
          vector: s.score,
        };
      }
    }
  }
  if (best) {
    return best;
  }
  const v4 =
    records
      .flatMap((r) => r.severity ?? [])
      .find((s) => s.type === "CVSS_V4" && typeof s.score === "string")
      ?.score ?? null;
  return { band: "unknown", score: null, source: "none", vector: v4 };
};

/** Union-find over ids: `find` gives a group's representative, `union` joins two groups. */
const disjointSets = () => {
  const parent = new Map<string, string>();
  // Every id reached through `parent` was added by `find`, so the fallback never applies.
  const parentOf = (x: string): string => parent.get(x) ?? x;
  const find = (x: string): string => {
    if (!parent.has(x)) {
      parent.set(x, x);
    }
    let r = x;
    while (parentOf(r) !== r) {
      r = parentOf(r);
    }
    let node = x;
    while (parentOf(node) !== r) {
      const next = parentOf(node);
      parent.set(node, r);
      node = next;
    }
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) {
      parent.set(rb, ra);
    }
  };
  return { find, union };
};

/** The ids in each group of records that alias each other, in first-seen order. */
const aliasGroups = (records: Map<string, OsvRecord | null>): string[][] => {
  const { find, union } = disjointSets();
  for (const [id, rec] of records) {
    find(id);
    for (const alias of rec?.aliases ?? []) {
      union(id, alias);
    }
  }
  const groups = new Map<string, string[]>();
  for (const id of records.keys()) {
    const root = find(id);
    groups.set(root, [...(groups.get(root) ?? []), id]);
  }
  return [...groups.values()];
};

/** Aliases the records name that are not themselves among `ids`. */
const outsideAliases = (recs: OsvRecord[], ids: string[]): string[] => {
  const aliasSet = new Set<string>();
  for (const r of recs) {
    for (const a of r.aliases ?? []) {
      if (!ids.includes(a)) {
        aliasSet.add(a);
      }
    }
  }
  return [...aliasSet];
};

const referenceUrls = (recs: OsvRecord[]): string[] => {
  const refs = new Set<string>();
  for (const r of recs) {
    for (const ref of r.references ?? []) {
      if (ref.url) {
        refs.add(ref.url);
      }
    }
  }
  return [...refs];
};

const presentStrings = (values: (string | undefined)[]): string[] =>
  values.filter((p): p is string => typeof p === "string");

/** One Advisory from a group of aliasing ids and whichever of their records were fetched. */
const buildAdvisory = (
  ids: string[],
  records: Map<string, OsvRecord | null>
): Advisory => {
  const recs = ids
    .map((id) => records.get(id))
    .filter((r): r is OsvRecord => r !== null && r !== undefined);
  const [primary] = recs.toSorted((a, b) => idRank(a.id) - idRank(b.id));
  return {
    aliases: outsideAliases(recs, ids).toSorted(byIdRank),
    details: primary?.details ?? "",
    failed: ids.filter((id) => !records.get(id)),
    id: displayId(ids),
    ids: ids.toSorted(byIdRank),
    modified:
      presentStrings(recs.map((r) => r.modified))
        .toSorted()
        .at(-1) ?? null,
    published:
      presentStrings(recs.map((r) => r.published)).toSorted()[0] ?? null,
    records: recs,
    references: referenceUrls(recs),
    severity: severityOf(recs),
    summary:
      recs
        .map((r) => r.summary)
        .find((s): s is string => typeof s === "string" && s.length > 0) ??
      primary?.details?.split("\n")[0] ??
      "",
    withdrawn:
      recs.length > 0 && recs.every((r) => typeof r.withdrawn === "string"),
  };
};

/** Groups records that alias each other (directly or through a shared CVE) into Advisories. */
export const mergeAdvisories = (
  records: Map<string, OsvRecord | null>
): Map<string, Advisory> => {
  const out = new Map<string, Advisory>();
  for (const ids of aliasGroups(records)) {
    const advisory = buildAdvisory(ids, records);
    for (const id of ids) {
      out.set(id, advisory);
    }
  }
  return out;
};

export const compareSeverity = (a: Severity, b: Severity): number =>
  BAND_ORDER[b.band] - BAND_ORDER[a.band] || (b.score ?? 0) - (a.score ?? 0);

/* ---------------- fixes ---------------- */

export interface FixInfo {
  /** The smallest fixed version above the installed one, when any range says so. */
  fixed: string | null;
  /** The introduced bound of the range the installed version sits in. */
  introduced: string | null;
  /** True when the record lists the version as affected but no range fixes it. */
  unfixed: boolean;
}

const affectsPackage = (a: OsvAffected, p: Package): boolean => {
  if (a.package?.ecosystem !== p.ecosystem) {
    return false;
  }
  const name = a.package?.name ?? "";
  return p.ecosystem === "PyPI"
    ? normalizePyPiName(name) === normalizePyPiName(p.name)
    : name === p.name;
};

interface FixState {
  fixed: string | null;
  introduced: string | null;
}

/** Walks one range's events for `version`, narrowing the best fix found so far in `state`. */
const scanRange = (
  events: Record<string, string>[],
  version: string,
  state: FixState
): void => {
  let intro: string | null = null;
  let inRange = false;
  for (const ev of events) {
    if (typeof ev.introduced === "string") {
      intro = ev.introduced;
      inRange = intro === "0" || compareLoose(version, intro) >= 0;
    } else if (typeof ev.fixed === "string") {
      const fixedIn = ev.fixed;
      if (
        inRange &&
        compareLoose(version, fixedIn) < 0 &&
        (!state.fixed || compareLoose(fixedIn, state.fixed) < 0)
      ) {
        state.fixed = fixedIn;
        state.introduced = intro;
      }
      inRange = false;
    } else if (typeof ev.last_affected === "string") {
      if (inRange && compareLoose(version, ev.last_affected) <= 0) {
        state.introduced = intro;
      }
      inRange = false;
    }
  }
  if (inRange && !state.fixed) {
    state.introduced = intro;
  }
};

/** What the records say about fixing `p`: the version to move to, from the range the installed version falls in. */
export const fixFor = (advisory: Advisory, p: Package): FixInfo => {
  const state: FixState = { fixed: null, introduced: null };
  let anyRange = false;
  for (const rec of advisory.records) {
    for (const a of rec.affected ?? []) {
      if (!affectsPackage(a, p)) {
        continue;
      }
      for (const range of a.ranges ?? []) {
        if (range.type === "GIT") {
          continue;
        }
        anyRange = true;
        scanRange(range.events ?? [], p.version, state);
      }
    }
  }
  return {
    fixed: state.fixed,
    introduced: state.introduced,
    unfixed: anyRange && state.fixed === null,
  };
};
