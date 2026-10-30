// Container walking and lossless stripping for JPEG, PNG, WebP, TIFF and
// HEIC/AVIF. Each walk classifies byte ranges as pixel-critical or Metadata;
// a Strip re-emits only the former, never re-encoding. A Strip is refused
// (throws) unless the walk covered the whole container cleanly.

import {
  ByteWriter,
  byteAt,
  concat,
  crc32,
  u16be,
  u32be,
  u32le,
} from "./bytes";
import {
  parseTiff,
  buildOrientationTiff,
  stripTiff,
  tiffHasDroppable,
} from "./exif";
import type { TiffInfo } from "./exif";

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
  avif: "image/avif",
  heic: "image/heic",
  jpeg: "image/jpeg",
  png: "image/png",
  tiff: "image/tiff",
  webp: "image/webp",
};

export const EXT: Record<Format, string> = {
  avif: "avif",
  heic: "heic",
  jpeg: "jpg",
  png: "png",
  tiff: "tif",
  webp: "webp",
};

// --------------------------------------------------------------- shared bits

const ascii = (b: Uint8Array, p: number, n: number): string => {
  let s = "";
  for (let i = 0; i < n && p + i < b.length; i += 1) {
    s += String.fromCodePoint(byteAt(b, p + i));
  }
  return s;
};

/** Whether the ASCII string `s` is at `p`. */
const startsWith = (b: Uint8Array, p: number, s: string): boolean => {
  for (let i = 0; i < s.length; i += 1) {
    if (b[p + i] !== s.codePointAt(i)) {
      return false;
    }
  }
  return true;
};

const decodeText = (b: Uint8Array): string =>
  new TextDecoder().decode(b).replace(/\0+$/u, "");

interface Span {
  start: number;
  end: number;
  keep: boolean;
  /** null for structural spans; a Section label for Metadata; "ICC" style kept sections use keptLabel. */
  label: string | null;
  keptLabel?: string;
}

const baseInspection = (format: Format): Inspection => ({
  clean: false,
  comments: [],
  format,
  hasMetadata: false,
  height: null,
  iptc: [],
  mime: MIME[format],
  sections: [],
  strippableBytes: 0,
  tiff: null,
  walkError: null,
  width: null,
  xmp: null,
});

/** Sections, kept ones last and each group largest first, and the totals they imply. */
const setSections = (insp: Inspection, sections: Section[]) => {
  insp.sections = sections.toSorted(
    (a, b) => (a.kept ? 1 : 0) - (b.kept ? 1 : 0) || b.bytes - a.bytes
  );
  let strippable = 0;
  for (const s of insp.sections) {
    strippable += s.kept ? 0 : s.bytes;
  }
  insp.strippableBytes = strippable;
  insp.hasMetadata = insp.sections.some((s) => !s.kept);
};

const sectionsFromSpans = (insp: Inspection, spans: Span[]) => {
  const agg = new Map<string, Section>();
  for (const s of spans) {
    const label = s.keep ? s.keptLabel : s.label;
    if (!label) {
      continue;
    }
    const key = (s.keep ? "k:" : "s:") + label;
    const sec = agg.get(key) ?? { bytes: 0, kept: s.keep || undefined, label };
    sec.bytes += s.end - s.start;
    agg.set(key, sec);
  }
  setSections(insp, [...agg.values()]);
};

// IPTC IIM datasets (record 2 is the editorial one).
const IPTC_NAMES = new Map<number, string>([
  [5, "Title"],
  [25, "Keywords"],
  [55, "Date created"],
  [60, "Time created"],
  [80, "By-line"],
  [85, "By-line title"],
  [90, "City"],
  [92, "Sublocation"],
  [95, "Province/State"],
  [101, "Country"],
  [103, "Transmission reference"],
  [105, "Headline"],
  [110, "Credit"],
  [115, "Source"],
  [116, "Copyright"],
  [120, "Caption"],
  [122, "Caption writer"],
]);

const parseIptc = (b: Uint8Array): { name: string; value: string }[] => {
  const out: { name: string; value: string }[] = [];
  let p = 0;
  while (p + 5 <= b.length && out.length < 64) {
    if (b[p] !== 0x1c) {
      break;
    }
    const record = b[p + 1];
    const dataset = b[p + 2];
    const len = u16be(b, p + 3);
    p += 5;
    // Extended-length datasets (high bit set) are rare: stop decoding.
    if (len >= 0x80_00) {
      break;
    }
    if (p + len > b.length) {
      break;
    }
    if (record === 2 && dataset !== 0) {
      const name = IPTC_NAMES.get(dataset) ?? `Dataset 2:${dataset}`;
      const value = decodeText(b.subarray(p, p + len));
      if (value) {
        out.push({ name, value });
      }
    }
    p += len;
  }
  return out;
};

const tryParseTiff = (insp: Inspection, tiffBytes: Uint8Array | null) => {
  if (!tiffBytes) {
    return;
  }
  try {
    insp.tiff = parseTiff(tiffBytes);
    if (insp.width === null) {
      insp.width = insp.tiff.width;
    }
    if (insp.height === null) {
      insp.height = insp.tiff.height;
    }
    if (insp.xmp === null) {
      insp.xmp = insp.tiff.xmp;
    }
    if (insp.tiff.iptc && insp.iptc.length === 0) {
      insp.iptc = parseIptc(insp.tiff.iptc);
    }
  } catch {
    // Unreadable EXIF payload: the section still shows and still strips.
  }
};

/** The Orientation an EXIF payload carries, when it is readable and not the default. */
const keptOrientationOf = (exifTiff: Uint8Array | null): number | null => {
  if (!exifTiff) {
    return null;
  }
  try {
    const t = parseTiff(exifTiff);
    if (t.orientation && t.orientation !== 1) {
      return t.orientation;
    }
  } catch {
    /* unreadable EXIF carries no orientation to keep */
  }
  return null;
};

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

interface SegmentClass {
  keep: boolean;
  label: string | null;
  keptLabel?: string;
}

const extract8bimIptc = (
  b: Uint8Array,
  start: number,
  end: number
): Uint8Array | null => {
  let p = start;
  while (p + 12 <= end) {
    if (!startsWith(b, p, "8BIM")) {
      break;
    }
    const id = u16be(b, p + 4);
    let q = p + 6;
    const nameLen = b[q];
    q += 1 + nameLen;
    if ((q - p) % 2) {
      q += 1;
    }
    if (q + 4 > end) {
      break;
    }
    const len = u32be(b, q);
    q += 4;
    if (q + len > end) {
      break;
    }
    if (id === 0x04_04) {
      return b.slice(q, q + len);
    }
    q += len;
    if (len % 2) {
      q += 1;
    }
    p = q;
  }
  return null;
};

/** APP1: EXIF, XMP and its extension, or something else. */
const classifyApp1 = (
  b: Uint8Array,
  payload: number,
  payloadEnd: number,
  w: JpegWalk
): SegmentClass => {
  if (startsWith(b, payload, "Exif\0\0")) {
    if (!w.exifTiff) {
      w.exifTiff = b.subarray(payload + 6, payloadEnd);
    }
    return { keep: false, label: "EXIF" };
  }
  if (startsWith(b, payload, "http://ns.adobe.com/xap/1.0/\0")) {
    if (w.xmp === null) {
      w.xmp = decodeText(b.subarray(payload + 29, payloadEnd));
    }
    return { keep: false, label: "XMP" };
  }
  if (startsWith(b, payload, "http://ns.adobe.com/xmp/extension/\0")) {
    return { keep: false, label: "XMP (extended)" };
  }
  return { keep: false, label: "APP1 segment" };
};

