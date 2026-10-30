// A streaming resampler for the microphone: the AudioContext runs at the
// device's rate (Firefox refuses to connect a microphone to a context at any
// other), and the engine wants 16 kHz. Windowed-sinc interpolation with the
// cutoff below the output's Nyquist, so downsampling does not alias. Fed in
// chunks of any size, it gives the same samples as one call over the whole
// signal. Files take the browser's own resampler instead (decodeAudioData).

export const ENGINE_RATE = 16_000;

/** Kernel half-width in input samples at 1:1; widened by the downsampling ratio. */
const HALF_TAPS = 16;
/** Cutoff as a fraction of the output's Nyquist, leaving room for the transition band. */
const CUTOFF = 0.9;
/** Kernel table entries per input sample; between two entries the kernel is interpolated linearly. */
const PHASES = 256;

const sinc = (x: number) => {
  if (x === 0) {
    return 1;
  }
  const px = Math.PI * x;
  return Math.sin(px) / px;
};

export class Resampler {
  private readonly step: number;
  private readonly half: number;
  /** The Blackman-windowed sinc sampled every 1/PHASES input samples over [-half, half]. */
  private readonly kernel: Float32Array;
  /** Input not yet consumed, with the kernel's history in front of it. */
  private buf: Float32Array;
  /** Position of the next output sample, in input samples from buf[0]. */
  private pos: number;

  constructor(inRate: number, outRate = ENGINE_RATE) {
    this.step = inRate / outRate;
    const fc = Math.min(1, outRate / inRate) * CUTOFF;
    const half = Math.ceil(HALF_TAPS / fc);
    this.half = half;
    this.kernel = new Float32Array(2 * half * PHASES + 2);
    for (let j = 0; j < this.kernel.length; j += 1) {
      const d = j / PHASES - half;
      const t = Math.min(1, (d + half) / (2 * half));
      const w =
        0.42 -
        0.5 * Math.cos(2 * Math.PI * t) +
        0.08 * Math.cos(4 * Math.PI * t);
      this.kernel[j] = fc * sinc(fc * d) * w;
    }
    // Zeros before the first sample: the signal starts from silence.
    this.buf = new Float32Array(half);
    this.pos = half;
  }

  push(input: Float32Array): Float32Array {
    const joined = new Float32Array(this.buf.length + input.length);
    joined.set(this.buf);
    joined.set(input, this.buf.length);
    const out: number[] = [];
    const { half, kernel, step } = this;
    while (Math.floor(this.pos) + half < joined.length) {
      const base = Math.floor(this.pos);
      let sum = 0;
      let norm = 0;
      // pos never falls below half - 1, so i and j stay inside joined and kernel.
      for (let i = base - half + 1; i <= base + half; i += 1) {
        const x = (this.pos - i + half) * PHASES;
        const j = Math.floor(x);
        const f = x - j;
        const h = kernel[j] + (kernel[j + 1] - kernel[j]) * f;
        sum += joined[i] * h;
        norm += h;
      }
      // Normalized per sample, so a constant signal comes out at exactly its level.
      out.push(norm ? sum / norm : 0);
      this.pos += step;
    }
    const drop = Math.max(0, Math.floor(this.pos) - half + 1);
    this.buf = joined.slice(drop);
    this.pos -= drop;
    return Float32Array.from(out);
  }
}
