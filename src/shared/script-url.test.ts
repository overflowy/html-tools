import { expect, test } from "bun:test";
import { scriptDataUrl } from "./script-url";

function decode(url: string): string {
  const b64 = url.slice(url.indexOf(",") + 1);
  return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
}

test("a data: URL script ends with a sourceURL pragma naming it", () => {
  // The engine would otherwise take the whole URL as the script's file name,
  // and Firefox builds that name into every Error's stack: with an 18 MB
  // script that made Pyright fifteen times slower than in Chromium.
  const url = scriptDataUrl("self.postMessage(1)", "tiny.js");
  expect(url.startsWith("data:text/javascript;charset=utf-8;base64,")).toBe(true);
  expect(decode(url)).toBe("self.postMessage(1)\n//# sourceURL=tiny.js\n");
});

test("bytes are carried unchanged, pragma appended", () => {
  const source = new TextEncoder().encode("export const x = 'ü';\n// no newline at the end").buffer;
  expect(decode(scriptDataUrl(source, "big.js"))).toBe("export const x = 'ü';\n// no newline at the end\n//# sourceURL=big.js\n");
});
