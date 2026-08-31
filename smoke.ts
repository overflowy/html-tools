// Browser smoke test for the built dist/index.html. Run: bun run smoke.ts
// Uses the Playwright headless Chromium already present in ~/Library/Caches/ms-playwright.
import { chromium } from "playwright-core";

const exe =
  process.env.CHROMIUM_PATH ??
  process.env.HOME + "/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell";

const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage();
const errors: string[] = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });

const url = "file://" + import.meta.dir + "/dist/index.html";
let failed = false;
function check(label: string, ok: boolean, detail = "") {
  console.log((ok ? "ok  " : "FAIL") + "  " + label + (detail ? "  [" + detail + "]" : ""));
  if (!ok) failed = true;
}

await page.goto(url);
const names = await page.locator(".tool-list button").allTextContents();
check("sidebar lists all tools", names.length === 4, names.join(", "));

// base64 tool: paste a tiny valid png via direct input.
await page.goto(url + "#base64-to-image");
await page.locator(".b64-input").fill("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==");
await page.waitForSelector(".tool-base64-to-image .output", { state: "visible" });
check("base64 decodes", (await page.locator(".tool-base64-to-image .meta").textContent())!.includes("image/png"));

// image paste -> base64 (encode direction), via a synthetic clipboard event
await page.evaluate((b64: string) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const dt = new DataTransfer();
  dt.items.add(new File([bytes], "pixel.png", { type: "image/png" }));
  document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
}, "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==");
await page.waitForFunction(() =>
  (document.querySelector(".tool-base64-to-image .b64-input") as HTMLTextAreaElement).value.startsWith("data:image/png;base64,"));
await page.waitForSelector(".tool-base64-to-image .output", { state: "visible" });
check("pasted image encodes to base64", true);

// image drop -> base64
await page.locator(".b64-input").fill("");
await page.evaluate((b64: string) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const dt = new DataTransfer();
  dt.items.add(new File([bytes], "pixel.png", { type: "image/png" }));
  document.querySelector(".tool-base64-to-image")!
    .dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
}, "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==");
await page.waitForFunction(() =>
  (document.querySelector(".tool-base64-to-image .b64-input") as HTMLTextAreaElement).value.startsWith("data:image/png;base64,"));
check("dropped image encodes to base64", true);

// jsonc tool: sort a snippet with a comment.
await page.goto(url + "#jsonc-sorter");
await page.locator(".tool-jsonc-sorter .src").fill('{\n  // b first\n  "b": 1,\n  "a": 2\n}');
await page.waitForSelector(".tool-jsonc-sorter .statusbar.ok");
check("jsonc sorts", (await page.locator(".tool-jsonc-sorter .status-text").textContent())!.includes("2 keys sorted"));

// save decoder: encode JSON on the right, verify base64 appears, then round-trip it back.
await page.goto(url + "#save-decoder");
await page.locator(".tool-save-decoder .dec").fill('{"resources": {"catnip": 5000}, "day": 12}');
await page.waitForSelector(".tool-save-decoder .dec-status.ok");
const encoded = await page.locator(".tool-save-decoder .enc").inputValue();
check("save encodes", encoded.length > 0, encoded.slice(0, 24) + "…");
await page.locator(".tool-save-decoder .dec").fill("");
await page.locator(".tool-save-decoder .enc").fill(encoded);
await page.waitForSelector(".tool-save-decoder .enc-status.ok");
const roundTrip = await page.locator(".tool-save-decoder .dec").inputValue();
check("save decodes back", JSON.parse(roundTrip).resources.catnip === 5000);
check("decode is pretty-printed", roundTrip.includes("\n    "));
const badStatus = page.locator(".tool-save-decoder .enc-status.error");
await page.locator(".tool-save-decoder .enc").fill("!!!not-a-save!!!");
await badStatus.waitFor();
check("invalid save reports error", true);

