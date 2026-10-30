// Images: saved out of a PDF (JPEGs and JPEG 2000 exactly as stored,
// anything else as PNG), recompressed to make a PDF smaller, and made into
// pages (Images to PDF).

import type { Image, PDFDocument, PDFObject, Pixmap } from "mupdf";

import { Painter } from "./compose";
import { openPdf, savePdf } from "./doc";
import type { Env, OutFile } from "./doc";
import { Fonts } from "./fonts";
import {
  POINTS_PER_INCH,
  POINTS_PER_MM,
  chain,
  paperSize,
  scale,
  translate,
} from "./geometry";
import type { Matrix, PaperId } from "./geometry";
import { walkResources } from "./inspect";
import type { Orientation } from "./layout";
import { dig, itemsOf, textOf } from "./objects";

/* ---------------- what an image is ---------------- */

/** The image's filters, outermost first. */
const filtersOf = (obj: PDFObject): string[] => {
  const f = obj.get("Filter");
  return f.isArray() ? itemsOf(f).map(textOf) : [textOf(f)].filter(Boolean);
};

/** The colour space's family: DeviceRGB, ICCBased, Indexed, ... */
const colorFamily = (obj: PDFObject): string => {
  const cs = obj.get("ColorSpace").resolve();
  if (cs.isName()) {
    return cs.asName();
  }
  return cs.isArray() ? textOf(cs.get(0)) : "";
};

/** Components of the image's colour space: 1, 3, 4, or 0 when not plainly known. */
const components = (obj: PDFObject): number => {
  const family = colorFamily(obj);
  if (family === "DeviceGray" || family === "CalGray") {
    return 1;
  }
  if (family === "DeviceRGB" || family === "CalRGB") {
    return 3;
  }
  if (family === "DeviceCMYK") {
    return 4;
  }
  if (family === "ICCBased") {
    const n = dig(obj, "ColorSpace", 1, "N");
    return n?.asNumber() ?? 0;
  }
  return 0;
};

/** Every image XObject in the document, once, with the first page (0-based) it is on and the largest page that uses it. */
const allImages = (doc: PDFDocument) => {
  const found = new Map<
    number,
    { ref: PDFObject; page: number; maxW: number; maxH: number }
  >();
  const n = doc.countPages();
  for (let i = 0; i < n; i += 1) {
    const page = doc.loadPage(i);
    const [x0, y0, x1, y1] = page.getBounds();
    walkResources(
      page.getObject().getInheritable("Resources"),
      {
        image: (ref) => {
          const key = ref.asIndirect();
          const known = found.get(key);
          if (known) {
            known.maxW = Math.max(known.maxW, x1 - x0);
            known.maxH = Math.max(known.maxH, y1 - y0);
          } else {
            found.set(key, { maxH: y1 - y0, maxW: x1 - x0, page: i, ref });
          }
        },
      },
      // Per page: an image on two pages is seen on both.
      new Set()
    );
  }
  return [...found.values()];
};

/* ---------------- extract ---------------- */

export interface ImageInfo {
  /** File name in the download. */
  name: string;
  /** 1-based page it first appears on. */
  page: number;
  width: number;
  height: number;
  format: "JPEG" | "JPEG 2000" | "PNG";
  bytes: number;
}

export interface ExtractImagesOptions {
  /** Skip images smaller than this many pixels on either side: icons, rules, spacers. */
  minSide: number;
}

const pad = (n: number, width: number) => String(n).padStart(width, "0");

/** A pixmap a PNG can hold: grey or RGB, alpha as it is. */
const pngReady = (env: Env, pix: Pixmap): Pixmap => {
  const cs = pix.getColorSpace();
  if (!cs || cs.isGray() || cs.isRGB()) {
    return pix;
  }
  return pix.convertToColorSpace(
    env.mupdf.ColorSpace.DeviceRGB,
    pix.getAlpha() > 0
  );
};

