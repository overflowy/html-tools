// A line diff for Compare: the shortest edit script between two lists of
// lines (Myers' algorithm, O((N+M)·D)), as runs of kept, removed, and added
// lines. Two documents with little in common would make D huge; past a
// budget of edits the diff gives up and says everything changed, which is
// the honest answer by then anyway.

export type DiffOp =
  | { kind: "same"; a: number; b: number }
  | { kind: "removed"; a: number }
  | { kind: "added"; b: number };

/**
 * Most edits looked for before calling the documents simply different. The
 * walk back keeps one snapshot per edit, each twice this many numbers, so
 * the budget bounds memory too: 2000 edits is 32 MB at worst.
 */
const MAX_EDITS = 2000;

/** Whether the path to diagonal `k` comes down (an insertion) rather than across (a deletion). */
const goesDown = (
  v: Int32Array,
  k: number,
  d: number,
  offset: number
): boolean =>
  k === -d || (k !== d && (v[k - 1 + offset] ?? 0) < (v[k + 1 + offset] ?? 0));

/**
 * The forward pass: for each number of edits, how far each diagonal gets.
 * Returns a snapshot per edit count (to walk back through) and the count
 * that reached the end, or -1 when the budget ran out first.
 */
const forward = (a: string[], b: string[], max: number, offset: number) => {
  const n = a.length;
  const m = b.length;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d += 1) {
    // Copies, not views: each snapshot must stay as it was.
    trace.push(Int32Array.from(v));
    const next = Int32Array.from(v);
    for (let k = -d; k <= d; k += 2) {
      let x = goesDown(v, k, d, offset)
        ? (v[k + 1 + offset] ?? 0)
        : (v[k - 1 + offset] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      next[k + offset] = x;
      if (x >= n && y >= m) {
        return { found: d, trace };
      }
    }
    v = next;
  }
  return { found: -1, trace };
};

/** Walk the snapshots back from the end, collecting the edits in reverse. */
const backtrack = (
  n: number,
  m: number,
  found: number,
  trace: Int32Array[],
  offset: number
): DiffOp[] => {
  const ops: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = found; d >= 0; d -= 1) {
    const snap = trace[d] ?? new Int32Array();
    const k = x - y;
    const down = goesDown(snap, k, d, offset);
    const prevK = down ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : (snap[prevK + offset] ?? 0);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
      ops.push({ a: x, b: y, kind: "same" });
    }
    if (d > 0 && down) {
      y -= 1;
      ops.push({ b: y, kind: "added" });
    } else if (d > 0) {
      x -= 1;
      ops.push({ a: x, kind: "removed" });
    }
  }
  return ops.toReversed();
};

/** The edit script from `a` to `b`, in order, by line index. */
export const diffLines = (a: string[], b: string[]): DiffOp[] => {
  const max = Math.min(a.length + b.length, MAX_EDITS);
  const offset = max + 1;
  const { found, trace } = forward(a, b, max, offset);
  if (found < 0) {
    return [
      ...a.map((_, i) => ({ a: i, kind: "removed" as const })),
      ...b.map((_, i) => ({ b: i, kind: "added" as const })),
    ];
  }
  return backtrack(a.length, b.length, found, trace, offset);
};

/** How many lines differ, either way. */
export const changes = (ops: DiffOp[]): { removed: number; added: number } => {
  let removed = 0;
  let added = 0;
  for (const op of ops) {
    if (op.kind === "removed") {
      removed += 1;
    } else if (op.kind === "added") {
      added += 1;
    }
  }
  return { added, removed };
};
