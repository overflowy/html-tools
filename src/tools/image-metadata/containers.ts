// Container walking and lossless stripping for JPEG, PNG, WebP, TIFF and
// HEIC/AVIF. Each walk classifies byte ranges as pixel-critical or Metadata;
// a Strip re-emits only the former, never re-encoding. A Strip is refused
// (throws) unless the walk covered the whole container cleanly.

import { parseTiff, buildOrientationTiff, stripTiff, tiffHasDroppable, type TiffInfo } from "./exif";

export type Format = "jpeg" | "png" | "webp" | "tiff" | "heic" | "avif";

export interface Section {
  label: string;
  bytes: number;
  kept?: boolean;
}

export interface Inspection {
  format: Format;
  mime: string;
  clean: boolean;
  walkError: string | null;
  sections: Section[];
  tiff: TiffInfo | null;
  xmp: string | null;
  iptc: { name: string; value: string }[];
  comments: string[];
  width: number | null;
  height: number | null;
  strippableBytes: number;
  hasMetadata: boolean;
}

export interface StripResult {
  out: Uint8Array;
  keptOrientation: number | null;
}

export const MIME: Record<Format, string> = {
  jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  tiff: "image/tiff", heic: "image/heic", avif: "image/avif",
};

export const EXT: Record<Format, string> = {
  jpeg: "jpg", png: "png", webp: "webp", tiff: "tif", heic: "heic", avif: "avif",
};

export function sniff(b: Uint8Array): Format | null {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return "webp";
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0) ||
      (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 0x2a)) return "tiff";
  if (ascii(b, 4, 4) === "ftyp") {
    const brands = new Set<string>([ascii(b, 8, 4)]);
    const boxSize = u32be(b, 0);
    for (let p = 16; p + 4 <= Math.min(boxSize, b.length, 64); p += 4) brands.add(ascii(b, p, 4));
    for (const br of brands) if (br === "avif" || br === "avis") return "avif";
    for (const br of brands) if (["heic", "heix", "hevc", "hevx", "mif1", "msf1", "heim", "heis"].includes(br)) return "heic";
  }
  return null;
}

export function inspect(b: Uint8Array): Inspection {
  const format = sniff(b);
  if (!format) throw new Error("Unrecognized image format");
  switch (format) {
    case "jpeg": return inspectJpeg(b);
    case "png": return inspectPng(b);
    case "webp": return inspectWebp(b);
    case "tiff": return inspectTiff(b);
    case "heic":
    case "avif": return inspectBmff(b, format);
  }
}

export function strip(b: Uint8Array): StripResult {
  const format = sniff(b);
  if (!format) throw new Error("Unrecognized image format");
  switch (format) {
    case "jpeg": return stripJpeg(b);
    case "png": return stripPng(b);
    case "webp": return stripWebp(b);
    case "tiff": return { out: stripTiff(b), keptOrientation: null };
    case "heic":
    case "avif": return stripBmff(b);
  }
}

// --------------------------------------------------------------- shared bits

function ascii(b: Uint8Array, p: number, n: number): string {
  let s = "";
  for (let i = 0; i < n && p + i < b.length; i++) s += String.fromCharCode(b[p + i]);
  return s;
}

function u32be(b: Uint8Array, p: number): number {
  return ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
}

function u32le(b: Uint8Array, p: number): number {
  return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
}

function startsWith(b: Uint8Array, p: number, s: string): boolean {
  for (let i = 0; i < s.length; i++) if (b[p + i] !== s.charCodeAt(i)) return false;
  return true;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function decodeText(b: Uint8Array): string {
  return new TextDecoder().decode(b).replace(/\0+$/, "");
}

interface Span {
  start: number;
  end: number;
  keep: boolean;
  /** null for structural spans; a Section label for Metadata; "ICC" style kept sections use keptLabel. */
  label: string | null;
  keptLabel?: string;
}

function baseInspection(format: Format): Inspection {
  return {
    format, mime: MIME[format], clean: false, walkError: null, sections: [],
    tiff: null, xmp: null, iptc: [], comments: [], width: null, height: null,
    strippableBytes: 0, hasMetadata: false,
  };
}

function sectionsFromSpans(insp: Inspection, spans: Span[]) {
  const agg = new Map<string, Section>();
  for (const s of spans) {
    const label = s.keep ? s.keptLabel : s.label;
    if (!label) continue;
    const key = (s.keep ? "k:" : "s:") + label;
    const sec = agg.get(key) ?? { label, bytes: 0, kept: s.keep || undefined };
    sec.bytes += s.end - s.start;
    agg.set(key, sec);
  }
  insp.sections = [...agg.values()].sort((a, b) => (a.kept ? 1 : 0) - (b.kept ? 1 : 0) || b.bytes - a.bytes);
  insp.strippableBytes = insp.sections.reduce((n, s) => n + (s.kept ? 0 : s.bytes), 0);
  insp.hasMetadata = insp.sections.some((s) => !s.kept);
}

function tryParseTiff(insp: Inspection, tiffBytes: Uint8Array | null) {
  if (!tiffBytes) return;
  try {
    insp.tiff = parseTiff(tiffBytes);
    if (insp.width === null) insp.width = insp.tiff.width;
    if (insp.height === null) insp.height = insp.tiff.height;
    if (insp.xmp === null) insp.xmp = insp.tiff.xmp;
    if (insp.tiff.iptc && insp.iptc.length === 0) insp.iptc = parseIptc(insp.tiff.iptc);
  } catch {
    // Unreadable EXIF payload: the section still shows and still strips.
  }
}

// IPTC IIM datasets (record 2 is the editorial one).
const IPTC_NAMES: Record<number, string> = {
  5: "Title", 25: "Keywords", 55: "Date created", 60: "Time created",
  80: "By-line", 85: "By-line title", 90: "City", 92: "Sublocation",
  95: "Province/State", 101: "Country", 103: "Transmission reference",
  105: "Headline", 110: "Credit", 115: "Source", 116: "Copyright",
  120: "Caption", 122: "Caption writer",
};

function parseIptc(b: Uint8Array): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  let p = 0;
  while (p + 5 <= b.length && out.length < 64) {
    if (b[p] !== 0x1c) break;
    const record = b[p + 1];
    const dataset = b[p + 2];
    let len = (b[p + 3] << 8) | b[p + 4];
    p += 5;
    if (len & 0x8000) break; // extended-length datasets: rare, stop decoding
    if (p + len > b.length) break;
    if (record === 2 && dataset !== 0) {
      const name = IPTC_NAMES[dataset] ?? "Dataset 2:" + dataset;
      const value = decodeText(b.subarray(p, p + len));
      if (value) out.push({ name, value });
    }
    p += len;
  }
  return out;
}

