// QR Code Model 2 encoder, implemented from the ISO/IEC 18004 specification.
// No rendering here: the output is the finished module matrix.

export type Ecl = "L" | "M" | "Q" | "H";
export type Mode = "numeric" | "alphanumeric" | "byte";

export interface Encoded {
  version: number;
  /** Modules per side: version * 4 + 17. */
  size: number;
  /** Mask pattern actually applied, 0-7. */
  mask: number;
  /** Text encoding mode chosen for the payload. */
  mode: Mode;
  /** Row-major dark-module flags (1 = dark), size * size entries. */
  matrix: Uint8Array;
}

const ECL_INDEX: Record<Ecl, number> = { L: 0, M: 1, Q: 2, H: 3 };
/** Two-bit error correction indicator placed in the format information. */
const ECL_FORMAT_BITS: Record<Ecl, number> = { L: 1, M: 0, Q: 3, H: 2 };

// Spec tables (ISO/IEC 18004), indexed [ecl][version]; version 0 is unused padding.
const ECC_CODEWORDS_PER_BLOCK = [
  [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const NUM_BLOCKS = [
  [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

const ALPHANUMERIC_CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";

/* ---------------- segment sizing ---------------- */

export function pickMode(text: string): Mode {
  if (/^[0-9]+$/.test(text)) return "numeric";
  let alnum = true;
  for (const ch of text) {
    if (!ALPHANUMERIC_CHARSET.includes(ch)) { alnum = false; break; }
  }
  return alnum ? "alphanumeric" : "byte";
}

/** Width of the character count field for a mode, by version. */
function charCountBits(mode: Mode, version: number): number {
  const cls = version <= 9 ? 0 : version <= 26 ? 1 : 2;
  if (mode === "numeric") return [10, 12, 14][cls]!;
  if (mode === "alphanumeric") return [9, 11, 13][cls]!;
  return [8, 16, 16][cls]!;
}

/** Payload bits for `count` characters (bytes for byte mode), excluding headers. */
function payloadBits(mode: Mode, count: number): number {
  if (mode === "numeric") return 10 * Math.floor(count / 3) + [0, 4, 7][count % 3]!;
  if (mode === "alphanumeric") return 11 * Math.floor(count / 2) + 6 * (count % 2);
  return 8 * count;
}

/** Data modules available in a version after removing every function pattern. */
function rawDataModules(version: number): number {
  let n = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    n -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) n -= 36;
  }
  return n;
}

function dataCodewords(version: number, ecl: Ecl): number {
  const e = ECL_INDEX[ecl];
  return Math.floor(rawDataModules(version) / 8) -
    ECC_CODEWORDS_PER_BLOCK[e]![version]! * NUM_BLOCKS[e]![version]!;
}

/** Largest byte-mode payload a given level can hold (version 40). */
export function maxBytes(ecl: Ecl): number {
  return dataCodewords(40, ecl) - Math.ceil((4 + charCountBits("byte", 40)) / 8);
}

/* ---------------- bit stream ---------------- */

function appendBits(buf: number[], value: number, length: number) {
  for (let i = length - 1; i >= 0; i--) buf.push((value >>> i) & 1);
}

function buildBitStream(text: string, mode: Mode, version: number): number[] {
  const buf: number[] = [];
  if (mode === "numeric") {
    appendBits(buf, 1, 4);
    appendBits(buf, text.length, charCountBits(mode, version));
    for (let i = 0; i < text.length; i += 3) {
      const group = text.slice(i, i + 3);
      appendBits(buf, Number(group), [0, 4, 7, 10][group.length]!);
    }
  } else if (mode === "alphanumeric") {
    appendBits(buf, 2, 4);
    appendBits(buf, text.length, charCountBits(mode, version));
    for (let i = 0; i + 1 < text.length; i += 2) {
      appendBits(buf,
        ALPHANUMERIC_CHARSET.indexOf(text[i]!) * 45 + ALPHANUMERIC_CHARSET.indexOf(text[i + 1]!), 11);
    }
    if (text.length % 2 === 1) appendBits(buf, ALPHANUMERIC_CHARSET.indexOf(text[text.length - 1]!), 6);
  } else {
    const bytes = new TextEncoder().encode(text);
    appendBits(buf, 4, 4);
    appendBits(buf, bytes.length, charCountBits(mode, version));
    for (const b of bytes) appendBits(buf, b, 8);
  }
  return buf;
}

/* ---------------- Reed-Solomon over GF(256), polynomial 0x11D ---------------- */

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]!;
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

/** Generator polynomial coefficients for `degree` ECC codewords, leading 1 omitted. */
function rsGenerator(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    const root = GF_EXP[i]!;
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j]!;
      next[j + 1] ^= gfMul(poly[j]!, root);
    }
    poly = next;
  }
  return poly.slice(1);
}

function rsRemainder(data: Uint8Array, generator: Uint8Array): Uint8Array {
  const rem = new Uint8Array(generator.length);
  for (const b of data) {
    const factor = b ^ rem[0]!;
    rem.copyWithin(0, 1);
    rem[rem.length - 1] = 0;
    for (let i = 0; i < generator.length; i++) rem[i] ^= gfMul(generator[i]!, factor);
  }
  return rem;
}

