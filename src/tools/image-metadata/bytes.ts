// Byte-level reads, writes and checksums for the container walks. A read past
// either end of the data gives 0, as a bitwise read of a missing byte does.

/** Byte `i` of `b`, or 0 outside it. */
export const byteAt = (b: Uint8Array, i: number): number => b[i] ?? 0;

export const u16be = (b: Uint8Array, p: number): number =>
  byteAt(b, p) * 0x1_00 + byteAt(b, p + 1);

export const u32be = (b: Uint8Array, p: number): number =>
  byteAt(b, p) * 0x1_00_00_00 +
  byteAt(b, p + 1) * 0x1_00_00 +
  byteAt(b, p + 2) * 0x1_00 +
  byteAt(b, p + 3);

export const u32le = (b: Uint8Array, p: number): number =>
  byteAt(b, p) +
  byteAt(b, p + 1) * 0x1_00 +
  byteAt(b, p + 2) * 0x1_00_00 +
  byteAt(b, p + 3) * 0x1_00_00_00;

export const concat = (parts: Uint8Array[]): Uint8Array => {
  let total = 0;
  for (const p of parts) {
    total += p.length;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

/* ---------------- CRC-32 ---------------- */

/** XOR_BYTE[a * 256 + b] is the bitwise XOR of bytes a and b. */
const XOR_BYTE = new Uint8Array(256 * 256);
for (let a = 0; a < 256; a += 1) {
  for (let b = 0; b < 256; b += 1) {
    // The low bits differ exactly when their sum is odd; the rest is the XOR of the halves.
    const high = byteAt(XOR_BYTE, Math.floor(a / 2) * 256 + Math.floor(b / 2));
    XOR_BYTE[a * 256 + b] = high * 2 + ((a + b) % 2);
  }
}

const xor8 = (a: number, b: number): number => byteAt(XOR_BYTE, a * 256 + b);

/** Bitwise XOR of two unsigned 32-bit numbers, a byte at a time. */
const xor32 = (a: number, b: number): number => {
  let result = 0;
  let scale = 1;
  for (let k = 0; k < 4; k += 1) {
    const x = Math.floor(a / scale) % 256;
    const y = Math.floor(b / scale) % 256;
    result += xor8(x, y) * scale;
    scale *= 256;
  }
  return result;
};

/**
 * The CRC-32 table (polynomial 0xEDB88320, as PNG uses), split into the four
 * bytes of each entry, low byte first, so a CRC step is four byte XORs.
 */
const CRC_BYTES = [
  new Uint8Array(256),
  new Uint8Array(256),
  new Uint8Array(256),
  new Uint8Array(256),
];
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    const half = Math.floor(c / 2);
    c = c % 2 === 1 ? xor32(0xed_b8_83_20, half) : half;
  }
  for (const [k, table] of CRC_BYTES.entries()) {
    table[n] = Math.floor(c / 256 ** k) % 256;
  }
}

/** CRC-32 of b[start, end). */
export const crc32 = (b: Uint8Array, start: number, end: number): number => {
  const [t0, t1, t2, t3] = CRC_BYTES;
  // The running CRC's bytes, low first, starting from 0xFFFFFFFF.
  let c0 = 255;
  let c1 = 255;
  let c2 = 255;
  let c3 = 255;
  for (let i = start; i < end; i += 1) {
    // Table entry for the low byte XOR the input, XOR the CRC shifted down a byte.
    const idx = xor8(c0, byteAt(b, i));
    c0 = xor8(byteAt(t0, idx), c1);
    c1 = xor8(byteAt(t1, idx), c2);
    c2 = xor8(byteAt(t2, idx), c3);
    c3 = byteAt(t3, idx);
  }
  // The final XOR with 0xFFFFFFFF complements every byte.
  return (
    (255 - c3) * 0x1_00_00_00 +
    (255 - c2) * 0x1_00_00 +
    (255 - c1) * 0x1_00 +
    (255 - c0)
  );
};

/* ---------------- writing ---------------- */

/** Big-endian field writer over a list of parts, for rebuilding ISO-BMFF boxes. */
export class ByteWriter {
  parts: Uint8Array[] = [];
  length = 0;
  raw(b: Uint8Array) {
    this.parts.push(b);
    this.length += b.length;
  }
  /** The low `size` bytes of `v` as an unsigned 32-bit number, big-endian. */
  private field(v: number, size: number) {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, v);
    this.raw(out.subarray(4 - size));
  }
  u8(v: number) {
    this.field(v, 1);
  }
  u16(v: number) {
    this.field(v, 2);
  }
  /** The 24-bit flags of a full box header. */
  u24(v: number) {
    this.field(v, 3);
  }
  u32(v: number) {
    this.field(v, 4);
  }
  uN(v: number, size: number) {
    if (size === 0) {
      if (v !== 0) {
        throw new Error("Cannot store offset in zero-width field");
      }
      return;
    }
    if (size === 2) {
      this.u16(v);
    } else if (size === 4) {
      this.u32(v);
    } else if (size === 8) {
      this.u32(Math.floor(v / 4_294_967_296));
      this.u32(v);
    } else {
      throw new Error(`Unsupported field size ${size}`);
    }
  }
  bytes() {
    return concat(this.parts);
  }
}