/** An APPn segment other than APP1. */
const classifyApp = (
  b: Uint8Array,
  appN: number,
  payload: number,
  payloadEnd: number,
  w: JpegWalk
): SegmentClass => {
  if (appN === 0) {
    if (startsWith(b, payload, "JFIF\0")) {
      return { keep: true, label: null };
    }
    if (startsWith(b, payload, "JFXX\0")) {
      return { keep: false, label: "JFXX thumbnail" };
    }
    return { keep: false, label: "APP0 segment" };
  }
  if (appN === 2) {
    if (startsWith(b, payload, "ICC_PROFILE\0")) {
      return { keep: true, keptLabel: "ICC profile", label: null };
    }
    if (startsWith(b, payload, "MPF\0")) {
      return { keep: false, label: "MPF (multi-picture)" };
    }
    return { keep: false, label: "APP2 segment" };
  }
  if (appN === 13) {
    if (startsWith(b, payload, "Photoshop 3.0\0")) {
      if (!w.iptcRaw) {
        w.iptcRaw = extract8bimIptc(b, payload + 14, payloadEnd);
      }
      return { keep: false, label: "IPTC / Photoshop" };
    }
    return { keep: false, label: "APP13 segment" };
  }
  if (appN === 14 && startsWith(b, payload, "Adobe")) {
    return { keep: true, label: null };
  }
  return { keep: false, label: `APP${appN} segment` };
};

const classifyJpegSegment = (
  b: Uint8Array,
  marker: number,
  payload: number,
  payloadEnd: number,
  w: JpegWalk
): SegmentClass => {
  if (marker === 0xfe) {
    const text = decodeText(
      b.subarray(payload, Math.min(payloadEnd, payload + 500))
    ).trim();
    if (text) {
      w.comments.push(text);
    }
    return { keep: false, label: "Comment" };
  }
  if (marker === 0xe1) {
    return classifyApp1(b, payload, payloadEnd, w);
  }
  if (marker >= 0xe0 && marker <= 0xef) {
    return classifyApp(b, marker - 0xe0, payload, payloadEnd, w);
  }

  const isSof =
    marker >= 0xc0 &&
    marker <= 0xcf &&
    marker !== 0xc4 &&
    marker !== 0xc8 &&
    marker !== 0xcc;
  if (isSof && payloadEnd - payload >= 5) {
    w.height = u16be(b, payload + 1);
    w.width = u16be(b, payload + 3);
  }
  return { keep: true, label: null };
};

/**
 * Where entropy-coded data starting at `pos` ends, or -1 when the file ends
 * first: stuffed 0xFF00 and restart markers stay inside the scan; any other
 * marker ends it.
 */
const scanEnd = (b: Uint8Array, pos: number): number => {
  let i = pos;
  while (i + 1 < b.length) {
    if (b[i] !== 0xff) {
      i += 1;
      continue;
    }
    const n = b[i + 1];
    if (n === 0x00 || (n >= 0xd0 && n <= 0xd7)) {
      i += 2;
    } else if (n === 0xff) {
      i += 1;
    } else {
      return i;
    }
  }
  return -1;
};

/** The marker at `pos`, past any 0xFF fill bytes: its index and value, or an error. */
const readMarker = (
  b: Uint8Array,
  pos: number
): { mpos: number; marker: number } | { error: string } => {
  if (pos + 2 > b.length) {
    return { error: "Truncated before EOI marker" };
  }
  if (b[pos] !== 0xff) {
    return { error: `Corrupt structure at offset ${pos}` };
  }
  let mpos = pos;
  while (mpos < b.length && b[mpos] === 0xff) {
    mpos += 1;
  }
  if (mpos >= b.length) {
    return { error: "Truncated before EOI marker" };
  }
  return { marker: b[mpos], mpos };
};

/** The segment after a marker: where it ends, or an error. */
const segmentEnd = (
  b: Uint8Array,
  mpos: number
): { segEnd: number } | { error: string } => {
  if (mpos + 3 > b.length) {
    return { error: "Truncated segment header" };
  }
  const len = u16be(b, mpos + 1);
  if (len < 2) {
    return { error: `Invalid segment length at offset ${mpos}` };
  }
  const segEnd = mpos + 1 + len;
  if (segEnd > b.length) {
    return { error: "Segment extends past end of file" };
  }
  return { segEnd };
};

const walkJpeg = (b: Uint8Array): JpegWalk => {
  const w: JpegWalk = {
    clean: false,
    comments: [],
    error: null,
    exifTiff: null,
    height: null,
    iptcRaw: null,
    spans: [],
    width: null,
    xmp: null,
  };
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) {
    w.error = "Not a JPEG (missing SOI marker)";
    return w;
  }
  w.spans.push({ end: 2, keep: true, label: null, start: 0 });
  let pos = 2;
  for (;;) {
    const at = readMarker(b, pos);
    if ("error" in at) {
      w.error = at.error;
      return w;
    }
    const { marker, mpos } = at;

    if (marker === 0xd9) {
      w.spans.push({ end: mpos + 1, keep: true, label: null, start: pos });
      if (mpos + 1 < b.length) {
        w.spans.push({
          end: b.length,
          keep: false,
          label: "Trailing data after EOI",
          start: mpos + 1,
        });
      }
      w.clean = true;
      return w;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      w.spans.push({ end: mpos + 1, keep: true, label: null, start: pos });
      pos = mpos + 1;
      continue;
    }
    const seg = segmentEnd(b, mpos);
    if ("error" in seg) {
      w.error = seg.error;
      return w;
    }
    const { segEnd } = seg;
    const cls = classifyJpegSegment(b, marker, mpos + 3, segEnd, w);
    w.spans.push({
      end: segEnd,
      keep: cls.keep,
      keptLabel: cls.keptLabel,
      label: cls.label,
      start: pos,
    });
    pos = segEnd;

    if (marker === 0xda) {
      const end = scanEnd(b, pos);
      if (end < 0) {
        w.error = "Truncated inside scan data";
        return w;
      }
      w.spans.push({ end, keep: true, label: null, start: pos });
      pos = end;
    }
  }
};

const inspectJpeg = (b: Uint8Array): Inspection => {
  const insp = baseInspection("jpeg");
  const w = walkJpeg(b);
  insp.clean = w.clean;
  insp.walkError = w.error;
  insp.width = w.width;
  insp.height = w.height;
  insp.comments = w.comments;
  insp.xmp = w.xmp;
  if (w.iptcRaw) {
    insp.iptc = parseIptc(w.iptcRaw);
  }
  sectionsFromSpans(insp, w.spans);
  tryParseTiff(insp, w.exifTiff);
  return insp;
};

/** An APP1 EXIF segment holding only the Orientation. */
const orientationApp1 = (orientation: number): Uint8Array => {
  const tiff = buildOrientationTiff(orientation);
  const app1 = new Uint8Array(4 + 6 + tiff.length);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  new DataView(app1.buffer).setUint16(2, 2 + 6 + tiff.length);
  app1.set([0x45, 0x78, 0x69, 0x66, 0, 0], 4);
  app1.set(tiff, 10);
  return app1;
};

const stripJpeg = (b: Uint8Array): StripResult => {
  const w = walkJpeg(b);
  if (!w.clean) {
    throw new Error(w.error ?? "JPEG walk failed");
  }
  const orientation = keptOrientationOf(w.exifTiff);
  const parts: Uint8Array[] = [];
  let first = true;
  for (const s of w.spans) {
    if (!s.keep) {
      continue;
    }
    parts.push(b.subarray(s.start, s.end));
    if (first) {
      first = false;
      if (orientation !== null) {
        parts.push(orientationApp1(orientation));
      }
    }
  }
  return { keptOrientation: orientation, out: concat(parts) };
};

