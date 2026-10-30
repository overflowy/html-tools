// TIFF/EXIF structure decoding, shared by every container (the EXIF payload is
// TIFF-structured in JPEG, PNG, WebP, HEIC and TIFF alike), plus the TIFF file
// rebuild used to Strip standalone TIFFs.

import { TiffWriter } from "./tiff-writer";

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

const IFD0_TAGS = new Map<number, string>([
  [254, "NewSubfileType"],
  [255, "SubfileType"],
  [256, "ImageWidth"],
  [257, "ImageHeight"],
  [258, "BitsPerSample"],
  [259, "Compression"],
  [262, "PhotometricInterpretation"],
  [266, "FillOrder"],
  [269, "DocumentName"],
  [270, "ImageDescription"],
  [271, "Make"],
  [272, "Model"],
  [273, "StripOffsets"],
  [274, "Orientation"],
  [277, "SamplesPerPixel"],
  [278, "RowsPerStrip"],
  [279, "StripByteCounts"],
  [282, "XResolution"],
  [283, "YResolution"],
  [284, "PlanarConfiguration"],
  [296, "ResolutionUnit"],
  [301, "TransferFunction"],
  [305, "Software"],
  [306, "DateTime"],
  [315, "Artist"],
  [316, "HostComputer"],
  [317, "Predictor"],
  [318, "WhitePoint"],
  [319, "PrimaryChromaticities"],
  [320, "ColorMap"],
  [322, "TileWidth"],
  [323, "TileLength"],
  [324, "TileOffsets"],
  [325, "TileByteCounts"],
  [330, "SubIFDs"],
  [338, "ExtraSamples"],
  [339, "SampleFormat"],
  [347, "JPEGTables"],
  [512, "JPEGProc"],
  [513, "ThumbnailOffset"],
  [514, "ThumbnailLength"],
  [529, "YCbCrCoefficients"],
  [530, "YCbCrSubSampling"],
  [531, "YCbCrPositioning"],
  [532, "ReferenceBlackWhite"],
  [700, "XMP"],
  [33_432, "Copyright"],
  [33_723, "IPTC"],
  [34_377, "PhotoshopSettings"],
  [34_665, "ExifIFD"],
  [34_675, "ICCProfile"],
  [34_853, "GPSIFD"],
  [40_091, "XPTitle"],
  [40_092, "XPComment"],
  [40_093, "XPAuthor"],
  [40_094, "XPKeywords"],
  [40_095, "XPSubject"],
  [50_341, "PrintImageMatching"],
]);

const EXIF_TAGS = new Map<number, string>([
  [33_434, "ExposureTime"],
  [33_437, "FNumber"],
  [34_850, "ExposureProgram"],
  [34_855, "ISO"],
  [34_864, "SensitivityType"],
  [34_866, "RecommendedExposureIndex"],
  [36_864, "ExifVersion"],
  [36_867, "DateTimeOriginal"],
  [36_868, "DateTimeDigitized"],
  [36_880, "OffsetTime"],
  [36_881, "OffsetTimeOriginal"],
  [36_882, "OffsetTimeDigitized"],
  [37_121, "ComponentsConfiguration"],
  [37_122, "CompressedBitsPerPixel"],
  [37_377, "ShutterSpeedValue"],
  [37_378, "ApertureValue"],
  [37_379, "BrightnessValue"],
  [37_380, "ExposureBiasValue"],
  [37_381, "MaxApertureValue"],
  [37_382, "SubjectDistance"],
  [37_383, "MeteringMode"],
  [37_384, "LightSource"],
  [37_385, "Flash"],
  [37_386, "FocalLength"],
  [37_396, "SubjectArea"],
  [37_500, "MakerNote"],
  [37_510, "UserComment"],
  [37_520, "SubSecTime"],
  [37_521, "SubSecTimeOriginal"],
  [37_522, "SubSecTimeDigitized"],
  [40_960, "FlashpixVersion"],
  [40_961, "ColorSpace"],
  [40_962, "PixelXDimension"],
  [40_963, "PixelYDimension"],
  [40_965, "InteropIFD"],
  [41_486, "FocalPlaneXResolution"],
  [41_487, "FocalPlaneYResolution"],
  [41_488, "FocalPlaneResolutionUnit"],
  [41_495, "SensingMethod"],
  [41_728, "FileSource"],
  [41_729, "SceneType"],
  [41_730, "CFAPattern"],
  [41_985, "CustomRendered"],
  [41_986, "ExposureMode"],
  [41_987, "WhiteBalance"],
  [41_988, "DigitalZoomRatio"],
  [41_989, "FocalLengthIn35mmFilm"],
  [41_990, "SceneCaptureType"],
  [41_991, "GainControl"],
  [41_992, "Contrast"],
  [41_993, "Saturation"],
  [41_994, "Sharpness"],
  [41_996, "SubjectDistanceRange"],
  [42_016, "ImageUniqueID"],
  [42_032, "CameraOwnerName"],
  [42_033, "BodySerialNumber"],
  [42_034, "LensSpecification"],
  [42_035, "LensMake"],
  [42_036, "LensModel"],
  [42_037, "LensSerialNumber"],
]);

