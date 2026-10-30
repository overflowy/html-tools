// The transcription worker. The Needle runtime is synchronous WebAssembly and
// blocks whichever thread calls it, so it lives here, off the main thread,
// and the Tool talks to it by message. Built as its own bundle by build.ts.
//
// The main thread fetches the engine's bytes (through the cache) and posts
// them in; the worker never touches the network itself.

import { scriptDataUrl } from "../../shared/script-url";
import { ENGINE_RATE } from "./resample";
import { WINDOW_SECONDS, cutWindow } from "./transcript";
import type { Word } from "./transcript";

export type WorkerRequest =
  | { type: "load"; glue: string; wasm: ArrayBuffer; model: ArrayBuffer }
  /** A whole clip, transcribed one Window at a time. `language` "" detects it. */
  | {
      type: "transcribe";
      pcm: Float32Array;
      language: string;
      keywords: string;
    }
  /** The next piece of a Recording. */
  | { type: "feed"; pcm: Float32Array; language: string; keywords: string }
  /** The Recording has ended: commit what is still pending. */
  | { type: "finish" };

export type WorkerResponse =
  | { type: "loaded" }
  /** One Window's Words, times from the start of the clip; `done` is how far into it the next Window starts. */
  | { type: "window"; words: Word[]; language: string; done: number }
  | { type: "transcribed"; language: string; ms: number }
  /** Words a Recording committed this pass, and its unconfirmed tail. */
  | { type: "fed"; words: Word[]; pending: string; language: string }
  | { type: "finished"; words: Word[]; language: string }
  | { type: "error"; message: string };

/** The parts of the Emscripten module the worker uses. */
interface Needle {
  HEAPU8: Uint8Array;
  _malloc: (n: number) => number;
  _free: (p: number) => void;
  _needle_load: (p: number, n: bigint) => number;
  _needle_last_error: () => number;
  _needle_transcribe: (
    pcm: number,
    samples: number,
    language: number,
    keywords: number,
    wordTimestamps: number,
    out: number,
    cap: number
  ) => number;
  _needle_stream_transcribe_process: (
    pcm: number,
    samples: number,
    language: number,
    keywords: number,
    out: number,
    cap: number
  ) => number;
  _needle_stream_transcribe_stop: (out: number, cap: number) => number;
  UTF8ToString: (p: number) => string;
}

interface EngineJson {
  text?: string;
  language?: string;
  words?: Word[];
  pending?: string;
}

/** Room for the JSON the engine writes back: a 30 s Window is a few kilobytes. */
const OUT_CAPACITY = 2 ** 20;

let needle: Needle | null = null;
let out = 0;
// Never settles: requests wait here until the init message replaces it.
let ready = Promise.withResolvers<Needle>().promise;

// A dedicated worker has no targetOrigin to give.
const post = (msg: WorkerResponse) => self.postMessage(msg, { transfer: [] });

const lastError = (m: Needle) =>
  m.UTF8ToString(m._needle_last_error()) || "unknown error";

/** Copy bytes into the engine's memory. The caller frees the pointer. */
const put = (m: Needle, bytes: Uint8Array): number => {
  const p = m._malloc(bytes.length || 1);
  // Read the view after malloc: growing the memory replaces it.
  m.HEAPU8.set(bytes, p);
  return p;
};

/** A NUL-terminated UTF-8 string in the engine's memory, or 0 for none. */
const putString = (m: Needle, s: string): number => {
  if (!s) {
    return 0;
  }
  const bytes = new TextEncoder().encode(`${s}\0`);
  return put(m, bytes);
};

const putPcm = (m: Needle, pcm: Float32Array): number =>
  put(m, new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));

const readJson = (m: Needle, rc: number): EngineJson => {
  if (rc < 0) {
    throw new Error(`The engine failed: ${lastError(m)}`);
  }
  return JSON.parse(m.UTF8ToString(out)) as EngineJson;
};

