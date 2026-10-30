import { expect, test } from "bun:test";

import { changes, diffLines } from "./diff";
import type { DiffOp } from "./diff";

/** The diff applied to `a`: must give back `b`. */
const replay = (a: string[], b: string[], ops: DiffOp[]): string[] =>
  ops.flatMap((op) => {
    if (op.kind === "same") {
      return [a[op.a] ?? ""];
    }
    return op.kind === "added" ? [b[op.b] ?? ""] : [];
  });

test("a line diff is minimal and replays to the second text", () => {
  const a = ["one", "two", "three", "four", "five"];
  const b = ["one", "three", "four", "4½", "five", "six"];
  const ops = diffLines(a, b);
  expect(replay(a, b, ops)).toEqual(b);
  expect(changes(ops)).toEqual({ added: 2, removed: 1 });
  expect(
    ops
      .filter((o) => o.kind === "removed")
      .map((o) => (o.kind === "removed" ? a[o.a] : ""))
  ).toEqual(["two"]);
});

test("identical and empty inputs", () => {
  expect(changes(diffLines(["a", "b"], ["a", "b"]))).toEqual({
    added: 0,
    removed: 0,
  });
  expect(diffLines([], ["x"])).toEqual([{ b: 0, kind: "added" }]);
  expect(diffLines(["x"], [])).toEqual([{ a: 0, kind: "removed" }]);
  expect(diffLines([], [])).toEqual([]);
});

test("random edits always replay", () => {
  let seed = 3;
  const rand = (n: number) => {
    seed = (seed * 48_271) % 2_147_483_647;
    return seed % n;
  };
  for (let round = 0; round < 50; round += 1) {
    const a = Array.from({ length: rand(30) }, () => `l${rand(6)}`);
    const b = Array.from({ length: rand(30) }, () => `l${rand(6)}`);
    expect(replay(a, b, diffLines(a, b))).toEqual(b);
  }
});