const GPS_TAGS = new Map<number, string>([
  [0, "GPSVersionID"],
  [1, "GPSLatitudeRef"],
  [2, "GPSLatitude"],
  [3, "GPSLongitudeRef"],
  [4, "GPSLongitude"],
  [5, "GPSAltitudeRef"],
  [6, "GPSAltitude"],
  [7, "GPSTimeStamp"],
  [8, "GPSSatellites"],
  [9, "GPSStatus"],
  [10, "GPSMeasureMode"],
  [11, "GPSDOP"],
  [12, "GPSSpeedRef"],
  [13, "GPSSpeed"],
  [14, "GPSTrackRef"],
  [15, "GPSTrack"],
  [16, "GPSImgDirectionRef"],
  [17, "GPSImgDirection"],
  [18, "GPSMapDatum"],
  [19, "GPSDestLatitudeRef"],
  [20, "GPSDestLatitude"],
  [21, "GPSDestLongitudeRef"],
  [22, "GPSDestLongitude"],
  [23, "GPSDestBearingRef"],
  [24, "GPSDestBearing"],
  [25, "GPSDestDistanceRef"],
  [26, "GPSDestDistance"],
  [27, "GPSProcessingMethod"],
  [28, "GPSAreaInformation"],
  [29, "GPSDateStamp"],
  [30, "GPSDifferential"],
  [31, "GPSHPositioningError"],
]);

const INTEROP_TAGS = new Map<number, string>([
  [1, "InteropIndex"],
  [2, "InteropVersion"],
]);

const ENUMS: Record<string, Record<number, string>> = {
  ColorSpace: { 1: "sRGB", 65_535: "Uncalibrated" },
  ExposureMode: { 0: "Auto", 1: "Manual", 2: "Auto bracket" },
  ExposureProgram: {
    0: "Not defined",
    1: "Manual",
    2: "Program",
    3: "Aperture priority",
    4: "Shutter priority",
    5: "Creative",
    6: "Action",
    7: "Portrait",
    8: "Landscape",
  },
  MeteringMode: {
    0: "Unknown",
    1: "Average",
    2: "Center-weighted",
    3: "Spot",
    4: "Multi-spot",
    5: "Pattern",
    6: "Partial",
  },
  Orientation: {
    1: "Normal",
    2: "Mirrored",
    3: "Rotated 180°",
    4: "Mirrored, rotated 180°",
    5: "Mirrored, rotated 90° CCW",
    6: "Rotated 90° CW",
    7: "Mirrored, rotated 90° CW",
    8: "Rotated 90° CCW",
  },
  ResolutionUnit: { 1: "None", 2: "inch", 3: "cm" },
  SceneCaptureType: {
    0: "Standard",
    1: "Landscape",
    2: "Portrait",
    3: "Night",
  },
  WhiteBalance: { 0: "Auto", 1: "Manual" },
};

