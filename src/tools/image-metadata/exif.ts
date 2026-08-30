// TIFF/EXIF structure decoding, shared by every container (the EXIF payload is
// TIFF-structured in JPEG, PNG, WebP, HEIC and TIFF alike), plus the TIFF file
// rebuild used to Strip standalone TIFFs.

export interface ExifTag {
  id: number;
  group: string;
  name: string;
  value: string;
}

export interface TiffInfo {
  tags: ExifTag[];
  orientation: number | null;
  gps: { lat: number; lon: number } | null;
  make: string | null;
  model: string | null;
  dateTaken: string | null;
  width: number | null;
  height: number | null;
  thumbnailBytes: number;
  makerNoteBytes: number;
  xmp: string | null;
  iptc: Uint8Array | null;
  iccBytes: number;
}

const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];

const IFD0_TAGS: Record<number, string> = {
  254: "NewSubfileType", 255: "SubfileType", 256: "ImageWidth", 257: "ImageHeight",
  258: "BitsPerSample", 259: "Compression", 262: "PhotometricInterpretation",
  266: "FillOrder", 269: "DocumentName", 270: "ImageDescription", 271: "Make",
  272: "Model", 273: "StripOffsets", 274: "Orientation", 277: "SamplesPerPixel",
  278: "RowsPerStrip", 279: "StripByteCounts", 282: "XResolution", 283: "YResolution",
  284: "PlanarConfiguration", 296: "ResolutionUnit", 301: "TransferFunction",
  305: "Software", 306: "DateTime", 315: "Artist", 316: "HostComputer",
  317: "Predictor", 318: "WhitePoint", 319: "PrimaryChromaticities", 320: "ColorMap",
  322: "TileWidth", 323: "TileLength", 324: "TileOffsets", 325: "TileByteCounts",
  330: "SubIFDs", 338: "ExtraSamples", 339: "SampleFormat", 347: "JPEGTables",
  512: "JPEGProc", 513: "ThumbnailOffset", 514: "ThumbnailLength",
  529: "YCbCrCoefficients", 530: "YCbCrSubSampling", 531: "YCbCrPositioning",
  532: "ReferenceBlackWhite", 700: "XMP", 33432: "Copyright", 33723: "IPTC",
  34377: "PhotoshopSettings", 34665: "ExifIFD", 34675: "ICCProfile", 34853: "GPSIFD",
  40091: "XPTitle", 40092: "XPComment", 40093: "XPAuthor", 40094: "XPKeywords",
  40095: "XPSubject", 50341: "PrintImageMatching",
};

const EXIF_TAGS: Record<number, string> = {
  33434: "ExposureTime", 33437: "FNumber", 34850: "ExposureProgram",
  34855: "ISO", 34864: "SensitivityType", 34866: "RecommendedExposureIndex",
  36864: "ExifVersion", 36867: "DateTimeOriginal", 36868: "DateTimeDigitized",
  36880: "OffsetTime", 36881: "OffsetTimeOriginal", 36882: "OffsetTimeDigitized",
  37121: "ComponentsConfiguration", 37122: "CompressedBitsPerPixel",
  37377: "ShutterSpeedValue", 37378: "ApertureValue", 37379: "BrightnessValue",
  37380: "ExposureBiasValue", 37381: "MaxApertureValue", 37382: "SubjectDistance",
  37383: "MeteringMode", 37384: "LightSource", 37385: "Flash", 37386: "FocalLength",
  37396: "SubjectArea", 37500: "MakerNote", 37510: "UserComment",
  37520: "SubSecTime", 37521: "SubSecTimeOriginal", 37522: "SubSecTimeDigitized",
  40960: "FlashpixVersion", 40961: "ColorSpace", 40962: "PixelXDimension",
  40963: "PixelYDimension", 40965: "InteropIFD", 41486: "FocalPlaneXResolution",
  41487: "FocalPlaneYResolution", 41488: "FocalPlaneResolutionUnit",
  41495: "SensingMethod", 41728: "FileSource", 41729: "SceneType",
  41730: "CFAPattern", 41985: "CustomRendered", 41986: "ExposureMode",
  41987: "WhiteBalance", 41988: "DigitalZoomRatio", 41989: "FocalLengthIn35mmFilm",
  41990: "SceneCaptureType", 41991: "GainControl", 41992: "Contrast",
  41993: "Saturation", 41994: "Sharpness", 41996: "SubjectDistanceRange",
  42016: "ImageUniqueID", 42032: "CameraOwnerName", 42033: "BodySerialNumber",
  42034: "LensSpecification", 42035: "LensMake", 42036: "LensModel",
  42037: "LensSerialNumber",
};