// --------------------------------------------------------------------- JPEG

interface JpegWalk {
  spans: Span[];
  clean: boolean;
  error: string | null;
  exifTiff: Uint8Array | null;
  xmp: string | null;
  iptcRaw: Uint8Array | null;
  comments: string[];
  width: number | null;
  height: number | null;
}

function classifyJpegSegment(b: Uint8Array, marker: number, payload: number, payloadEnd: number, w: JpegWalk): { keep: boolean; label: string | null; keptLabel?: string } {
  const appN = marker >= 0xe0 && marker <= 0xef ? marker - 0xe0 : -1;
  if (marker === 0xfe) {
    const text = decodeText(b.subarray(payload, Math.min(payloadEnd, payload + 500))).trim();
    if (text) w.comments.push(text);
    return { keep: false, label: "Comment" };
  }
  if (appN === 0) {
    if (startsWith(b, payload, "JFIF\0")) return { keep: true, label: null };
    if (startsWith(b, payload, "JFXX\0")) return { keep: false, label: "JFXX thumbnail" };
    return { keep: false, label: "APP0 segment" };
  }
  if (appN === 1) {
    if (startsWith(b, payload, "Exif\0\0")) {
      if (!w.exifTiff) w.exifTiff = b.subarray(payload + 6, payloadEnd);
      return { keep: false, label: "EXIF" };
    }
    if (startsWith(b, payload, "http://ns.adobe.com/xap/1.0/\0")) {
      if (w.xmp === null) w.xmp = decodeText(b.subarray(payload + 29, payloadEnd));
      return { keep: false, label: "XMP" };
    }
    if (startsWith(b, payload, "http://ns.adobe.com/xmp/extension/\0")) {
      return { keep: false, label: "XMP (extended)" };
    }
    return { keep: false, label: "APP1 segment" };
  }
  if (appN === 2) {
    if (startsWith(b, payload, "ICC_PROFILE\0")) return { keep: true, label: null, keptLabel: "ICC profile" };
    if (startsWith(b, payload, "MPF\0")) return { keep: false, label: "MPF (multi-picture)" };
    return { keep: false, label: "APP2 segment" };
  }
  if (appN === 13) {
    if (startsWith(b, payload, "Photoshop 3.0\0")) {
      if (!w.iptcRaw) w.iptcRaw = extract8bimIptc(b, payload + 14, payloadEnd);
      return { keep: false, label: "IPTC / Photoshop" };
    }
    return { keep: false, label: "APP13 segment" };
  }
  if (appN === 14) {
    if (startsWith(b, payload, "Adobe")) return { keep: true, label: null };
    return { keep: false, label: "APP14 segment" };
  }
  if (appN >= 0) return { keep: false, label: "APP" + appN + " segment" };

  const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
  if (isSof && payloadEnd - payload >= 5) {
    w.height = (b[payload + 1] << 8) | b[payload + 2];
    w.width = (b[payload + 3] << 8) | b[payload + 4];
  }
  return { keep: true, label: null };
}

function extract8bimIptc(b: Uint8Array, p: number, end: number): Uint8Array | null {
  while (p + 12 <= end) {
    if (!startsWith(b, p, "8BIM")) break;
    const id = (b[p + 4] << 8) | b[p + 5];
    let q = p + 6;
    const nameLen = b[q];
    q += 1 + nameLen;
    if ((q - p) % 2) q++;
    if (q + 4 > end) break;
    const len = u32be(b, q);
    q += 4;
    if (q + len > end) break;
    if (id === 0x0404) return b.slice(q, q + len);
    q += len;
    if (len % 2) q++;
    p = q;
  }
  return null;
}

function walkJpeg(b: Uint8Array): JpegWalk {
  const w: JpegWalk = {
    spans: [], clean: false, error: null, exifTiff: null, xmp: null,
    iptcRaw: null, comments: [], width: null, height: null,
  };
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) {
    w.error = "Not a JPEG (missing SOI marker)";
    return w;
  }
  w.spans.push({ start: 0, end: 2, keep: true, label: null });
  let pos = 2;
  outer: while (true) {
    if (pos + 2 > b.length) { w.error = "Truncated before EOI marker"; return w; }
    if (b[pos] !== 0xff) { w.error = "Corrupt structure at offset " + pos; return w; }
    let mpos = pos;
    while (mpos < b.length && b[mpos] === 0xff) mpos++;
    if (mpos >= b.length) { w.error = "Truncated before EOI marker"; return w; }
    const marker = b[mpos];

    if (marker === 0xd9) {
      w.spans.push({ start: pos, end: mpos + 1, keep: true, label: null });
      if (mpos + 1 < b.length) {
        w.spans.push({ start: mpos + 1, end: b.length, keep: false, label: "Trailing data after EOI" });
      }
      w.clean = true;
      return w;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      w.spans.push({ start: pos, end: mpos + 1, keep: true, label: null });
      pos = mpos + 1;
      continue;
    }
    if (mpos + 3 > b.length) { w.error = "Truncated segment header"; return w; }
    const len = (b[mpos + 1] << 8) | b[mpos + 2];
    if (len < 2) { w.error = "Invalid segment length at offset " + mpos; return w; }
    const segEnd = mpos + 1 + len;
    if (segEnd > b.length) { w.error = "Segment extends past end of file"; return w; }
    const cls = classifyJpegSegment(b, marker, mpos + 3, segEnd, w);
    w.spans.push({ start: pos, end: segEnd, keep: cls.keep, label: cls.label, keptLabel: cls.keptLabel });
    pos = segEnd;

    if (marker === 0xda) {
      // Entropy-coded data: stuffed 0xFF00 and restart markers stay inside the
      // scan; any other marker ends it.
      let i = pos;
      while (true) {
        if (i + 1 >= b.length) { w.error = "Truncated inside scan data"; return w; }
        if (b[i] !== 0xff) { i++; continue; }
        const n = b[i + 1];
        if (n === 0x00 || (n >= 0xd0 && n <= 0xd7)) { i += 2; continue; }
        if (n === 0xff) { i += 1; continue; }
        w.spans.push({ start: pos, end: i, keep: true, label: null });
        pos = i;
        continue outer;
      }
    }
  }
}