interface Rat {
  n: number;
  d: number;
}
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
    if (bytes.length < 8) {
      throw new Error("TIFF data truncated");
    }
    this.bytes = bytes;
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const bom = this.dv.getUint16(0, false);
    if (bom === 0x49_49) {
      this.le = true;
    } else if (bom === 0x4d_4d) {
      this.le = false;
    } else {
      throw new Error("Not a TIFF structure (bad byte order mark)");
    }
    const magic = this.u16(2);
    if (magic === 0x2b) {
      throw new Error("BigTIFF is not supported");
    }
    if (magic !== 0x2a) {
      throw new Error("Not a TIFF structure (bad magic)");
    }
  }

  u16(o: number) {
    return this.dv.getUint16(o, this.le);
  }
  u32(o: number) {
    return this.dv.getUint32(o, this.le);
  }

  ifd0Offset() {
    return this.u32(4);
  }

  readIfd(off: number): { entries: RawEntry[]; next: number } {
    if (off < 8 || off + 2 > this.bytes.length) {
      throw new Error("IFD offset out of bounds");
    }
    const count = this.u16(off);
    if (count > 1024) {
      throw new Error("Implausible IFD entry count");
    }
    if (off + 2 + count * 12 + 4 > this.bytes.length) {
      throw new Error("IFD extends past end of data");
    }
    const entries: RawEntry[] = [];
    for (let i = 0; i < count; i += 1) {
      const e = off + 2 + i * 12;
      const tag = this.u16(e);
      const type = this.u16(e + 2);
      const count32 = this.u32(e + 4);
      const unit = TYPE_SIZE[type] ?? 0;
      const size = unit * count32;
      const valOff = size <= 4 ? e + 8 : this.u32(e + 8);
      entries.push({ count: count32, size, tag, type, valOff });
    }
    return { entries, next: this.u32(off + 2 + count * 12) };
  }

  valueInBounds(e: RawEntry): boolean {
    return (
      e.size > 0 && e.valOff >= 0 && e.valOff + e.size <= this.bytes.length
    );
  }

  readRationals(e: RawEntry): Rat[] {
    const out: Rat[] = [];
    for (let i = 0; i < e.count; i += 1) {
      const p = e.valOff + i * 8;
      out.push(
        e.type === 5
          ? { d: this.u32(p + 4), n: this.u32(p) }
          : {
              d: this.dv.getInt32(p + 4, this.le),
              n: this.dv.getInt32(p, this.le),
            }
      );
    }
    return out;
  }

  /** The number of a numeric type stored at `p`, or null for a type that is not a number. */
  readNumber(type: number, p: number): number | null {
    switch (type) {
      case 1: {
        return this.bytes[p];
      }
      case 3: {
        return this.u16(p);
      }
      case 4: {
        return this.u32(p);
      }
      case 6: {
        return this.dv.getInt8(p);
      }
      case 8: {
        return this.dv.getInt16(p, this.le);
      }
      case 9: {
        return this.dv.getInt32(p, this.le);
      }
      case 11: {
        return this.dv.getFloat32(p, this.le);
      }
      case 12: {
        return this.dv.getFloat64(p, this.le);
      }
      default: {
        return null;
      }
    }
  }

  readValue(e: RawEntry): Val | null {
    const unit = TYPE_SIZE[e.type];
    if (unit === undefined || unit === 0) {
      return null;
    }
    if (!this.valueInBounds(e)) {
      return null;
    }
    const o = e.valOff;
    if (e.type === 2) {
      const raw = this.bytes.subarray(o, o + e.count);
      return new TextDecoder().decode(raw).replace(/\0+$/u, "").trim();
    }
    if (e.type === 7 || (e.type === 1 && e.count > 64)) {
      return this.bytes.subarray(o, o + e.size);
    }
    if (e.type === 5 || e.type === 10) {
      return this.readRationals(e);
    }
    const nums: number[] = [];
    for (let i = 0; i < e.count; i += 1) {
      const n = this.readNumber(e.type, o + i * unit);
      if (n === null) {
        return null;
      }
      nums.push(n);
    }
    return nums;
  }
}

const ratNum = (r: Rat): number => (r.d === 0 ? Number.NaN : r.n / r.d);

const trimNum = (v: number, digits = 2): string => {
  if (!Number.isFinite(v)) {
    return "?";
  }
  return String(Number(v.toFixed(digits)));
};

const dmsToDecimal = (v: Rat[], ref: string): number | null => {
  if (v.length < 1) {
    return null;
  }
  const deg =
    ratNum(v[0]) +
    (v.length > 1 ? ratNum(v[1]) / 60 : 0) +
    (v.length > 2 ? ratNum(v[2]) / 3600 : 0);
  if (!Number.isFinite(deg)) {
    return null;
  }
  return ref === "S" || ref === "W" ? -deg : deg;
};

/** EXIF stores timestamps as "YYYY:MM:DD HH:MM:SS"; show the date part with dashes. */
const fmtExifDate = (s: string): string => {
  const m = /^(?<year>\d{4}):(?<month>\d{2}):(?<day>\d{2})(?<rest>.*)$/u.exec(
    s
  )?.groups;
  return m ? `${m.year}-${m.month}-${m.day}${m.rest}` : s;
};

const DATE_TAGS = new Set([
  "DateTime",
  "DateTimeOriginal",
  "DateTimeDigitized",
  "GPSDateStamp",
]);

/** UTF-16 text up to the first NUL, two bytes per unit, low byte first or high byte first. */
const utf16Units = (bytes: Uint8Array, littleEndian: boolean): string => {
  let s = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const c = littleEndian
      ? bytes[i] + bytes[i + 1] * 256
      : bytes[i] * 256 + bytes[i + 1];
    if (c === 0) {
      break;
    }
    s += String.fromCodePoint(c);
  }
  return s;
};

const ucs2 = (bytes: Uint8Array): string => utf16Units(bytes, true);

const ucs2Or16 = (bytes: Uint8Array): string => {
  // UserComment UNICODE payloads are UTF-16 with unspecified endianness; guess LE
  // unless the first character decodes as garbage.
  const le = ucs2(bytes);
  if (le && /[\u0020-\u007E]/u.test(le[0] ?? "")) {
    return le.trim();
  }
  return utf16Units(bytes, false).trim();
};

