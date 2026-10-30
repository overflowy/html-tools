// One Audit: parse the Lockfiles, ask OSV about every distinct Package once,
// fetch each record once, merge aliases, and attach Advisories to Packages.
import { LockfileError } from "./lockfiles";
import type { Package, ParsedLockfile } from "./lockfiles";
import {
  AuditError,
  compareSeverity,
  fetchRecord,
  fixFor,
  mergeAdvisories,
  pool,
  queryBatch,
  queryFor,
  queryKey,
} from "./osv";
import type { Advisory, FixInfo, JsonFetch, OsvRecord } from "./osv";
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

type ReadableReport = LockfileReport & { parsed: ParsedLockfile };

const readFile = (f: InputFile): LockfileReport => {
  try {
    return {
      error: null,
      name: f.name || "pasted",
      packages: [],
      parsed: parseLockfile(f.text, f.name),
    };
  } catch (error) {
    return {
      error: error instanceof LockfileError ? error.message : String(error),
      name: f.name || "pasted",
      packages: [],
      parsed: null,
    };
  }
};

const advisoryProgress = (fetched: number, total: number): string =>
  `Fetching ${total} advisor${total === 1 ? "y" : "ies"}… ${fetched}/${total}`;

export const runAudit = async (
  files: InputFile[],
  fetcher: JsonFetch,
  signal: AbortSignal,
  progress: Progress
): Promise<AuditResult> => {
  const started = performance.now();
  const reports = files.map(readFile);
  const readable = reports.filter(
    (r): r is ReadableReport => r.parsed !== null
  );
  if (!readable.length) {
    const onlyError = reports.length === 1 ? reports[0]?.error : null;
    throw new AuditError(
      onlyError ??
        `None of the ${reports.length} files could be read: ${reports
          .map((r) => `${r.name} (${r.error})`)
          .join("; ")}`
    );
  }

  // Distinct queries across every Lockfile.
  const queries = new Map<string, ReturnType<typeof queryFor>>();
  for (const r of readable) {
    for (const p of r.parsed.packages) {
      const q = queryFor(p);
      queries.set(queryKey(q), q);
    }
  }
  const queryList = [...queries.values()];
  if (!queryList.length) {
    return {
      advisories: [],
      failedRecords: [],
      lockfiles: reports,
      ms: Math.round(performance.now() - started),
      queried: 0,
    };
  }
  progress(
    `Asking OSV.dev about ${queryList.length} package${
      queryList.length === 1 ? "" : "s"
    }…`
  );
  const idLists = await queryBatch(
    queryList,
    fetcher,
    signal,
    (done, total) => {
      if (total > 1000) {
        progress(`Asking OSV.dev about ${total} packages… ${done}/${total}`);
      }
    }
  );
  const idsByQuery = new Map<string, string[]>();
  const allIds = new Set<string>();
  for (const [i, q] of queryList.entries()) {
    const list = idLists[i];
    if (!list) {
      throw new AuditError("OSV.dev returned fewer results than queries.");
    }
    idsByQuery.set(queryKey(q), list);
    for (const id of list) {
      allIds.add(id);
    }
  }

  // Every record once, failures kept as stubs rather than failing the Audit.
  const ids = [...allIds];
  const records = new Map<string, OsvRecord | null>();
  const failedRecords: string[] = [];
  let fetched = 0;
  if (ids.length) {
    progress(advisoryProgress(0, ids.length));
  }
  await pool(ids, CONCURRENCY, async (id) => {
    try {
      records.set(id, await fetchRecord(id, fetcher, signal));
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      records.set(id, null);
      failedRecords.push(id);
    }
    fetched += 1;
    progress(advisoryProgress(fetched, ids.length));
  });
  const byId = mergeAdvisories(records);

  const seen = new Map<string, Advisory>();
  for (const r of readable) {
    r.packages = r.parsed.packages.map((pkg) => {
      const hits = new Map<string, Hit>();
      for (const id of idsByQuery.get(queryKey(queryFor(pkg))) ?? []) {
        const advisory = byId.get(id);
        if (!advisory || advisory.withdrawn || hits.has(advisory.id)) {
          continue;
        }
        hits.set(advisory.id, { advisory, fix: fixFor(advisory, pkg) });
        seen.set(advisory.id, advisory);
      }
      return {
        hits: [...hits.values()].toSorted(
          (a, b) =>
            compareSeverity(a.advisory.severity, b.advisory.severity) ||
            a.advisory.id.localeCompare(b.advisory.id)
        ),
        pkg,
      };
    });
  }
  return {
    advisories: [...seen.values()].toSorted(
      (a, b) =>
        compareSeverity(a.severity, b.severity) || a.id.localeCompare(b.id)
    ),
    failedRecords,
    lockfiles: reports,
    ms: Math.round(performance.now() - started),
    queried: queryList.length,
  };
};