const GPS_TAGS: Record<number, string> = {
  0: "GPSVersionID", 1: "GPSLatitudeRef", 2: "GPSLatitude", 3: "GPSLongitudeRef",
  4: "GPSLongitude", 5: "GPSAltitudeRef", 6: "GPSAltitude", 7: "GPSTimeStamp",
  8: "GPSSatellites", 9: "GPSStatus", 10: "GPSMeasureMode", 11: "GPSDOP",
  12: "GPSSpeedRef", 13: "GPSSpeed", 14: "GPSTrackRef", 15: "GPSTrack",
  16: "GPSImgDirectionRef", 17: "GPSImgDirection", 18: "GPSMapDatum",
  19: "GPSDestLatitudeRef", 20: "GPSDestLatitude", 21: "GPSDestLongitudeRef",
  22: "GPSDestLongitude", 23: "GPSDestBearingRef", 24: "GPSDestBearing",
  25: "GPSDestDistanceRef", 26: "GPSDestDistance", 27: "GPSProcessingMethod",
  28: "GPSAreaInformation", 29: "GPSDateStamp", 30: "GPSDifferential",
  31: "GPSHPositioningError",
};

const ENUMS: Record<string, Record<number, string>> = {
  Orientation: {
    1: "Normal", 2: "Mirrored", 3: "Rotated 180°", 4: "Mirrored, rotated 180°",
    5: "Mirrored, rotated 90° CCW", 6: "Rotated 90° CW", 7: "Mirrored, rotated 90° CW",
    8: "Rotated 90° CCW",
  },
  ResolutionUnit: { 1: "None", 2: "inch", 3: "cm" },
  ColorSpace: { 1: "sRGB", 65535: "Uncalibrated" },
  ExposureProgram: {
    0: "Not defined", 1: "Manual", 2: "Program", 3: "Aperture priority",
    4: "Shutter priority", 5: "Creative", 6: "Action", 7: "Portrait", 8: "Landscape",
  },
  MeteringMode: {
    0: "Unknown", 1: "Average", 2: "Center-weighted", 3: "Spot",
    4: "Multi-spot", 5: "Pattern", 6: "Partial",
  },
  ExposureMode: { 0: "Auto", 1: "Manual", 2: "Auto bracket" },
  WhiteBalance: { 0: "Auto", 1: "Manual" },
  SceneCaptureType: { 0: "Standard", 1: "Landscape", 2: "Portrait", 3: "Night" },
};

type Rat = { n: number; d: number };
type Val = string | number[] | Rat[] | Uint8Array;

interface RawEntry {
  tag: number;
  type: number;
  count: number;
  /** Absolute offset of the value bytes within the TIFF blob. */
  valOff: number;
  size: number;
}