const ASCII_VERSION_TAGS = new Set([
  "ExifVersion",
  "FlashpixVersion",
  "SceneType",
  "FileSource",
]);

const GPS_COORDINATE_TAGS = new Set([
  "GPSLatitude",
  "GPSLongitude",
  "GPSDestLatitude",
  "GPSDestLongitude",
]);

/** A UserComment's text after its eight-byte charset code, or "" when there is none. */
const userComment = (val: Uint8Array): string => {
  const charset = new TextDecoder()
    .decode(val.subarray(0, 8))
    .replace(/\0+$/u, "");
  const body = val.subarray(8);
  return charset === "UNICODE"
    ? ucs2Or16(body)
    : new TextDecoder().decode(body).replace(/\0+$/u, "").trim();
};

/** Byte-valued tags: version strings, comments, and Windows XP UCS-2 text; otherwise just the size. */
const formatBytes = (name: string, val: Uint8Array): string => {
  if (ASCII_VERSION_TAGS.has(name)) {
    return (
      new TextDecoder().decode(val).replace(/\0+$/u, "") ||
      `(${val.length} bytes)`
    );
  }
  if (name === "UserComment" && val.length > 8) {
    const text = userComment(val);
    if (text) {
      return text;
    }
  }
  if (name.startsWith("XP")) {
    const text = ucs2(val);
    if (text) {
      return text;
    }
  }
  if (name === "GPSProcessingMethod" && val.length > 8) {
    const text = new TextDecoder()
      .decode(val.subarray(8))
      .replace(/\0+$/u, "")
      .trim();
    if (text) {
      return text;
    }
  }
  return `(${val.length} bytes)`;
};

/** A single rational in the unit its tag is read in, or null for tags shown as plain fractions. */
const formatRationalTag = (name: string, rats: Rat[]): string | null => {
  const v = ratNum(rats[0]);
  switch (name) {
    case "ExposureTime": {
      return v > 0 && v < 1 ? `1/${Math.round(1 / v)} s` : `${trimNum(v, 4)} s`;
    }
    case "FNumber": {
      return `f/${trimNum(v, 1)}`;
    }
    case "FocalLength": {
      return `${trimNum(v, 1)} mm`;
    }
    case "ExposureBiasValue": {
      return `${(v > 0 ? "+" : "") + trimNum(v)} EV`;
    }
    case "GPSAltitude": {
      return `${trimNum(v, 1)} m`;
    }
    default: {
      return null;
    }
  }
};

const formatRationals = (name: string, rats: Rat[]): string => {
  const single = formatRationalTag(name, rats);
  if (single !== null) {
    return single;
  }
  if (GPS_COORDINATE_TAGS.has(name) && rats.length >= 3) {
    return `${trimNum(ratNum(rats[0]), 0)}° ${trimNum(
      ratNum(rats[1]),
      0
    )}′ ${trimNum(ratNum(rats[2]), 3)}″`;
  }
  if (name === "GPSTimeStamp" && rats.length >= 3) {
    const pad = (r: Rat) => String(Math.floor(ratNum(r))).padStart(2, "0");
    return `${pad(rats[0])}:${pad(rats[1])}:${pad(rats[2])}`;
  }
  if (name === "LensSpecification" && rats.length >= 4) {
    return rats.map((r) => trimNum(ratNum(r), 1)).join(", ");
  }
  const parts = rats
    .slice(0, 8)
    .map((r) => (r.d === 1 ? String(r.n) : `${r.n}/${r.d}`));
  return (
    parts.join(", ") + (rats.length > 8 ? `, … (${rats.length} values)` : "")
  );
};

/** Scratch for reading a number as a 32-bit integer, the way bitwise operators do. */
const INT32 = new Int32Array(1);

/** Flash: bit 0 says whether it fired. */
const formatFlash = (v: number): string => {
  INT32[0] = v;
  const fired = INT32[0] % 2 !== 0;
  return `${fired ? "Fired" : "Did not fire"} (0x${v.toString(16)})`;
};

const isRationals = (val: number[] | Rat[]): val is Rat[] =>
  val.length > 0 && typeof val[0] === "object";