function inspectJpeg(b: Uint8Array): Inspection {
  const insp = baseInspection("jpeg");
  const w = walkJpeg(b);
  insp.clean = w.clean;
  insp.walkError = w.error;
  insp.width = w.width;
  insp.height = w.height;
  insp.comments = w.comments;
  insp.xmp = w.xmp;
  if (w.iptcRaw) insp.iptc = parseIptc(w.iptcRaw);
  sectionsFromSpans(insp, w.spans);
  tryParseTiff(insp, w.exifTiff);
  return insp;
}

function stripJpeg(b: Uint8Array): StripResult {
  const w = walkJpeg(b);
  if (!w.clean) throw new Error(w.error ?? "JPEG walk failed");
  let orientation: number | null = null;
  if (w.exifTiff) {
    try {
      const t = parseTiff(w.exifTiff);
      if (t.orientation && t.orientation !== 1) orientation = t.orientation;
    } catch { /* unreadable EXIF carries no orientation to keep */ }
  }
  const parts: Uint8Array[] = [];
  let first = true;
  for (const s of w.spans) {
    if (!s.keep) continue;
    parts.push(b.subarray(s.start, s.end));
    if (first) {
      first = false;
      if (orientation !== null) {
        const tiff = buildOrientationTiff(orientation);
        const app1 = new Uint8Array(4 + 6 + tiff.length);
        app1[0] = 0xff; app1[1] = 0xe1;
        const len = 2 + 6 + tiff.length;
        app1[2] = len >> 8; app1[3] = len & 0xff;
        app1.set([0x45, 0x78, 0x69, 0x66, 0, 0], 4);
        app1.set(tiff, 10);
        parts.push(app1);
      }
    }
  }
  return { out: concat(parts), keptOrientation: orientation };
}

// ---------------------------------------------------------------------- PNG

let CRC_TABLE: Uint32Array | null = null;

function crc32(b: Uint8Array, start: number, end: number): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const PNG_TEXT_CHUNKS = new Set(["tEXt", "zTXt", "iTXt"]);
const XMP_KEYWORD = "XML:com.adobe.xmp";

interface PngWalk {
  spans: Span[];
  clean: boolean;
  error: string | null;
  exifTiff: Uint8Array | null;
  xmp: string | null;
  comments: string[];
  width: number | null;
  height: number | null;
  ihdrEnd: number;
}

function walkPng(b: Uint8Array): PngWalk {
  const w: PngWalk = {
    spans: [], clean: false, error: null, exifTiff: null, xmp: null,
    comments: [], width: null, height: null, ihdrEnd: 8,
  };
  if (b.length < 8) { w.error = "Truncated PNG signature"; return w; }
  w.spans.push({ start: 0, end: 8, keep: true, label: null });
  let p = 8;
  while (true) {
    if (p + 12 > b.length) { w.error = "Truncated before IEND chunk"; return w; }
    const len = u32be(b, p);
    const type = ascii(b, p + 4, 4);
    const dataStart = p + 8;
    const chunkEnd = dataStart + len + 4;
    if (chunkEnd > b.length) { w.error = "Chunk " + type + " extends past end of file"; return w; }
    if (crc32(b, p + 4, dataStart + len) !== u32be(b, dataStart + len)) {
      w.error = "CRC mismatch in " + type + " chunk";
      return w;
    }

    let keep = true;
    let label: string | null = null;
    if (type === "eXIf") {
      keep = false;
      label = "EXIF";
      if (!w.exifTiff) w.exifTiff = b.subarray(dataStart, dataStart + len);
    } else if (type === "tIME") {
      keep = false;
      label = "Modification time";
    } else if (PNG_TEXT_CHUNKS.has(type)) {
      keep = false;
      let kwEnd = dataStart;
      while (kwEnd < dataStart + len && b[kwEnd] !== 0) kwEnd++;
      const keyword = decodeText(b.subarray(dataStart, kwEnd));
      if (type === "iTXt" && keyword === XMP_KEYWORD) {
        label = "XMP";
        // iTXt: keyword\0 compFlag compMethod lang\0 translated\0 text
        let q = kwEnd + 1;
        const compFlag = b[q];
        q += 2;
        while (q < dataStart + len && b[q] !== 0) q++;
        q++;
        while (q < dataStart + len && b[q] !== 0) q++;
        q++;
        if (w.xmp === null && compFlag === 0 && q <= dataStart + len) {
          w.xmp = decodeText(b.subarray(q, dataStart + len));
        }
      } else {
        label = type === "zTXt" || (type === "iTXt" && b[kwEnd + 1] === 1)
          ? "Text, compressed (" + keyword + ")"
          : "Text (" + keyword + ")";
        if (type === "tEXt") {
          const value = decodeText(b.subarray(kwEnd + 1, Math.min(dataStart + len, kwEnd + 1 + 500))).trim();
          if (value) w.comments.push(keyword + ": " + value);
        }
      }
    } else if (type === "iCCP") {
      label = null;
      w.spans.push({ start: p, end: chunkEnd, keep: true, label: null, keptLabel: "ICC profile" });
      p = chunkEnd;
      continue;
    } else if (type === "IHDR" && len >= 8) {
      w.width = u32be(b, dataStart);
      w.height = u32be(b, dataStart + 4);
      w.ihdrEnd = chunkEnd;
    }

    w.spans.push({ start: p, end: chunkEnd, keep, label });
    p = chunkEnd;
    if (type === "IEND") {
      if (p < b.length) w.spans.push({ start: p, end: b.length, keep: false, label: "Trailing data" });
      w.clean = true;
      return w;
    }
  }
}

