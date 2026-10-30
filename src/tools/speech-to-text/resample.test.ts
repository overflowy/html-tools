// Unit tests for the microphone's resampler. Run: bun test
import { describe, expect, test } from "bun:test";

import { Resampler } from "./resample";

function sine(
  rate: number,
  hz: number,
  seconds: number,
  amp = 0.5
): Float32Array {
  return Float32Array.from(
    { length: Math.round(rate * seconds) },
    (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / rate)
  );
}

function rms(x: Float32Array) {
  let s = 0;
  for (const v of x) {
    s += v * v;
  }
  return Math.sqrt(s / x.length);
}

/** Amplitude of one frequency in a signal, by correlation. */
function tone(x: Float32Array, rate: number, hz: number) {
  let re = 0;
  let im = 0;
  for (let i = 0; i < x.length; i += 1) {
    re += x[i]! * Math.cos((2 * Math.PI * hz * i) / rate);
    im += x[i]! * Math.sin((2 * Math.PI * hz * i) / rate);
  }
  return (2 * Math.hypot(re, im)) / x.length;
}

describe("Resampler", () => {
  for (const rate of [48_000, 44_100, 16_000, 8000]) {
    test(`${rate} Hz to 16 kHz keeps the length ratio and a 440 Hz tone`, () => {
      const out = new Resampler(rate).push(sine(rate, 440, 1));
      // Less the kernel's lookahead, which waits for more input.
      expect(out.length).toBeGreaterThan(16_000 - 120);
      expect(out.length).toBeLessThanOrEqual(16_000);
      expect(tone(out.subarray(200, 15_000), 16_000, 440)).toBeCloseTo(0.5, 2);
    });
  }

  test("chunked input gives the same samples as one push", () => {
    const x = sine(44_100, 300, 0.5);
    const whole = new Resampler(44_100).push(x);
    const r = new Resampler(44_100);
    const parts: number[] = [];
    for (let i = 0; i < x.length; i += 128) {
      parts.push(...r.push(x.subarray(i, i + 128)));
    }
    expect(parts.length).toBe(whole.length);
    for (let i = 0; i < whole.length; i += 1) {
      expect(parts[i]).toBeCloseTo(whole[i]!, 5);
    }
  });

  test("a tone above the output's Nyquist is filtered out, not folded down", () => {
    // 11 kHz at 48 kHz would alias to 5 kHz at 16 kHz without the low-pass.
    const out = new Resampler(48_000).push(sine(48_000, 11_000, 1));
    expect(rms(out.subarray(200, 15_000))).toBeLessThan(0.005);
  });

  test("a constant comes out at its level", () => {
    const out = new Resampler(48_000).push(new Float32Array(48_000).fill(0.25));
    for (const v of out.subarray(200, 15_000)) {
      expect(v).toBeCloseTo(0.25, 4);
    }
  });
});