const formatValue = (name: string, val: Val): string => {
  const en = ENUMS[name];
  if (
    en &&
    Array.isArray(val) &&
    val.length === 1 &&
    typeof val[0] === "number"
  ) {
    const label = en[val[0]];
    if (label) {
      return label;
    }
  }
  if (name === "Flash" && Array.isArray(val) && typeof val[0] === "number") {
    return formatFlash(val[0]);
  }
  if (typeof val === "string") {
    return DATE_TAGS.has(name) ? fmtExifDate(val) : val;
  }
  if (val instanceof Uint8Array) {
    return formatBytes(name, val);
  }
  if (isRationals(val)) {
    return formatRationals(name, val);
  }
  if (name === "FocalLengthIn35mmFilm") {
    return `${val[0]} mm`;
  }
  const parts = val.slice(0, 8).map((n) => trimNum(n, 4));
  return (
    parts.join(", ") + (val.length > 8 ? `, … (${val.length} values)` : "")
  );
};

/** IFD pointers, followed rather than listed. */
const POINTER_TAGS = new Set([34_665, 34_853, 40_965]);

interface ParseState {
  t: Tiff;
  info: TiffInfo;
  gpsRaw: Map<number, Val>;
  visited: Set<number>;
}

const sizeOnlyTag = (e: RawEntry, group: string, name: string): ExifTag => ({
  group,
  id: e.tag,
  name,
  value: `(${e.size} bytes)`,
});

/** Tags holding a payload of their own (MakerNote, XMP, IPTC, ICC): recorded by size. False when `e` is not one. */
const readPayloadTag = (
  s: ParseState,
  e: RawEntry,
  group: string,
  name: string
): boolean => {
  const { info, t } = s;
  if (e.tag === 37_500) {
    info.makerNoteBytes = e.size;
    info.tags.push({
      group,
      id: e.tag,
      name: "MakerNote",
      value: `(${e.size} bytes, not decoded)`,
    });
    return true;
  }
  if (group !== "Image") {
    return false;
  }
  if (e.tag === 700) {
    if (t.valueInBounds(e)) {
      info.xmp = new TextDecoder()
        .decode(t.bytes.subarray(e.valOff, e.valOff + e.size))
        .replace(/\0+$/u, "");
    }
  } else if (e.tag === 33_723) {
    if (t.valueInBounds(e)) {
      info.iptc = t.bytes.slice(e.valOff, e.valOff + e.size);
    }
  } else if (e.tag === 34_675) {
    info.iccBytes = e.size;
  } else {
    return false;
  }
  info.tags.push(sizeOnlyTag(e, group, name));
  return true;
};

/** The summary fields a number fills in: orientation and pixel size. */
const noteNumber = (info: TiffInfo, tag: number, group: string, n: number) => {
  if (group === "Image" && tag === 274) {
    info.orientation = n;
  }
  if (group === "Image" && tag === 256) {
    info.width = n;
  }
  if (group === "Image" && tag === 257) {
    info.height = n;
  }
  if (tag === 40_962 && group === "Photo" && info.width === null) {
    info.width = n;
  }
  if (tag === 40_963 && group === "Photo" && info.height === null) {
    info.height = n;
  }
};

/** The summary fields a decoded value fills in: orientation, size, camera, and capture date. */
const noteSummary = (info: TiffInfo, e: RawEntry, group: string, val: Val) => {
  if (Array.isArray(val) && typeof val[0] === "number") {
    noteNumber(info, e.tag, group, val[0]);
  }
  if (typeof val === "string") {
    if (e.tag === 271 && group === "Image") {
      info.make = val;
    }
    if (e.tag === 272 && group === "Image") {
      info.model = val;
    }
    if ((e.tag === 36_867 || e.tag === 306) && info.dateTaken === null && val) {
      info.dateTaken = fmtExifDate(val);
    }
  }
};

const readEntry = (s: ParseState, e: RawEntry, group: string, name: string) => {
  if (POINTER_TAGS.has(e.tag) || readPayloadTag(s, e, group, name)) {
    return;
  }
  const { info } = s;
  const val = s.t.readValue(e);
  if (val === null) {
    info.tags.push({ group, id: e.tag, name, value: "(unreadable)" });
    return;
  }
  if (group === "GPS") {
    s.gpsRaw.set(e.tag, val);
  }
  const shown = formatValue(name, val);
  info.tags.push({
    group,
    id: e.tag,
    name,
    value: shown.length > 160 ? `${shown.slice(0, 160)}…` : shown,
  });
  noteSummary(info, e, group, val);
};

/** Reads one IFD into the tag list; null when it was seen before, too many were read, or it is unreadable. */
const readGroup = (
  s: ParseState,
  off: number,
  group: string,
  names: Map<number, string>
): { entries: RawEntry[]; next: number } | null => {
  if (s.visited.has(off) || s.visited.size > 32) {
    return null;
  }
  s.visited.add(off);
  let ifd;
  try {
    ifd = s.t.readIfd(off);
  } catch {
    return null;
  }
  for (const e of ifd.entries) {
    const name =
      names.get(e.tag) ?? `Tag 0x${e.tag.toString(16).padStart(4, "0")}`;
    readEntry(s, e, group, name);
  }
  return ifd;
};

