// Just enough zip for Export and Import: writing stores entries uncompressed
// (a Project is small, and the browser's own download compression is not
// the point), reading accepts stored and deflated entries, the two methods
// every zip tool writes. Everything else in the format is skipped over.

export interface ZipEntry {
  path: string;
  data: Uint8Array;
}

// CRC-32 works a byte at a time, so it is kept here as four bytes, low
// first, and XOR comes from a table of every pair of bytes.

/** `XOR[a * 256 + b]` is the exclusive or of bytes `a` and `b`. */
const XOR = new Uint8Array(256 * 256);
for (let a = 0; a < 256; a += 1) {
  for (let b = 0; b < 256; b += 1) {
    let x = 0;
    for (let bit = 1; bit < 256; bit *= 2) {
      if ((Math.floor(a / bit) + Math.floor(b / bit)) % 2 === 1) {
        x += bit;
      }
    }
    XOR[a * 256 + b] = x;
  }
}

const xorByte = (a: number, b: number): number => XOR[a * 256 + b];

/** The reflected CRC-32 polynomial, 0xedb88320, as bytes low first. */
const POLY = [0x20, 0x83, 0xb8, 0xed] as const;

/** The CRC of each byte value, four bytes per entry, low first. */
const CRC_TABLE = new Uint8Array(256 * 4);
for (let n = 0; n < 256; n += 1) {
  const c = [n, 0, 0, 0];
  for (let k = 0; k < 8; k += 1) {
    const odd = c[0] % 2 === 1;
    // Shift the four bytes right by one bit.
    for (let i = 0; i < 4; i += 1) {
      const next = i < 3 ? c[i + 1] : 0;
      const carry = next % 2 === 1 ? 128 : 0;
      c[i] = Math.floor(c[i] / 2) + carry;
    }
    if (odd) {
      for (let i = 0; i < 4; i += 1) {
        c[i] = xorByte(c[i], POLY[i]);
      }
    }
  }
  CRC_TABLE.set(c, n * 4);
}

const crc32 = (bytes: Uint8Array): number => {
  let [c0, c1, c2, c3] = [255, 255, 255, 255];
  for (const byte of bytes) {
    // c = TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
    const at = xorByte(c0, byte) * 4;
    c0 = xorByte(CRC_TABLE[at], c1);
    c1 = xorByte(CRC_TABLE[at + 1], c2);
    c2 = xorByte(CRC_TABLE[at + 2], c3);
    c3 = CRC_TABLE[at + 3];
  }
  // The final XOR with 0xffffffff, byte by byte.
  return (
    255 - c0 + (255 - c1) * 2 ** 8 + (255 - c2) * 2 ** 16 + (255 - c3) * 2 ** 24
  );
};

/**
 * MS-DOS time and date: hours, minutes and seconds halved in 5, 6 and 5
 * bits; years since 1980, month and day in 7, 4 and 5 bits. The fields
 * never overlap, so packing them is adding them at their place values.
 */
const dosDateTime = (ms: number): [number, number] => {
  const d = new Date(ms);
  const time =
    d.getHours() * 2 ** 11 +
    d.getMinutes() * 2 ** 5 +
    Math.floor(d.getSeconds() / 2);
  const date =
    (Math.max(1980, d.getFullYear()) - 1980) * 2 ** 9 +
    (d.getMonth() + 1) * 2 ** 5 +
    d.getDate();
  return [time, date];
};

export const writeZip = (entries: ZipEntry[], mtime = Date.now()): Blob => {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const [time, date] = dosDateTime(mtime);
  for (const e of entries) {
    const name = encoder.encode(e.path);
    const crc = crc32(e.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04_03_4b_50, true);
    local.setUint16(4, 20, true);
    // UTF-8 names.
    local.setUint16(6, 0x08_00, true);
    // Stored.
    local.setUint16(8, 0, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, e.data.length, true);
    local.setUint32(22, e.data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), name, e.data);

    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02_01_4b_50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x08_00, true);
    c.setUint16(10, 0, true);
    c.setUint16(12, time, true);
    c.setUint16(14, date, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, e.data.length, true);
    c.setUint32(24, e.data.length, true);
    c.setUint16(28, name.length, true);
    c.setUint16(30, 0, true);
    c.setUint16(32, 0, true);
    c.setUint16(34, 0, true);
    c.setUint16(36, 0, true);
    c.setUint32(38, 0, true);
    c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), name);
    offset += 30 + name.length + e.data.length;
  }
  let centralSize = 0;
  for (const c of central) {
    centralSize += c.length;
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06_05_4b_50, true);
  end.setUint16(4, 0, true);
  end.setUint16(6, 0, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  end.setUint16(20, 0, true);
  return new Blob(
    [...parts, ...central, new Uint8Array(end.buffer)] as BlobPart[],
    { type: "application/zip" }
  );
};

const inflateRaw = async (data: Uint8Array): Promise<Uint8Array> => {
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

/** Reads a zip's files (directories are skipped). Throws when it is not a zip. */
export const readZip = async (buffer: ArrayBuffer): Promise<ZipEntry[]> => {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  // The end-of-central-directory record is within the last 64 KB + 22 bytes.
  let eocd = -1;
  for (
    let i = bytes.length - 22;
    i >= Math.max(0, bytes.length - 65_558);
    i -= 1
  ) {
    if (view.getUint32(i, true) === 0x06_05_4b_50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) {
    throw new Error("Not a zip file.");
  }
  const count = view.getUint16(eocd + 10, true);
  let pos = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const cp437 = new TextDecoder("latin1");
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n += 1) {
    if (view.getUint32(pos, true) !== 0x02_01_4b_50) {
      throw new Error("Corrupt zip directory.");
    }
    const flags = view.getUint16(pos + 8, true);
    const method = view.getUint16(pos + 10, true);
    const compressed = view.getUint32(pos + 20, true);
    const size = view.getUint32(pos + 24, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const localOffset = view.getUint32(pos + 42, true);
    const nameBytes = bytes.subarray(pos + 46, pos + 46 + nameLen);
    // Bit 11 of the flags marks a UTF-8 name.
    const utf8 = Math.floor(flags / 0x08_00) % 2 === 1;
    const path = (utf8 ? decoder : cp437).decode(nameBytes);
    pos += 46 + nameLen + extraLen + commentLen;
    if (path.endsWith("/")) {
      continue;
    }
    if (view.getUint32(localOffset, true) !== 0x04_03_4b_50) {
      throw new Error("Corrupt zip entry.");
    }
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    const raw = bytes.slice(start, start + compressed);
    let data: Uint8Array;
    if (method === 0) {
      data = raw;
    } else if (method === 8) {
      data = await inflateRaw(raw);
    } else {
      throw new Error(
        `Unsupported compression (method ${method}) for ${path}.`
      );
    }
    if (data.length !== size && size !== 0xff_ff_ff_ff) {
      throw new Error(`Size mismatch for ${path}.`);
    }
    entries.push({ data, path });
  }
  return entries;
};