// ---------------------------------------------------------------------- PNG

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

/** Where the text of an iTXt chunk starts: keyword\0 compFlag compMethod lang\0 translated\0 text. */
const itxtTextStart = (
  b: Uint8Array,
  kwEnd: number,
  dataEnd: number
): number => {
  let q = kwEnd + 3;
  while (q < dataEnd && b[q] !== 0) {
    q += 1;
  }
  q += 1;
  while (q < dataEnd && b[q] !== 0) {
    q += 1;
  }
  return q + 1;
};

/** A text chunk's label; XMP in iTXt is read, plain tEXt kept as a comment. */
const textChunkLabel = (
  b: Uint8Array,
  type: string,
  dataStart: number,
  dataEnd: number,
  w: PngWalk
): string => {
  let kwEnd = dataStart;
  while (kwEnd < dataEnd && b[kwEnd] !== 0) {
    kwEnd += 1;
  }
  const keyword = decodeText(b.subarray(dataStart, kwEnd));
  if (type === "iTXt" && keyword === XMP_KEYWORD) {
    const compFlag = b[kwEnd + 1];
    const q = itxtTextStart(b, kwEnd, dataEnd);
    if (w.xmp === null && compFlag === 0 && q <= dataEnd) {
      w.xmp = decodeText(b.subarray(q, dataEnd));
    }
    return "XMP";
  }
  if (type === "tEXt") {
    const value = decodeText(
      b.subarray(kwEnd + 1, Math.min(dataEnd, kwEnd + 1 + 500))
    ).trim();
    if (value) {
      w.comments.push(`${keyword}: ${value}`);
    }
  }
  return type === "zTXt" || (type === "iTXt" && b[kwEnd + 1] === 1)
    ? `Text, compressed (${keyword})`
    : `Text (${keyword})`;
};

/** How a chunk is kept or stripped, reading what it holds along the way. */
const classifyPngChunk = (
  b: Uint8Array,
  type: string,
  dataStart: number,
  len: number,
  w: PngWalk
): { keep: boolean; label: string | null } => {
  if (type === "eXIf") {
    if (!w.exifTiff) {
      w.exifTiff = b.subarray(dataStart, dataStart + len);
    }
    return { keep: false, label: "EXIF" };
  }
  if (type === "tIME") {
    return { keep: false, label: "Modification time" };
  }
  if (PNG_TEXT_CHUNKS.has(type)) {
    return {
      keep: false,
      label: textChunkLabel(b, type, dataStart, dataStart + len, w),
    };
  }
  if (type === "IHDR" && len >= 8) {
    w.width = u32be(b, dataStart);
    w.height = u32be(b, dataStart + 4);
    w.ihdrEnd = dataStart + len + 4;
  }
  return { keep: true, label: null };
};

const walkPng = (b: Uint8Array): PngWalk => {
  const w: PngWalk = {
    clean: false,
    comments: [],
    error: null,
    exifTiff: null,
    height: null,
    ihdrEnd: 8,
    spans: [],
    width: null,
    xmp: null,
  };
  if (b.length < 8) {
    w.error = "Truncated PNG signature";
    return w;
  }
  w.spans.push({ end: 8, keep: true, label: null, start: 0 });
  let p = 8;
  for (;;) {
    if (p + 12 > b.length) {
      w.error = "Truncated before IEND chunk";
      return w;
    }
    const len = u32be(b, p);
    const type = ascii(b, p + 4, 4);
    const dataStart = p + 8;
    const chunkEnd = dataStart + len + 4;
    if (chunkEnd > b.length) {
      w.error = `Chunk ${type} extends past end of file`;
      return w;
    }
    if (crc32(b, p + 4, dataStart + len) !== u32be(b, dataStart + len)) {
      w.error = `CRC mismatch in ${type} chunk`;
      return w;
    }

    if (type === "iCCP") {
      w.spans.push({
        end: chunkEnd,
        keep: true,
        keptLabel: "ICC profile",
        label: null,
        start: p,
      });
    } else {
      const { keep, label } = classifyPngChunk(b, type, dataStart, len, w);
      w.spans.push({ end: chunkEnd, keep, label, start: p });
    }
    p = chunkEnd;
    if (type === "IEND") {
      if (p < b.length) {
        w.spans.push({
          end: b.length,
          keep: false,
          label: "Trailing data",
          start: p,
        });
      }
      w.clean = true;
      return w;
    }
  }
};

const inspectPng = (b: Uint8Array): Inspection => {
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
};

const pngChunk = (type: string, data: Uint8Array): Uint8Array => {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) {
    out[4 + i] = type.codePointAt(i) ?? 0;
  }
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
};

const stripPng = (b: Uint8Array): StripResult => {
  const w = walkPng(b);
  if (!w.clean) {
    throw new Error(w.error ?? "PNG walk failed");
  }
  const orientation = keptOrientationOf(w.exifTiff);
  const parts: Uint8Array[] = [];
  for (const s of w.spans) {
    if (!s.keep) {
      continue;
    }
    parts.push(b.subarray(s.start, s.end));
    if (s.end === w.ihdrEnd && orientation !== null) {
      parts.push(pngChunk("eXIf", buildOrientationTiff(orientation)));
    }
  }
  return { keptOrientation: orientation, out: concat(parts) };
};

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

/** How a chunk is kept or stripped, reading EXIF and XMP along the way. */
const classifyWebpChunk = (
  b: Uint8Array,
  fourcc: string,
  dataStart: number,
  size: number,
  w: WebpWalk
): SegmentClass => {
  if (fourcc === "EXIF") {
    if (!w.exifTiff) {
      const skip = startsWith(b, dataStart, "Exif\0\0") ? 6 : 0;
      w.exifTiff = b.subarray(dataStart + skip, dataStart + size);
    }
    return { keep: false, label: "EXIF" };
  }
  if (fourcc === "XMP ") {
    if (w.xmp === null) {
      w.xmp = decodeText(b.subarray(dataStart, dataStart + size));
    }
    return { keep: false, label: "XMP" };
  }
  if (fourcc === "ICCP") {
    return { keep: true, keptLabel: "ICC profile", label: null };
  }
  if (!WEBP_KEEP.has(fourcc)) {
    return { keep: false, label: `${fourcc.trim()} chunk` };
  }
  return { keep: true, label: null };
};

/**
 * Canvas size from the chunk that carries it: VP8X (24-bit sizes less one),
 * a VP8 key frame (14-bit sizes), or a VP8L header (14-bit sizes less one).
 */
const readWebpSize = (
  b: Uint8Array,
  fourcc: string,
  d: number,
  size: number,
  w: WebpWalk
) => {
  if (fourcc === "VP8X" && size >= 10) {
    w.width = 1 + b[d + 4] + b[d + 5] * 0x1_00 + b[d + 6] * 0x1_00_00;
    w.height = 1 + b[d + 7] + b[d + 8] * 0x1_00 + b[d + 9] * 0x1_00_00;
  }
  if (
    fourcc === "VP8 " &&
    w.width === null &&
    size >= 10 &&
    b[d + 3] === 0x9d &&
    b[d + 4] === 0x01 &&
    b[d + 5] === 0x2a
  ) {
    // The top two bits of each are the scale, not the size.
    w.width = (b[d + 6] + b[d + 7] * 0x1_00) % 0x40_00;
    w.height = (b[d + 8] + b[d + 9] * 0x1_00) % 0x40_00;
  }
  if (fourcc === "VP8L" && w.width === null && size >= 5 && b[d] === 0x2f) {
    // Width-1 in bits 0-13 of the four bytes after the signature, height-1 in bits 14-27.
    w.width = 1 + b[d + 1] + (b[d + 2] % 0x40) * 0x1_00;
    w.height =
      1 +
      Math.floor(b[d + 2] / 0x40) +
      b[d + 3] * 4 +
      (b[d + 4] % 0x10) * 0x4_00;
  }
};