/** The first number of a pointer tag's value, if it has one. */
const pointerOf = (t: Tiff, e: RawEntry): number | null => {
  const v = t.readValue(e);
  return Array.isArray(v) && typeof v[0] === "number" ? v[0] : null;
};

/** The Exif IFD, the Interoperability IFD inside it, and the GPS IFD. */
const readSubIfds = (s: ParseState, ifd0: RawEntry[]) => {
  for (const e of ifd0) {
    if (e.tag === 34_665) {
      const exifOff = pointerOf(s.t, e);
      const exifIfd =
        exifOff === null ? null : readGroup(s, exifOff, "Photo", EXIF_TAGS);
      for (const ee of exifIfd?.entries ?? []) {
        const interopOff = ee.tag === 40_965 ? pointerOf(s.t, ee) : null;
        if (interopOff !== null) {
          readGroup(s, interopOff, "Interop", INTEROP_TAGS);
        }
      }
    }
    if (e.tag === 34_853) {
      const gpsOff = pointerOf(s.t, e);
      if (gpsOff !== null) {
        readGroup(s, gpsOff, "GPS", GPS_TAGS);
      }
    }
  }
};

/** Thumbnail: IFD1 in the chain. */
const readThumbnail = (s: ParseState, next: number) => {
  if (!next) {
    return;
  }
  const ifd1 = readGroup(s, next, "Thumbnail", IFD0_TAGS);
  for (const e of ifd1?.entries ?? []) {
    if (e.tag === 514 || e.tag === 279) {
      const v = s.t.readValue(e);
      if (Array.isArray(v)) {
        for (const n of v as number[]) {
          s.info.thumbnailBytes += typeof n === "number" ? n : 0;
        }
      }
    }
  }
};

const gpsPosition = (
  gpsRaw: Map<number, Val>
): { lat: number; lon: number } | null => {
  const lat = gpsRaw.get(2);
  const lon = gpsRaw.get(4);
  const latRef = gpsRaw.get(1);
  const lonRef = gpsRaw.get(3);
  if (
    !Array.isArray(lat) ||
    !Array.isArray(lon) ||
    !lat.length ||
    !lon.length ||
    typeof lat[0] !== "object"
  ) {
    return null;
  }
  const dLat = dmsToDecimal(
    lat as Rat[],
    typeof latRef === "string" ? latRef : "N"
  );
  const dLon = dmsToDecimal(
    lon as Rat[],
    typeof lonRef === "string" ? lonRef : "E"
  );
  return dLat !== null && dLon !== null ? { lat: dLat, lon: dLon } : null;
};

/** Decode a TIFF blob for display. Tolerant: bad sub-IFDs are skipped, only a
    broken header throws. */
export const parseTiff = (bytes: Uint8Array): TiffInfo => {
  const t = new Tiff(bytes);
  const info: TiffInfo = {
    dateTaken: null,
    gps: null,
    height: null,
    iccBytes: 0,
    iptc: null,
    make: null,
    makerNoteBytes: 0,
    model: null,
    orientation: null,
    tags: [],
    thumbnailBytes: 0,
    width: null,
    xmp: null,
  };
  const s: ParseState = { gpsRaw: new Map(), info, t, visited: new Set() };

  const ifd0 = readGroup(s, t.ifd0Offset(), "Image", IFD0_TAGS);
  if (!ifd0) {
    throw new Error("Broken IFD0");
  }
  readSubIfds(s, ifd0.entries);
  readThumbnail(s, ifd0.next);
  const gps = gpsPosition(s.gpsRaw);
  if (gps) {
    info.gps = gps;
  }
  return info;
};

/** Minimal EXIF TIFF blob carrying only the Orientation tag. Kept in a Strip
    when the original had a non-default orientation (see ADR 0001). */
export const buildOrientationTiff = (orientation: number): Uint8Array => {
  const out = new Uint8Array(26);
  const dv = new DataView(out.buffer);
  // Little endian
  out[0] = 0x49;
  out[1] = 0x49;
  dv.setUint16(2, 42, true);
  // IFD0 at offset 8, holding one entry
  dv.setUint32(4, 8, true);
  dv.setUint16(8, 1, true);
  // Orientation, a SHORT
  dv.setUint16(10, 274, true);
  dv.setUint16(12, 3, true);
  dv.setUint32(14, 1, true);
  dv.setUint16(18, orientation, true);
  // No next IFD
  dv.setUint32(22, 0, true);
  return out;
};

// ---------------------------------------------------------------------------
// TIFF file Strip: rebuild the file keeping only what is needed to decode the
// pixels, plus ICC and Orientation (rendering-critical, see ADR 0001).