/** Split into blocks, compute ECC per block, and interleave both, per the spec. */
function addEccAndInterleave(data: Uint8Array, version: number, ecl: Ecl): Uint8Array {
  const e = ECL_INDEX[ecl];
  const numBlocks = NUM_BLOCKS[e]![version]!;
  const eccLen = ECC_CODEWORDS_PER_BLOCK[e]![version]!;
  const rawCodewords = Math.floor(rawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortDataLen = Math.floor(rawCodewords / numBlocks) - eccLen;

  const generator = rsGenerator(eccLen);
  const dataBlocks: Uint8Array[] = [];
  const eccBlocks: Uint8Array[] = [];
  let k = 0;
  for (let i = 0; i < numBlocks; i++) {
    const len = shortDataLen + (i < numShortBlocks ? 0 : 1);
    const block = data.slice(k, k + len);
    k += len;
    dataBlocks.push(block);
    eccBlocks.push(rsRemainder(block, generator));
  }

  const out = new Uint8Array(rawCodewords);
  let o = 0;
  for (let i = 0; i <= shortDataLen; i++) {
    for (const block of dataBlocks) {
      if (i < block.length) out[o++] = block[i]!;
    }
  }
  for (let i = 0; i < eccLen; i++) {
    for (const block of eccBlocks) out[o++] = block[i]!;
  }
  return out;
}

/* ---------------- matrix construction ---------------- */

function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const size = version * 4 + 17;
  const numAlign = Math.floor(version / 7) + 2;
  const step = Math.floor((version * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
  const positions = [6];
  for (let pos = size - 7; positions.length < numAlign; pos -= step) positions.splice(1, 0, pos);
  return positions;
}

interface Grid {
  size: number;
  modules: Uint8Array;
  isFunction: Uint8Array;
}

function setFunction(g: Grid, x: number, y: number, dark: boolean) {
  if (x < 0 || x >= g.size || y < 0 || y >= g.size) return;
  const i = y * g.size + x;
  g.modules[i] = dark ? 1 : 0;
  g.isFunction[i] = 1;
}

function drawFunctionPatterns(g: Grid, version: number) {
  // Timing patterns
  for (let i = 0; i < g.size; i++) {
    setFunction(g, 6, i, i % 2 === 0);
    setFunction(g, i, 6, i % 2 === 0);
  }
  // Finder patterns with separators, at three corners
  for (const [cx, cy] of [[3, 3], [g.size - 4, 3], [3, g.size - 4]] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        setFunction(g, cx + dx, cy + dy, dist !== 2 && dist !== 4);
      }
    }
  }
  // Alignment patterns, skipping the three finder corners
  const positions = alignmentPositions(version);
  const last = positions.length - 1;
  for (let i = 0; i < positions.length; i++) {
    for (let j = 0; j < positions.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          setFunction(g, positions[i]! + dx, positions[j]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }
  drawFormatBits(g, "M", 0); // placeholder so format modules count as reserved
  drawVersionInfo(g, version);
}

/** BCH-protected format information, drawn in both of its locations. */
function drawFormatBits(g: Grid, ecl: Ecl, mask: number) {
  const data = ECL_FORMAT_BITS[ecl] << 3 | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = (data << 10 | rem) ^ 0x5412;
  const bit = (i: number) => ((bits >>> i) & 1) === 1;

  for (let i = 0; i <= 5; i++) setFunction(g, 8, i, bit(i));
  setFunction(g, 8, 7, bit(6));
  setFunction(g, 8, 8, bit(7));
  setFunction(g, 7, 8, bit(8));
  for (let i = 9; i < 15; i++) setFunction(g, 14 - i, 8, bit(i));

  for (let i = 0; i < 8; i++) setFunction(g, g.size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) setFunction(g, 8, g.size - 15 + i, bit(i));
  setFunction(g, 8, g.size - 8, true); // dark module
}

/** BCH-protected version information, present from version 7 up. */
function drawVersionInfo(g: Grid, version: number) {
  if (version < 7) return;
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = version << 12 | rem;
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) === 1;
    const a = g.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    setFunction(g, a, b, dark);
    setFunction(g, b, a, dark);
  }
}

/** Zigzag placement: column pairs right to left, alternating up and down, skipping column 6. */
function placeData(g: Grid, codewords: Uint8Array) {
  let bitIndex = 0;
  const totalBits = codewords.length * 8;
  for (let right = g.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let v = 0; v < g.size; v++) {
      const y = upward ? g.size - 1 - v : v;
      for (const x of [right, right - 1]) {
        const i = y * g.size + x;
        if (g.isFunction[i] || bitIndex >= totalBits) continue;
        g.modules[i] = (codewords[bitIndex >>> 3]! >>> (7 - (bitIndex & 7))) & 1;
        bitIndex++;
      }
    }
  }
}

function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return (x * y) % 2 + (x * y) % 3 === 0;
    case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0;
    default: return ((x + y) % 2 + (x * y) % 3) % 2 === 0;
  }
}