export const extractImages = (
  env: Env,
  bytes: Uint8Array,
  o: ExtractImagesOptions
): { files: OutFile[]; images: ImageInfo[] } => {
  const doc = openPdf(env, bytes);
  try {
    const files: OutFile[] = [];
    const images: ImageInfo[] = [];
    const list = allImages(doc);
    const width = String(doc.countPages()).length;
    const perPage = new Map<number, number>();
    for (const { ref, page } of list) {
      const obj = ref.resolve();
      const w = obj.get("Width").asNumber();
      const h = obj.get("Height").asNumber();
      if (w < o.minSide || h < o.minSide) {
        continue;
      }
      const k = (perPage.get(page) ?? 0) + 1;
      perPage.set(page, k);
      const stem = `page-${pad(page + 1, width)}-image-${pad(k, 2)}`;
      const filters = filtersOf(obj);
      const only = filters.length === 1 ? filters[0] : null;
      const plain =
        [1, 3].includes(components(obj)) && obj.get("Decode").isNull();
      let file: OutFile;
      let format: ImageInfo["format"];
      if (only === "DCTDecode" && plain) {
        file = {
          bytes: new Uint8Array(ref.readRawStream().asUint8Array()),
          mime: "image/jpeg",
          name: `${stem}.jpg`,
        };
        format = "JPEG";
      } else if (only === "JPXDecode") {
        file = {
          bytes: new Uint8Array(ref.readRawStream().asUint8Array()),
          mime: "image/jp2",
          name: `${stem}.jp2`,
        };
        format = "JPEG 2000";
      } else {
        const image = doc.loadImage(ref);
        const pix = pngReady(env, image.toPixmap());
        file = {
          bytes: new Uint8Array(pix.asPNG()),
          mime: "image/png",
          name: `${stem}.png`,
        };
        format = "PNG";
      }
      files.push(file);
      images.push({
        bytes: file.bytes.length,
        format,
        height: h,
        name: file.name,
        page: page + 1,
        width: w,
      });
    }
    return { files, images };
  } finally {
    doc.destroy();
  }
};

/* ---------------- compress ---------------- */

export interface CompressOptions {
  /** Recompress images at this preset, or leave them as they are. */
  images: "keep" | "high" | "medium" | "low";
  /** Pack objects into compressed object streams (PDF 1.5 and later). */
  objectStreams: boolean;
  /** Keep only the glyphs used of every embedded font. */
  subsetFonts: boolean;
}

export interface CompressReport {
  before: number;
  after: number;
  /** Images replaced by smaller ones. */
  images: number;
  /** Images looked at and left, because a smaller one was not to be had. */
  kept: number;
}

/** Highest resolution kept, and JPEG quality, per preset. */
const PRESETS = {
  high: { dpi: 200, quality: 85 },
  low: { dpi: 96, quality: 50 },
  medium: { dpi: 150, quality: 70 },
} as const;

/**
 * Bytes per pixel above which a losslessly stored image is a photograph:
 * flat drawings and screenshots deflate far below it, and turning those into
 * JPEGs would smear their edges.
 */
const PHOTO_DENSITY = 0.15;

/** How small a replacement must be to be worth it, as a share of the original. */
const WORTH_IT = 0.9;

/** The image's colours, without its mask, scaled to `w`×`h`, as grey or RGB. */
const resampled = (env: Env, image: Image, w: number, h: number): Pixmap => {
  const base = image.toPixmap();
  const cs = base.getColorSpace();
  const gray = cs?.isGray() ?? false;
  const target = gray
    ? env.mupdf.ColorSpace.DeviceGray
    : env.mupdf.ColorSpace.DeviceRGB;
  const plain =
    base.getAlpha() > 0 || !(cs?.isGray() || cs?.isRGB())
      ? base.convertToColorSpace(target, false)
      : base;
  if (plain.getWidth() === w && plain.getHeight() === h) {
    return plain;
  }
  const out = new env.mupdf.Pixmap(target, [0, 0, w, h], false);
  out.clear(255);
  const device = new env.mupdf.DrawDevice([1, 0, 0, 1, 0, 0], out);
  device.fillImage(new env.mupdf.Image(plain), [w, 0, 0, h, 0, 0], 1);
  device.close();
  return out;
};