const walkWebp = (b: Uint8Array): WebpWalk => {
  const w: WebpWalk = {
    clean: false,
    error: null,
    exifTiff: null,
    height: null,
    spans: [],
    vp8x: null,
    width: null,
    xmp: null,
  };
  const riffSize = u32le(b, 4);
  const fileEnd = 8 + riffSize;
  if (fileEnd > b.length) {
    w.error = "RIFF size extends past end of file";
    return w;
  }
  w.spans.push({ end: 12, keep: true, label: null, start: 0 });
  let p = 12;
  while (p < fileEnd) {
    if (p + 8 > fileEnd) {
      w.error = "Truncated chunk header";
      return w;
    }
    const fourcc = ascii(b, p, 4);
    const size = u32le(b, p + 4);
    const dataStart = p + 8;
    // Chunks are padded to an even length.
    const chunkEnd = dataStart + size + (size % 2);
    if (dataStart + size > fileEnd) {
      w.error = `Chunk ${fourcc} extends past RIFF size`;
      return w;
    }

    const { keep, label, keptLabel } = classifyWebpChunk(
      b,
      fourcc,
      dataStart,
      size,
      w
    );
    if (fourcc === "VP8X" && size >= 10) {
      w.vp8x = { end: chunkEnd, start: p };
    }
    readWebpSize(b, fourcc, dataStart, size, w);

    w.spans.push({
      end: Math.min(chunkEnd, fileEnd),
      keep,
      keptLabel,
      label,
      start: p,
    });
    p = chunkEnd;
  }
  if (fileEnd < b.length) {
    w.spans.push({
      end: b.length,
      keep: false,
      label: "Trailing data",
      start: fileEnd,
    });
  }
  w.clean = true;
  return w;
};

const inspectWebp = (b: Uint8Array): Inspection => {
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
};

/** VP8X flag bits for EXIF (0x08) and XMP (0x04). */
const VP8X_EXIF = 0x08;
/** Where a VP8X chunk's flags byte is: right after the 8-byte chunk header. */
const VP8X_FLAGS_AT = 8;

/** A VP8X chunk with the EXIF and XMP flags cleared, and EXIF set again when an Orientation is kept. */
const patchVp8x = (chunk: Uint8Array, keepExif: boolean): Uint8Array => {
  const patched = new Uint8Array(chunk);
  const flags = patched[VP8X_FLAGS_AT];
  // Bits 2 and 3: what remains of the low nibble above its low two bits.
  patched[VP8X_FLAGS_AT] = flags - ((flags % 0x10) - (flags % 0x04));
  if (keepExif) {
    patched[VP8X_FLAGS_AT] += VP8X_EXIF;
  }
  return patched;
};

/** An EXIF chunk holding only the Orientation. */
const orientationExifChunk = (orientation: number): Uint8Array => {
  const tiff = buildOrientationTiff(orientation);
  const chunk = new Uint8Array(8 + tiff.length);
  chunk.set([0x45, 0x58, 0x49, 0x46], 0);
  new DataView(chunk.buffer).setUint16(4, tiff.length, true);
  chunk.set(tiff, 8);
  return chunk;
};

const stripWebp = (b: Uint8Array): StripResult => {
  const w = walkWebp(b);
  if (!w.clean) {
    throw new Error(w.error ?? "WebP walk failed");
  }
  const orientation = w.vp8x ? keptOrientationOf(w.exifTiff) : null;
  const parts: Uint8Array[] = [];
  for (const s of w.spans) {
    if (!s.keep) {
      continue;
    }
    if (w.vp8x && s.start === w.vp8x.start) {
      parts.push(patchVp8x(b.subarray(s.start, s.end), orientation !== null));
    } else {
      parts.push(b.subarray(s.start, s.end));
    }
  }
  if (orientation !== null) {
    parts.push(orientationExifChunk(orientation));
  }
  const out = concat(parts);
  new DataView(out.buffer).setUint32(4, out.length - 8, true);
  return { keptOrientation: orientation, out };
};

// --------------------------------------------------------------------- TIFF

/** The Sections of a standalone TIFF: XMP, IPTC, the other droppable tags, and ICC. */
const tiffSections = (insp: Inspection, tiff: TiffInfo) => {
  const xmpBytes = insp.xmp ? insp.xmp.length : 0;
  const iptcBytes = tiff.iptc ? tiff.iptc.length : 0;
  const rest = Math.max(0, insp.strippableBytes - xmpBytes - iptcBytes);
  if (xmpBytes) {
    insp.sections.push({ bytes: xmpBytes, label: "XMP" });
  }
  if (iptcBytes) {
    insp.sections.push({ bytes: iptcBytes, label: "IPTC" });
  }
  if (insp.hasMetadata && rest) {
    insp.sections.push({ bytes: rest, label: "TIFF metadata tags" });
  }
  if (tiff.iccBytes) {
    insp.sections.push({
      bytes: tiff.iccBytes,
      kept: true,
      label: "ICC profile",
    });
  }
  insp.hasMetadata ||= insp.sections.some((s) => !s.kept);
};

const inspectTiff = (b: Uint8Array): Inspection => {
  const insp = baseInspection("tiff");
  let tiff: TiffInfo;
  try {
    tiff = parseTiff(b);
    insp.tiff = tiff;
    insp.width = tiff.width;
    insp.height = tiff.height;
    insp.xmp = tiff.xmp;
    if (tiff.iptc) {
      insp.iptc = parseIptc(tiff.iptc);
    }
  } catch (error) {
    insp.walkError = error instanceof Error ? error.message : String(error);
    return insp;
  }
  insp.hasMetadata = tiffHasDroppable(b);
  try {
    const out = stripTiff(b);
    insp.clean = true;
    insp.strippableBytes = Math.max(0, b.length - out.length);
  } catch (error) {
    insp.walkError = error instanceof Error ? error.message : String(error);
    insp.clean = false;
  }
  tiffSections(insp, tiff);
  return insp;
};

// --------------------------------------------------------- HEIC/AVIF (BMFF)

interface BBox {
  type: string;
  start: number;
  end: number;
  /** Payload start, right after the (possibly 64-bit) size header. */
  body: number;
}

const readBoxList = (b: Uint8Array, start: number, end: number): BBox[] => {
  const out: BBox[] = [];
  let p = start;
  while (p < end) {
    if (p + 8 > end) {
      throw new Error("Box header out of bounds");
    }
    let size = u32be(b, p);
    const type = ascii(b, p + 4, 4);
    let body = p + 8;
    if (size === 1) {
      if (p + 16 > end) {
        throw new Error("Truncated 64-bit box size");
      }
      size = u32be(b, p + 8) * 4_294_967_296 + u32be(b, p + 12);
      body = p + 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < body - p || p + size > end) {
      throw new Error(`Box ${type} size out of bounds`);
    }
    out.push({ body, end: p + size, start: p, type });
    p += size;
  }
  return out;
};

const readN = (b: Uint8Array, p: number, size: number): number => {
  if (size === 0) {
    return 0;
  }
  if (size === 2) {
    return u16be(b, p);
  }
  if (size === 4) {
    return u32be(b, p);
  }
  if (size === 8) {
    return u32be(b, p) * 4_294_967_296 + u32be(b, p + 4);
  }
  throw new Error(`Unsupported field size ${size}`);
};