// invalid JSON in the decoded pane must refuse to encode, keeping the encoded pane intact
await page.reload();
await page.locator(".tool-save-decoder .enc").fill(encoded);
await page.waitForSelector(".tool-save-decoder .enc-status.ok");
await page.locator(".tool-save-decoder .dec").fill('{\n    resources: "unquoted key"\n}');
await page.waitForSelector(".tool-save-decoder .dec-status.error");
const decErr = await page.locator(".tool-save-decoder .dec-status .status-text").textContent();
check("invalid JSON refuses to encode", decErr!.includes("Not valid JSON"), decErr!.slice(0, 60));
check("encoded pane untouched on bad JSON", (await page.locator(".tool-save-decoder .enc").inputValue()) === encoded);

// image metadata: minimal hand-crafted fixtures, one per container, each with
// EXIF GPS 52.520008 N, 13.404954 E. Drop each one, expect the GPS highlight,
// then strip and expect the self-verification to pass.
// - jpeg: SOI, APP0 JFIF, APP1 EXIF (Orientation 6), COM, DQT/SOF0/DHT/SOS 1x1, EOI, trailing junk
// - png: 1x1 gray with eXIf + tEXt + tIME chunks
// - webp: VP8X (EXIF flag) + VP8L stub + EXIF chunk
// - tiff: 1x1 gray with Software/DateTime tags + GPS IFD
// - heic: ftyp + meta (hdlr/pitm/iinf/iref/iprp/iloc) + mdat with Exif item
const FIXTURES: Record<string, string> = {
  jpeg: "/9j/4AAQSkZJRgABAQAASABIAAD/4QEaRXhpZgAASUkqAAgAAAAGAA8BAgAFAAAAVgAAABABAgAJAAAAXAAAABIBAwABAAAABgAAADIBAgAUAAAAZgAAAGmHBAABAAAAegAAACWIBAABAAAAoAAAAAAAAABBY21lAABDYW0gOTAwMAAAMjAyNDowNTowMSAxMjowMDowMAABAAOQAgAUAAAAjAAAAAAAAAAyMDI0OjA1OjAxIDEyOjAwOjAwAAUAAQACAAIAAABOAAAAAgAFAAMAAADiAAAAAwACAAIAAABFAAAABAAFAAMAAAD6AAAABQABAAEAAAAAAAAAAAAAADQAAAABAAAAHwAAAAEAAADg1QEAECcAAA0AAAABAAAAGAAAAAEAAACouAIAECcAAP/+ABJzaG90IG9uIGEgcG90YXRv/9sAQwABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB/8AACwgAAQABAQERAP/EABQAAAEAAAAAAAAAAAAAAAAAAAD/xAAUEAABAAAAAAAAAAAAAAAAAAAA/9oACAEBAAA/AA//2VRSQUlMSU5HSlVOSw==",
  png: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAABEmVYSWZJSSoACAAAAAYADwECAAUAAABWAAAAEAECAAkAAABcAAAAEgEDAAEAAAABAAAAMgECABQAAABmAAAAaYcEAAEAAAB6AAAAJYgEAAEAAACgAAAAAAAAAEFjbWUAAENhbSA5MDAwAAAyMDI0OjA1OjAxIDEyOjAwOjAwAAEAA5ACABQAAACMAAAAAAAAADIwMjQ6MDU6MDEgMTI6MDA6MDAABQABAAIAAgAAAE4AAAACAAUAAwAAAOIAAAADAAIAAgAAAEUAAAAEAAUAAwAAAPoAAAAFAAEAAQAAAAAAAAAAAAAANAAAAAEAAAAfAAAAAQAAAODVAQAQJwAADQAAAAEAAAAYAAAAAQAAAKi4AgAQJwAAASqWTAAAABV0RVh0U29mdHdhcmUAbWFkZSBieSBoYW5kDW494gAAAAd0SU1FB+gFAQwAAE+FIj4AAAANSURBVHgBAQIA/f8AgACCAIHDbiXgAAAAAElFTkSuQmCC",
  webp: "UklGRkABAABXRUJQVlA4WAoAAAAIAAAAAAAAAAAAVlA4TAgAAAAvAAAAAIiICEVYSUYSAQAASUkqAAgAAAAGAA8BAgAFAAAAVgAAABABAgAJAAAAXAAAABIBAwABAAAAAQAAADIBAgAUAAAAZgAAAGmHBAABAAAAegAAACWIBAABAAAAoAAAAAAAAABBY21lAABDYW0gOTAwMAAAMjAyNDowNTowMSAxMjowMDowMAABAAOQAgAUAAAAjAAAAAAAAAAyMDI0OjA1OjAxIDEyOjAwOjAwAAUAAQACAAIAAABOAAAAAgAFAAMAAADiAAAAAwACAAIAAABFAAAABAAFAAMAAAD6AAAABQABAAEAAAAAAAAAAAAAADQAAAABAAAAHwAAAAEAAADg1QEAECcAAA0AAAABAAAAGAAAAAEAAACouAIAECcAAA==",
  tiff: "SUkqAAgAAAAKAAABAwABAAAAAQAAAAEBAwABAAAAAQAAAAIBAwABAAAACAAAAAMBAwABAAAAAQAAAAYBAwABAAAAAQAAABEBBAABAAAAhgAAABcBBAABAAAAAQAAADEBAgASAAAAiAAAADIBAgAUAAAAmgAAACWIBAABAAAArgAAAAAAAACAAGhhbmRtYWRlIGZpeHR1cmUAADIwMjQ6MDU6MDEgMTI6MDA6MDAABQABAAIAAgAAAE4AAAACAAUAAwAAAPAAAAADAAIAAgAAAEUAAAAEAAUAAwAAAAgBAAAFAAEAAQAAAAAAAAAAAAAANAAAAAEAAAAfAAAAAQAAAODVAQAQJwAADQAAAAEAAAAYAAAAAQAAAKi4AgAQJwAA",
  heic: "AAAAGGZ0eXBoZWljAAAAAG1pZjFoZWljAAAA8W1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAHBpY3QAAAAAAAAAAAAAAAAAAAAADnBpdG0AAAAAAAEAAAA4aWluZgAAAAAAAgAAABVpbmZlAgAAAAABAABodmMxAAAAABVpbmZlAgAAAAACAABFeGlmAAAAABppcmVmAAAAAAAAAA5jZHNjAAIAAQABAAAAOGlwcnAAAAAcaXBjbwAAABRpc3BlAAAAAAAAAEAAAAAwAAAAFGlwbWEAAAAAAAAAAQABAYEAAAAsaWxvYwAAAABEAAACAAEAAAABAAABEQAAABAAAgAAAAEAAAEhAAABHAAAATRtZGF0RkFLRUhFVkNQQVlMT0FEIQAAAAZFeGlmAABJSSoACAAAAAYADwECAAUAAABWAAAAEAECAAkAAABcAAAAEgEDAAEAAAABAAAAMgECABQAAABmAAAAaYcEAAEAAAB6AAAAJYgEAAEAAACgAAAAAAAAAEFjbWUAAENhbSA5MDAwAAAyMDI0OjA1OjAxIDEyOjAwOjAwAAEAA5ACABQAAACMAAAAAAAAADIwMjQ6MDU6MDEgMTI6MDA6MDAABQABAAIAAgAAAE4AAAACAAUAAwAAAOIAAAADAAIAAgAAAEUAAAAEAAUAAwAAAPoAAAAFAAEAAQAAAAAAAAAAAAAANAAAAAEAAAAfAAAAAQAAAODVAQAQJwAADQAAAAEAAAAYAAAAAQAAAKi4AgAQJwAA",
};