function inspectPng(b: Uint8Array): Inspection {
  const insp = baseInspection("png");
  const w = walkPng(b);
  insp.clean = w.clean;
  insp.walkError = w.error;
  insp.width = w.width;
  insp.height = w.height;
  insp.comments = w.comments;
  insp.xmp = w.xmp;
  sectionsFromSpans(insp, w.spans);
  tryParseTiff(insp, w.exifTiff);
  return insp;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

function stripPng(b: Uint8Array): StripResult {
  const w = walkPng(b);
  if (!w.clean) throw new Error(w.error ?? "PNG walk failed");
  let orientation: number | null = null;
  if (w.exifTiff) {
    try {
      const t = parseTiff(w.exifTiff);
      if (t.orientation && t.orientation !== 1) orientation = t.orientation;
    } catch { /* unreadable EXIF carries no orientation to keep */ }
  }
  const parts: Uint8Array[] = [];
  for (const s of w.spans) {
    if (!s.keep) continue;
    parts.push(b.subarray(s.start, s.end));
    if (s.end === w.ihdrEnd && orientation !== null) {
      parts.push(pngChunk("eXIf", buildOrientationTiff(orientation)));
    }
  }
  return { out: concat(parts), keptOrientation: orientation };
}

// --------------------------------------------------------------------- WebP

const WEBP_KEEP = new Set(["VP8 ", "VP8L", "VP8X", "ALPH", "ANIM", "ANMF"]);

interface WebpWalk {
  spans: Span[];
  clean: boolean;
  error: string | null;
  exifTiff: Uint8Array | null;
  xmp: string | null;
  width: number | null;
  height: number | null;
  vp8x: { start: number; end: number } | null;
}

function walkWebp(b: Uint8Array): WebpWalk {
  const w: WebpWalk = {
    spans: [], clean: false, error: null, exifTiff: null, xmp: null,
    width: null, height: null, vp8x: null,
  };
  const riffSize = u32le(b, 4);
  const fileEnd = 8 + riffSize;
  if (fileEnd > b.length) { w.error = "RIFF size extends past end of file"; return w; }
  w.spans.push({ start: 0, end: 12, keep: true, label: null });
  let p = 12;
  while (p < fileEnd) {
    if (p + 8 > fileEnd) { w.error = "Truncated chunk header"; return w; }
    const fourcc = ascii(b, p, 4);
    const size = u32le(b, p + 4);
    const dataStart = p + 8;
    const chunkEnd = dataStart + size + (size & 1);
    if (dataStart + size > fileEnd) { w.error = "Chunk " + fourcc + " extends past RIFF size"; return w; }

    let keep = true;
    let label: string | null = null;
    let keptLabel: string | undefined;
    if (fourcc === "EXIF") {
      keep = false;
      label = "EXIF";
      if (!w.exifTiff) {
        const skip = startsWith(b, dataStart, "Exif\0\0") ? 6 : 0;
        w.exifTiff = b.subarray(dataStart + skip, dataStart + size);
      }
    } else if (fourcc === "XMP ") {
      keep = false;
      label = "XMP";
      if (w.xmp === null) w.xmp = decodeText(b.subarray(dataStart, dataStart + size));
    } else if (fourcc === "ICCP") {
      keptLabel = "ICC profile";
    } else if (!WEBP_KEEP.has(fourcc)) {
      keep = false;
      label = fourcc.trim() + " chunk";
    }

    if (fourcc === "VP8X" && size >= 10) {
      w.vp8x = { start: p, end: chunkEnd };
      w.width = 1 + (b[dataStart + 4] | (b[dataStart + 5] << 8) | (b[dataStart + 6] << 16));
      w.height = 1 + (b[dataStart + 7] | (b[dataStart + 8] << 8) | (b[dataStart + 9] << 16));
    }
    if (fourcc === "VP8 " && w.width === null && size >= 10 &&
        b[dataStart + 3] === 0x9d && b[dataStart + 4] === 0x01 && b[dataStart + 5] === 0x2a) {
      w.width = (b[dataStart + 6] | (b[dataStart + 7] << 8)) & 0x3fff;
      w.height = (b[dataStart + 8] | (b[dataStart + 9] << 8)) & 0x3fff;
    }
    if (fourcc === "VP8L" && w.width === null && size >= 5 && b[dataStart] === 0x2f) {
      w.width = 1 + (b[dataStart + 1] | ((b[dataStart + 2] & 0x3f) << 8));
      w.height = 1 + ((b[dataStart + 2] >> 6) | (b[dataStart + 3] << 2) | ((b[dataStart + 4] & 0x0f) << 10));
    }

    w.spans.push({ start: p, end: Math.min(chunkEnd, fileEnd), keep, label, keptLabel });
    p = chunkEnd;
  }
  if (fileEnd < b.length) w.spans.push({ start: fileEnd, end: b.length, keep: false, label: "Trailing data" });
  w.clean = true;
  return w;
}

function inspectWebp(b: Uint8Array): Inspection {
  const insp = baseInspection("webp");
  const w = walkWebp(b);
  insp.clean = w.clean;
  insp.walkError = w.error;
  insp.width = w.width;
  insp.height = w.height;
  insp.xmp = w.xmp;
  sectionsFromSpans(insp, w.spans);
  tryParseTiff(insp, w.exifTiff);
  return insp;
}

function stripWebp(b: Uint8Array): StripResult {
  const w = walkWebp(b);
  if (!w.clean) throw new Error(w.error ?? "WebP walk failed");
  let orientation: number | null = null;
  if (w.exifTiff && w.vp8x) {
    try {
      const t = parseTiff(w.exifTiff);
      if (t.orientation && t.orientation !== 1) orientation = t.orientation;
    } catch { /* unreadable EXIF carries no orientation to keep */ }
  }
  const parts: Uint8Array[] = [];
  for (const s of w.spans) {
    if (!s.keep) continue;
    if (w.vp8x && s.start === w.vp8x.start) {
      const patched = b.slice(s.start, s.end);
      patched[8] &= ~0x0c; // clear the EXIF and XMP flag bits
      if (orientation !== null) patched[8] |= 0x08;
      parts.push(patched);
    } else {
      parts.push(b.subarray(s.start, s.end));
    }
  }
  if (orientation !== null) {
    const tiff = buildOrientationTiff(orientation);
    const chunk = new Uint8Array(8 + tiff.length);
    chunk.set([0x45, 0x58, 0x49, 0x46], 0); // "EXIF"
    chunk[4] = tiff.length & 0xff;
    chunk[5] = (tiff.length >> 8) & 0xff;
    chunk.set(tiff, 8);
    parts.push(chunk);
  }
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  const dv = new DataView(out.buffer);
  dv.setUint32(4, total - 8, true);
  return { out, keptOrientation: orientation };
}

// --------------------------------------------------------------------- TIFF

function inspectTiff(b: Uint8Array): Inspection {
  const insp = baseInspection("tiff");
  try {
    insp.tiff = parseTiff(b);
    insp.width = insp.tiff.width;
    insp.height = insp.tiff.height;
    insp.xmp = insp.tiff.xmp;
    if (insp.tiff.iptc) insp.iptc = parseIptc(insp.tiff.iptc);
  } catch (e) {
    insp.walkError = e instanceof Error ? e.message : String(e);
    return insp;
  }
  insp.hasMetadata = tiffHasDroppable(b);
  try {
    const out = stripTiff(b);
    insp.clean = true;
    insp.strippableBytes = Math.max(0, b.length - out.length);
  } catch (e) {
    insp.walkError = e instanceof Error ? e.message : String(e);
    insp.clean = false;
  }
  const xmpBytes = insp.xmp ? insp.xmp.length : 0;
  const iptcBytes = insp.tiff.iptc ? insp.tiff.iptc.length : 0;
  const rest = Math.max(0, insp.strippableBytes - xmpBytes - iptcBytes);
  if (xmpBytes) insp.sections.push({ label: "XMP", bytes: xmpBytes });
  if (iptcBytes) insp.sections.push({ label: "IPTC", bytes: iptcBytes });
  if (insp.hasMetadata && rest) insp.sections.push({ label: "TIFF metadata tags", bytes: rest });
  if (insp.tiff.iccBytes) insp.sections.push({ label: "ICC profile", bytes: insp.tiff.iccBytes, kept: true });
  insp.hasMetadata = insp.hasMetadata || insp.sections.some((s) => !s.kept);
  return insp;
}

// --------------------------------------------------------- HEIC/AVIF (BMFF)

interface BBox {
  type: string;
  start: number;
  end: number;
  /** Payload start, right after the (possibly 64-bit) size header. */
  body: number;
}

function readBoxList(b: Uint8Array, start: number, end: number): BBox[] {
  const out: BBox[] = [];
  let p = start;
  while (p < end) {
    if (p + 8 > end) throw new Error("Box header out of bounds");
    let size = u32be(b, p);
    const type = ascii(b, p + 4, 4);
    let body = p + 8;
    if (size === 1) {
      if (p + 16 > end) throw new Error("Truncated 64-bit box size");
      size = u32be(b, p + 8) * 4294967296 + u32be(b, p + 12);
      body = p + 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < body - p || p + size > end) throw new Error("Box " + type + " size out of bounds");
    out.push({ type, start: p, end: p + size, body });
    p += size;
  }
  return out;
}

function readN(b: Uint8Array, p: number, size: number): number {
  if (size === 0) return 0;
  if (size === 2) return (b[p] << 8) | b[p + 1];
  if (size === 4) return u32be(b, p);
  if (size === 8) return u32be(b, p) * 4294967296 + u32be(b, p + 4);
  throw new Error("Unsupported field size " + size);
}

interface IlocItem {
  id: number;
  method: number;
  dataRefIdx: number;
  base: number;
  extents: { offset: number; length: number }[];
}

interface IlocParsed {
  box: BBox;
  version: number;
  flags: number;
  offSize: number;
  lenSize: number;
  baseSize: number;
  idxSize: number;
  items: IlocItem[];
}

interface BmffWalk {
  top: BBox[];
  clean: boolean;
  error: string | null;
  meta: BBox | null;
  metaChildren: BBox[];
  items: { id: number; type: string; contentType: string | null; infe: BBox }[];
  iloc: IlocParsed | null;
  iref: { box: BBox; version: number; refs: { type: string; from: number; to: number[] }[] } | null;
  ipmas: { box: BBox; version: number; flags: number; entries: { id: number; assoc: Uint8Array; indexes: number[] }[] }[];
  iprp: BBox | null;
  ipco: BBox | null;
  idat: BBox | null;
  primary: number | null;
  width: number | null;
  height: number | null;
  exifTiff: Uint8Array | null;
  xmp: string | null;
  metaItemIds: Set<number>;
  metaSections: Section[];
}

function parseBmff(b: Uint8Array): BmffWalk {
  const w: BmffWalk = {
    top: [], clean: false, error: null, meta: null, metaChildren: [], items: [],
    iloc: null, iref: null, ipmas: [], iprp: null, ipco: null, idat: null,
    primary: null, width: null, height: null, exifTiff: null, xmp: null,
    metaItemIds: new Set(), metaSections: [],
  };
  try {
    w.top = readBoxList(b, 0, b.length);
    const meta = w.top.find((x) => x.type === "meta");
    if (!meta) { w.clean = true; return w; }
    w.meta = meta;
    w.metaChildren = readBoxList(b, meta.body + 4, meta.end);

    for (const c of w.metaChildren) {
      if (c.type === "pitm") {
        const v = b[c.body];
        w.primary = v < 1 ? readN(b, c.body + 4, 2) : u32be(b, c.body + 4);
      } else if (c.type === "iinf") {
        const v = b[c.body];
        const countSize = v === 0 ? 2 : 4;
        const entriesStart = c.body + 4 + countSize;
        for (const infe of readBoxList(b, entriesStart, c.end)) {
          if (infe.type !== "infe") continue;
          const iv = b[infe.body];
          if (iv < 2) continue;
          let q = infe.body + 4;
          const id = iv === 2 ? readN(b, q, 2) : u32be(b, q);
          q += iv === 2 ? 2 : 4;
          q += 2; // item_protection_index
          const itemType = ascii(b, q, 4);
          q += 4;
          let contentType: string | null = null;
          if (itemType === "mime") {
            while (q < infe.end && b[q] !== 0) q++; // item_name
            q++;
            let ctEnd = q;
            while (ctEnd < infe.end && b[ctEnd] !== 0) ctEnd++;
            contentType = decodeText(b.subarray(q, ctEnd));
          }
          w.items.push({ id, type: itemType, contentType, infe });
        }
      } else if (c.type === "iloc") {
        const v = b[c.body];
        const flags = u32be(b, c.body) & 0xffffff;
        let q = c.body + 4;
        const sizes = (b[q] << 8) | b[q + 1];
        q += 2;
        const offSize = (sizes >> 12) & 0xf;
        const lenSize = (sizes >> 8) & 0xf;
        const baseSize = (sizes >> 4) & 0xf;
        const idxSize = v === 1 || v === 2 ? sizes & 0xf : 0;
        const count = v < 2 ? readN(b, q, 2) : u32be(b, q);
        q += v < 2 ? 2 : 4;
        const items: IlocItem[] = [];
        for (let i = 0; i < count; i++) {
          const id = v < 2 ? readN(b, q, 2) : u32be(b, q);
          q += v < 2 ? 2 : 4;
          let method = 0;
          if (v === 1 || v === 2) {
            method = readN(b, q, 2) & 0xf;
            q += 2;
          }
          const dataRefIdx = readN(b, q, 2);
          q += 2;
          const base = readN(b, q, baseSize);
          q += baseSize;
          const extentCount = readN(b, q, 2);
          q += 2;
          const extents: { offset: number; length: number }[] = [];
          for (let e = 0; e < extentCount; e++) {
            if (idxSize > 0) q += idxSize;
            const offset = readN(b, q, offSize);
            q += offSize;
            const length = readN(b, q, lenSize);
            q += lenSize;
            extents.push({ offset, length });
          }
          items.push({ id, method, dataRefIdx, base, extents });
        }
        w.iloc = { box: c, version: v, flags, offSize, lenSize, baseSize, idxSize, items };
      } else if (c.type === "iref") {
        const v = b[c.body];
        const idSize = v === 0 ? 2 : 4;
        const refs: { type: string; from: number; to: number[] }[] = [];
        for (const rb of readBoxList(b, c.body + 4, c.end)) {
          let q = rb.body;
          const from = readN(b, q, idSize);
          q += idSize;
          const n = readN(b, q, 2);
          q += 2;
          const to: number[] = [];
          for (let i = 0; i < n; i++) { to.push(readN(b, q, idSize)); q += idSize; }
          refs.push({ type: rb.type, from, to });
        }
        w.iref = { box: c, version: v, refs };
      } else if (c.type === "iprp") {
        w.iprp = c;
        for (const pc of readBoxList(b, c.body, c.end)) {
          if (pc.type === "ipco") w.ipco = pc;
          if (pc.type === "ipma") {
            const v = b[pc.body];
            const flags = u32be(b, pc.body) & 0xffffff;
            let q = pc.body + 4;
            const count = u32be(b, q);
            q += 4;
            const entries: { id: number; assoc: Uint8Array; indexes: number[] }[] = [];
            for (let i = 0; i < count; i++) {
              const id = v < 1 ? readN(b, q, 2) : u32be(b, q);
              q += v < 1 ? 2 : 4;
              const n = b[q];
              const assocStart = q;
              q++;
              const indexes: number[] = [];
              for (let a = 0; a < n; a++) {
                if (flags & 1) { indexes.push(((b[q] << 8) | b[q + 1]) & 0x7fff); q += 2; }
                else { indexes.push(b[q] & 0x7f); q += 1; }
              }
              entries.push({ id, assoc: b.slice(assocStart, q), indexes });
            }
            w.ipmas.push({ box: pc, version: v, flags, entries });
          }
        }
      } else if (c.type === "idat") {
        w.idat = c;
      }
    }

    // Metadata items: Exif payloads plus any mime item (XMP and friends).
    for (const item of w.items) {
      if (item.type === "Exif" || item.type === "mime") {
        w.metaItemIds.add(item.id);
        const data = bmffItemData(b, w, item.id);
        const bytes = data ? data.length : 0;
        let label = "Metadata item";
        if (item.type === "Exif") {
          label = "EXIF";
          if (data && data.length > 8 && !w.exifTiff) {
            const off = u32be(data, 0);
            const t = 4 + off;
            if (t + 8 < data.length && (data[t] === 0x49 || data[t] === 0x4d)) {
              w.exifTiff = data.subarray(t);
            } else if (data[4] === 0x49 || data[4] === 0x4d) {
              w.exifTiff = data.subarray(4);
            }
          }
        } else if (item.contentType && /xmp|rdf/i.test(item.contentType)) {
          label = "XMP";
          if (data && w.xmp === null) w.xmp = decodeText(data);
        } else if (item.contentType) {
          label = "Metadata (" + item.contentType + ")";
        }
        w.metaSections.push({ label, bytes });
      }
    }

    // Dimensions: the primary item's ispe property, else the largest ispe.
    if (w.ipco) {
      const props = readBoxList(b, w.ipco.body, w.ipco.end);
      const primaryIdx = w.primary !== null
        ? w.ipmas.flatMap((m) => m.entries).find((e) => e.id === w.primary)?.indexes ?? []
        : [];
      let primIspe: { wd: number; ht: number } | null = null;
      let firstIspe: { wd: number; ht: number } | null = null;
      for (let i = 0; i < props.length; i++) {
        const prop = props[i];
        if (prop.type === "ispe" && prop.end - prop.body >= 12) {
          const size = { wd: u32be(b, prop.body + 4), ht: u32be(b, prop.body + 8) };
          if (primaryIdx.includes(i + 1) && !primIspe) primIspe = size;
          if (!firstIspe) firstIspe = size;
        }
        if (prop.type === "colr") {
          const sub = ascii(b, prop.body, 4);
          if (sub === "rICC" || sub === "prof") {
            w.metaSections.push({ label: "ICC profile", bytes: prop.end - prop.start, kept: true });
          }
        }
      }
      const chosen = primIspe ?? firstIspe;
      if (chosen) { w.width = chosen.wd; w.height = chosen.ht; }
    }

    for (const t of w.top) {
      if (t.type === "free" || t.type === "skip") {
        w.metaSections.push({ label: "Padding (free box)", bytes: t.end - t.start });
      }
    }

    w.clean = true;
  } catch (e) {
    w.error = e instanceof Error ? e.message : String(e);
  }
  return w;
}

function bmffItemData(b: Uint8Array, w: BmffWalk, id: number): Uint8Array | null {
  const item = w.iloc?.items.find((x) => x.id === id);
  if (!item || item.dataRefIdx !== 0) return null;
  const parts: Uint8Array[] = [];
  for (const e of item.extents) {
    if (item.method === 0) {
      const s = item.base + e.offset;
      if (s + e.length > b.length) return null;
      parts.push(b.subarray(s, s + e.length));
    } else if (item.method === 1 && w.idat) {
      const s = w.idat.body + item.base + e.offset;
      if (s + e.length > w.idat.end) return null;
      parts.push(b.subarray(s, s + e.length));
    } else {
      return null;
    }
  }
  return concat(parts);
}

function inspectBmff(b: Uint8Array, format: "heic" | "avif"): Inspection {
  const insp = baseInspection(format);
  const w = parseBmff(b);
  insp.clean = w.clean;
  insp.walkError = w.error;
  insp.width = w.width;
  insp.height = w.height;
  insp.xmp = w.xmp;
  insp.sections = w.metaSections.sort((a, x) => (a.kept ? 1 : 0) - (x.kept ? 1 : 0) || x.bytes - a.bytes);
  insp.strippableBytes = insp.sections.reduce((n, s) => n + (s.kept ? 0 : s.bytes), 0);
  insp.hasMetadata = insp.sections.some((s) => !s.kept);
  tryParseTiff(insp, w.exifTiff);
  if (insp.tiff?.iptc) insp.iptc = parseIptc(insp.tiff.iptc);
  return insp;
}

interface Range { start: number; end: number }

function mergeRanges(ranges: Range[]): Range[] {
  const sorted = ranges.slice().sort((a, b) => a.start - b.start);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ start: r.start, end: r.end });
  }
  return out;
}