/** The 24-bit flags of a full box whose version byte is at `p`. */
const fullBoxFlags = (b: Uint8Array, p: number): number =>
  u32be(b, p) % 0x1_00_00_00;

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

interface IpmaEntry {
  id: number;
  assoc: Uint8Array;
  indexes: number[];
}

interface Ipma {
  box: BBox;
  version: number;
  flags: number;
  entries: IpmaEntry[];
}

interface BmffItem {
  id: number;
  type: string;
  contentType: string | null;
  infe: BBox;
}

interface BmffWalk {
  top: BBox[];
  clean: boolean;
  error: string | null;
  meta: BBox | null;
  metaChildren: BBox[];
  items: BmffItem[];
  iloc: IlocParsed | null;
  iref: {
    box: BBox;
    version: number;
    refs: { type: string; from: number; to: number[] }[];
  } | null;
  ipmas: Ipma[];
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

/** One infe box (versions 2 and up), or null for older versions. */
const parseInfe = (b: Uint8Array, infe: BBox): BmffItem | null => {
  const iv = b[infe.body];
  if (iv < 2) {
    return null;
  }
  let q = infe.body + 4;
  const id = iv === 2 ? readN(b, q, 2) : u32be(b, q);
  q += iv === 2 ? 2 : 4;
  // item_protection_index
  q += 2;
  const itemType = ascii(b, q, 4);
  q += 4;
  let contentType: string | null = null;
  if (itemType === "mime") {
    // item_name, then content_type
    while (q < infe.end && b[q] !== 0) {
      q += 1;
    }
    q += 1;
    let ctEnd = q;
    while (ctEnd < infe.end && b[ctEnd] !== 0) {
      ctEnd += 1;
    }
    contentType = decodeText(b.subarray(q, ctEnd));
  }
  return { contentType, id, infe, type: itemType };
};

const parseIinf = (b: Uint8Array, c: BBox): BmffItem[] => {
  const v = b[c.body];
  const countSize = v === 0 ? 2 : 4;
  const entriesStart = c.body + 4 + countSize;
  const items: BmffItem[] = [];
  for (const infe of readBoxList(b, entriesStart, c.end)) {
    if (infe.type !== "infe") {
      continue;
    }
    const item = parseInfe(b, infe);
    if (item) {
      items.push(item);
    }
  }
  return items;
};

const parseIloc = (b: Uint8Array, c: BBox): IlocParsed => {
  const v = b[c.body];
  const flags = fullBoxFlags(b, c.body);
  let q = c.body + 4;
  // Four nibbles: offset_size, length_size, base_offset_size, index_size (v1 and v2).
  const sizes = u16be(b, q);
  q += 2;
  const offSize = Math.floor(sizes / 0x10_00);
  const lenSize = Math.floor(sizes / 0x1_00) % 0x10;
  const baseSize = Math.floor(sizes / 0x10) % 0x10;
  const idxSize = v === 1 || v === 2 ? sizes % 0x10 : 0;
  const count = v < 2 ? readN(b, q, 2) : u32be(b, q);
  q += v < 2 ? 2 : 4;
  const items: IlocItem[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = v < 2 ? readN(b, q, 2) : u32be(b, q);
    q += v < 2 ? 2 : 4;
    let method = 0;
    if (v === 1 || v === 2) {
      // construction_method is the low nibble.
      method = readN(b, q, 2) % 0x10;
      q += 2;
    }
    const dataRefIdx = readN(b, q, 2);
    q += 2;
    const base = readN(b, q, baseSize);
    q += baseSize;
    const extentCount = readN(b, q, 2);
    q += 2;
    const extents: { offset: number; length: number }[] = [];
    for (let e = 0; e < extentCount; e += 1) {
      if (idxSize > 0) {
        q += idxSize;
      }
      const offset = readN(b, q, offSize);
      q += offSize;
      const length = readN(b, q, lenSize);
      q += lenSize;
      extents.push({ length, offset });
    }
    items.push({ base, dataRefIdx, extents, id, method });
  }
  return {
    baseSize,
    box: c,
    flags,
    idxSize,
    items,
    lenSize,
    offSize,
    version: v,
  };
};

const parseIref = (b: Uint8Array, c: BBox): BmffWalk["iref"] => {
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
    for (let i = 0; i < n; i += 1) {
      to.push(readN(b, q, idSize));
      q += idSize;
    }
    refs.push({ from, to, type: rb.type });
  }
  return { box: c, refs, version: v };
};

const parseIpma = (b: Uint8Array, pc: BBox): Ipma => {
  const v = b[pc.body];
  const flags = fullBoxFlags(b, pc.body);
  // Flag bit 0: property indexes are 15 bits wide rather than 7.
  const wide = flags % 2 === 1;
  let q = pc.body + 4;
  const count = u32be(b, q);
  q += 4;
  const entries: IpmaEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = v < 1 ? readN(b, q, 2) : u32be(b, q);
    q += v < 1 ? 2 : 4;
    const n = b[q];
    const assocStart = q;
    q += 1;
    const indexes: number[] = [];
    for (let a = 0; a < n; a += 1) {
      // The top bit of each is the essential flag.
      if (wide) {
        indexes.push(u16be(b, q) % 0x80_00);
        q += 2;
      } else {
        indexes.push(byteAt(b, q) % 0x80);
        q += 1;
      }
    }
    entries.push({ assoc: b.slice(assocStart, q), id, indexes });
  }
  return { box: pc, entries, flags, version: v };
};

const parseIprp = (b: Uint8Array, c: BBox, w: BmffWalk) => {
  w.iprp = c;
  for (const pc of readBoxList(b, c.body, c.end)) {
    if (pc.type === "ipco") {
      w.ipco = pc;
    }
    if (pc.type === "ipma") {
      w.ipmas.push(parseIpma(b, pc));
    }
  }
};

const parseMetaChild = (b: Uint8Array, c: BBox, w: BmffWalk) => {
  if (c.type === "pitm") {
    const v = b[c.body];
    w.primary = v < 1 ? readN(b, c.body + 4, 2) : u32be(b, c.body + 4);
  } else if (c.type === "iinf") {
    w.items.push(...parseIinf(b, c));
  } else if (c.type === "iloc") {
    w.iloc = parseIloc(b, c);
  } else if (c.type === "iref") {
    w.iref = parseIref(b, c);
  } else if (c.type === "iprp") {
    parseIprp(b, c, w);
  } else if (c.type === "idat") {
    w.idat = c;
  }
};

const bmffItemData = (
  b: Uint8Array,
  w: BmffWalk,
  id: number
): Uint8Array | null => {
  const item = w.iloc?.items.find((x) => x.id === id);
  if (!item || item.dataRefIdx !== 0) {
    return null;
  }
  const parts: Uint8Array[] = [];
  for (const e of item.extents) {
    if (item.method === 0) {
      const s = item.base + e.offset;
      if (s + e.length > b.length) {
        return null;
      }
      parts.push(b.subarray(s, s + e.length));
    } else if (item.method === 1 && w.idat) {
      const s = w.idat.body + item.base + e.offset;
      if (s + e.length > w.idat.end) {
        return null;
      }
      parts.push(b.subarray(s, s + e.length));
    } else {
      return null;
    }
  }
  return concat(parts);
};

