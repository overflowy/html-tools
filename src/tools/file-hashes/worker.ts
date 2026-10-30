// The hashing worker. A file is read once, a slice at a time, and every
// slice goes to every Algorithm asked for, so a gigabyte is read once
// whether one Digest is wanted or ten, and the page stays responsive.
// Built as its own bundle by build.ts; hash-wasm's WebAssembly is inlined
// in it, so nothing is fetched.

import {
  createAdler32,
  createBLAKE2b,
  createBLAKE2s,
  createBLAKE3,
  createCRC32,
  createCRC64,
  createKeccak,
  createMD5,
  createRIPEMD160,
  createSHA1,
  createSHA224,
  createSHA256,
  createSHA3,
  createSHA384,
  createSHA512,
  createSM3,
  createWhirlpool,
  createXXHash128,
  createXXHash3,
  createXXHash32,
  createXXHash64,
} from "hash-wasm";
import type { IHasher } from "hash-wasm";

import type { AlgorithmId } from "./algorithms";

export interface WorkerRequest {
  type: "hash";
  /** A file, or text, which is hashed as UTF-8. */
  source: Blob | string;
  algorithms: AlgorithmId[];
}

export type WorkerResponse =
  /** Bytes read of the current source. */
  | { type: "progress"; read: number }
  | {
      type: "hashed";
      digests: Partial<Record<AlgorithmId, string>>;
      ms: number;
    }
  | { type: "error"; message: string };

/** CRC-32C's polynomial, reflected. */
const CASTAGNOLI = 0x82_f6_3b_78;
/** How much of a file is read at a time: big enough that per-slice costs vanish. */
const SLICE = 4 * 1024 * 1024;
const PROGRESS_MS = 100;

const FACTORIES: Record<AlgorithmId, () => Promise<IHasher>> = {
  adler32: () => createAdler32(),
  blake2b: () => createBLAKE2b(512),
  blake2s: () => createBLAKE2s(256),
  blake3: () => createBLAKE3(256),
  crc32: () => createCRC32(),
  crc32c: () => createCRC32(CASTAGNOLI),
  crc64: () => createCRC64(),
  keccak256: () => createKeccak(256),
  md5: () => createMD5(),
  ripemd160: () => createRIPEMD160(),
  sha1: () => createSHA1(),
  sha224: () => createSHA224(),
  sha256: () => createSHA256(),
  "sha3-256": () => createSHA3(256),
  "sha3-512": () => createSHA3(512),
  sha384: () => createSHA384(),
  sha512: () => createSHA512(),
  sm3: () => createSM3(),
  whirlpool: () => createWhirlpool(),
  xxh128: () => createXXHash128(),
  xxh3: () => createXXHash3(),
  xxh32: () => createXXHash32(),
  xxh64: () => createXXHash64(),
};

// A dedicated worker has no targetOrigin to give.
const post = (msg: WorkerResponse) => self.postMessage(msg, { transfer: [] });

const hash = async (msg: WorkerRequest) => {
  const t0 = performance.now();
  const hashers = await Promise.all(
    msg.algorithms.map(async (id) => {
      const h = await FACTORIES[id]();
      h.init();
      return [id, h] as const;
    })
  );
  const feed = (bytes: Uint8Array) => {
    for (const [, h] of hashers) {
      h.update(bytes);
    }
  };
  if (typeof msg.source === "string") {
    feed(new TextEncoder().encode(msg.source));
  } else {
    const blob = msg.source;
    let posted = 0;
    for (let at = 0; at < blob.size; at += SLICE) {
      feed(new Uint8Array(await blob.slice(at, at + SLICE).arrayBuffer()));
      const now = performance.now();
      if (now - posted > PROGRESS_MS) {
        posted = now;
        post({ read: Math.min(blob.size, at + SLICE), type: "progress" });
      }
    }
  }
  const digests: Partial<Record<AlgorithmId, string>> = {};
  for (const [id, h] of hashers) {
    digests[id] = h.digest("hex");
  }
  post({ digests, ms: performance.now() - t0, type: "hashed" });
};

// One request at a time, in order: the client waits for each answer before the next.
self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  try {
    await hash(ev.data);
  } catch (error) {
    post({
      message: error instanceof Error ? error.message : String(error),
      type: "error",
    });
  }
};