function removedBefore(ranges: Range[], pos: number): number {
  let n = 0;
  for (const r of ranges) {
    if (r.end <= pos) n += r.end - r.start;
    else if (r.start < pos) throw new Error("Offset inside removed data");
  }
  return n;
}

class ByteWriter {
  parts: Uint8Array[] = [];
  length = 0;
  raw(b: Uint8Array) { this.parts.push(b); this.length += b.length; }
  u8(v: number) { this.raw(new Uint8Array([v & 0xff])); }
  u16(v: number) { this.raw(new Uint8Array([(v >> 8) & 0xff, v & 0xff])); }
  u32(v: number) { this.raw(new Uint8Array([(v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff])); }
  uN(v: number, size: number) {
    if (size === 0) {
      if (v !== 0) throw new Error("Cannot store offset in zero-width field");
      return;
    }
    if (size === 2) this.u16(v);
    else if (size === 4) this.u32(v);
    else if (size === 8) { this.u32(Math.floor(v / 4294967296)); this.u32(v >>> 0); }
    else throw new Error("Unsupported field size " + size);
  }
  bytes() { return concat(this.parts); }
}

function box(type: string, content: Uint8Array): Uint8Array {
  const w = new ByteWriter();
  w.u32(8 + content.length);
  w.raw(new Uint8Array([type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)]));
  w.raw(content);
  return w.bytes();
}