/** The TIFF inside an Exif item: after a 4-byte offset to it, or right after the offset field. */
const exifItemTiff = (data: Uint8Array): Uint8Array | null => {
  const off = u32be(data, 0);
  const t = 4 + off;
  if (t + 8 < data.length && (data[t] === 0x49 || data[t] === 0x4d)) {
    return data.subarray(t);
  }
  if (data[4] === 0x49 || data[4] === 0x4d) {
    return data.subarray(4);
  }
  return null;
};

/** Metadata items: Exif payloads plus any mime item (XMP and friends). */
const readMetadataItems = (b: Uint8Array, w: BmffWalk) => {
  for (const item of w.items) {
    if (item.type !== "Exif" && item.type !== "mime") {
      continue;
    }
    w.metaItemIds.add(item.id);
    const data = bmffItemData(b, w, item.id);
    const bytes = data ? data.length : 0;
    let label = "Metadata item";
    if (item.type === "Exif") {
      label = "EXIF";
      if (data && data.length > 8 && !w.exifTiff) {
        const tiff = exifItemTiff(data);
        if (tiff) {
          w.exifTiff = tiff;
        }
      }
    } else if (item.contentType && /xmp|rdf/iu.test(item.contentType)) {
      label = "XMP";
      if (data && w.xmp === null) {
        w.xmp = decodeText(data);
      }
    } else if (item.contentType) {
      label = `Metadata (${item.contentType})`;
    }
    w.metaSections.push({ bytes, label });
  }
};

/** Dimensions: the primary item's ispe property, else the first ispe. ICC profiles are noted as kept. */
const readProperties = (b: Uint8Array, w: BmffWalk, ipco: BBox) => {
  const props = readBoxList(b, ipco.body, ipco.end);
  const primaryIdx =
    w.primary === null
      ? []
      : (w.ipmas.flatMap((m) => m.entries).find((e) => e.id === w.primary)
          ?.indexes ?? []);
  let primIspe: { wd: number; ht: number } | null = null;
  let firstIspe: { wd: number; ht: number } | null = null;
  for (const [i, prop] of props.entries()) {
    if (prop.type === "ispe" && prop.end - prop.body >= 12) {
      const size = {
        ht: u32be(b, prop.body + 8),
        wd: u32be(b, prop.body + 4),
      };
      if (primaryIdx.includes(i + 1) && !primIspe) {
        primIspe = size;
      }
      firstIspe ??= size;
    }
    if (prop.type === "colr") {
      const sub = ascii(b, prop.body, 4);
      if (sub === "rICC" || sub === "prof") {
        w.metaSections.push({
          bytes: prop.end - prop.start,
          kept: true,
          label: "ICC profile",
        });
      }
    }
  }
  const chosen = primIspe ?? firstIspe;
  if (chosen) {
    w.width = chosen.wd;
    w.height = chosen.ht;
  }
};

const parseBmff = (b: Uint8Array): BmffWalk => {
  const w: BmffWalk = {
    clean: false,
    error: null,
    exifTiff: null,
    height: null,
    idat: null,
    iloc: null,
    ipco: null,
    ipmas: [],
    iprp: null,
    iref: null,
    items: [],
    meta: null,
    metaChildren: [],
    metaItemIds: new Set(),
    metaSections: [],
    primary: null,
    top: [],
    width: null,
    xmp: null,
  };
  try {
    w.top = readBoxList(b, 0, b.length);
    const meta = w.top.find((x) => x.type === "meta");
    if (!meta) {
      w.clean = true;
      return w;
    }
    w.meta = meta;
    w.metaChildren = readBoxList(b, meta.body + 4, meta.end);
    for (const c of w.metaChildren) {
      parseMetaChild(b, c, w);
    }
    readMetadataItems(b, w);
    if (w.ipco) {
      readProperties(b, w, w.ipco);
    }
    for (const t of w.top) {
      if (t.type === "free" || t.type === "skip") {
        w.metaSections.push({
          bytes: t.end - t.start,
          label: "Padding (free box)",
        });
      }
    }
    w.clean = true;
  } catch (error) {
    w.error = error instanceof Error ? error.message : String(error);
  }
  return w;
};

const inspectBmff = (b: Uint8Array, format: "heic" | "avif"): Inspection => {
  const insp = baseInspection(format);
  const w = parseBmff(b);
  insp.clean = w.clean;
  insp.walkError = w.error;
  insp.width = w.width;
  insp.height = w.height;
  insp.xmp = w.xmp;
  setSections(insp, w.metaSections);
  tryParseTiff(insp, w.exifTiff);
  if (insp.tiff?.iptc) {
    insp.iptc = parseIptc(insp.tiff.iptc);
  }
  return insp;
};

interface Range {
  start: number;
  end: number;
}

const mergeRanges = (ranges: Range[]): Range[] => {
  const sorted = ranges.toSorted((a, b) => a.start - b.start);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out.at(-1);
    if (last && r.start <= last.end) {
      last.end = Math.max(last.end, r.end);
    } else {
      out.push({ end: r.end, start: r.start });
    }
  }
  return out;
};

const removedBefore = (ranges: Range[], pos: number): number => {
  let n = 0;
  for (const r of ranges) {
    if (r.end <= pos) {
      n += r.end - r.start;
    } else if (r.start < pos) {
      throw new Error("Offset inside removed data");
    }
  }
  return n;
};

const box = (type: string, content: Uint8Array): Uint8Array => {
  const w = new ByteWriter();
  w.u32(8 + content.length);
  w.raw(Uint8Array.from({ length: 4 }, (_, i) => type.codePointAt(i) ?? 0));
  w.raw(content);
  return w.bytes();
};

const fullBoxContent = (
  version: number,
  flags: number,
  body: Uint8Array
): Uint8Array => {
  const w = new ByteWriter();
  w.u8(version);
  w.u24(flags);
  w.raw(body);
  return w.bytes();
};

/** The byte ranges the removed items occupy: absolute (in mdat) and inside idat. */
const removedRanges = (
  il: IlocParsed,
  removed: Set<number>
): { mAbs: Range[]; mIdat: Range[] } => {
  const absRanges: Range[] = [];
  const idatRanges: Range[] = [];
  for (const item of il.items) {
    if (!removed.has(item.id)) {
      continue;
    }
    if (item.dataRefIdx !== 0) {
      throw new Error("Metadata stored in an external file reference");
    }
    for (const e of item.extents) {
      const range = {
        end: item.base + e.offset + e.length,
        start: item.base + e.offset,
      };
      if (item.method === 0) {
        absRanges.push(range);
      } else if (item.method === 1) {
        idatRanges.push(range);
      } else {
        throw new Error(`Unsupported iloc construction method ${item.method}`);
      }
    }
  }
  return { mAbs: mergeRanges(absRanges), mIdat: mergeRanges(idatRanges) };
};

/** The idat box without the removed ranges; the original when nothing in it goes; null without one. */
const rebuildIdat = (
  b: Uint8Array,
  idat: BBox | null,
  mIdat: Range[]
): Uint8Array | null => {
  if (!idat) {
    return null;
  }
  if (!mIdat.length) {
    return b.subarray(idat.start, idat.end);
  }
  const bodyLen = idat.end - idat.body;
  const parts: Uint8Array[] = [];
  let p = 0;
  for (const r of mIdat) {
    if (r.end > bodyLen) {
      throw new Error("idat removal out of bounds");
    }
    if (r.start > p) {
      parts.push(b.subarray(idat.body + p, idat.body + r.start));
    }
    p = r.end;
  }
  if (p < bodyLen) {
    parts.push(b.subarray(idat.body + p, idat.body + bodyLen));
  }
  return box("idat", concat(parts));
};