/** Recompress one image in place; true if it was replaced. */
const recompress = (
  env: Env,
  doc: PDFDocument,
  img: ReturnType<typeof allImages>[number],
  preset: { dpi: number; quality: number }
): boolean | null => {
  const obj = img.ref.resolve();
  const filters = filtersOf(obj);
  const n = components(obj);
  const bpc = obj.get("BitsPerComponent").asNumber();
  // Masks, bilevel scans, palettes, and print colour (CMYK) are left as they are.
  const eligible =
    !obj.get("ImageMask").asBoolean() &&
    bpc === 8 &&
    (n === 1 || n === 3) &&
    obj.get("Decode").isNull() &&
    !filters.some((f) =>
      ["JBIG2Decode", "CCITTFaxDecode", "JPXDecode"].includes(f)
    );
  if (!eligible) {
    return null;
  }
  const w = obj.get("Width").asNumber();
  const h = obj.get("Height").asNumber();
  const raw = img.ref.readRawStream().getLength();
  const jpeg = filters.length === 1 && filters[0] === "DCTDecode";
  // At most the page's size: the most room the image could be drawn in.
  const dpi = Math.max(
    w / (img.maxW / POINTS_PER_INCH),
    h / (img.maxH / POINTS_PER_INCH)
  );
  const factor = dpi > preset.dpi ? preset.dpi / dpi : 1;
  const photo = jpeg || raw / (w * h * n) > PHOTO_DENSITY;
  if (!photo && factor === 1) {
    return null;
  }
  const tw = Math.max(1, Math.round(w * factor));
  const th = Math.max(1, Math.round(h * factor));
  const pix = resampled(env, doc.loadImage(img.ref), tw, th);
  const encoded = photo ? pix.asJPEG(preset.quality, false) : null;
  if (!encoded || encoded.length > raw * WORTH_IT) {
    return false;
  }
  img.ref.writeRawStream(encoded);
  obj.put("Filter", doc.newName("DCTDecode"));
  obj.delete("DecodeParms");
  obj.put("Width", doc.newInteger(tw));
  obj.put("Height", doc.newInteger(th));
  obj.put("BitsPerComponent", doc.newInteger(8));
  obj.put(
    "ColorSpace",
    doc.newName(pix.getNumberOfComponents() === 1 ? "DeviceGray" : "DeviceRGB")
  );
  return true;
};

export const compress = (
  env: Env,
  bytes: Uint8Array,
  o: CompressOptions
): { bytes: Uint8Array; report: CompressReport } => {
  const doc = openPdf(env, bytes);
  try {
    let replaced = 0;
    let kept = 0;
    if (o.images !== "keep") {
      const preset = PRESETS[o.images];
      for (const img of allImages(doc)) {
        const r = recompress(env, doc, img, preset);
        if (r === true) {
          replaced += 1;
        } else if (r === false) {
          kept += 1;
        }
      }
    }
    const extra = ["garbage=deduplicate", "compress-fonts", "compress-images"];
    if (o.objectStreams) {
      extra.push("objstms");
    }
    let out = savePdf(doc, { extra, subset: o.subsetFonts });
    // Nothing gained is no reason to hand back a different file.
    if (out.length >= bytes.length) {
      out = bytes;
    }
    return {
      bytes: out,
      report: {
        after: out.length,
        before: bytes.length,
        images: replaced,
        kept,
      },
    };
  } finally {
    doc.destroy();
  }
};

/* ---------------- images to PDF ---------------- */

export interface ImagePagesOptions {
  /** A page the image's own size (at its resolution), or a paper. */
  page: "image" | PaperId;
  orientation: Orientation;
  /** Millimetres of white around the image, on a paper. */
  margin: number;
  /** The whole image on the page, or the page filled and the image cropped. */
  fit: "contain" | "cover";
}

