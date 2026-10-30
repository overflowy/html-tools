// qpdf as a function: files in, a command line, files and messages out. The
// Emscripten build is the qpdf command itself, with its own in-memory
// filesystem; every run writes its inputs there, runs, reads its outputs,
// and removes them again, so nothing outlives the run but what is cached on
// purpose (the Sources, under /src).

import { loadQpdf } from "./load";
import type { QpdfInstance, ScriptUrl } from "./load";
import { QpdfError } from "./qpdf-error";
import type { QpdfRun } from "./qpdf-error";

export { QpdfError, type QpdfRun } from "./qpdf-error";

/** qpdf's exit status for a run that succeeded with warnings: the output is written and usable. */
const WARNINGS = 3;

/** Whether a message is qpdf's way of saying the password was wrong or missing. */
export const isPasswordError = (run: QpdfRun): boolean =>
  run.err.some((l) => /invalid password/iu.test(l));

export class Qpdf {
  private readonly q: QpdfInstance;
  private readonly sink: { out: string[]; err: string[] };
  private readonly dirs = new Set<string>();

  private constructor(q: QpdfInstance, sink: { out: string[]; err: string[] }) {
    this.q = q;
    this.sink = sink;
  }

  static async create(
    glue: string,
    wasm: ArrayBuffer,
    toUrl: ScriptUrl
  ): Promise<Qpdf> {
    const sink = { err: [] as string[], out: [] as string[] };
    const q = await loadQpdf(glue, wasm, toUrl, {
      err: (line) => sink.err.push(line),
      out: (line) => sink.out.push(line),
    });
    return new Qpdf(q, sink);
  }

  private dir(path: string) {
    const parent = path.slice(0, path.lastIndexOf("/"));
    if (parent && !this.dirs.has(parent)) {
      if (!this.has(parent)) {
        this.q.FS.mkdir(parent);
      }
      this.dirs.add(parent);
    }
  }

  write(path: string, bytes: Uint8Array) {
    this.dir(path);
    this.q.FS.writeFile(path, bytes);
  }

  has(path: string): boolean {
    try {
      this.q.FS.stat(path);
      return true;
    } catch {
      return false;
    }
  }

  /** A copy of the file: the filesystem's own buffer is reused by the next write. */
  read(path: string): Uint8Array {
    return new Uint8Array(this.q.FS.readFile(path));
  }

  remove(path: string) {
    if (this.has(path)) {
      this.q.FS.unlink(path);
    }
  }

  /** Run one qpdf command line and collect what it printed. */
  exec(args: string[]): QpdfRun {
    this.sink.out.length = 0;
    this.sink.err.length = 0;
    let code: number;
    try {
      code = this.q.callMain(args);
    } catch (error) {
      // An exit() from deep inside surfaces as a thrown status object.
      const { status } = error as { status?: unknown };
      if (typeof status !== "number") {
        throw error;
      }
      code = status;
    }
    return { code, err: [...this.sink.err], out: [...this.sink.out] };
  }

  /**
   * Run a command that writes `output`, and return the file. `inputs` are
   * written first and removed after, along with the output; a run that
   * failed throws a QpdfError with qpdf's first complaint.
   */
  produce(
    what: string,
    inputs: Record<string, Uint8Array>,
    args: string[],
    output: string
  ): { bytes: Uint8Array; run: QpdfRun } {
    for (const [path, bytes] of Object.entries(inputs)) {
      this.write(path, bytes);
    }
    this.dir(output);
    try {
      const run = this.exec(args);
      if ((run.code !== 0 && run.code !== WARNINGS) || !this.has(output)) {
        throw new QpdfError(what, run);
      }
      return { bytes: this.read(output), run };
    } finally {
      for (const path of Object.keys(inputs)) {
        this.remove(path);
      }
      this.remove(output);
    }
  }
}
