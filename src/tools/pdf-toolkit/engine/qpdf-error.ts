// What a failed qpdf run throws: the first thing qpdf complained about, and
// everything it printed, for whoever wants to look closer.

export interface QpdfRun {
  /** Exit status: 0 success, 2 errors, 3 warnings. */
  code: number;
  out: string[];
  err: string[];
}

export class QpdfError extends Error {
  readonly run: QpdfRun;

  constructor(what: string, run: QpdfRun) {
    const first = run.err.find((l) => l.trim() !== "");
    super(first ? `${what}: ${first.replace(/^qpdf: /u, "")}` : what);
    this.name = "QpdfError";
    this.run = run;
  }
}