/** XOR the mask over data modules; self-inverse. */
function applyMask(g: Grid, mask: number) {
  for (let y = 0; y < g.size; y++) {
    for (let x = 0; x < g.size; x++) {
      const i = y * g.size + x;
      if (!g.isFunction[i] && maskBit(mask, x, y)) g.modules[i] ^= 1;
    }
  }
}

/* ---------------- mask evaluation (spec penalty rules N1-N4) ---------------- */

const PENALTY_N1 = 3, PENALTY_N2 = 3, PENALTY_N3 = 40, PENALTY_N4 = 10;

/**
 * Count 1:1:3:1:1 finder-like patterns ending at the just-finished light run.
 * `runs` holds the latest run lengths, most recent first; the line's light
 * border counts as extra light run length at both ends.
 */
function finderLikePatterns(runs: number[]): number {
  const n = runs[1]!;
  const core = n > 0 && runs[2] === n && runs[3] === n * 3 && runs[4] === n && runs[5] === n;
  if (!core) return 0;
  return (runs[0]! >= n * 4 && runs[6]! >= n ? 1 : 0) + (runs[6]! >= n * 4 && runs[0]! >= n ? 1 : 0);
}

function penaltyScore(g: Grid): number {
  const size = g.size;
  let score = 0;

  const pushRun = (runs: number[], length: number) => {
    if (runs[0] === 0) length += size; // light border pads the first run
    runs.pop();
    runs.unshift(length);
  };

  // N1 (same-color runs of 5+) and N3 (finder-like patterns), along both axes
  for (let axis = 0; axis < 2; axis++) {
    for (let a = 0; a < size; a++) {
      const runs = [0, 0, 0, 0, 0, 0, 0];
      let runColor = 0;
      let runLen = 0;
      for (let b = 0; b < size; b++) {
        const dark = axis === 0 ? g.modules[a * size + b]! : g.modules[b * size + a]!;
        if (dark === runColor) {
          runLen++;
          if (runLen === 5) score += PENALTY_N1;
          else if (runLen > 5) score++;
        } else {
          pushRun(runs, runLen);
          if (!runColor) score += finderLikePatterns(runs) * PENALTY_N3;
          runColor = dark;
          runLen = 1;
        }
      }
      if (runColor) { // close a trailing dark run before the border
        pushRun(runs, runLen);
        runLen = 0;
      }
      pushRun(runs, runLen + size); // light border pads the final run
      score += finderLikePatterns(runs) * PENALTY_N3;
    }
  }

  // N2: 2x2 blocks of one color
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = g.modules[y * size + x];
      if (c === g.modules[y * size + x + 1] &&
          c === g.modules[(y + 1) * size + x] &&
          c === g.modules[(y + 1) * size + x + 1]) score += PENALTY_N2;
    }
  }

  // N4: dark-module proportion, 10 points per 5% step away from 50%
  let dark = 0;
  for (const m of g.modules) dark += m;
  const total = size * size;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * PENALTY_N4;
  return score;
}

/* ---------------- top level ---------------- */

/**
 * Encode `text` at the given error correction level into a finished module
 * matrix, choosing the densest mode, the smallest version, and (unless
 * `forcedMask` is 0-7) the best-scoring mask. Throws if the payload cannot
 * fit in version 40.
 */
export function encode(text: string, ecl: Ecl, forcedMask = -1): Encoded {
  const mode = pickMode(text);
  const count = mode === "byte" ? new TextEncoder().encode(text).length : text.length;

  let version = 0;
  for (let v = 1; v <= 40; v++) {
    if (4 + charCountBits(mode, v) + payloadBits(mode, count) <= dataCodewords(v, ecl) * 8) {
      version = v;
      break;
    }
  }
  if (version === 0) throw new RangeError("Data too long for a QR code at level " + ecl);

  const bits = buildBitStream(text, mode, version);
  const capacityBits = dataCodewords(version, ecl) * 8;
  appendBits(bits, 0, Math.min(4, capacityBits - bits.length)); // terminator
  appendBits(bits, 0, (8 - bits.length % 8) % 8); // byte alignment
  const data = new Uint8Array(capacityBits / 8);
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) data[i >>> 3] |= 0x80 >>> (i & 7);
  }
  for (let i = bits.length / 8, pad = 0xec; i < data.length; i++, pad ^= 0xec ^ 0x11) data[i] = pad;

  const size = version * 4 + 17;
  const g: Grid = { size, modules: new Uint8Array(size * size), isFunction: new Uint8Array(size * size) };
  drawFunctionPatterns(g, version);
  placeData(g, addEccAndInterleave(data, version, ecl));

  let mask = forcedMask;
  if (mask === -1) {
    let best = Infinity;
    for (let m = 0; m < 8; m++) {
      applyMask(g, m);
      drawFormatBits(g, ecl, m);
      const score = penaltyScore(g);
      if (score < best) {
        best = score;
        mask = m;
      }
      applyMask(g, m); // undo
    }
  }
  applyMask(g, mask);
  drawFormatBits(g, ecl, mask);

  return { version, size, mask, mode, matrix: g.modules };
}
