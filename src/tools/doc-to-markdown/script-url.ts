// Turning script text into something a worker can load. From file://, which
// is where the Collection lives, Chromium refuses module workers spawned from
// blob: URLs and refuses importScripts() of a blob: URL inside any worker:
// every blob gets a fresh opaque origin and none of them match. data: URLs
// carry no origin and load anywhere, with one limit: a worker's own script
// may not be a data: URL past 2 MB. So small scripts become data: URLs, big
// ones are imported from data: URLs by a small bootstrap, and a bootstrap
// that must embed big URLs inline is a blob: URL, which has no size limit and
// does work as a worker's own script.

const CHUNK = 0x8000;

function base64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  return btoa(bin);
}

/** A data: URL for JavaScript source, decoded as UTF-8 by the loader. */
export function scriptDataUrl(source: string | ArrayBuffer): string {
  const bytes = typeof source === "string" ? new TextEncoder().encode(source) : new Uint8Array(source);
  return "data:text/javascript;charset=utf-8;base64," + base64(bytes);
}

/** A blob: URL for JavaScript source. Revoke it when the loader is done. */
export function scriptBlobUrl(source: string): string {
  return URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
}