class Tiff {
  dv: DataView;
  le: boolean;
  bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    if (bytes.length < 8) throw new Error("TIFF data truncated");
    this.bytes = bytes;
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const bom = this.dv.getUint16(0, false);
    if (bom === 0x4949) this.le = true;
    else if (bom === 0x4d4d) this.le = false;
    else throw new Error("Not a TIFF structure (bad byte order mark)");
    const magic = this.u16(2);
    if (magic === 0x2b) throw new Error("BigTIFF is not supported");
    if (magic !== 0x2a) throw new Error("Not a TIFF structure (bad magic)");
  }

  u16(o: number) { return this.dv.getUint16(o, this.le); }
  u32(o: number) { return this.dv.getUint32(o, this.le); }

  ifd0Offset() {
    return this.u32(4);
  }

  readIfd(off: number): { entries: RawEntry[]; next: number } {
    if (off < 8 || off + 2 > this.bytes.length) throw new Error("IFD offset out of bounds");
    const count = this.u16(off);
    if (count > 1024) throw new Error("Implausible IFD entry count");
    if (off + 2 + count * 12 + 4 > this.bytes.length) throw new Error("IFD extends past end of data");
    const entries: RawEntry[] = [];
    for (let i = 0; i < count; i++) {
      const e = off + 2 + i * 12;
      const tag = this.u16(e);
      const type = this.u16(e + 2);
      const count32 = this.u32(e + 4);
      const unit = TYPE_SIZE[type] ?? 0;
      const size = unit * count32;
      const valOff = size <= 4 ? e + 8 : this.u32(e + 8);
      entries.push({ tag, type, count: count32, valOff, size });
    }
    return { entries, next: this.u32(off + 2 + count * 12) };
  }

  valueInBounds(e: RawEntry): boolean {
    return e.size > 0 && e.valOff >= 0 && e.valOff + e.size <= this.bytes.length;
  }

  readValue(e: RawEntry): Val | null {
    if (TYPE_SIZE[e.type] === undefined || TYPE_SIZE[e.type] === 0) return null;
    if (!this.valueInBounds(e)) return null;
    const o = e.valOff;
    if (e.type === 2) {
      const raw = this.bytes.subarray(o, o + e.count);
      return new TextDecoder().decode(raw).replace(/\0+$/, "").trim();
    }
    if (e.type === 7 || e.type === 1 && e.count > 64) {
      return this.bytes.subarray(o, o + e.size);
    }
    if (e.type === 5 || e.type === 10) {
      const out: Rat[] = [];
      for (let i = 0; i < e.count; i++) {
        const p = o + i * 8;
        out.push(e.type === 5
          ? { n: this.u32(p), d: this.u32(p + 4) }
          : { n: this.dv.getInt32(p, this.le), d: this.dv.getInt32(p + 4, this.le) });
      }
      return out;
    }
    const nums: number[] = [];
    for (let i = 0; i < e.count; i++) {
      const p = o + i * TYPE_SIZE[e.type];
      switch (e.type) {
        case 1: nums.push(this.bytes[o + i]); break;
        case 3: nums.push(this.u16(p)); break;
        case 4: nums.push(this.u32(p)); break;
        case 6: nums.push(this.dv.getInt8(p)); break;
        case 8: nums.push(this.dv.getInt16(p, this.le)); break;
        case 9: nums.push(this.dv.getInt32(p, this.le)); break;
        case 11: nums.push(this.dv.getFloat32(p, this.le)); break;
        case 12: nums.push(this.dv.getFloat64(p, this.le)); break;
        default: return null;
      }
    }
    return nums;
  }
}

function ratNum(r: Rat): number {
  return r.d === 0 ? NaN : r.n / r.d;
}

function trimNum(v: number, digits = 2): string {
  if (!isFinite(v)) return "?";
  return String(parseFloat(v.toFixed(digits)));
}

function dmsToDecimal(v: Rat[], ref: string): number | null {
  if (v.length < 1) return null;
  const deg = ratNum(v[0]) + (v.length > 1 ? ratNum(v[1]) / 60 : 0) + (v.length > 2 ? ratNum(v[2]) / 3600 : 0);
  if (!isFinite(deg)) return null;
  return ref === "S" || ref === "W" ? -deg : deg;
}

