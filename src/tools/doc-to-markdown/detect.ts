// What kind of Document the user gave us, decided before any engine is loaded.
// The converter's own detection is the authority for office formats; this
// pass only has to tell an image from an office document, and name the
// format for the few cases the converter cannot sniff (CSV has no signature).

/** Office families the converter handles, as the converter names them. */
export type OfficeFormat = "doc" | "docx" | "odt" | "pdf" | "ppt" | "pptx" | "rtf" | "epub" | "xlsx" | "ods" | "odp" | "csv";

export type ImageFormat = "png" | "jpeg" | "webp" | "gif" | "bmp" | "tiff";

export type Detected =
  | { kind: "office"; format: OfficeFormat }
  | { kind: "image"; format: ImageFormat }
  | { kind: "unknown"; ext: string };

/** Extensions the converter accepts, mapped onto the format it converts them as. */
export const OFFICE_EXT: Record<string, OfficeFormat> = {
  doc: "doc", docx: "docx", docm: "docx",
  ppt: "ppt", pps: "ppt", pot: "ppt", pptx: "pptx", pptm: "pptx", ppsx: "pptx", ppsm: "pptx",
  xls: "xlsx", xlsx: "xlsx", xlsm: "xlsx", xlsb: "xlsx",
  odt: "odt", ods: "ods", odp: "odp",
  rtf: "rtf", epub: "epub", csv: "csv", pdf: "pdf",
};

export const IMAGE_EXT: Record<string, ImageFormat> = {
  png: "png", jpg: "jpeg", jpeg: "jpeg", webp: "webp", gif: "gif", bmp: "bmp", tif: "tiff", tiff: "tiff",
};

/** The `accept` attribute for the file picker: every extension above. */
export const ACCEPT = Object.keys(OFFICE_EXT).concat(Object.keys(IMAGE_EXT)).map((e) => "." + e).join(",");

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function startsWith(bytes: Uint8Array, sig: number[], at = 0): boolean {
  if (bytes.length < at + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (bytes[at + i] !== sig[i]) return false;
  return true;
}

function ascii(bytes: Uint8Array, from: number, to: number): string {
  let s = "";
  for (let i = from; i < Math.min(to, bytes.length); i++) s += String.fromCharCode(bytes[i]!);
  return s;
}

/** Image formats by signature. Images are never sniffed by the converter, so this is the only image detection. */
export function sniffImage(bytes: Uint8Array): ImageFormat | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "gif";
  if (startsWith(bytes, [0x42, 0x4d])) return "bmp";
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return "tiff";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "webp";
  return null;
}

/**
 * Office formats by signature, only as far as needed to say "this is an office
 * document" before the converter is loaded. Zip containers (docx, xlsx, pptx,
 * odt, ods, odp, epub) are told apart by the converter, not here.
 */
export function sniffOffice(bytes: Uint8Array): OfficeFormat | "zip" | null {
  if (ascii(bytes, 0, 5) === "%PDF-") return "pdf";
  if (ascii(bytes, 0, 5) === "{\\rtf") return "rtf";
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return "doc"; // OLE2: doc, xls, or ppt; converter decides
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return "zip";
  return null;
}

/**
 * Decide by content first, by extension second. An extension is only trusted
 * when the content says nothing, or agrees with it at the family level.
 */
export function detect(bytes: Uint8Array, name: string): Detected {
  const ext = extensionOf(name);
  const image = sniffImage(bytes);
  if (image) return { kind: "image", format: image };

  const office = sniffOffice(bytes);
  const byExt = OFFICE_EXT[ext];
  if (office === "zip") {
    // A zip could be any OOXML/ODF/EPUB; let the converter sniff the parts.
    // Pass the extension's format along as a hint if it names a zip family.
    if (byExt && byExt !== "pdf" && byExt !== "rtf" && byExt !== "csv" && byExt !== "doc" && byExt !== "ppt") return { kind: "office", format: byExt };
    return { kind: "office", format: "docx" };
  }
  if (office === "doc") {
    // OLE2 container: the extension says which office app, if it is one of them.
    if (byExt === "xlsx") return { kind: "office", format: "xlsx" };
    if (byExt === "ppt") return { kind: "office", format: "ppt" };
    return { kind: "office", format: "doc" };
  }
  if (office) return { kind: "office", format: office };

  if (byExt) return { kind: "office", format: byExt };
  const imageExt = IMAGE_EXT[ext];
  if (imageExt) return { kind: "image", format: imageExt };
  return { kind: "unknown", ext };
}