await page.goto(url + "#image-metadata");
for (const [fmt, b64] of Object.entries(FIXTURES)) {
  await page.evaluate(([n, s]) => {
    const bytes = Uint8Array.from(atob(s!), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], "fixture." + n, { type: "application/octet-stream" }));
    document.querySelector(".tool-image-metadata")!
      .dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, [fmt, b64]);
  await page.waitForFunction(
    (n) => document.querySelector(".tool-image-metadata .status")?.textContent === "fixture." + n, fmt);
  const gpsText = await page.locator(".tool-image-metadata .hl.gps .hl-val").textContent();
  check(fmt + " shows GPS coordinates", gpsText!.includes("52.520008") && gpsText!.includes("13.404954"), gpsText!.trim().slice(0, 40));
  const hlText = await page.locator(".tool-image-metadata .highlights").textContent();
  check(fmt + " shows dashed date", hlText!.includes("2024-05-01 12:00:00"), hlText!.trim().slice(0, 60));
  await page.locator(".tool-image-metadata .strip-btn").click();
  await page.waitForSelector(".tool-image-metadata .strip-ok");
  const verdict = await page.locator(".tool-image-metadata .strip-ok").textContent();
  check(fmt + " strips clean", verdict!.startsWith("Re-parsed the stripped copy"), verdict!.slice(0, 70));
  if (fmt === "jpeg") {
    // The JPEG fixture has Orientation 6: the strip must keep it and say so.
    check("jpeg keeps orientation", verdict!.includes("orientation (6)"), verdict!.slice(0, 90));
  }
}

