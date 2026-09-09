// Turning script text into something a worker can load. From file://, which
// is where the Collection lives, Chromium refuses module workers spawned from
// blob: URLs and refuses importScripts() of a blob: URL inside any worker:
// every blob gets a fresh opaque origin and none of them match. data: URLs
// carry no origin and load anywhere, with one limit: a worker's own script
// may not be a data: URL past 2 MB. So small scripts become data: URLs, big
// ones are imported from data: URLs by a small bootstrap, and a bootstrap
// that must embed big URLs inline is a blob: URL, which has no size limit and
// does work as a worker's own script.
//
// A script loaded from a data: URL has that URL as its file name, and the
// engine touches file names more often than one would think: every Error
// captures a stack whose frames name their file, and Firefox builds those
// names eagerly. With an 18 MB script the URL is 24 MB, and Pyright, which
// raises an Error for every missing file it probes, ran fifteen times slower
// in Firefox than in Chromium. So every data: URL script ends with a
// `//# sourceURL=` pragma naming it, which is the name the engine uses instead.

const CHUNK = 0x8000;

function base64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  return btoa(bin);
}

/**
 * A data: URL for JavaScript source, decoded as UTF-8 by the loader. `name`
 * is what stack traces and the console call the script.
 */
export function scriptDataUrl(source: string | ArrayBuffer, name: string): string {
  const pragma = new TextEncoder().encode(`\n//# sourceURL=${name}\n`);
  const body = typeof source === "string" ? new TextEncoder().encode(source) : new Uint8Array(source);
  const bytes = new Uint8Array(body.length + pragma.length);
  bytes.set(body);
  bytes.set(pragma, body.length);
  return "data:text/javascript;charset=utf-8;base64," + base64(bytes);
}

/** A blob: URL for JavaScript source. Revoke it when the loader is done. */
export function scriptBlobUrl(source: string | ArrayBuffer): string {
  return URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
}

let blobModuleWorkers: Promise<boolean> | null = null;

/**
 * Whether a module worker can be spawned here from a blob: URL, and import
 * another blob: URL from inside: Firefox allows it from file://, Chromium
 * does not (see above). Where it works, a big script is better loaded that
 * way than from a data: URL: no base64 to decode per worker, and no
 * multi-megabyte string to hold and clone. Probed once, with a one-line
 * worker; Chromium answers with an error event within milliseconds.
 */
export function blobModuleWorkersWork(): Promise<boolean> {
  if (blobModuleWorkers) return blobModuleWorkers;
  blobModuleWorkers = new Promise((resolve) => {
    const url = scriptBlobUrl("self.postMessage(true)");
    let worker: Worker;
    try {
      worker = new Worker(url, { type: "module" });
    } catch {
      URL.revokeObjectURL(url);
      resolve(false);
      return;
    }
    const settle = (ok: boolean) => {
      resolve(ok);
      worker.terminate();
      URL.revokeObjectURL(url);
    };
    worker.onmessage = () => settle(true);
    worker.onerror = () => settle(false);
    setTimeout(() => settle(false), 5000);
  });
  return blobModuleWorkers;
}
