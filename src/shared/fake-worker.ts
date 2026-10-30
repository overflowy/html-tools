// A Worker that runs nothing, for unit tests of the code that talks to one.
// It refuses the first messages sent to it, as postMessage does with one
// that cannot be cloned, and answers each of the rest with what `answer`
// makes of it.

export const installFakeWorker = (
  answer: (msg: unknown) => unknown,
  refusals: number
): (() => void) => {
  const real = globalThis.Worker;
  let refused = 0;
  class FakeWorker {
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onerror: ((ev: { message: string }) => void) | null = null;

    postMessage(msg: unknown) {
      if (refused < refusals) {
        refused += 1;
        throw new DOMException(
          "The message could not be cloned.",
          "DataCloneError"
        );
      }
      setTimeout(() => this.onmessage?.({ data: answer(msg) }), 0);
    }

    terminate() {
      this.onmessage = null;
    }
  }
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  return () => {
    globalThis.Worker = real;
  };
};

/** `p`, or a rejection once `ms` pass without it settling. */
export const within = async <T>(p: Promise<T>, ms: number): Promise<T> => {
  const late = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => late.reject(new Error(`Not settled within ${ms} ms`)),
    ms
  );
  try {
    return await Promise.race([p, late.promise]);
  } finally {
    clearTimeout(timer);
  }
};
