// One Audit: parse the Lockfiles, ask OSV about every distinct Package once,
// fetch each record once, merge aliases, and attach Advisories to Packages.
import { LockfileError, type Package, type ParsedLockfile } from "./lockfiles";
import {
  AuditError, compareSeverity, fetchRecord, fixFor, mergeAdvisories, pool, queryBatch, queryFor, queryKey,
  type Advisory, type FixInfo, type JsonFetch, type OsvRecord,
} from "./osv";
import { parseLockfile } from "./parse";

/** Record fetches in flight at once. */
export const CONCURRENCY = 6;

export interface InputFile {
  /** File name, or "" for pasted text. */
  name: string;
  text: string;
}

export interface Hit {
  advisory: Advisory;
  fix: FixInfo;
}

export interface AuditedPackage {
  pkg: Package;
  /** Advisories affecting this exact version, worst first; withdrawn ones dropped. */
  hits: Hit[];
}

export interface LockfileReport {
  /** What the user called it: file name, "pasted", or repo shorthand plus file name. */
  name: string;
  parsed: ParsedLockfile | null;
  error: string | null;
  packages: AuditedPackage[];
}

export interface AuditResult {
  lockfiles: LockfileReport[];
  /** Every distinct Advisory reported, worst first. */
  advisories: Advisory[];
  /** Distinct name-and-version pairs asked about. */
  queried: number;
  /** Record ids OSV listed but whose details could not be fetched. */
  failedRecords: string[];
  ms: number;
}

export type Progress = (message: string) => void;

export async function runAudit(files: InputFile[], fetcher: JsonFetch, signal: AbortSignal, progress: Progress): Promise<AuditResult> {
  const started = performance.now();
  const reports: LockfileReport[] = files.map((f) => {
    try {
      return { name: f.name || "pasted", parsed: parseLockfile(f.text, f.name), error: null, packages: [] };
    } catch (e) {
      return { name: f.name || "pasted", parsed: null, error: e instanceof LockfileError ? e.message : String(e), packages: [] };
    }
  });
  const readable = reports.filter((r) => r.parsed);
  if (!readable.length) {
    throw new AuditError(reports.length === 1 ? reports[0]!.error! : "None of the " + reports.length + " files could be read: " + reports.map((r) => r.name + " (" + r.error + ")").join("; "));
  }

  // Distinct queries across every Lockfile.
  const queries = new Map<string, ReturnType<typeof queryFor>>();
  for (const r of readable) for (const p of r.parsed!.packages) {
    const q = queryFor(p);
    queries.set(queryKey(q), q);
  }
  const queryList = [...queries.values()];
  if (!queryList.length) {
    return { lockfiles: reports, advisories: [], queried: 0, failedRecords: [], ms: Math.round(performance.now() - started) };
  }
  progress("Asking OSV.dev about " + queryList.length + " package" + (queryList.length === 1 ? "" : "s") + "…");
  const idLists = await queryBatch(queryList, fetcher, signal, (done, total) => {
    if (total > 1000) progress("Asking OSV.dev about " + total + " packages… " + done + "/" + total);
  });
  const idsByQuery = new Map<string, string[]>();
  const allIds = new Set<string>();
  queryList.forEach((q, i) => {
    idsByQuery.set(queryKey(q), idLists[i]!);
    for (const id of idLists[i]!) allIds.add(id);
  });

  // Every record once, failures kept as stubs rather than failing the Audit.
  const ids = [...allIds];
  const records = new Map<string, OsvRecord | null>();
  const failedRecords: string[] = [];
  let fetched = 0;
  if (ids.length) progress("Fetching " + ids.length + " advisor" + (ids.length === 1 ? "y" : "ies") + "… 0/" + ids.length);
  await pool(ids, CONCURRENCY, async (id) => {
    try {
      records.set(id, await fetchRecord(id, fetcher, signal));
    } catch (e) {
      if (signal.aborted) throw e;
      records.set(id, null);
      failedRecords.push(id);
    }
    fetched++;
    progress("Fetching " + ids.length + " advisor" + (ids.length === 1 ? "y" : "ies") + "… " + fetched + "/" + ids.length);
  });
  const byId = mergeAdvisories(records);

  const seen = new Map<string, Advisory>();
  for (const r of readable) {
    r.packages = r.parsed!.packages.map((pkg) => {
      const hits = new Map<string, Hit>();
      for (const id of idsByQuery.get(queryKey(queryFor(pkg))) ?? []) {
        const advisory = byId.get(id);
        if (!advisory || advisory.withdrawn || hits.has(advisory.id)) continue;
        hits.set(advisory.id, { advisory, fix: fixFor(advisory, pkg) });
        seen.set(advisory.id, advisory);
      }
      return { pkg, hits: [...hits.values()].toSorted((a, b) => compareSeverity(a.advisory.severity, b.advisory.severity) || a.advisory.id.localeCompare(b.advisory.id)) };
    });
  }
  return {
    lockfiles: reports,
    advisories: [...seen.values()].toSorted((a, b) => compareSeverity(a.severity, b.severity) || a.id.localeCompare(b.id)),
    queried: queryList.length,
    failedRecords,
    ms: Math.round(performance.now() - started),
  };
}
