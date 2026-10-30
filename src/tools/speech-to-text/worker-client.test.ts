// Unit tests for the transcription worker's main-thread handle, over a fake
// Worker. Run: bun test
import { afterAll, beforeAll, expect, test } from "bun:test";

import { installFakeWorker, within } from "../../shared/fake-worker";
import type { WorkerResponse } from "./worker";
import { SpeechWorker } from "./worker-client";

let restore: (() => void) | null = null;

beforeAll(() => {
  Reflect.set(globalThis, "STT_WORKER_SRC", "");
  restore = installFakeWorker(
    (): WorkerResponse => ({ language: "en", type: "finished", words: [] }),
    1
  );
});

afterAll(() => {
  restore?.();
  Reflect.deleteProperty(globalThis, "STT_WORKER_SRC");
});

test("a request that cannot be sent leaves the next one its answer", async () => {
  const w = new SpeechWorker();
  await expect(w.finish()).rejects.toThrow("cloned");
  const r = await within(w.finish(), 1000);
  expect(r.language).toBe("en");
});
