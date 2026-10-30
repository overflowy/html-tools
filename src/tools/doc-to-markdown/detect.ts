// What kind of Document the user gave us, decided before any engine is loaded.
// The converter's own detection is the authority for office formats; this
// pass only has to tell an image from an office document, and name the
// format for the few cases the converter cannot sniff (CSV has no signature).

/** Office families the converter handles, as the converter names them. */
export type OfficeFormat =
  | "doc"
  | "docx"
  | "odt"
  | "pdf"
  | "ppt"
  | "pptx"
  | "rtf"
  | "epub"
  | "xlsx"
  | "ods"
  | "odp"
  | "csv";

export type ImageFormat = "png" | "jpeg" | "webp" | "gif" | "bmp" | "tiff";

export type Detected =
  | { kind: "office"; format: OfficeFormat }
  | { kind: "image"; format: ImageFormat }
  | { kind: "unknown"; ext: string };

/**
 * Extensions the converter accepts, mapped onto the format it converts them
 * as. Kept as ordered pairs: the file picker lists them in this order.
 */
const OFFICE_EXTENSIONS: [string, OfficeFormat][] = [
  ["doc", "doc"],
  ["docx", "docx"],
  ["docm", "docx"],
  ["ppt", "ppt"],
  ["pps", "ppt"],
  ["pot", "ppt"],
  ["pptx", "pptx"],
  ["pptm", "pptx"],
  ["ppsx", "pptx"],
  ["ppsm", "pptx"],
  ["xls", "xlsx"],
  ["xlsx", "xlsx"],
  ["xlsm", "xlsx"],
  ["xlsb", "xlsx"],
  ["odt", "odt"],
  ["ods", "ods"],
  ["odp", "odp"],
  ["rtf", "rtf"],
  ["epub", "epub"],
  ["csv", "csv"],
  ["pdf", "pdf"],
];

const IMAGE_EXTENSIONS: [string, ImageFormat][] = [
  ["png", "png"],
  ["jpg", "jpeg"],
  ["jpeg", "jpeg"],
  ["webp", "webp"],
  ["gif", "gif"],
  ["bmp", "bmp"],
  ["tif", "tiff"],
  ["tiff", "tiff"],
];

export const OFFICE_EXT: Record<string, OfficeFormat> =
  Object.fromEntries(OFFICE_EXTENSIONS);

export const IMAGE_EXT: Record<string, ImageFormat> =
  Object.fromEntries(IMAGE_EXTENSIONS);

/** The `accept` attribute for the file picker: every extension above. */
export const ACCEPT = [...OFFICE_EXTENSIONS, ...IMAGE_EXTENSIONS]
  .map(([e]) => `.${e}`)
  .join(",");

export const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

const startsWith = (bytes: Uint8Array, sig: number[], at = 0): boolean => {
  if (bytes.length < at + sig.length) {
    return false;
  }
  for (let i = 0; i < sig.length; i += 1) {
    if (bytes[at + i] !== sig[i]) {
      return false;
    }
  }
  return true;
};

const ascii = (bytes: Uint8Array, from: number, to: number): string => {
  let s = "";
  for (const b of bytes.subarray(from, to)) {
    s += String.fromCodePoint(b);
  }
  return s;
};

/** Image formats by signature. Images are never sniffed by the converter, so this is the only image detection. */
export const sniffImage = (bytes: Uint8Array): ImageFormat | null => {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "png";
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return "jpeg";
  }
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) {
    return "gif";
  }
  if (startsWith(bytes, [0x42, 0x4d])) {
    return "bmp";
  }
  if (
    startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) ||
    startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])
  ) {
    return "tiff";
  }
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") {
    return "webp";
  }
  return null;
};

/**
 * Office formats by signature, only as far as needed to say "this is an office
 * document" before the converter is loaded. Zip containers (docx, xlsx, pptx,
 * odt, ods, odp, epub) are told apart by the converter, not here.
 */
export const sniffOffice = (bytes: Uint8Array): OfficeFormat | "zip" | null => {
  if (ascii(bytes, 0, 5) === "%PDF-") {
    return "pdf";
  }
  if (ascii(bytes, 0, 5) === "{\\rtf") {
    return "rtf";
  }
  // OLE2: doc, xls, or ppt; converter decides
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return "doc";
  }
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    return "zip";
  }
  return null;
};

/**
 * Decide by content first, by extension second. An extension is only trusted
 * when the content says nothing, or agrees with it at the family level.
 */
export const detect = (bytes: Uint8Array, name: string): Detected => {
  const ext = extensionOf(name);
  const image = sniffImage(bytes);
  if (image) {
    return { format: image, kind: "image" };
  }

  const office = sniffOffice(bytes);
  const byExt = OFFICE_EXT[ext];
  if (office === "zip") {
    // A zip could be any OOXML/ODF/EPUB; let the converter sniff the parts.
    // Pass the extension's format along as a hint if it names a zip family.
    if (
      byExt &&
      byExt !== "pdf" &&
      byExt !== "rtf" &&
      byExt !== "csv" &&
      byExt !== "doc" &&
      byExt !== "ppt"
    ) {
      return { format: byExt, kind: "office" };
    }
    return { format: "docx", kind: "office" };
  }
  if (office === "doc") {
    // OLE2 container: the extension says which office app, if it is one of them.
    if (byExt === "xlsx") {
      return { format: "xlsx", kind: "office" };
    }
    if (byExt === "ppt") {
      return { format: "ppt", kind: "office" };
    }
    return { format: "doc", kind: "office" };
  }
  if (office) {
    return { format: office, kind: "office" };
  }

  if (byExt) {
    return { format: byExt, kind: "office" };
  }
  const imageExt = IMAGE_EXT[ext];
  if (imageExt) {
    return { format: imageExt, kind: "image" };
  }
  return { ext, kind: "unknown" };
};