const TIFF_KEEP = new Set([
  254, 255, 256, 257, 258, 259, 262, 263, 264, 265, 266, 273, 274, 277, 278,
  279, 280, 281, 282, 283, 284, 290, 291, 292, 293, 296, 297, 301, 317, 318,
  319, 320, 321, 322, 323, 324, 325, 332, 336, 338, 339, 340, 341, 347, 512,
  515, 516, 517, 518, 519, 520, 521, 529, 530, 531, 532, 34_675,
]);

/** True when the TIFF chain carries any tag a Strip would remove. */
export const tiffHasDroppable = (src: Uint8Array): boolean => {
  try {
    const t = new Tiff(src);
    let off = t.ifd0Offset();
    const seen = new Set<number>();
    while (off !== 0 && !seen.has(off) && seen.size < 64) {
      seen.add(off);
      const ifd = t.readIfd(off);
      for (const e of ifd.entries) {
        if (!TIFF_KEEP.has(e.tag)) {
          return true;
        }
      }
      off = ifd.next;
    }
  } catch {
    return false;
  }
  return false;
};

interface KeptEntry {
  tag: number;
  type: number;
  count: number;
  /** Raw value bytes in file byte order; for pointer tags, filled in later. */
  data: Uint8Array;
}

interface Page {
  kept: KeptEntry[];
  blocks: { data: Uint8Array }[][];
  pointerTags: number[];
}

/** Pixel data pointer and size tags, rewritten by the Strip. */
const PIXEL_POINTER_TAGS = new Set([273, 279, 324, 325, 513, 514]);

const numArray = (t: Tiff, e: RawEntry): number[] => {
  const v = t.readValue(e);
  if (!Array.isArray(v) || v.length === 0 || typeof v[0] !== "number") {
    throw new Error(`Unreadable offsets in tag ${e.tag}`);
  }
  return v as number[];
};

const entryOf = (byTag: Map<number, RawEntry>, tag: number): RawEntry => {
  const e = byTag.get(tag);
  if (!e) {
    throw new Error(`TIFF page has no tag ${tag}`);
  }
  return e;
};

/** Pixel data pointer pairs: strips, tiles, and old-style JPEG streams. */
const pixelPairs = (
  t: Tiff,
  byTag: Map<number, RawEntry>
): [number, number][] => {
  const comp = byTag.get(259);
  const compression = comp ? numArray(t, comp)[0] : 1;
  const pairs: [number, number][] = [];
  if (byTag.has(273) && byTag.has(279)) {
    pairs.push([273, 279]);
  }
  if (byTag.has(322) && byTag.has(324) && byTag.has(325)) {
    pairs.push([324, 325]);
  }
  if (compression === 6 && byTag.has(513) && byTag.has(514)) {
    pairs.push([513, 514]);
  }
  if (pairs.length === 0) {
    throw new Error("TIFF page has no pixel data; refusing to strip");
  }
  return pairs;
};

/** One IFD's kept tags and pixel blocks. */
const readPage = (
  t: Tiff,
  src: Uint8Array,
  ifd: { entries: RawEntry[] }
): Page => {
  const byTag = new Map<number, RawEntry>();
  for (const e of ifd.entries) {
    byTag.set(e.tag, e);
  }
  const kept: KeptEntry[] = [];
  const blocks: { data: Uint8Array }[][] = [];
  const pointerTags: number[] = [];

  for (const [offTag, cntTag] of pixelPairs(t, byTag)) {
    const offsets = numArray(t, entryOf(byTag, offTag));
    const counts = numArray(t, entryOf(byTag, cntTag));
    if (offsets.length !== counts.length) {
      throw new Error("Offset/count mismatch in TIFF page");
    }
    const group: { data: Uint8Array }[] = [];
    for (const [i, s] of offsets.entries()) {
      const n = counts[i];
      if (s + n > src.length) {
        throw new Error("Pixel data out of bounds");
      }
      group.push({ data: src.subarray(s, s + n) });
    }
    blocks.push(group);
    pointerTags.push(offTag);
    kept.push({
      count: offsets.length,
      data: new Uint8Array(0),
      tag: offTag,
      type: 4,
    });
    const cw = new TiffWriter(t.le);
    for (const n of counts) {
      cw.u32(n);
    }
    kept.push({
      count: counts.length,
      data: cw.toBytes(),
      tag: cntTag,
      type: 4,
    });
  }

  for (const e of ifd.entries) {
    if (!TIFF_KEEP.has(e.tag) || PIXEL_POINTER_TAGS.has(e.tag)) {
      continue;
    }
    const unit = TYPE_SIZE[e.type];
    if (!unit) {
      throw new Error(`Unknown type on structural tag ${e.tag}`);
    }
    if (!t.valueInBounds(e)) {
      throw new Error(`Structural tag ${e.tag} value out of bounds`);
    }
    kept.push({
      count: e.count,
      data: src.slice(e.valOff, e.valOff + e.size),
      tag: e.tag,
      type: e.type,
    });
  }

  kept.sort((a, b) => a.tag - b.tag);
  return { blocks, kept, pointerTags };
};