/** The iinf box without the removed items' infe boxes; infe versions the parse skipped stay. */
const rebuildIinf = (
  b: Uint8Array,
  w: BmffWalk,
  removed: Set<number>
): Uint8Array | null => {
  const iinf = w.metaChildren.find((c) => c.type === "iinf");
  if (!iinf) {
    return null;
  }
  const v = b[iinf.body];
  const keptInfes = w.items
    .filter((x) => !removed.has(x.id))
    .map((x) => b.subarray(x.infe.start, x.infe.end));
  const countSize = v === 0 ? 2 : 4;
  const known = new Set(w.items.map((x) => x.infe.start));
  const others: Uint8Array[] = [];
  for (const infe of readBoxList(b, iinf.body + 4 + countSize, iinf.end)) {
    if (!known.has(infe.start)) {
      others.push(b.subarray(infe.start, infe.end));
    }
  }
  const bw = new ByteWriter();
  const total = keptInfes.length + others.length;
  if (v === 0) {
    bw.u16(total);
  } else {
    bw.u32(total);
  }
  for (const x of others) {
    bw.raw(x);
  }
  for (const x of keptInfes) {
    bw.raw(x);
  }
  return box("iinf", fullBoxContent(v, fullBoxFlags(b, iinf.body), bw.bytes()));
};

/** The iref box without references from or to removed items; null when none are left. */
const rebuildIref = (
  iref: BmffWalk["iref"],
  removed: Set<number>
): Uint8Array | null => {
  if (!iref) {
    return null;
  }
  const idSize = iref.version === 0 ? 2 : 4;
  const kept = iref.refs
    .filter((r) => !removed.has(r.from))
    .map((r) => ({
      from: r.from,
      to: r.to.filter((t) => !removed.has(t)),
      type: r.type,
    }))
    .filter((r) => r.to.length > 0);
  if (kept.length === 0) {
    return null;
  }
  const bw = new ByteWriter();
  for (const r of kept) {
    const rw = new ByteWriter();
    rw.uN(r.from, idSize);
    rw.u16(r.to.length);
    for (const t of r.to) {
      rw.uN(t, idSize);
    }
    bw.raw(box(r.type, rw.bytes()));
  }
  return box("iref", fullBoxContent(iref.version, 0, bw.bytes()));
};

/** The iprp box with the removed items' property associations dropped. */
const rebuildIprp = (
  b: Uint8Array,
  w: BmffWalk,
  removed: Set<number>
): Uint8Array | null => {
  if (!w.iprp) {
    return null;
  }
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
      if (parsed.version < 1) {
        ew.u16(e.id);
      } else {
        ew.u32(e.id);
      }
      ew.raw(e.assoc);
    }
    bw.raw(
      box("ipma", fullBoxContent(parsed.version, parsed.flags, ew.bytes()))
    );
  }
  return box("iprp", bw.bytes());
};

const ilocSizeOf = (il: IlocParsed, keptIloc: IlocItem[]): number => {
  const idSize = il.version < 2 ? 2 : 4;
  let n = 4 + 2 + (il.version < 2 ? 2 : 4);
  for (const item of keptIloc) {
    n += idSize + (il.version >= 1 ? 2 : 0) + 2 + il.baseSize + 2;
    n += item.extents.length * (il.idxSize + il.offSize + il.lenSize);
  }
  return 8 + n;
};

/** A region copied verbatim, and where it lands. */
interface Piece {
  oldStart: number;
  oldEnd: number;
  newStart: number;
}

interface TopOut {
  src: BBox;
  kind: "verbatim" | "meta" | "mdat" | "drop";
  newStart: number;
  newSize: number;
}

/** An mdat with the removed ranges cut out: its new size, adding the kept pieces to `pieces`. */
const layoutMdat = (
  t: BBox,
  mAbs: Range[],
  cursor: number,
  pieces: Piece[]
): number => {
  const inside = mAbs.filter((r) => r.start >= t.body && r.end <= t.end);
  let kept = 0;
  let p = t.body;
  const headerLen = t.body - t.start;
  let bodyCursor = cursor + headerLen;
  for (const r of inside) {
    if (r.start > p) {
      pieces.push({ newStart: bodyCursor, oldEnd: r.start, oldStart: p });
      bodyCursor += r.start - p;
      kept += r.start - p;
    }
    p = r.end;
  }
  if (p < t.end) {
    pieces.push({ newStart: bodyCursor, oldEnd: t.end, oldStart: p });
    kept += t.end - p;
  }
  return headerLen + kept;
};

/** Top-level layout with new positions, building the old-to-new byte map for regions copied verbatim. */
const layoutTop = (
  top: BBox[],
  metaSize: number,
  mAbs: Range[]
): { topOut: TopOut[]; pieces: Piece[]; size: number } => {
  const pieces: Piece[] = [];
  const topOut: TopOut[] = [];
  let cursor = 0;
  for (const t of top) {
    if (t.type === "free" || t.type === "skip") {
      topOut.push({ kind: "drop", newSize: 0, newStart: cursor, src: t });
      continue;
    }
    if (t.type === "meta") {
      topOut.push({
        kind: "meta",
        newSize: metaSize,
        newStart: cursor,
        src: t,
      });
      cursor += metaSize;
      continue;
    }
    if (t.type === "mdat") {
      const newSize = layoutMdat(t, mAbs, cursor, pieces);
      topOut.push({ kind: "mdat", newSize, newStart: cursor, src: t });
      cursor += newSize;
      continue;
    }
    pieces.push({ newStart: cursor, oldEnd: t.end, oldStart: t.start });
    topOut.push({
      kind: "verbatim",
      newSize: t.end - t.start,
      newStart: cursor,
      src: t,
    });
    cursor += t.end - t.start;
  }
  return { pieces, size: cursor, topOut };
};

/** The iloc box with the kept items' extents relocated to where their bytes now are. */
const rebuildIloc = (
  il: IlocParsed,
  keptIloc: IlocItem[],
  pieces: Piece[],
  mIdat: Range[]
): Uint8Array => {
  const mapRange = (start: number, len: number): number => {
    for (const p of pieces) {
      if (start >= p.oldStart && start + len <= p.oldEnd) {
        return p.newStart + (start - p.oldStart);
      }
    }
    throw new Error(`Cannot relocate data at offset ${start}`);
  };
  const bw = new ByteWriter();
  // The four field sizes, a nibble each.
  bw.u16(
    il.offSize * 0x10_00 + il.lenSize * 0x1_00 + il.baseSize * 0x10 + il.idxSize
  );
  if (il.version < 2) {
    bw.u16(keptIloc.length);
  } else {
    bw.u32(keptIloc.length);
  }
  for (const item of keptIloc) {
    // Positions are rewritten as base 0 plus an absolute (method 0) or
    // idat-relative (method 1) extent offset; with a zero-width offset field
    // the single extent's position goes into base_offset instead.
    const relocated = (e: { offset: number; length: number }) =>
      item.method === 0
        ? mapRange(item.base + e.offset, e.length)
        : item.base + e.offset - removedBefore(mIdat, item.base + e.offset);
    if (il.version < 2) {
      bw.u16(item.id);
    } else {
      bw.u32(item.id);
    }
    if (il.version >= 1) {
      bw.u16(item.method);
    }
    bw.u16(item.dataRefIdx);
    bw.uN(il.offSize === 0 ? relocated(item.extents[0]) : 0, il.baseSize);
    bw.u16(item.extents.length);
    for (const e of item.extents) {
      if (il.idxSize > 0) {
        bw.uN(0, il.idxSize);
      }
      if (il.offSize > 0) {
        bw.uN(relocated(e), il.offSize);
      }
      bw.uN(e.length, il.lenSize);
    }
  }
  return box("iloc", fullBoxContent(il.version, il.flags, bw.bytes()));
};

