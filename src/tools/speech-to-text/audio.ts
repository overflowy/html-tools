// Getting audio into the shape the engine wants: 16 kHz mono float PCM.
// A file is decoded by the browser, which also resamples it; the microphone
// is captured by an AudioWorklet at the device's rate and resampled here.

import { ENGINE_RATE, Resampler } from "./resample";

/**
 * Decode an audio or video file to 16 kHz mono. An OfflineAudioContext at
 * 16 kHz resamples as it decodes; the channels are averaged into one.
 */
export async function decodeFile(bytes: ArrayBuffer): Promise<Float32Array> {
  let buffer: AudioBuffer;
  try {
    buffer = await new OfflineAudioContext(1, 1, ENGINE_RATE).decodeAudioData(
      bytes
    );
  } catch (error) {
    throw new Error(
      "The browser could not decode this file's audio. Try a common format: WAV, MP3, M4A, OGG, FLAC, WebM, or MP4.",
      { cause: error }
    );
  }
  if (buffer.numberOfChannels === 1) {
    return buffer.getChannelData(0);
  }
  const mono = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c += 1) {
    const ch = buffer.getChannelData(c);
    for (let i = 0; i < ch.length; i += 1) {
      mono[i]! += ch[i]! / buffer.numberOfChannels;
    }
  }
  return mono;
}

/** 16 kHz mono PCM as a 16-bit WAV file, for playing a Recording back. */
export function encodeWav(pcm: Float32Array): Blob {
  const data = pcm.length * 2;
  const view = new DataView(new ArrayBuffer(44 + data));
  const text = (at: number, s: string) => {
    for (let i = 0; i < s.length; i += 1) {
      view.setUint8(at + i, s.charCodeAt(i));
    }
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + data, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, ENGINE_RATE, true);
  view.setUint32(28, ENGINE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, data, true);
  for (let i = 0; i < pcm.length; i += 1) {
    const s = Math.max(-1, Math.min(1, pcm[i]!));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x80_00 : s * 0x7f_ff, true);
  }
  return new Blob([view.buffer], { type: "audio/wav" });
}

// The worklet gathers the 128-frame render quanta into blocks of about 85 ms
// before posting, so the main thread is not woken 375 times a second. It has
// no outputs, which keeps it running without being wired to the speakers.
const CAPTURE_WORKLET = `
registerProcessor("capture", class extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(4096);
    this.filled = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    this.block.set(ch, this.filled);
    this.filled += ch.length;
    if (this.filled + 128 > this.block.length) {
      const out = this.block.slice(0, this.filled);
      this.port.postMessage(out, [out.buffer]);
      this.filled = 0;
    }
    return true;
  }
});`;

export class Microphone {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;

  /**
   * Ask for the microphone and start delivering 16 kHz mono blocks, with the
   * block's peak level (0 to 1) for a meter. Rejects with a readable message
   * when the browser or the visitor says no.
   */
  async start(
    onAudio: (pcm: Float32Array, peak: number) => void
  ): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser offers no microphone access here.");
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1 },
      });
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        throw new Error(
          "Microphone access was refused. Allow it for this page in the browser's site settings, then try again.",
          { cause: error }
        );
      }
      if (name === "NotFoundError") {
        throw new Error("No microphone was found.", { cause: error });
      }
      throw new Error(
        `The microphone could not be opened: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error }
      );
    }
    // The device's own rate: Firefox will not connect a microphone to a context running at another.
    const ctx = new AudioContext();
    this.ctx = ctx;
    // A data: URL, because Chromium will not load a worklet from a blob: URL on a file:// page.
    await ctx.audioWorklet.addModule(
      `data:text/javascript;charset=utf-8,${encodeURIComponent(
        CAPTURE_WORKLET
      )}`
    );
    const resampler = new Resampler(ctx.sampleRate);
    const node = new AudioWorkletNode(ctx, "capture", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: "explicit",
    });
    node.port.onmessage = (ev: MessageEvent<Float32Array>) => {
      let peak = 0;
      for (const v of ev.data) {
        peak = Math.max(peak, Math.abs(v));
      }
      onAudio(resampler.push(ev.data), peak);
    };
    ctx.createMediaStreamSource(this.stream).connect(node);
    this.node = node;
    await ctx.resume();
  }

  /** Release the microphone, so the browser's recording indicator goes away. */
  stop() {
    this.node?.port.close();
    this.node?.disconnect();
    for (const t of this.stream?.getTracks() ?? []) {
      t.stop();
    }
    void this.ctx?.close();
    this.node = null;
    this.stream = null;
    this.ctx = null;
  }
}