const load = async (
  msg: Extract<WorkerRequest, { type: "load" }>
): Promise<Needle> => {
  // The glue is a classic script defining createNeedle; a line at its end makes it a module.
  const mod = (await import(
    scriptDataUrl(`${msg.glue}\nexport default createNeedle;`, "needle.js")
  )) as {
    default: (init: { wasmBinary: ArrayBuffer }) => Promise<Needle>;
  };
  const m = await mod.default({ wasmBinary: msg.wasm });
  const p = put(m, new Uint8Array(msg.model));
  // The engine reads the model in place, so its bytes stay where they are.
  const rc = m._needle_load(p, BigInt(msg.model.byteLength));
  if (rc < 0) {
    throw new Error(`The model did not load: ${lastError(m)}`);
  }
  out = m._malloc(OUT_CAPACITY);
  return m;
};

/** One pass over at most a Window of audio, starting `offset` samples in. */
const pass = (
  m: Needle,
  pcm: Float32Array,
  offset: number,
  samples: number,
  language: string,
  keywords: string
): EngineJson => {
  const p = putPcm(m, pcm.subarray(offset, offset + samples));
  const lang = putString(m, language);
  const keys = putString(m, keywords);
  try {
    return readJson(
      m,
      m._needle_transcribe(p, samples, lang, keys, 1, out, OUT_CAPACITY)
    );
  } finally {
    m._free(p);
    if (lang) {
      m._free(lang);
    }
    if (keys) {
      m._free(keys);
    }
  }
};

/**
 * A whole clip, one Window at a time, each posted as it is done so the Tool
 * can show progress and the Words so far. With the language left to
 * detection, the first Window that hears speech decides it for the rest, so
 * a clip is transcribed in one language throughout.
 */
const transcribe = (
  m: Needle,
  pcm: Float32Array,
  language: string,
  keywords: string
) => {
  const t0 = performance.now();
  const window = WINDOW_SECONDS * ENGINE_RATE;
  let offset = 0;
  let lang = language;
  let detected = language;
  while (offset < pcm.length) {
    const samples = Math.min(window, pcm.length - offset);
    const last = offset + samples >= pcm.length;
    const res = pass(m, pcm, offset, samples, lang, keywords);
    const at = offset / ENGINE_RATE;
    const { keep, advance } = cutWindow(
      res.words ?? [],
      samples / ENGINE_RATE,
      last
    );
    if (!lang && res.text && res.language) {
      lang = res.language;
    }
    if (res.language && res.text) {
      detected = res.language;
    }
    offset = last ? pcm.length : offset + Math.round(advance * ENGINE_RATE);
    post({
      done: offset / ENGINE_RATE,
      language: detected,
      type: "window",
      words: keep.map((w) => ({
        end: w.end + at,
        probability: w.probability,
        start: w.start + at,
        word: w.word,
      })),
    });
  }
  post({ language: detected, ms: performance.now() - t0, type: "transcribed" });
};

const feed = (
  m: Needle,
  pcm: Float32Array,
  language: string,
  keywords: string
) => {
  const p = putPcm(m, pcm);
  const lang = putString(m, language);
  const keys = putString(m, keywords);
  try {
    const res = readJson(
      m,
      m._needle_stream_transcribe_process(
        p,
        pcm.length,
        lang,
        keys,
        out,
        OUT_CAPACITY
      )
    );
    post({
      language: res.language ?? "",
      pending: res.pending ?? "",
      type: "fed",
      words: res.words ?? [],
    });
  } finally {
    m._free(p);
    if (lang) {
      m._free(lang);
    }
    if (keys) {
      m._free(keys);
    }
  }
};

const finish = (m: Needle) => {
  const res = readJson(m, m._needle_stream_transcribe_stop(out, OUT_CAPACITY));
  post({
    language: res.language ?? "",
    type: "finished",
    words: res.words ?? [],
  });
};

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  try {
    if (msg.type === "load") {
      if (needle) {
        return post({ type: "loaded" });
      }
      ready = load(msg);
      needle = await ready;
      post({ type: "loaded" });
      return;
    }
    // Every request after the load waits for it; they run in the order they came.
    const m = await ready;
    if (msg.type === "transcribe") {
      transcribe(m, msg.pcm, msg.language, msg.keywords);
    } else if (msg.type === "feed") {
      feed(m, msg.pcm, msg.language, msg.keywords);
    } else {
      finish(m);
    }
  } catch (error) {
    post({
      message: error instanceof Error ? error.message : String(error),
      type: "error",
    });
  }
};