/** An mdat box: a new header for its new size, then its kept pieces. */
const writeMdat = (
  out: ByteWriter,
  b: Uint8Array,
  t: TopOut,
  pieces: Piece[]
) => {
  const headerLen = t.src.body - t.src.start;
  if (headerLen === 8) {
    out.u32(t.newSize);
    out.raw(b.subarray(t.src.start + 4, t.src.start + 8));
  } else {
    out.u32(1);
    out.raw(b.subarray(t.src.start + 4, t.src.start + 8));
    out.u32(Math.floor(t.newSize / 4_294_967_296));
    out.u32(t.newSize);
  }
  for (const p of pieces) {
    if (p.oldStart >= t.src.body && p.oldEnd <= t.src.end) {
      out.raw(b.subarray(p.oldStart, p.oldEnd));
    }
  }
};

/** Which removals a Strip makes, after checking it can make them safely. */
const planRemoval = (b: Uint8Array, w: BmffWalk) => {
  if (!w.clean) {
    throw new Error(w.error ?? "Container walk failed");
  }
  const { meta, iloc } = w;
  if (!meta || !iloc || w.metaItemIds.size === 0) {
    throw new Error("No metadata items to strip");
  }
  const removed = w.metaItemIds;
  const { mAbs, mIdat } = removedRanges(iloc, removed);

  // Every absolute removal must fall inside an mdat body.
  const mdats = w.top.filter((t) => t.type === "mdat");
  for (const r of mAbs) {
    if (!mdats.some((m) => r.start >= m.body && r.end <= m.end)) {
      throw new Error("Metadata bytes stored outside mdat; refusing to strip");
    }
  }
  if (mIdat.length && !w.idat) {
    throw new Error("idat-based metadata without an idat box");
  }

  const keptIloc = iloc.items.filter((x) => !removed.has(x.id));
  for (const item of keptIloc) {
    if (
      iloc.offSize === 0 &&
      (iloc.baseSize === 0 || item.extents.length !== 1)
    ) {
      throw new Error("Cannot rewrite iloc with zero-width offset fields");
    }
  }
  // The small meta children are rebuilt first: their sizes do not depend on offsets.
  const idat = rebuildIdat(b, w.idat, mIdat);
  const iinf = rebuildIinf(b, w, removed);
  const iref = rebuildIref(w.iref, removed);
  const iprp = rebuildIprp(b, w, removed);
  if (meta.body - meta.start !== 8) {
    throw new Error("Unexpected meta box header");
  }
  const rebuilt = { idat, iinf, iprp, iref };
  return { iloc, keptIloc, mAbs, mIdat, meta, rebuilt };
};

/** The meta box's children in their original order, substituting the rebuilt ones; the iloc comes later. */
const metaChildrenOut = (
  b: Uint8Array,
  w: BmffWalk,
  rebuilt: ReturnType<typeof planRemoval>["rebuilt"]
): (Uint8Array | { iloc: true })[] => {
  const childOut: (Uint8Array | { iloc: true })[] = [];
  for (const c of w.metaChildren) {
    if (c.type === "iinf" && rebuilt.iinf) {
      childOut.push(rebuilt.iinf);
    } else if (c.type === "iloc") {
      childOut.push({ iloc: true });
    } else if (c.type === "iref") {
      if (rebuilt.iref) {
        childOut.push(rebuilt.iref);
      }
    } else if (c.type === "iprp" && rebuilt.iprp) {
      childOut.push(rebuilt.iprp);
    } else if (c.type === "idat" && rebuilt.idat) {
      childOut.push(rebuilt.idat);
    } else {
      childOut.push(b.subarray(c.start, c.end));
    }
  }
  return childOut;
};

const stripBmff = (b: Uint8Array): StripResult => {
  const w = parseBmff(b);
  const { iloc, keptIloc, mAbs, mIdat, meta, rebuilt } = planRemoval(b, w);
  const ilocSize = ilocSizeOf(iloc, keptIloc);

  // 32-bit size + type + fullbox version/flags
  const metaHeaderLen = 12;
  const childOut = metaChildrenOut(b, w, rebuilt);
  let metaSize = metaHeaderLen;
  for (const c of childOut) {
    metaSize += c instanceof Uint8Array ? c.length : ilocSize;
  }

  const { pieces, size, topOut } = layoutTop(w.top, metaSize, mAbs);
  const newIloc = rebuildIloc(iloc, keptIloc, pieces, mIdat);
  if (newIloc.length !== ilocSize) {
    throw new Error("iloc layout error");
  }

  const out = new ByteWriter();
  for (const t of topOut) {
    if (t.kind === "verbatim") {
      out.raw(b.subarray(t.src.start, t.src.end));
    } else if (t.kind === "mdat") {
      writeMdat(out, b, t, pieces);
    } else if (t.kind === "meta") {
      const mw = new ByteWriter();
      mw.u32(metaSize);
      mw.raw(b.subarray(meta.start + 4, meta.body + 4));
      for (const c of childOut) {
        mw.raw(c instanceof Uint8Array ? c : newIloc);
      }
      if (mw.length !== metaSize) {
        throw new Error("meta layout error");
      }
      out.raw(mw.bytes());
    }
  }
  if (out.length !== size) {
    throw new Error("Output layout error");
  }
  return { keptOrientation: null, out: out.bytes() };
};

// ------------------------------------------------------------------ entry points

const HEIF_BRANDS = new Set([
  "heic",
  "heix",
  "hevc",
  "hevx",
  "mif1",
  "msf1",
  "heim",
  "heis",
]);

/** An ISO-BMFF file's format from its ftyp brands: AVIF wins over the HEIF brands. */
const sniffBmff = (b: Uint8Array): Format | null => {
  const brands = new Set<string>([ascii(b, 8, 4)]);
  const boxSize = u32be(b, 0);
  for (let p = 16; p + 4 <= Math.min(boxSize, b.length, 64); p += 4) {
    brands.add(ascii(b, p, 4));
  }
  if (brands.has("avif") || brands.has("avis")) {
    return "avif";
  }
  for (const br of brands) {
    if (HEIF_BRANDS.has(br)) {
      return "heic";
    }
  }
  return null;
};

export const sniff = (b: Uint8Array): Format | null => {
  if (b.length < 12) {
    return null;
  }
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return "jpeg";
  }
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return "png";
  }
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") {
    return "webp";
  }
  const tiffLe = b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0;
  const tiffBe = b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 0x2a;
  if (tiffLe || tiffBe) {
    return "tiff";
  }
  if (ascii(b, 4, 4) === "ftyp") {
    return sniffBmff(b);
  }
  return null;
};

export const inspect = (b: Uint8Array): Inspection => {
  const format = sniff(b);
  if (!format) {
    throw new Error("Unrecognized image format");
  }
  switch (format) {
    case "jpeg": {
      return inspectJpeg(b);
    }
    case "png": {
      return inspectPng(b);
    }
    case "webp": {
      return inspectWebp(b);
    }
    case "tiff": {
      return inspectTiff(b);
    }
    default: {
      return inspectBmff(b, format);
    }
  }
};

export const strip = (b: Uint8Array): StripResult => {
  const format = sniff(b);
  if (!format) {
    throw new Error("Unrecognized image format");
  }
  switch (format) {
    case "jpeg": {
      return stripJpeg(b);
    }
    case "png": {
      return stripPng(b);
    }
    case "webp": {
      return stripWebp(b);
    }
    case "tiff": {
      return { keptOrientation: null, out: stripTiff(b) };
    }
    default: {
      return stripBmff(b);
    }
  }
};