function fullBoxContent(version: number, flags: number, body: Uint8Array): Uint8Array {
  const w = new ByteWriter();
  w.u32(((version & 0xff) << 24) | (flags & 0xffffff));
  w.raw(body);
  return w.bytes();
}

function stripBmff(b: Uint8Array): StripResult {
  const w = parseBmff(b);
  if (!w.clean) throw new Error(w.error ?? "Container walk failed");
  if (!w.meta || !w.iloc || w.metaItemIds.size === 0) throw new Error("No metadata items to strip");
  const removed = w.metaItemIds;

  const absRanges: Range[] = [];
  const idatRanges: Range[] = [];
  for (const item of w.iloc.items) {
    if (!removed.has(item.id)) continue;
    if (item.dataRefIdx !== 0) throw new Error("Metadata stored in an external file reference");
    for (const e of item.extents) {
      if (item.method === 0) absRanges.push({ start: item.base + e.offset, end: item.base + e.offset + e.length });
      else if (item.method === 1) idatRanges.push({ start: item.base + e.offset, end: item.base + e.offset + e.length });
      else throw new Error("Unsupported iloc construction method " + item.method);
    }
  }
  const mAbs = mergeRanges(absRanges);
  const mIdat = mergeRanges(idatRanges);

  // Every absolute removal must fall inside an mdat body.
  const mdats = w.top.filter((t) => t.type === "mdat");
  for (const r of mAbs) {
    if (!mdats.some((m) => r.start >= m.body && r.end <= m.end)) {
      throw new Error("Metadata bytes stored outside mdat; refusing to strip");
    }
  }
  if (mIdat.length && !w.idat) throw new Error("idat-based metadata without an idat box");

  // Rebuild the small meta children first (sizes are offset-independent).
  const il = w.iloc;
  const keptIloc = il.items.filter((x) => !removed.has(x.id));
  for (const item of keptIloc) {
    if (il.offSize === 0 && (il.baseSize === 0 || item.extents.length !== 1)) {
      throw new Error("Cannot rewrite iloc with zero-width offset fields");
    }
  }

  const newIdat = (() => {
    if (!w.idat) return null;
    if (!mIdat.length) return b.subarray(w.idat.start, w.idat.end);
    const bodyLen = w.idat.end - w.idat.body;
    const parts: Uint8Array[] = [];
    let p = 0;
    for (const r of mIdat) {
      if (r.end > bodyLen) throw new Error("idat removal out of bounds");
      if (r.start > p) parts.push(b.subarray(w.idat.body + p, w.idat.body + r.start));
      p = r.end;
    }
    if (p < bodyLen) parts.push(b.subarray(w.idat.body + p, w.idat.body + bodyLen));
    return box("idat", concat(parts));
  })();

  const newIinf = (() => {
    const iinf = w.metaChildren.find((c) => c.type === "iinf");
    if (!iinf) return null;
    const v = b[iinf.body];
    const keptInfes = w.items.filter((x) => !removed.has(x.id)).map((x) => b.subarray(x.infe.start, x.infe.end));
    // Items with infe versions we skipped during parsing must be preserved.
    const countSize = v === 0 ? 2 : 4;
    const known = new Set(w.items.map((x) => x.infe.start));
    const others: Uint8Array[] = [];
    for (const infe of readBoxList(b, iinf.body + 4 + countSize, iinf.end)) {
      if (!known.has(infe.start)) others.push(b.subarray(infe.start, infe.end));
    }
    const bw = new ByteWriter();
    const total = keptInfes.length + others.length;
    if (v === 0) bw.u16(total); else bw.u32(total);
    for (const x of others) bw.raw(x);
    for (const x of keptInfes) bw.raw(x);
    return box("iinf", fullBoxContent(v, u32be(b, iinf.body) & 0xffffff, bw.bytes()));
  })();

  const newIref = (() => {
    if (!w.iref) return null;
    const idSize = w.iref.version === 0 ? 2 : 4;
    const kept = w.iref.refs
      .filter((r) => !removed.has(r.from))
      .map((r) => ({ ...r, to: r.to.filter((t) => !removed.has(t)) }))
      .filter((r) => r.to.length > 0);
    if (kept.length === 0) return null;
    const bw = new ByteWriter();
    for (const r of kept) {
      const rw = new ByteWriter();
      rw.uN(r.from, idSize);
      rw.u16(r.to.length);
      for (const t of r.to) rw.uN(t, idSize);
      bw.raw(box(r.type, rw.bytes()));
    }
    return box("iref", fullBoxContent(w.iref.version, 0, bw.bytes()));
  })();

  const newIprp = (() => {
    if (!w.iprp) return null;
    const bw = new ByteWriter();
    for (const pc of readBoxList(b, w.iprp.body, w.iprp.end)) {
      const parsed = w.ipmas.find((m) => m.box.start === pc.start);
      if (!parsed) {
        bw.raw(b.subarray(pc.start, pc.end));
        continue;
      }
      const kept = parsed.entries.filter((e) => !removed.has(e.id));
      const ew = new ByteWriter();
      ew.u32(kept.length);
      for (const e of kept) {
        if (parsed.version < 1) ew.u16(e.id); else ew.u32(e.id);
        ew.raw(e.assoc);
      }
      bw.raw(box("ipma", fullBoxContent(parsed.version, parsed.flags, ew.bytes())));
    }
    return box("iprp", bw.bytes());
  })();

  const ilocSize = (() => {
    const idSize = il.version < 2 ? 2 : 4;
    let n = 4 + 2 + (il.version < 2 ? 2 : 4);
    for (const item of keptIloc) {
      n += idSize + (il.version >= 1 ? 2 : 0) + 2 + il.baseSize + 2;
      n += item.extents.length * (il.idxSize + il.offSize + il.lenSize);
    }
    return 8 + n;
  })();

  // meta layout: children in original order, substituting the rebuilt ones.
  if (w.meta.body - w.meta.start !== 8) throw new Error("Unexpected meta box header");
  const metaHeaderLen = 12; // 32-bit size + type + fullbox version/flags
  const childOut: (Uint8Array | { iloc: true })[] = [];
  for (const c of w.metaChildren) {
    if (c.type === "iinf" && newIinf) childOut.push(newIinf);
    else if (c.type === "iloc") childOut.push({ iloc: true });
    else if (c.type === "iref") { if (newIref) childOut.push(newIref); }
    else if (c.type === "iprp" && newIprp) childOut.push(newIprp);
    else if (c.type === "idat" && newIdat) childOut.push(newIdat);
    else childOut.push(b.subarray(c.start, c.end));
  }
  let metaSize = metaHeaderLen;
  for (const c of childOut) metaSize += c instanceof Uint8Array ? c.length : ilocSize;

  // Top-level layout with new positions, building the old-to-new byte map for
  // regions copied verbatim (mdat pieces and untouched boxes).
  interface Piece { oldStart: number; oldEnd: number; newStart: number }
  const pieces: Piece[] = [];
  const topOut: { src: BBox; kind: "verbatim" | "meta" | "mdat" | "drop"; newStart: number; newSize: number }[] = [];
  let cursor = 0;
  for (const t of w.top) {
    if (t.type === "free" || t.type === "skip") {
      topOut.push({ src: t, kind: "drop", newStart: cursor, newSize: 0 });
      continue;
    }
    if (t.type === "meta") {
      topOut.push({ src: t, kind: "meta", newStart: cursor, newSize: metaSize });
      cursor += metaSize;
      continue;
    }
    if (t.type === "mdat") {
      const inside = mAbs.filter((r) => r.start >= t.body && r.end <= t.end);
      let kept = 0;
      let p = t.body;
      const headerLen = t.body - t.start;
      let bodyCursor = cursor + headerLen;
      for (const r of inside) {
        if (r.start > p) {
          pieces.push({ oldStart: p, oldEnd: r.start, newStart: bodyCursor });
          bodyCursor += r.start - p;
          kept += r.start - p;
        }
        p = r.end;
      }
      if (p < t.end) {
        pieces.push({ oldStart: p, oldEnd: t.end, newStart: bodyCursor });
        kept += t.end - p;
      }
      const newSize = headerLen + kept;
      topOut.push({ src: t, kind: "mdat", newStart: cursor, newSize });
      cursor += newSize;
      continue;
    }
    pieces.push({ oldStart: t.start, oldEnd: t.end, newStart: cursor });
    topOut.push({ src: t, kind: "verbatim", newStart: cursor, newSize: t.end - t.start });
    cursor += t.end - t.start;
  }

  const mapRange = (start: number, len: number): number => {
    for (const p of pieces) {
      if (start >= p.oldStart && start + len <= p.oldEnd) return p.newStart + (start - p.oldStart);
    }
    throw new Error("Cannot relocate data at offset " + start);
  };

  // Serialize the new iloc with relocated offsets.
  const newIloc = (() => {
    const bw = new ByteWriter();
    bw.u16((il.offSize << 12) | (il.lenSize << 8) | (il.baseSize << 4) | il.idxSize);
    if (il.version < 2) bw.u16(keptIloc.length); else bw.u32(keptIloc.length);
    for (const item of keptIloc) {
      // Positions are rewritten as base 0 plus an absolute (method 0) or
      // idat-relative (method 1) extent offset; with a zero-width offset field
      // the single extent's position goes into base_offset instead.
      const relocated = (e: { offset: number; length: number }) =>
        item.method === 0
          ? mapRange(item.base + e.offset, e.length)
          : item.base + e.offset - removedBefore(mIdat, item.base + e.offset);
      if (il.version < 2) bw.u16(item.id); else bw.u32(item.id);
      if (il.version >= 1) bw.u16(item.method);
      bw.u16(item.dataRefIdx);
      bw.uN(il.offSize === 0 ? relocated(item.extents[0]) : 0, il.baseSize);
      bw.u16(item.extents.length);
      for (const e of item.extents) {
        if (il.idxSize > 0) bw.uN(0, il.idxSize);
        if (il.offSize > 0) bw.uN(relocated(e), il.offSize);
        bw.uN(e.length, il.lenSize);
      }
    }
    return box("iloc", fullBoxContent(il.version, il.flags, bw.bytes()));
  })();
  if (newIloc.length !== ilocSize) throw new Error("iloc layout error");

  const out = new ByteWriter();
  for (const t of topOut) {
    if (t.kind === "drop") continue;
    if (t.kind === "verbatim") {
      out.raw(b.subarray(t.src.start, t.src.end));
    } else if (t.kind === "mdat") {
      const headerLen = t.src.body - t.src.start;
      if (headerLen === 8) {
        out.u32(t.newSize);
        out.raw(b.subarray(t.src.start + 4, t.src.start + 8));
      } else {
        out.u32(1);
        out.raw(b.subarray(t.src.start + 4, t.src.start + 8));
        out.u32(Math.floor(t.newSize / 4294967296));
        out.u32(t.newSize >>> 0);
      }
      for (const p of pieces) {
        if (p.oldStart >= t.src.body && p.oldEnd <= t.src.end) out.raw(b.subarray(p.oldStart, p.oldEnd));
      }
    } else {
      const mw = new ByteWriter();
      mw.u32(metaSize);
      mw.raw(b.subarray(w.meta!.start + 4, w.meta!.body + 4));
      for (const c of childOut) {
        if (c instanceof Uint8Array) mw.raw(c);
        else mw.raw(newIloc);
      }
      if (mw.length !== metaSize) throw new Error("meta layout error");
      out.raw(mw.bytes());
    }
  }
  if (out.length !== cursor) throw new Error("Output layout error");
  return { out: out.bytes(), keptOrientation: null };
}
