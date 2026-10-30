// How a file from an archive is shown: an image, audio, or video plays in
// the browser's own element; a PDF in the browser's viewer; text as text,
// highlighted when its extension names a language; anything else as a hex
// dump of its start. Nothing is ever run or rendered as a page: an HTML
// file is shown as its source, and an SVG goes in an <img>, where scripts
// do not run.

import hljs from "highlight.js/lib/common";

import { extOf } from "./commands";

/** For a preview that holds nothing to free. */
const noop = () => {
  // Text and hex previews hold no object URL.
};

const IMAGE = new Map([
  ["apng", "image/apng"],
  ["avif", "image/avif"],
  ["bmp", "image/bmp"],
  ["gif", "image/gif"],
  ["ico", "image/x-icon"],
  ["jfif", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["jpg", "image/jpeg"],
  ["png", "image/png"],
  ["svg", "image/svg+xml"],
  ["webp", "image/webp"],
]);

const VIDEO = new Map([
  ["m4v", "video/mp4"],
  ["mov", "video/quicktime"],
  ["mp4", "video/mp4"],
  ["ogv", "video/ogg"],
  ["webm", "video/webm"],
]);

const AUDIO = new Map([
  ["aac", "audio/aac"],
  ["flac", "audio/flac"],
  ["m4a", "audio/mp4"],
  ["mp3", "audio/mpeg"],
  ["oga", "audio/ogg"],
  ["ogg", "audio/ogg"],
  ["opus", "audio/ogg"],
  ["wav", "audio/wav"],
]);

/** Text past this many bytes is cut, and the preview says so. */
const TEXT_LIMIT = 1024 * 1024;
/** Highlighting is skipped past this, where it would hold up the page. */
const HIGHLIGHT_LIMIT = 256 * 1024;
/** How much of a binary file the hex dump shows. */
const HEX_LIMIT = 4096;
/** How much of the start is sniffed for text. */
const SNIFF = 64 * 1024;

export type PreviewKind = "image" | "video" | "audio" | "pdf" | "text" | "hex";

export interface Preview {
  kind: PreviewKind;
  el: HTMLElement;
  /** A sentence about what is not shown, when something is cut. */
  note: string;
  /** Frees what the preview holds. */
  dispose: () => void;
}

/** Whether the start of a file reads as UTF-8 text: no NUL byte, no invalid sequence. */
export const looksLikeText = (bytes: Uint8Array): boolean => {
  const head = bytes.subarray(0, SNIFF);
  if (head.includes(0)) {
    return false;
  }
  try {
    // stream: a multi-byte character cut by the sniff's end is not an error.
    new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: true });
    return true;
  } catch {
    return false;
  }
};

const hexRow = (bytes: Uint8Array, offset: number): string => {
  const row = bytes.subarray(offset, offset + 16);
  const hex = [...row]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ")
    .padEnd(47, " ");
  const ascii = [...row]
    .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCodePoint(b) : "."))
    .join("");
  return `${offset.toString(16).padStart(8, "0")}  ${hex}  ${ascii}`;
};

/** The classic dump: offset, sixteen bytes in hex, the same as ASCII. */
export const hexDump = (bytes: Uint8Array): string => {
  const lines: string[] = [];
  for (let at = 0; at < bytes.length; at += 16) {
    lines.push(hexRow(bytes, at));
  }
  return lines.join("\n");
};

const media = (
  tag: "img" | "video" | "audio",
  url: string,
  name: string
): HTMLElement => {
  const el = document.createElement(tag);
  el.src = url;
  if (el instanceof HTMLImageElement) {
    el.alt = name;
  } else {
    el.controls = true;
    el.preload = "metadata";
  }
  return el;
};

const textPreview = (bytes: Uint8Array, ext: string, size: number): Preview => {
  const cut = bytes.length > TEXT_LIMIT;
  const text = new TextDecoder().decode(bytes.subarray(0, TEXT_LIMIT));
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  pre.append(code);
  const lang = ext && hljs.getLanguage(ext) ? ext : "";
  if (lang && text.length <= HIGHLIGHT_LIMIT) {
    // highlight.js escapes the source; its output is spans around text.
    code.innerHTML = hljs.highlight(text, {
      ignoreIllegals: true,
      language: lang,
    }).value;
    code.classList.add("hljs");
  } else {
    code.textContent = text;
  }
  return {
    dispose: noop,
    el: pre,
    kind: "text",
    note: cut
      ? `Showing the first ${TEXT_LIMIT / 1024} KB of ${Math.round(size / 1024)} KB.`
      : "",
  };
};

/** The preview for a file's contents. */
export const renderPreview = async (
  blob: Blob,
  name: string
): Promise<Preview> => {
  const ext = extOf(name);
  const typed = (type: string) => new Blob([blob], { type });
  const withUrl = (
    kind: PreviewKind,
    type: string,
    build: (url: string) => HTMLElement
  ): Preview => {
    const url = URL.createObjectURL(typed(type));
    return {
      dispose: () => URL.revokeObjectURL(url),
      el: build(url),
      kind,
      note: "",
    };
  };
  const image = IMAGE.get(ext);
  if (image) {
    return withUrl("image", image, (url) => media("img", url, name));
  }
  const video = VIDEO.get(ext);
  if (video) {
    return withUrl("video", video, (url) => media("video", url, name));
  }
  const audio = AUDIO.get(ext);
  if (audio) {
    return withUrl("audio", audio, (url) => media("audio", url, name));
  }
  if (ext === "pdf") {
    return withUrl("pdf", "application/pdf", (url) => {
      const frame = document.createElement("iframe");
      frame.src = url;
      frame.title = name;
      return frame;
    });
  }
  const head = new Uint8Array(
    await blob.slice(0, Math.max(TEXT_LIMIT, SNIFF) + 1).arrayBuffer()
  );
  if (looksLikeText(head)) {
    return textPreview(head, ext, blob.size);
  }
  const pre = document.createElement("pre");
  pre.className = "hex";
  pre.textContent = hexDump(head.subarray(0, HEX_LIMIT));
  return {
    dispose: noop,
    el: pre,
    kind: "hex",
    note:
      blob.size > HEX_LIMIT
        ? `Binary file: the first ${HEX_LIMIT / 1024} KB as hex.`
        : "Binary file, as hex.",
  };
};