/** EXIF stores timestamps as "YYYY:MM:DD HH:MM:SS"; show the date part with dashes. */
function fmtExifDate(s: string): string {
  const m = s.match(/^(\d{4}):(\d{2}):(\d{2})(.*)$/);
  return m ? m[1] + "-" + m[2] + "-" + m[3] + m[4] : s;
}

const DATE_TAGS = new Set(["DateTime", "DateTimeOriginal", "DateTimeDigitized", "GPSDateStamp"]);

function ucs2(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const c = bytes[i] | (bytes[i + 1] << 8);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

function formatValue(name: string, val: Val): string {
  const en = ENUMS[name];
  if (en && Array.isArray(val) && val.length === 1 && typeof val[0] === "number") {
    const label = en[val[0] as number];
    if (label) return label;
  }
  if (name === "Flash" && Array.isArray(val) && typeof val[0] === "number") {
    const v = val[0] as number;
    return (v & 1 ? "Fired" : "Did not fire") + " (0x" + v.toString(16) + ")";
  }
  if (typeof val === "string") return DATE_TAGS.has(name) ? fmtExifDate(val) : val;
  if (val instanceof Uint8Array) {
    if (name === "ExifVersion" || name === "FlashpixVersion" || name === "SceneType" || name === "FileSource") {
      return new TextDecoder().decode(val).replace(/\0+$/, "") || "(" + val.length + " bytes)";
    }
    if (name === "UserComment" && val.length > 8) {
      const charset = new TextDecoder().decode(val.subarray(0, 8)).replace(/\0+$/, "");
      const body = val.subarray(8);
      const text = charset === "UNICODE" ? ucs2Or16(body) : new TextDecoder().decode(body).replace(/\0+$/, "").trim();
      if (text) return text;
    }
    if (name.startsWith("XP")) {
      const text = ucs2(val);
      if (text) return text;
    }
    if (name === "GPSProcessingMethod" && val.length > 8) {
      const text = new TextDecoder().decode(val.subarray(8)).replace(/\0+$/, "").trim();
      if (text) return text;
    }
    return "(" + val.length + " bytes)";
  }
  const rats = val.length > 0 && typeof val[0] === "object" ? (val as Rat[]) : null;
  if (rats) {
    if (name === "ExposureTime") {
      const v = ratNum(rats[0]);
      if (v > 0 && v < 1) return "1/" + Math.round(1 / v) + " s";
      return trimNum(v, 4) + " s";
    }
    if (name === "FNumber") return "f/" + trimNum(ratNum(rats[0]), 1);
    if (name === "FocalLength") return trimNum(ratNum(rats[0]), 1) + " mm";
    if (name === "ExposureBiasValue") {
      const v = ratNum(rats[0]);
      return (v > 0 ? "+" : "") + trimNum(v) + " EV";
    }
    if (name === "GPSAltitude") return trimNum(ratNum(rats[0]), 1) + " m";
    if ((name === "GPSLatitude" || name === "GPSLongitude" || name === "GPSDestLatitude" || name === "GPSDestLongitude") && rats.length >= 3) {
      return trimNum(ratNum(rats[0]), 0) + "° " + trimNum(ratNum(rats[1]), 0) + "′ " + trimNum(ratNum(rats[2]), 3) + "″";
    }
    if (name === "GPSTimeStamp" && rats.length >= 3) {
      const pad = (r: Rat) => String(Math.floor(ratNum(r))).padStart(2, "0");
      return pad(rats[0]) + ":" + pad(rats[1]) + ":" + pad(rats[2]);
    }
    if (name === "LensSpecification" && rats.length >= 4) {
      return rats.map((r) => trimNum(ratNum(r), 1)).join(", ");
    }
    const parts = rats.slice(0, 8).map((r) => (r.d === 1 ? String(r.n) : r.n + "/" + r.d));
    return parts.join(", ") + (rats.length > 8 ? ", … (" + rats.length + " values)" : "");
  }
  if (name === "FocalLengthIn35mmFilm") return val[0] + " mm";
  const nums = val as number[];
  const parts = nums.slice(0, 8).map((n) => trimNum(n, 4));
  return parts.join(", ") + (nums.length > 8 ? ", … (" + nums.length + " values)" : "");
}

function ucs2Or16(bytes: Uint8Array): string {
  // UserComment UNICODE payloads are UTF-16 with unspecified endianness; guess LE
  // unless the first character decodes as garbage.
  const le = ucs2(bytes);
  if (le && /[\x20-\x7e]/.test(le[0] ?? "")) return le.trim();
  let s = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const c = (bytes[i] << 8) | bytes[i + 1];
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s.trim();
}

/** Decode a TIFF blob for display. Tolerant: bad sub-IFDs are skipped, only a
    broken header throws. */
export function parseTiff(bytes: Uint8Array): TiffInfo {
  const t = new Tiff(bytes);
  const info: TiffInfo = {
    tags: [], orientation: null, gps: null, make: null, model: null,
    dateTaken: null, width: null, height: null, thumbnailBytes: 0,
    makerNoteBytes: 0, xmp: null, iptc: null, iccBytes: 0,
  };
  const gpsRaw: Record<number, Val> = {};
  const visited = new Set<number>();

  const readGroup = (off: number, group: string, names: Record<number, string>): { entries: RawEntry[]; next: number } | null => {
    if (visited.has(off) || visited.size > 32) return null;
    visited.add(off);
    let ifd;
    try {
      ifd = t.readIfd(off);
    } catch {
      return null;
    }
    for (const e of ifd.entries) {
      const name = names[e.tag] ?? "Tag 0x" + e.tag.toString(16).padStart(4, "0");
      if (e.tag === 34665 || e.tag === 34853 || e.tag === 40965) continue;
      if (e.tag === 37500) {
        info.makerNoteBytes = e.size;
        info.tags.push({ id: e.tag, group, name: "MakerNote", value: "(" + e.size + " bytes, not decoded)" });
        continue;
      }
      if (e.tag === 700 && group === "Image") {
        if (t.valueInBounds(e)) info.xmp = new TextDecoder().decode(t.bytes.subarray(e.valOff, e.valOff + e.size)).replace(/\0+$/, "");
        info.tags.push({ id: e.tag, group, name, value: "(" + e.size + " bytes)" });
        continue;
      }
      if (e.tag === 33723 && group === "Image") {
        if (t.valueInBounds(e)) info.iptc = t.bytes.slice(e.valOff, e.valOff + e.size);
        info.tags.push({ id: e.tag, group, name, value: "(" + e.size + " bytes)" });
        continue;
      }
      if (e.tag === 34675 && group === "Image") {
        info.iccBytes = e.size;
        info.tags.push({ id: e.tag, group, name, value: "(" + e.size + " bytes)" });
        continue;
      }
      const val = t.readValue(e);
      if (val === null) {
        info.tags.push({ id: e.tag, group, name, value: "(unreadable)" });
        continue;
      }
      if (group === "GPS") gpsRaw[e.tag] = val;
      const shown = formatValue(name, val);
      info.tags.push({ id: e.tag, group, name, value: shown.length > 160 ? shown.slice(0, 160) + "…" : shown });

      if (Array.isArray(val) && typeof val[0] === "number") {
        const n = val[0] as number;
        if (e.tag === 274 && group === "Image") info.orientation = n;
        if (e.tag === 256 && group === "Image") info.width = n;
        if (e.tag === 257 && group === "Image") info.height = n;
        if (e.tag === 40962 && group === "Photo" && info.width === null) info.width = n;
        if (e.tag === 40963 && group === "Photo" && info.height === null) info.height = n;
      }
      if (typeof val === "string") {
        if (e.tag === 271 && group === "Image") info.make = val;
        if (e.tag === 272 && group === "Image") info.model = val;
        if ((e.tag === 36867 || e.tag === 306) && info.dateTaken === null && val) info.dateTaken = fmtExifDate(val);
      }
    }
    return ifd;
  };

  const ifd0 = readGroup(t.ifd0Offset(), "Image", IFD0_TAGS);
  if (!ifd0) throw new Error("Broken IFD0");

  for (const e of ifd0.entries) {
    if (e.tag === 34665) {
      const v = t.readValue(e);
      if (Array.isArray(v) && typeof v[0] === "number") {
        const exifIfd = readGroup(v[0] as number, "Photo", EXIF_TAGS);
        if (exifIfd) {
          for (const ee of exifIfd.entries) {
            if (ee.tag === 40965) {
              const iv = t.readValue(ee);
              if (Array.isArray(iv) && typeof iv[0] === "number") {
                readGroup(iv[0] as number, "Interop", { 1: "InteropIndex", 2: "InteropVersion" });
              }
            }
          }
        }
      }
    }
    if (e.tag === 34853) {
      const v = t.readValue(e);
      if (Array.isArray(v) && typeof v[0] === "number") readGroup(v[0] as number, "GPS", GPS_TAGS);
    }
  }

  // Thumbnail: IFD1 in the chain.
  if (ifd0.next) {
    const ifd1 = readGroup(ifd0.next, "Thumbnail", IFD0_TAGS);
    if (ifd1) {
      for (const e of ifd1.entries) {
        if (e.tag === 514 || e.tag === 279) {
          const v = t.readValue(e);
          if (Array.isArray(v)) {
            for (const n of v as number[]) info.thumbnailBytes += typeof n === "number" ? n : 0;
          }
        }
      }
    }
  }

  const lat = gpsRaw[2];
  const lon = gpsRaw[4];
  const latRef = gpsRaw[1];
  const lonRef = gpsRaw[3];
  if (Array.isArray(lat) && Array.isArray(lon) && lat.length && lon.length && typeof lat[0] === "object") {
    const dLat = dmsToDecimal(lat as Rat[], typeof latRef === "string" ? latRef : "N");
    const dLon = dmsToDecimal(lon as Rat[], typeof lonRef === "string" ? lonRef : "E");
    if (dLat !== null && dLon !== null) info.gps = { lat: dLat, lon: dLon };
  }

  return info;
}

/** Minimal EXIF TIFF blob carrying only the Orientation tag. Kept in a Strip
    when the original had a non-default orientation (see ADR 0001). */
export function buildOrientationTiff(orientation: number): Uint8Array {
  const out = new Uint8Array(26);
  const dv = new DataView(out.buffer);
  out[0] = 0x49; out[1] = 0x49;              // little endian
  dv.setUint16(2, 42, true);
  dv.setUint32(4, 8, true);                  // IFD0 at offset 8
  dv.setUint16(8, 1, true);                  // one entry
  dv.setUint16(10, 274, true);               // Orientation
  dv.setUint16(12, 3, true);                 // SHORT
  dv.setUint32(14, 1, true);
  dv.setUint16(18, orientation, true);
  dv.setUint32(22, 0, true);                 // no next IFD
  return out;
}

// ---------------------------------------------------------------------------
// TIFF file Strip: rebuild the file keeping only what is needed to decode the
// pixels, plus ICC and Orientation (rendering-critical, see ADR 0001).

/** True when the TIFF chain carries any tag a Strip would remove. */
export function tiffHasDroppable(src: Uint8Array): boolean {
  try {
    const t = new Tiff(src);
    let off = t.ifd0Offset();
    const seen = new Set<number>();
    while (off !== 0 && !seen.has(off) && seen.size < 64) {
      seen.add(off);
      const ifd = t.readIfd(off);
      for (const e of ifd.entries) if (!TIFF_KEEP.has(e.tag)) return true;
      off = ifd.next;
    }
  } catch {
    return false;
  }
  return false;
}

const TIFF_KEEP = new Set([
  254, 255, 256, 257, 258, 259, 262, 263, 264, 265, 266, 273, 274, 277, 278,
  279, 280, 281, 282, 283, 284, 290, 291, 292, 293, 296, 297, 301, 317, 318,
  319, 320, 321, 322, 323, 324, 325, 332, 336, 338, 339, 340, 341, 347, 512,
  515, 516, 517, 518, 519, 520, 521, 529, 530, 531, 532, 34675,
]);

interface KeptEntry {
  tag: number;
  type: number;
  count: number;
  /** Raw value bytes in file byte order; for pointer tags, filled in later. */
  data: Uint8Array;
}

class TiffWriter {
  bytes: number[] = [];
  le: boolean;
  constructor(le: boolean) { this.le = le; }
  get length() { return this.bytes.length; }
  u8(v: number) { this.bytes.push(v & 0xff); }
  u16(v: number) {
    if (this.le) { this.u8(v); this.u8(v >> 8); }
    else { this.u8(v >> 8); this.u8(v); }
  }
  u32(v: number) {
    if (this.le) { this.u8(v); this.u8(v >> 8); this.u8(v >> 16); this.u8(v >> 24); }
    else { this.u8(v >> 24); this.u8(v >> 16); this.u8(v >> 8); this.u8(v); }
  }
  raw(b: Uint8Array) { for (let i = 0; i < b.length; i++) this.bytes.push(b[i]); }
  setU32At(pos: number, v: number) {
    const b = this.le ? [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]
      : [(v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
    for (let i = 0; i < 4; i++) this.bytes[pos + i] = b[i];
  }
  align(n: number) { while (this.bytes.length % n !== 0) this.u8(0); }
  toBytes() { return new Uint8Array(this.bytes); }
}

function numArray(t: Tiff, e: RawEntry): number[] {
  const v = t.readValue(e);
  if (!Array.isArray(v) || v.length === 0 || typeof v[0] !== "number") {
    throw new Error("Unreadable offsets in tag " + e.tag);
  }
  return v as number[];
}

/** Rebuild a standalone TIFF with all Metadata removed. Throws when the file
    cannot be walked cleanly; a possibly-broken output is never produced. */
export function stripTiff(src: Uint8Array): Uint8Array {
  const t = new Tiff(src);
  const pages: { kept: KeptEntry[]; blocks: { data: Uint8Array }[][]; pointerTags: number[] }[] = [];
  const visited = new Set<number>();

  let off = t.ifd0Offset();
  while (off !== 0) {
    if (visited.has(off)) throw new Error("IFD loop");
    if (visited.size > 64) throw new Error("Too many TIFF pages");
    visited.add(off);
    const ifd = t.readIfd(off);
    const byTag = new Map<number, RawEntry>();
    for (const e of ifd.entries) byTag.set(e.tag, e);

    const compression = byTag.has(259) ? numArray(t, byTag.get(259)!)[0] : 1;
    // Pixel data pointer pairs: strips, tiles, and old-style JPEG streams.
    const pairs: [number, number][] = [];
    if (byTag.has(273) && byTag.has(279)) pairs.push([273, 279]);
    if (byTag.has(322) && byTag.has(324) && byTag.has(325)) pairs.push([324, 325]);
    if (compression === 6 && byTag.has(513) && byTag.has(514)) pairs.push([513, 514]);
    if (pairs.length === 0) throw new Error("TIFF page has no pixel data; refusing to strip");

    const kept: KeptEntry[] = [];
    const blocks: { data: Uint8Array }[][] = [];
    const pointerTags: number[] = [];

    for (const [offTag, cntTag] of pairs) {
      const offsets = numArray(t, byTag.get(offTag)!);
      const counts = numArray(t, byTag.get(cntTag)!);
      if (offsets.length !== counts.length) throw new Error("Offset/count mismatch in TIFF page");
      const group: { data: Uint8Array }[] = [];
      for (let i = 0; i < offsets.length; i++) {
        const s = offsets[i], n = counts[i];
        if (s + n > src.length) throw new Error("Pixel data out of bounds");
        group.push({ data: src.subarray(s, s + n) });
      }
      blocks.push(group);
      pointerTags.push(offTag);
      kept.push({ tag: offTag, type: 4, count: offsets.length, data: new Uint8Array(0) });
      const cw = new TiffWriter(t.le);
      for (const n of counts) cw.u32(n);
      kept.push({ tag: cntTag, type: 4, count: counts.length, data: cw.toBytes() });
    }

    for (const e of ifd.entries) {
      if (!TIFF_KEEP.has(e.tag)) continue;
      if (e.tag === 273 || e.tag === 279 || e.tag === 324 || e.tag === 325 || e.tag === 513 || e.tag === 514) continue;
      const unit = TYPE_SIZE[e.type];
      if (!unit) throw new Error("Unknown type on structural tag " + e.tag);
      if (!t.valueInBounds(e)) throw new Error("Structural tag " + e.tag + " value out of bounds");
      kept.push({ tag: e.tag, type: e.type, count: e.count, data: src.slice(e.valOff, e.valOff + e.size) });
    }

    kept.sort((a, b) => a.tag - b.tag);
    pages.push({ kept, blocks, pointerTags });
    off = ifd.next;
  }

  if (pages.length === 0) throw new Error("TIFF has no pages");

  const w = new TiffWriter(t.le);
  w.u8(t.le ? 0x49 : 0x4d); w.u8(t.le ? 0x49 : 0x4d);
  w.u16(42);
  w.u32(8);

  let prevNextPos = -1;
  for (const page of pages) {
    w.align(2);
    const ifdStart = w.length;
    if (prevNextPos >= 0) w.setU32At(prevNextPos, ifdStart);

    const n = page.kept.length;
    const ifdSize = 2 + n * 12 + 4;
    // Lay out out-of-line values, then pixel blocks, computing positions first.
    let cursor = ifdStart + ifdSize;
    const valuePos = new Map<KeptEntry, number>();
    for (const e of page.kept) {
      const size = page.pointerTags.includes(e.tag) ? e.count * 4 : e.data.length;
      if (size > 4) {
        if (cursor % 2) cursor++;
        valuePos.set(e, cursor);
        cursor += size;
      }
    }
    const blockPos: number[][] = [];
    for (const group of page.blocks) {
      const positions: number[] = [];
      for (const b of group) {
        if (cursor % 2) cursor++;
        positions.push(cursor);
        cursor += b.data.length;
      }
      blockPos.push(positions);
    }

    // Fill pointer-tag value bytes now that block positions are known.
    for (let gi = 0; gi < page.pointerTags.length; gi++) {
      const e = page.kept.find((k) => k.tag === page.pointerTags[gi])!;
      const ow = new TiffWriter(t.le);
      for (const p of blockPos[gi]) ow.u32(p);
      e.data = ow.toBytes();
    }

    w.u16(n);
    for (const e of page.kept) {
      w.u16(e.tag);
      w.u16(e.type);
      w.u32(e.count);
      if (e.data.length <= 4) {
        w.raw(e.data);
        for (let i = e.data.length; i < 4; i++) w.u8(0);
      } else {
        w.u32(valuePos.get(e)!);
      }
    }
    prevNextPos = w.length;
    w.u32(0);

    for (const e of page.kept) {
      if (e.data.length > 4) {
        w.align(2);
        if (w.length !== valuePos.get(e)) throw new Error("TIFF layout error");
        w.raw(e.data);
      }
    }
    for (let gi = 0; gi < page.blocks.length; gi++) {
      const group = page.blocks[gi];
      for (let bi = 0; bi < group.length; bi++) {
        w.align(2);
        if (w.length !== blockPos[gi][bi]) throw new Error("TIFF layout error");
        w.raw(group[bi].data);
      }
    }
  }

  return w.toBytes();
}
