import { afterEach, beforeEach, expect, test } from "bun:test";

import { Interpreter } from "./interpreter";
import type { InterpreterEvents } from "./interpreter";

const RealWorker = globalThis.Worker;

class FakeWorker {
  static last: FakeWorker;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  posted: unknown[] = [];
  terminated = false;

  constructor() {
    FakeWorker.last = this;
  }

  postMessage(message: unknown) {
    this.posted.push(message);
  }

  terminate() {
    this.terminated = true;
  }
}

beforeEach(() => {
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  (
    globalThis as typeof globalThis & { PYIDE_PY_WORKER_SRC: string }
  ).PYIDE_PY_WORKER_SRC = "";
});

afterEach(() => {
  globalThis.Worker = RealWorker;
});

const events = (onCrash: (message: string) => void): InterpreterEvents => ({
  onCrash,
  onFigure() {},
  onInputRequest() {},
  onInputUnavailable() {},
  onOutput() {},
  onProgress() {},
});

test("an error from an intentionally terminated worker stays quiet", () => {
  let crash = "";
  let prevented = false;
  const interpreter = new Interpreter(events((message) => (crash = message)));
  interpreter.terminate();

  FakeWorker.last.onerror?.({
    message: "",
    preventDefault: () => (prevented = true),
  } as unknown as ErrorEvent);

  expect(prevented).toBe(true);
  expect(crash).toBe("");
});

test("an error from a live worker is reported without reaching the console", () => {
  let crash = "";
  let prevented = false;
  const interpreter = new Interpreter(events((message) => (crash = message)));

  FakeWorker.last.onerror?.({
    message: "boom",
    preventDefault: () => (prevented = true),
  } as unknown as ErrorEvent);

  expect(prevented).toBe(true);
  expect(crash).toBe("The interpreter crashed: boom");
  expect(interpreter.alive).toBe(true);
});
