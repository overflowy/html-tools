// Unit tests for the 7-Zip worker's main-thread handle, over a fake Worker.
// Run: bun test
import { afterAll, beforeAll, expect, test } from "bun:test";

import { installFakeWorker, within } from "../../shared/fake-worker";
import type { WorkerResponse } from "./worker";
import { ArchiveWorker } from "./worker-client";

let restore: (() => void) | null = null;

beforeAll(() => {
  Reflect.set(globalThis, "ARCHIVE_WORKER_SRC", "");
  restore = installFakeWorker(
    (): WorkerResponse => ({
      code: 0,
      outputs: [],
      stderr: [],
      stdout: ["ok"],
      type: "ran",
    }),
    1
  );
});

afterAll(() => {
  restore?.();
  Reflect.deleteProperty(globalThis, "ARCHIVE_WORKER_SRC");
});

test("a request that cannot be sent leaves the next one its answer", async () => {
  const w = new ArchiveWorker();
  const req = { args: ["l"], collect: false, cwd: "/", inputs: [] };
  await expect(w.run(req)).rejects.toThrow("cloned");
  const r = await within(w.run(req), 1000);
  expect(r.stdout).toEqual(["ok"]);
});
