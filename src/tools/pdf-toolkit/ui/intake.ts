// What a dropped or picked file is to the Toolkit: a PDF, an image to make
// into a page, a document MuPDF lays out (an e-book), or none of those.

import { CONVERTIBLE } from "../pdf/convert";
import { extension } from "./dom";

const IMAGE_EXT = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "bmp",
  "tif",
  "tiff",
  "webp",
  "avif",
  "heic",
  "svg",
  "jxr",
  "jp2",
  "pnm",
  "pbm",
  "pgm",
  "ppm",
]);
/** Images MuPDF reads itself; the rest the browser decodes first. */
const MUPDF_IMAGES = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "bmp",
  "tif",
  "tiff",
  "jp2",
  "pnm",
  "pbm",
  "pgm",
  "ppm",
]);

export type FileKind = "pdf" | "image" | "convertible" | "other";

/** What a file is, by its first bytes, its type, and its name. */
export const kindOf = async (file: File): Promise<FileKind> => {
  const ext = extension(file.name);
  if (IMAGE_EXT.has(ext) || file.type.startsWith("image/")) {
    return "image";
  }
  const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  if (
    ext === "pdf" ||
    new TextDecoder("latin1").decode(head).includes("%PDF-")
  ) {
    return "pdf";
  }
  return CONVERTIBLE[ext] ? "convertible" : "other";
};

/** The PNG the browser makes of an image it decodes. */
const toPng = async (file: File): Promise<Uint8Array> => {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement("canvas");
    // An SVG without a size of its own is drawn at a size worth printing.
    canvas.width = img.naturalWidth || 1024;
    canvas.height = img.naturalHeight || 1024;
    canvas.getContext("2d")?.drawImage(img, 0, 0, canvas.width, canvas.height);
    const { promise, resolve, reject } = Promise.withResolvers<Blob>();
    canvas.toBlob((b) => {
      if (b) {
        resolve(b);
      } else {
        reject(new Error(`${file.name} could not be decoded.`));
      }
    }, "image/png");
    const blob = await promise;
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    URL.revokeObjectURL(url);
  }
};

/** An image in a form MuPDF reads: as it is, or decoded by the browser into PNG (WebP, AVIF, HEIC, SVG). */
export const mupdfImage = async (file: File): Promise<Uint8Array> =>
  MUPDF_IMAGES.has(extension(file.name))
    ? new Uint8Array(await file.arrayBuffer())
    : toPng(file);