// Deep links: a tool's state lives in the URL hash and a fresh load restores it.
await page.goto(url + "#jsonc-sorter");
await page.locator(".tool-jsonc-sorter .src").fill('{"z": 1, "a": 2}');
await page.locator(".tool-jsonc-sorter .opt-order").selectOption("desc");
await page.waitForSelector(".tool-jsonc-sorter .statusbar.ok");
await page.waitForFunction(() => location.hash.startsWith("#jsonc-sorter/"));
const jsoncLink = await page.evaluate(() => location.href);
await page.goto("about:blank");
await page.goto(jsoncLink);
await page.waitForSelector(".tool-jsonc-sorter .statusbar.ok");
check("jsonc deep link restores input", (await page.locator(".tool-jsonc-sorter .src").inputValue()) === '{"z": 1, "a": 2}');
check("jsonc deep link restores options", (await page.locator(".tool-jsonc-sorter .opt-order").inputValue()) === "desc");
const sortedOut = await page.locator(".tool-jsonc-sorter .output").textContent();
check("jsonc deep link sorts on load", sortedOut!.indexOf('"z"') !== -1 && sortedOut!.indexOf('"z"') < sortedOut!.indexOf('"a"'));

// Switching tools via the sidebar keeps each tool's state in its deep link.
await page.locator(".tool-list button", { hasText: "Base64" }).click();
await page.waitForFunction(() => location.hash === "#base64-to-image");
await page.locator(".tool-list button", { hasText: "JSONC" }).click();
await page.waitForFunction(() => location.hash.startsWith("#jsonc-sorter/"));
check("switching tools keeps state in the deep link", true);

await page.goto(url + "#save-decoder");
await page.locator(".tool-save-decoder .dec").fill('{"day": 7}');
await page.waitForSelector(".tool-save-decoder .dec-status.ok");
const savedEnc = await page.locator(".tool-save-decoder .enc").inputValue();
await page.waitForFunction(() => location.hash.startsWith("#save-decoder/"));
const saveLink = await page.evaluate(() => location.href);
await page.goto("about:blank");
await page.goto(saveLink);
await page.waitForSelector(".tool-save-decoder .enc-status.ok");
check("save deep link restores encoded pane", (await page.locator(".tool-save-decoder .enc").inputValue()) === savedEnc);
check("save deep link decodes on load", JSON.parse(await page.locator(".tool-save-decoder .dec").inputValue()).day === 7);

check("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
process.exit(failed ? 1 : 0);
