// Browser smoke test for the built dist/index.html. Run: bun run smoke.ts
// Uses the Playwright headless Chromium already present in ~/Library/Caches/ms-playwright.
import { chromium } from "playwright-core";
import jsQR from "jsqr";

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
check("sidebar lists all tools", names.length === 5, names.join(", "));

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

// qr generator: render codes for every payload type and error correction level,
// then prove they scan by decoding the canvas pixels with jsQR.
async function decodeQrCanvas(): Promise<{ text: string; bytes: Uint8Array } | null> {
  const img = await page.evaluate(() => {
    const c = document.querySelector(".tool-qr-generator .qr-canvas") as HTMLCanvasElement | null;
    if (!c || c.hidden) return null;
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height);
    return { data: Array.from(d.data), width: d.width, height: d.height };
  });
  if (!img) return null;
  const res = jsQR(new Uint8ClampedArray(img.data), img.width, img.height);
  return res ? { text: res.data, bytes: new Uint8Array(res.binaryData) } : null;
}

/** Poll until the rendered code decodes to `expected` (the tool debounces regeneration). */
async function checkQrDecodes(label: string, expected: string, utf8 = false) {
  const deadline = Date.now() + 5000;
  let got = "";
  for (;;) {
    const res = await decodeQrCanvas();
    if (res) got = utf8 ? new TextDecoder().decode(res.bytes) : res.text;
    if (got === expected || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  check(label, got === expected, got.slice(0, 50) || "(no decode)");
}

await page.goto(url + "#qr-generator");
await page.locator(".tool-qr-generator .opt-size").fill("192");
await page.locator(".tool-qr-generator .f-text").fill("https://example.com/some/path?q=1");
await checkQrDecodes("qr text scans back", "https://example.com/some/path?q=1");
for (const ecl of ["L", "Q", "H", "M"]) {
  await page.locator(".tool-qr-generator .opt-ecl").selectOption(ecl);
  await checkQrDecodes("qr scans at level " + ecl, "https://example.com/some/path?q=1");
}
await page.locator(".tool-qr-generator .f-text").fill("Grüße, 世界! \u{1F389}");
await checkQrDecodes("qr utf-8 scans back", "Grüße, 世界! \u{1F389}", true);
const longText = "The quick brown fox jumps over the lazy dog. ".repeat(20);
await page.locator(".tool-qr-generator .f-text").fill(longText);
await checkQrDecodes("qr high-version payload scans back", longText);

await page.locator('.tool-qr-generator [data-type="wifi"]').click();
await page.locator(".tool-qr-generator .f-wifi-ssid").fill("Home Network");
await page.locator(".tool-qr-generator .f-wifi-pass").fill("s3cret;pass");
await page.locator(".tool-qr-generator .f-wifi-hidden").check();
await checkQrDecodes("qr wifi payload scans back", "WIFI:T:WPA;S:Home Network;P:s3cret\\;pass;H:true;;");

await page.locator('.tool-qr-generator [data-type="contact"]').click();
await page.locator(".tool-qr-generator .f-ct-first").fill("Jane");
await page.locator(".tool-qr-generator .f-ct-last").fill("Doe");
await page.locator(".tool-qr-generator .f-ct-phone").fill("+1 555 0100");
await page.locator(".tool-qr-generator .f-ct-email").fill("jane@example.com");
await checkQrDecodes("qr vcard payload scans back",
  "BEGIN:VCARD\r\nVERSION:3.0\r\nN:Doe;Jane;;;\r\nFN:Jane Doe\r\nTEL:+1 555 0100\r\nEMAIL:jane@example.com\r\nEND:VCARD");

await page.locator('.tool-qr-generator [data-type="email"]').click();
await page.locator(".tool-qr-generator .f-em-to").fill("jane@example.com");
await page.locator(".tool-qr-generator .f-em-subject").fill("Hi there");
await checkQrDecodes("qr email payload scans back", "mailto:jane@example.com?subject=Hi%20there");

await page.locator('.tool-qr-generator [data-type="sms"]').click();
await page.locator(".tool-qr-generator .f-sms-num").fill("+1 555 0100");
await page.locator(".tool-qr-generator .f-sms-msg").fill("See you at 6");
await checkQrDecodes("qr sms payload scans back", "SMSTO:+15550100:See you at 6");

await page.locator('.tool-qr-generator [data-type="phone"]').click();
await page.locator(".tool-qr-generator .f-ph-num").fill("+1 555 0100");
await checkQrDecodes("qr phone payload scans back", "tel:+15550100");

await page.locator('.tool-qr-generator [data-type="geo"]').click();
await page.locator(".tool-qr-generator .f-geo-lat").fill("52.520008");
await page.locator(".tool-qr-generator .f-geo-lng").fill("13.404954");
await checkQrDecodes("qr geo payload scans back", "geo:52.520008,13.404954");

// oversized payload reports an error instead of rendering
await page.locator('.tool-qr-generator [data-type="text"]').click();
await page.locator(".tool-qr-generator .f-text").fill("x".repeat(3200));
await page.waitForSelector(".tool-qr-generator .statusbar.error");
check("qr too-long payload reports error",
  (await page.locator(".tool-qr-generator .status-text").textContent())!.includes("too long"));

// inverted colors get a warning
await page.locator(".tool-qr-generator .f-text").fill("contrast check");
await page.evaluate(() => {
  const fg = document.querySelector(".tool-qr-generator .opt-fg") as HTMLInputElement;
  const bg = document.querySelector(".tool-qr-generator .opt-bg") as HTMLInputElement;
  fg.value = "#ffffff";
  bg.value = "#000000";
  fg.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.waitForSelector(".tool-qr-generator .statusbar.warn");
check("qr inverted colors warn",
  (await page.locator(".tool-qr-generator .status-text").textContent())!.includes("inverted"));

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

await page.goto(url + "#qr-generator");
await page.locator('.tool-qr-generator [data-type="wifi"]').click();
await page.locator(".tool-qr-generator .f-wifi-ssid").fill("Cafe Guest");
await page.locator(".tool-qr-generator .f-wifi-pass").fill("espresso99");
await page.locator(".tool-qr-generator .opt-ecl").selectOption("Q");
await page.waitForFunction(() => location.hash.startsWith("#qr-generator/wifi."));
await page.waitForSelector(".tool-qr-generator .statusbar.ok");
const qrLink = await page.evaluate(() => location.href);
await page.goto("about:blank");
await page.goto(qrLink);
await page.waitForSelector(".tool-qr-generator .statusbar.ok");
check("qr deep link restores type", await page.locator('.tool-qr-generator [data-type="wifi"]').evaluate((b) => b.classList.contains("active")));
check("qr deep link restores fields", (await page.locator(".tool-qr-generator .f-wifi-ssid").inputValue()) === "Cafe Guest" &&
  (await page.locator(".tool-qr-generator .f-wifi-pass").inputValue()) === "espresso99");
check("qr deep link restores options", (await page.locator(".tool-qr-generator .opt-ecl").inputValue()) === "Q");
await checkQrDecodes("qr deep link renders a scannable code", "WIFI:T:WPA;S:Cafe Guest;P:espresso99;;");

check("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
process.exit(failed ? 1 : 0);
