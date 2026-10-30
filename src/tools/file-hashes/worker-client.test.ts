// Unit tests for the hashing worker's main-thread handle, over a fake
// Worker. Run: bun test
import { afterAll, beforeAll, expect, test } from "bun:test";

import { installFakeWorker, within } from "../../shared/fake-worker";
import type { WorkerResponse } from "./worker";
import { HashWorker } from "./worker-client";

let restore: (() => void) | null = null;

beforeAll(() => {
  Reflect.set(globalThis, "HASH_WORKER_SRC", "");
  restore = installFakeWorker(
    (): WorkerResponse => ({
      digests: { sha256: "ab" },
      ms: 1,
      type: "hashed",
    }),
    1
  );
});

afterAll(() => {
  restore?.();
  Reflect.deleteProperty(globalThis, "HASH_WORKER_SRC");
});

test("a request that cannot be sent leaves the next one its answer", async () => {
  const w = new HashWorker();
  await expect(w.hash("first", ["sha256"])).rejects.toThrow("cloned");
  const r = await within(w.hash("second", ["sha256"]), 1000);
  expect(r.digests).toEqual({ sha256: "ab" });
});