/** The EXIF orientation of a JPEG (1 to 8), 1 when it has none. */
export const exifOrientation = (bytes: Uint8Array): number => {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return 1;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 2;
  while (at + 4 <= bytes.length && bytes[at] === 0xff) {
    const marker = bytes[at + 1] ?? 0;
    const length = view.getUint16(at + 2);
    // APP1 holding "Exif\0\0", then a TIFF header.
    if (marker === 0xe1 && view.getUint32(at + 4) === 0x45_78_69_66) {
      const tiff = at + 10;
      const little = view.getUint16(tiff) === 0x49_49;
      const u16 = (p: number) => view.getUint16(p, little);
      const ifd = tiff + view.getUint32(tiff + 4, little);
      const count = u16(ifd);
      for (let i = 0; i < count; i += 1) {
        const entry = ifd + 2 + i * 12;
        if (entry + 12 > bytes.length) {
          break;
        }
        if (u16(entry) === 0x01_12) {
          const v = u16(entry + 8);
          return v >= 1 && v <= 8 ? v : 1;
        }
      }
      return 1;
    }
    if (marker === 0xda) {
      break;
    }
    at += 2 + length;
  }
  return 1;
};

/**
 * Where the image's unit square goes for each EXIF orientation, in a unit
 * box of display space (y down): [a b c d e f] taking image space (y up)
 * to the box as the image should be seen.
 */
const ORIENT: Record<number, Matrix> = {
  1: [1, 0, 0, -1, 0, 1],
  2: [-1, 0, 0, -1, 1, 1],
  3: [-1, 0, 0, 1, 1, 0],
  4: [1, 0, 0, 1, 0, 0],
  5: [0, 1, -1, 0, 1, 0],
  6: [0, 1, 1, 0, 0, 0],
  7: [0, -1, 1, 0, 0, 1],
  8: [0, -1, -1, 0, 1, 1],
};

export const imagesToPdf = (
  env: Env,
  images: Uint8Array[],
  o: ImagePagesOptions
): Uint8Array => {
  const doc = new env.mupdf.PDFDocument();
  try {
    const fonts = new Fonts(env.mupdf, doc);
    for (const bytes of images) {
      let image: Image;
      try {
        image = new env.mupdf.Image(bytes);
      } catch (error) {
        throw new Error(
          `An image could not be read: ${(error as Error).message}`,
          { cause: error }
        );
      }
      const orientation = exifOrientation(bytes);
      const turned = orientation >= 5;
      const pw = image.getWidth();
      const ph = image.getHeight();
      const [iw, ih] = turned ? [ph, pw] : [pw, ph];
      const xres = image.getXResolution() || 96;
      const yres = image.getYResolution() || xres;
      // The image at its resolution, in points.
      const nw = (iw * POINTS_PER_INCH) / (turned ? yres : xres);
      const nh = (ih * POINTS_PER_INCH) / (turned ? xres : yres);
      const [w, h] =
        o.page === "image"
          ? [nw, nh]
          : paperSize(o.page, o.orientation, nw, nh);
      const margin = o.page === "image" ? 0 : o.margin * POINTS_PER_MM;
      const bw = w - 2 * margin;
      const bh = h - 2 * margin;
      const s =
        o.fit === "cover"
          ? Math.max(bw / nw, bh / nh)
          : Math.min(bw / nw, bh / nh);
      const dw = nw * s;
      const dh = nh * s;
      const x = margin + (bw - dw) / 2;
      const y = margin + (bh - dh) / 2;
      const pageObj = doc.addPage([0, 0, w, h], 0, {}, "");
      doc.insertPage(-1, pageObj);
      const page = doc.loadPage(doc.countPages() - 1);
      const painter = new Painter(doc, page, fonts);
      const m = chain(
        ORIENT[orientation] ?? ORIENT[1] ?? [1, 0, 0, -1, 0, 1],
        scale(dw, dh),
        translate(x, y)
      );
      painter.xobject(doc.addImage(image), m, {
        clip: [margin, margin, w - margin, h - margin],
      });
      painter.apply();
    }
    return savePdf(doc);
  } finally {
    doc.destroy();
  }
};