/** Every page in the IFD chain. */
const readPages = (t: Tiff, src: Uint8Array): Page[] => {
  const pages: Page[] = [];
  const visited = new Set<number>();
  let off = t.ifd0Offset();
  while (off !== 0) {
    if (visited.has(off)) {
      throw new Error("IFD loop");
    }
    if (visited.size > 64) {
      throw new Error("Too many TIFF pages");
    }
    visited.add(off);
    const ifd = t.readIfd(off);
    pages.push(readPage(t, src, ifd));
    off = ifd.next;
  }
  if (pages.length === 0) {
    throw new Error("TIFF has no pages");
  }
  return pages;
};

/** Where a page's out-of-line values and pixel blocks go, laid out after its IFD. */
const layoutPage = (
  page: Page,
  ifdStart: number
): { valuePos: Map<KeptEntry, number>; blockPos: number[][] } => {
  const n = page.kept.length;
  const ifdSize = 2 + n * 12 + 4;
  let cursor = ifdStart + ifdSize;
  const valuePos = new Map<KeptEntry, number>();
  for (const e of page.kept) {
    const size = page.pointerTags.includes(e.tag) ? e.count * 4 : e.data.length;
    if (size > 4) {
      if (cursor % 2) {
        cursor += 1;
      }
      valuePos.set(e, cursor);
      cursor += size;
    }
  }
  const blockPos: number[][] = [];
  for (const group of page.blocks) {
    const positions: number[] = [];
    for (const b of group) {
      if (cursor % 2) {
        cursor += 1;
      }
      positions.push(cursor);
      cursor += b.data.length;
    }
    blockPos.push(positions);
  }
  return { blockPos, valuePos };
};

const positionOf = (valuePos: Map<KeptEntry, number>, e: KeptEntry): number => {
  const pos = valuePos.get(e);
  if (pos === undefined) {
    throw new Error("TIFF layout error");
  }
  return pos;
};

/** Writes one page; returns where its next-IFD pointer is, for the page after it to fill in. */
const writePage = (
  w: TiffWriter,
  le: boolean,
  page: Page,
  prevNextPos: number
): number => {
  w.align(2);
  const ifdStart = w.length;
  if (prevNextPos >= 0) {
    w.setU32At(prevNextPos, ifdStart);
  }
  const { blockPos, valuePos } = layoutPage(page, ifdStart);

  // Fill pointer-tag value bytes now that block positions are known.
  for (const [gi, tag] of page.pointerTags.entries()) {
    const e = page.kept.find((k) => k.tag === tag);
    if (!e) {
      throw new Error("TIFF layout error");
    }
    const ow = new TiffWriter(le);
    for (const p of blockPos[gi]) {
      ow.u32(p);
    }
    e.data = ow.toBytes();
  }

  w.u16(page.kept.length);
  for (const e of page.kept) {
    w.u16(e.tag);
    w.u16(e.type);
    w.u32(e.count);
    if (e.data.length <= 4) {
      w.raw(e.data);
      for (let i = e.data.length; i < 4; i += 1) {
        w.u8(0);
      }
    } else {
      w.u32(positionOf(valuePos, e));
    }
  }
  const nextPos = w.length;
  w.u32(0);

  for (const e of page.kept) {
    if (e.data.length > 4) {
      w.align(2);
      if (w.length !== valuePos.get(e)) {
        throw new Error("TIFF layout error");
      }
      w.raw(e.data);
    }
  }
  for (const [gi, group] of page.blocks.entries()) {
    for (const [bi, block] of group.entries()) {
      w.align(2);
      if (w.length !== blockPos[gi][bi]) {
        throw new Error("TIFF layout error");
      }
      w.raw(block.data);
    }
  }
  return nextPos;
};

/** Rebuild a standalone TIFF with all Metadata removed. Throws when the file
    cannot be walked cleanly; a possibly-broken output is never produced. */
export const stripTiff = (src: Uint8Array): Uint8Array => {
  const t = new Tiff(src);
  const pages = readPages(t, src);

  const w = new TiffWriter(t.le);
  w.u8(t.le ? 0x49 : 0x4d);
  w.u8(t.le ? 0x49 : 0x4d);
  w.u16(42);
  w.u32(8);

  let prevNextPos = -1;
  for (const page of pages) {
    prevNextPos = writePage(w, t.le, page, prevNextPos);
  }
  return w.toBytes();
};
