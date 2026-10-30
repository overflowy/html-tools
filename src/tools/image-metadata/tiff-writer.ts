// Byte buffer for rebuilding a TIFF file in either byte order, used by the
// TIFF Strip. Values are stored the way TIFF stores them: integers wrap to the
// field's width.

/** Scratch space for laying out one field in the writer's byte order. */
const scratch = new DataView(new ArrayBuffer(4));

/** The scratch's first `n` bytes. */
const scratchBytes = (n: number): number[] => {
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push(scratch.getUint8(i));
  }
  return out;
};

export class TiffWriter {
  bytes: number[] = [];
  le: boolean;
  constructor(le: boolean) {
    this.le = le;
  }
  get length() {
    return this.bytes.length;
  }
  u8(v: number) {
    scratch.setUint8(0, v);
    this.bytes.push(...scratchBytes(1));
  }
  u16(v: number) {
    scratch.setUint16(0, v, this.le);
    this.bytes.push(...scratchBytes(2));
  }
  u32(v: number) {
    scratch.setUint32(0, v, this.le);
    this.bytes.push(...scratchBytes(4));
  }
  raw(b: Uint8Array) {
    for (const byte of b) {
      this.bytes.push(byte);
    }
  }
  setU32At(pos: number, v: number) {
    scratch.setUint32(0, v, this.le);
    for (const [i, byte] of scratchBytes(4).entries()) {
      this.bytes[pos + i] = byte;
    }
  }
  align(n: number) {
    while (this.bytes.length % n !== 0) {
      this.u8(0);
    }
  }
  toBytes() {
    return new Uint8Array(this.bytes);
  }
}
