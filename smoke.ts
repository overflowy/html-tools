// Browser smoke test for the built dist/index.html. Run: bun run smoke.ts
// Uses the Playwright headless Chromium already present in ~/Library/Caches/ms-playwright.
import { chromium } from "playwright-core";
import jsQR from "jsqr";
import dnsFixtures from "./src/tools/dns-lookup/fixtures.json";
import { DKIM_SELECTORS } from "./src/tools/dns-lookup/email";
import osvFixtures from "./src/tools/dependency-audit/fixtures/osv.json";
import { buildDocx, buildPdf } from "./src/tools/doc-to-markdown/fixtures";

const exe =
  process.env.CHROMIUM_PATH ??
  process.env.HOME + "/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell";

const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage();
const errors: string[] = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => {
  // Probing a repository for lockfiles that are not there is a 404 by design, and the
  // Whoami test cuts the IPv6 trace on purpose; the browser logs each one.
  const byDesign = m.location().url.startsWith("https://raw.githubusercontent.com/") || m.location().url.startsWith("https://[2606:4700:4700::1001]/");
  if (m.type() === "error" && !byDesign) errors.push("console: " + m.text());
});

const url = "file://" + import.meta.dir + "/dist/index.html";
let failed = false;
function check(label: string, ok: boolean, detail = "") {
  console.log((ok ? "ok  " : "FAIL") + "  " + label + (detail ? "  [" + detail + "]" : ""));
  if (!ok) failed = true;
}

await page.goto(url);
const names = await page.locator(".tool-list button").allTextContents();
check("sidebar lists all tools", names.length === 10, names.join(", "));

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
check("jsonc sorts", (await page.locator(".tool-jsonc-sorter .status-text").textContent())!.includes("2 keys sorted · 1 comment preserved"));

// Plain JSON, with trailing commas at every depth, comes out as strict JSON.
await page.locator(".tool-jsonc-sorter .src").fill('{"b": [1, {"y": 2, "x": 3,},], "a": {"d": {"f": 1,}, "c": 2,},}');
await page.waitForFunction(() => document.querySelector(".tool-jsonc-sorter .status-text")!.textContent!.includes("7 keys"));
const jsonOut = (await page.locator(".tool-jsonc-sorter .output").textContent())!;
let jsonOk = false;
try { jsonOk = JSON.stringify(JSON.parse(jsonOut)) === '{"a":{"c":2,"d":{"f":1}},"b":[1,{"x":3,"y":2}]}'; } catch { /* invalid */ }
check("jsonc accepts plain JSON, drops nested trailing commas", jsonOk, jsonOut.replace(/\s+/g, " "));
check("jsonc status omits comment count when there are none",
  (await page.locator(".tool-jsonc-sorter .status-text").textContent()) === "7 keys sorted");

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

// dns lookup: the only tool that talks to the network. Every endpoint is
// intercepted and answered from the unit-test fixtures, so this stays offline
// and deterministic; what it proves is the wiring from input to table to URL.
const dnsHits: string[] = [];
const cors = { "access-control-allow-origin": "*" };
await page.route(/^https:\/\/(cloudflare-dns\.com|security\.cloudflare-dns\.com|family\.cloudflare-dns\.com|dns\.google)\//, (route) => {
  const u = new URL(route.request().url());
  const name = u.searchParams.get("name");
  // Known types travel as numbers; map the ones this test dispatches on back to names.
  const wire = u.searchParams.get("type")!;
  const type = ({ "1": "A", "2": "NS", "12": "PTR", "15": "MX", "16": "TXT", "33": "SRV" } as Record<string, string>)[wire] ?? wire;
  dnsHits.push(u.host + " " + name + " " + type + (u.searchParams.get("do") ? " do" : ""));
  let body: unknown;
  if (name === "doesnotexist.example.com") body = dnsFixtures.cloudflare_nxdomain;
  else if (name === "8.8.8.8.in-addr.arpa") body = dnsFixtures.cloudflare_ptr;
  else if (type === "A") body = u.host === "dns.google" ? dnsFixtures.google_a : dnsFixtures.cloudflare_a;
  else if (type === "MX") body = dnsFixtures.cloudflare_mx;
  else if (type === "NS" && name === "example.com") {
    // Matches the delegation in the RDAP fixture, so the whois card can report agreement.
    body = { ...dnsFixtures.cloudflare_empty, Question: [{ name, type: 2 }], Authority: [],
      Answer: ["elliott.ns.cloudflare.com.", "hera.ns.cloudflare.com."].map((data) => ({ name, type: 2, TTL: 300, data })) };
  }
  else if (type === "TXT") {
    // TXT is served per name so the email check sees SPF, DMARC, and DKIM where they belong and nothing elsewhere.
    const strings = (dnsFixtures.txt_by_name as Record<string, string[]>)[name ?? ""];
    body = strings
      ? { ...dnsFixtures.cloudflare_empty, Question: [{ name, type: 16 }], Authority: [], Answer: strings.map((data) => ({ name, type: 16, TTL: 300, data })) }
      : dnsFixtures.cloudflare_empty;
  }
  else if (type === "NOTIMPTYPE") body = dnsFixtures.cloudflare_notimp;
  else body = dnsFixtures.cloudflare_empty;
  return route.fulfill({ status: 200, contentType: "application/dns-json", headers: cors, body: JSON.stringify(body) });
});
await page.route(/^https:\/\/api\.certspotter\.com\//, (route) => {
  const u = new URL(route.request().url());
  dnsHits.push("certspotter " + u.searchParams.get("domain") + (u.searchParams.get("after") ? " after" : ""));
  const body = u.searchParams.get("after") ? [] : dnsFixtures.certspotter_page;
  return route.fulfill({ status: 200, contentType: "application/json", headers: cors, body: JSON.stringify(body) });
});
await page.route(/^https:\/\/example\.com\/brand\//, (route) => {
  const path = new URL(route.request().url()).pathname;
  dnsHits.push("asset " + path);
  if (path.endsWith("logo.svg")) return route.fulfill({ status: 200, contentType: "image/svg+xml", headers: cors, body: dnsFixtures.bimi_logo });
  if (path.endsWith("vmc.pem")) return route.fulfill({ status: 200, contentType: "application/x-pem-file", headers: cors, body: dnsFixtures.bimi_cert });
  return route.fulfill({ status: 404, headers: cors, body: "" });
});
await page.route(/^https:\/\/(data\.iana\.org|rdap\.verisign\.com|rdap\.arin\.net)\//, (route) => {
  const u = new URL(route.request().url());
  dnsHits.push("rdap " + u.host + u.pathname);
  const bodies: Record<string, unknown> = {
    "data.iana.org/rdap/dns.json": dnsFixtures.rdap_bootstrap_dns,
    "data.iana.org/rdap/ipv4.json": dnsFixtures.rdap_bootstrap_ipv4,
    "data.iana.org/rdap/ipv6.json": dnsFixtures.rdap_bootstrap_ipv6,
    "rdap.verisign.com/com/v1/domain/example.com": dnsFixtures.rdap_domain,
    "rdap.arin.net/registry/ip/8.8.8.8": dnsFixtures.rdap_ip,
  };
  const body = bodies[u.host + u.pathname];
  // Unknown names get an RDAP-shaped 404 body, but a 200 status: Chromium logs a console error for
  // any 404 and this harness treats console errors as failures. The tool keys off the status alone,
  // so the walk-up path is covered in the unit tests instead.
  return route.fulfill({ status: 200, contentType: "application/rdap+json", headers: cors, body: JSON.stringify(body ?? { errorCode: 404 }) });
});
await page.route(/^https:\/\/api\.whois\.vu\//, (route) => {
  dnsHits.push("whois.vu " + new URL(route.request().url()).searchParams.get("q"));
  return route.fulfill({ status: 200, contentType: "text/plain", headers: cors, body: JSON.stringify(dnsFixtures.whois_text) });
});
await page.route(/^https:\/\/api\.hackertarget\.com\//, (route) => {
  dnsHits.push("hackertarget " + new URL(route.request().url()).searchParams.get("q"));
  return route.fulfill({ status: 200, contentType: "text/plain", headers: cors, body: dnsFixtures.hackertarget_text });
});

await page.goto(url + "#dns-lookup");
await page.locator(".tool-dns-lookup .name").fill("https://Example.COM/some/path?x=1");
await page.locator(".tool-dns-lookup .type").selectOption("MX");
await page.locator(".tool-dns-lookup .btn-lookup").click();
await page.waitForSelector(".tool-dns-lookup .statusbar.ok");
check("dns normalizes the pasted URL to a name", (await page.locator(".tool-dns-lookup .name").inputValue()) === "example.com");
check("dns asks the resolver for exactly that", dnsHits.at(-1) === "cloudflare-dns.com example.com MX", dnsHits.at(-1));
check("dns renders the answer rows", (await page.locator(".tool-dns-lookup .records tbody tr").count()) === 3);
check("dns shows the status flags", (await page.locator(".tool-dns-lookup .flags").textContent())!.startsWith("NOERROR"));
check("dns status counts records", (await page.locator(".tool-dns-lookup .status-text").textContent())!.startsWith("3 records"));
check("dns writes the query into the deep link", await page.evaluate(() => location.hash === "#dns-lookup/cf.00.lookup.MX.example.com"));
check("dns raw pane holds the response", (await page.locator(".tool-dns-lookup .raw").textContent())!.includes('"data": "10 mail.example.com."'));

// No records of that type is reported distinctly from NXDOMAIN, with the SOA shown.
await page.locator(".tool-dns-lookup .type").selectOption("SRV");
await page.locator(".tool-dns-lookup .btn-lookup").click();
await page.waitForFunction(() => document.querySelector(".tool-dns-lookup .status-text")?.textContent?.startsWith("no records"));
check("dns empty answer says so", (await page.locator(".tool-dns-lookup .results .note").textContent())!.includes("No SRV records for example.com"));
check("dns empty answer still shows the authority SOA", (await page.locator(".tool-dns-lookup .results .section").textContent()) === "authority" &&
  (await page.locator(".tool-dns-lookup .records .type-badge").first().textContent()) === "SOA");

await page.locator(".tool-dns-lookup .name").fill("doesnotexist.example.com");
await page.locator(".tool-dns-lookup .type").selectOption("A");
await page.locator(".tool-dns-lookup .btn-lookup").click();
await page.waitForFunction(() => document.querySelector(".tool-dns-lookup .status-text")?.textContent?.startsWith("NXDOMAIN"));
check("dns NXDOMAIN is its own outcome", (await page.locator(".tool-dns-lookup .results .note").textContent())!.includes("does not exist (NXDOMAIN)"));
check("dns NXDOMAIN flags show the rcode", (await page.locator(".tool-dns-lookup .flags .status").textContent()) === "NXDOMAIN");

// An IP address becomes a reverse lookup regardless of the picked type.
await page.locator(".tool-dns-lookup .name").fill("8.8.8.8");
await page.locator(".tool-dns-lookup .btn-lookup").click();
await page.waitForFunction(() => document.querySelector(".tool-dns-lookup .status-text")?.textContent?.startsWith("1 record"));
check("dns IP input queries the arpa name for PTR", dnsHits.at(-1) === "cloudflare-dns.com 8.8.8.8.in-addr.arpa PTR", dnsHits.at(-1));
check("dns reverse lookup is labelled", (await page.locator(".tool-dns-lookup .results-title").textContent()) === "reverse lookup");
check("dns reverse lookup shows the PTR", (await page.locator(".tool-dns-lookup .records .c-data").first().textContent()) === "dns.google.");

// Resolver-side failure (NOTIMP with an EDE comment) renders as an error, not as "no records".
await page.locator(".tool-dns-lookup .name").fill("example.com");
await page.locator(".tool-dns-lookup .type").selectOption("custom");
await page.locator(".tool-dns-lookup .custom-type").fill("not a type");
await page.locator(".tool-dns-lookup .btn-lookup").click();
await page.waitForSelector(".tool-dns-lookup .statusbar.error");
const hitsBefore = dnsHits.length;
check("dns rejects a malformed custom type before querying", (await page.locator(".tool-dns-lookup .status-text").textContent())!.includes("record type name or number"));
await page.locator(".tool-dns-lookup .custom-type").fill("notimptype");
await page.locator(".tool-dns-lookup .custom-type").press("Enter");
await page.waitForFunction(() => document.querySelector(".tool-dns-lookup .results .error-box") !== null);
check("dns custom type is uppercased and sent", dnsHits.length === hitsBefore + 1 && dnsHits.at(-1) === "cloudflare-dns.com example.com NOTIMPTYPE", dnsHits.at(-1));
check("dns resolver failure shows the rcode and EDE", (await page.locator(".tool-dns-lookup .results .error-box").textContent())!.includes("NOTIMP: EDE(21): Not Supported"));

// Google with DNSSEC OK: the flag reaches the wire and the string Comment is displayed.
await page.locator(".tool-dns-lookup .type").selectOption("A");
await page.locator(".tool-dns-lookup .resolver").selectOption("google");
await page.locator(".tool-dns-lookup .opt-do").check();
await page.locator(".tool-dns-lookup .btn-lookup").click();
await page.waitForFunction(() => document.querySelector(".tool-dns-lookup .status-text")?.textContent?.includes("Google 8.8.8.8"));
check("dns google resolver with DO", dnsHits.at(-1) === "dns.google example.com A do", dnsHits.at(-1));
check("dns shows the resolver comment", (await page.locator(".tool-dns-lookup .results .comment").textContent()) === "Response from 108.162.195.228.");
check("dns deep link carries resolver and flags", await page.evaluate(() => location.hash === "#dns-lookup/google.01.lookup.A.example.com"));

// All Types: one collapsible group per Common Type, empties collapsed.
await page.locator(".tool-dns-lookup .resolver").selectOption("cf");
await page.locator(".tool-dns-lookup .opt-do").uncheck();
const allStart = dnsHits.length;
await page.locator(".tool-dns-lookup .btn-all").click();
await page.waitForSelector(".tool-dns-lookup .statusbar.ok");
check("dns all types queries the 14 common types", dnsHits.length - allStart === 14, String(dnsHits.length - allStart));
check("dns all types renders a group per type", (await page.locator(".tool-dns-lookup .group").count()) === 14);
check("dns all types opens groups with records", await page.locator('.tool-dns-lookup .group[data-type="MX"]').evaluate((d) => (d as HTMLDetailsElement).open) &&
  !(await page.locator('.tool-dns-lookup .group[data-type="SRV"]').evaluate((d) => (d as HTMLDetailsElement).open)));
check("dns all types summarises", (await page.locator(".tool-dns-lookup .status-text").textContent())!.startsWith("14 types · 9 records"));
check("dns all types deep link", await page.evaluate(() => location.hash === "#dns-lookup/cf.00.all.A.example.com"));

// Subdomains: both sources queried, union rendered, www. dropped, a row click looks that name up.
await page.locator(".tool-dns-lookup .name").fill("www.example.com");
await page.locator(".tool-dns-lookup .btn-subs").click();
await page.waitForSelector(".tool-dns-lookup .statusbar.ok");
check("dns subdomains asks both sources without www.",
  dnsHits.includes("certspotter example.com") && dnsHits.includes("hackertarget example.com"), dnsHits.slice(-3).join(" | "));
check("dns subdomains walks cert spotter pages", dnsHits.includes("certspotter example.com after"));
check("dns subdomains unions the sources", (await page.locator(".tool-dns-lookup .subs tbody tr").count()) === 8);
check("dns subdomains lists the searched name first", (await page.locator(".tool-dns-lookup .subs .link").first().textContent()) === "example.com");
check("dns subdomains status per source", (await page.locator(".tool-dns-lookup .status-text").textContent())!.includes("8 subdomains · Cert Spotter 5 · HackerTarget 5"));
await page.locator(".tool-dns-lookup .subs .link", { hasText: "blog.example.com" }).click();
await page.waitForFunction(() => location.hash === "#dns-lookup/cf.00.lookup.A.blog.example.com");
check("dns subdomain row click looks the name up", dnsHits.at(-1) === "cloudflare-dns.com blog.example.com A", dnsHits.at(-1));

// Email check: MX, SPF (following includes), DMARC, and a DKIM selector sweep, all from the TXT fixtures.
await page.locator(".tool-dns-lookup .name").fill("example.com");
const emailStart = dnsHits.length;
await page.locator(".tool-dns-lookup .btn-email").click();
await page.waitForFunction(() => document.querySelector(".tool-dns-lookup .status-text")?.textContent?.startsWith("SPF"));
const emailStatus = (await page.locator(".tool-dns-lookup .status-text").textContent())!;
check("dns email verdicts", emailStatus.startsWith("SPF ok · DMARC ok · DKIM ok · BIMI ok"), emailStatus);
check("dns email queries MX, SPF and its include, DMARC, and every selector",
  dnsHits.slice(emailStart).filter((h) => h.endsWith(" TXT")).length === 4 + DKIM_SELECTORS.length && dnsHits.includes("cloudflare-dns.com _spf.example.net TXT") &&
  dnsHits.includes("cloudflare-dns.com _dmarc.example.com TXT") && dnsHits.includes("cloudflare-dns.com google._domainkey.example.com TXT"),
  String(dnsHits.length - emailStart));
check("dns email renders the five cards", (await page.locator(".tool-dns-lookup .card").count()) === 5);
check("dns email MX lists the exchangers", (await page.locator('.tool-dns-lookup .card[data-check="mx"] .mx-list li').count()) === 3);
check("dns email SPF counts lookups through the include",
  (await page.locator('.tool-dns-lookup .card[data-check="spf"]').textContent())!.includes("2 of the 10 allowed DNS lookups"));
check("dns email DMARC reads the policy",
  (await page.locator('.tool-dns-lookup .card[data-check="dmarc"]').textContent())!.includes("p=quarantine: failing mail goes to spam"));
check("dns email DKIM finds the live key and the revoked one",
  (await page.locator('.tool-dns-lookup .card[data-check="dkim"] .dkim-key').count()) === 2 &&
  (await page.locator('.tool-dns-lookup .card[data-check="dkim"]').textContent())!.includes("2048-bit RSA key") &&
  (await page.locator('.tool-dns-lookup .card[data-check="dkim"]').textContent())!.includes("this key is revoked"));
check("dns email BIMI fetches both assets", dnsHits.includes("asset /brand/logo.svg") && dnsHits.includes("asset /brand/vmc.pem"));
const bimiText = (await page.locator('.tool-dns-lookup .card[data-check="bimi"]').textContent())!;
check("dns email BIMI judges the logo and certificate",
  bimiText.includes("DMARC enforces p=quarantine") && bimiText.includes("SVG Tiny Portable/Secure checks pass") && bimiText.includes("Valid until 2126-08-08"));
check("dns email BIMI shows the logo", await page.locator(".tool-dns-lookup .bimi-logo").evaluate((img) => (img as HTMLImageElement).naturalWidth > 0 && !(img as HTMLImageElement).hidden));
check("dns email deep link", await page.evaluate(() => location.hash === "#dns-lookup/cf.00.email.A.example.com"));

// Probing one more selector by hand.
await page.locator(".tool-dns-lookup .dkim-selector").fill("selector1");
await page.locator(".tool-dns-lookup .btn-dkim").click();
await page.waitForFunction(() => document.querySelector(".tool-dns-lookup .status-text")?.textContent?.startsWith("No key at selector selector1"));
check("dns email DKIM probe reports a missing selector", (await page.locator(".tool-dns-lookup .dkim-extra .note").textContent())!.includes("selector1._domainkey.example.com"));
await page.locator(".tool-dns-lookup .dkim-selector").fill("google");
await page.locator(".tool-dns-lookup .dkim-selector").press("Enter");
await page.waitForFunction(() => document.querySelector(".tool-dns-lookup .status-text")?.textContent?.startsWith("Key found at selector google"));
check("dns email DKIM probe renders a found key", (await page.locator(".tool-dns-lookup .dkim-extra .dkim-key").count()) === 1);

// Whois over RDAP: the registry answer for a domain, cross-checked against the zone's NS set, and an IP network.
await page.locator(".tool-dns-lookup .name").fill("example.com");
await page.locator(".tool-dns-lookup .btn-whois").click();
await page.waitForFunction(() => document.querySelector(".tool-dns-lookup .status-text")?.textContent?.startsWith("registrar "));
const whoisText = (await page.locator('.tool-dns-lookup .card[data-check="whois"]').textContent())!;
check("dns whois loads the bootstrap and asks the registry",
  dnsHits.includes("rdap data.iana.org/rdap/dns.json") && dnsHits.includes("rdap rdap.verisign.com/com/v1/domain/example.com"));
check("dns whois shows registrar and abuse contact", whoisText.includes("IANA ID 376") && whoisText.includes("abuse@registrar.example"));
check("dns whois judges expiry, locks, and DNSSEC",
  whoisText.includes("Expires on 2099-08-13") && whoisText.includes("Registrar lock against transfers") && whoisText.includes("delegation is signed (1 DS record at the registry)"));
check("dns whois compares registry delegation with the zone", whoisText.includes("Nameservers at the registry match the zone's NS records"));
check("dns whois verdict", (await page.locator('.tool-dns-lookup .card[data-check="whois"] .card-head .verdict').textContent()) === "ok");
check("dns whois deep link", await page.evaluate(() => location.hash === "#dns-lookup/cf.00.whois.A.example.com"));
check("dns whois raw pane skips the bootstrap", !(await page.locator(".tool-dns-lookup .raw").textContent())!.includes("data.iana.org"));

await page.locator(".tool-dns-lookup .name").fill("8.8.8.8");
await page.locator(".tool-dns-lookup .btn-whois").click();
await page.waitForFunction(() => document.querySelector(".tool-dns-lookup .status-text")?.textContent?.startsWith("Google LLC"));
const ipText = (await page.locator('.tool-dns-lookup .card[data-check="whois"]').textContent())!;
check("dns whois IP goes to the RIR from the ipv4 bootstrap", dnsHits.includes("rdap rdap.arin.net/registry/ip/8.8.8.8"));
check("dns whois IP shows the network and holder", ipText.includes("8.8.8.0/24") && ipText.includes("Google LLC") && ipText.includes("network-abuse@google.com"));

// A TLD without RDAP falls back to raw WHOIS through the proxy.
await page.locator(".tool-dns-lookup .name").fill("google.it");
await page.locator(".tool-dns-lookup .btn-whois").click();
await page.waitForFunction(() => document.querySelector(".tool-dns-lookup .status-text")?.textContent?.includes("raw WHOIS via whois.vu"));
const rawWhois = (await page.locator('.tool-dns-lookup .card[data-check="whois"]').textContent())!;
check("dns whois falls back to the proxy for a TLD without RDAP", dnsHits.includes("whois.vu google.it") && !dnsHits.some((h) => h.includes("/domain/google.it")));
check("dns whois fallback shows parsed fields and the registry text",
  rawWhois.includes("MarkMonitor International Limited") && rawWhois.includes("Expires on 2099-04-21") && rawWhois.includes("Nameservers\n  ns1.google.com"));

// A DNS deep link restores every control and runs the query on load.
await page.goto("about:blank");
await page.goto(url + "#dns-lookup/google.01.lookup.TXT.example.com");
await page.waitForSelector(".tool-dns-lookup .statusbar.ok");
check("dns deep link restores controls",
  (await page.locator(".tool-dns-lookup .name").inputValue()) === "example.com" &&
  (await page.locator(".tool-dns-lookup .type").inputValue()) === "TXT" &&
  (await page.locator(".tool-dns-lookup .resolver").inputValue()) === "google" &&
  (await page.locator(".tool-dns-lookup .opt-do").isChecked()) && !(await page.locator(".tool-dns-lookup .opt-cd").isChecked()));
check("dns deep link runs the lookup", dnsHits.at(-1) === "dns.google example.com TXT do" &&
  (await page.locator(".tool-dns-lookup .records tbody tr").count()) === 2, dnsHits.at(-1));

// Dependency audit: OSV answered from the fixture's hit table, GitHub raw
// files from the fixture lockfiles. What this proves is the wiring from
// lockfile to OSV to cards, the filters, and the two Deep Link forms.
const auditFixture = (name: string) => Bun.file(import.meta.dir + "/src/tools/dependency-audit/fixtures/" + name).text();
const npmLock = await auditFixture("npm-v3.lock.json");
const uvLock = await auditFixture("uv-v1.lock");
const osvHits: string[] = [];
await page.route(/^https:\/\/api\.osv\.dev\//, (route) => {
  const u = new URL(route.request().url());
  if (u.pathname === "/v1/querybatch") {
    const queries = JSON.parse(route.request().postData() ?? "{}").queries as { package: { name: string; ecosystem: string }; version: string }[];
    osvHits.push("querybatch " + queries.length);
    const hits = osvFixtures.hits as Record<string, string[]>;
    const results = queries.map((q) => ({ vulns: (hits[q.package.ecosystem + ":" + q.package.name + "@" + q.version] ?? []).map((id) => ({ id })) }));
    return route.fulfill({ status: 200, contentType: "application/json", headers: cors, body: JSON.stringify({ results }) });
  }
  const id = decodeURIComponent(u.pathname.split("/").pop()!);
  osvHits.push("vulns " + id);
  const rec = (osvFixtures.records as Record<string, unknown>)[id];
  return route.fulfill({ status: rec ? 200 : 404, contentType: "application/json", headers: cors, body: JSON.stringify(rec ?? { message: "Bug not found." }) });
});
const rawHits: string[] = [];
await page.route(/^https:\/\/raw\.githubusercontent\.com\//, (route) => {
  const path = new URL(route.request().url()).pathname;
  rawHits.push(path);
  const body = path === "/acme/demo/HEAD/package-lock.json" ? npmLock : path === "/acme/demo/HEAD/uv.lock" ? uvLock : null;
  return route.fulfill({ status: body ? 200 : 404, contentType: "text/plain", headers: cors, body: body ?? "404: Not Found" });
});

await page.goto(url + "#dependency-audit");
await page.locator(".tool-dependency-audit .src").fill(npmLock);
await page.waitForFunction(() => document.querySelector(".tool-dependency-audit .kind-label")?.textContent === "package-lock.json");
check("audit sniffs the pasted lockfile kind", true);
await page.locator(".tool-dependency-audit .btn-audit").click();
await page.waitForFunction(() => document.querySelector(".tool-dependency-audit .status-text")?.textContent?.startsWith("4 advisories in 3 packages"));
check("audit asks OSV once for the distinct packages, then each record once",
  osvHits.filter((h) => h.startsWith("querybatch")).join() === "querybatch 3" && osvHits.filter((h) => h.startsWith("vulns")).length === 4, osvHits.join(" | "));
check("audit renders one card per affected package, worst first",
  (await page.locator(".tool-dependency-audit .card").count()) === 3 &&
  (await page.locator(".tool-dependency-audit .card .pkg").first().textContent()) === "minimist@1.2.0" &&
  (await page.locator(".tool-dependency-audit .card .card-head .sev").first().textContent()) === "critical 9.8");
check("audit tags direct and dev, names the fix",
  (await page.locator('.tool-dependency-audit .card[data-scope="direct"]').count()) === 2 &&
  (await page.locator(".tool-dependency-audit .card", { hasText: "minimist@1.2.5" }).locator(".tag").allTextContents()).join(",") === "direct,dev" &&
  (await page.locator(".tool-dependency-audit .card", { hasText: "lodash@4.17.20" }).textContent())!.includes("Fixed in 4.17.21.") &&
  (await page.locator(".tool-dependency-audit .card", { hasText: "minimist@1.2.0" }).textContent())!.includes("Fixed in 1.2.6, affected since 1.0.0."));
check("audit lists what was not checked, with reasons",
  (await page.locator(".tool-dependency-audit .skipped-list li").count()) === 3 &&
  (await page.locator(".tool-dependency-audit .skipped-list").textContent())!.includes("git dependency"));
check("audit deep link holds filters and the compressed input", await page.evaluate(() => location.hash.startsWith("#dependency-audit/11111.a.a.lz:")));

// Filters hide advisories and packages without a new Audit.
const hitsBeforeFilter = osvHits.length;
await page.locator('.tool-dependency-audit .f-sev[value="moderate"]').uncheck();
check("audit severity filter hides moderate advisories",
  (await page.locator(".tool-dependency-audit .advisory:not([hidden])").count()) === 3 &&
  (await page.locator(".tool-dependency-audit .card:not([hidden])").count()) === 3 &&
  osvHits.length === hitsBeforeFilter);
await page.locator(".tool-dependency-audit .f-scope").selectOption("d");
check("audit scope filter hides the transitive package",
  (await page.locator(".tool-dependency-audit .card:not([hidden])").count()) === 2 &&
  !(await page.locator(".tool-dependency-audit .card", { hasText: "minimist@1.2.0" }).isVisible()));
check("audit deep link tracks the filters", await page.evaluate(() => location.hash.startsWith("#dependency-audit/11011.d.a.lz:")));
await page.locator('.tool-dependency-audit .f-sev[value="moderate"]').check();
await page.locator(".tool-dependency-audit .f-scope").selectOption("a");

// A declaration file is refused with a pointer to the lockfile.
await page.locator(".tool-dependency-audit .src").fill('{"name": "x", "dependencies": {"lodash": "^4"}}');
await page.waitForFunction(() => document.querySelector(".tool-dependency-audit .kind-label")?.textContent === "not a lockfile");
await page.locator(".tool-dependency-audit .btn-audit").click();
await page.waitForSelector(".tool-dependency-audit .statusbar.error");
check("audit refuses package.json by name", (await page.locator(".tool-dependency-audit .status-text").textContent())!.includes("package.json"));

// Repository Fetch: the five names tried at the root, the two present audited together.
await page.locator(".tool-dependency-audit .repo").fill("https://github.com/acme/demo");
await page.locator(".tool-dependency-audit .btn-fetch").click();
await page.waitForFunction(() => document.querySelector(".tool-dependency-audit .status-text")?.textContent?.startsWith("6 advisories in 4 packages"));
check("audit fetch tries every lockfile name at the repository root",
  rawHits.length === 5 && rawHits.every((p) => p.startsWith("/acme/demo/HEAD/")), rawHits.join(" "));
check("audit fetch normalizes the repo box and shows the files as chips",
  (await page.locator(".tool-dependency-audit .repo").inputValue()) === "acme/demo" &&
  (await page.locator(".tool-dependency-audit .chip").allTextContents()).join("|").replace(/×/g, "") === "package-lock.json|uv.lock");
check("audit groups results by lockfile",
  (await page.locator(".tool-dependency-audit .lockfile").count()) === 2 &&
  (await page.locator(".tool-dependency-audit .lockfile .type-badge").allTextContents()).join() === "npm,PyPI" &&
  (await page.locator(".tool-dependency-audit .f-file-wrap").isVisible()));
check("audit merges records that alias each other",
  (await page.locator(".tool-dependency-audit .card", { hasText: "requests@2.30.0" }).locator(".advisory").count()) === 2 &&
  (await page.locator(".tool-dependency-audit .card", { hasText: "requests@2.30.0" }).textContent())!.includes("PYSEC-2023-74"));
check("audit fetch deep link names the repository", await page.evaluate(() => location.hash === "#dependency-audit/11111.a.a.gh:acme%2Fdemo"));
check("audit results title links the repository",
  (await page.locator(".tool-dependency-audit .results-title a").getAttribute("href")) === "https://github.com/acme/demo");

// A repository Deep Link fetches and audits on load, filters restored.
await page.goto("about:blank");
await page.goto(url + "#dependency-audit/11111.d.p.gh:acme%2Fdemo");
await page.waitForFunction(() => document.querySelector(".tool-dependency-audit .status-text")?.textContent?.startsWith("6 advisories"));
check("audit deep link restores the repository and filters",
  (await page.locator(".tool-dependency-audit .repo").inputValue()) === "acme/demo" &&
  (await page.locator(".tool-dependency-audit .f-scope").inputValue()) === "d" &&
  (await page.locator(".tool-dependency-audit .f-group").inputValue()) === "p" &&
  (await page.locator(".tool-dependency-audit .card:not([hidden])").count()) === 2);

// Document to Markdown: real conversions over the real CDN, from file://.
// The fixtures are built here: a text PDF, a scanned one (a JPEG of text
// drawn on a canvas, no text layer), a mixed one, a PNG, a DOCX. What this
// proves is that every engine loads from file:// (data: URL workers), that
// the converter's verdict decides which pages are Scanned, that OCR text is
// spliced in page order with its comment, that a cancelled run leaves a
// clean screen, and that a second visit fetches nothing.
await page.goto("about:blank");
await page.goto(url + "#doc-to-markdown");
const shot = await page.evaluate(() => {
  const c = document.createElement("canvas");
  c.width = 1200;
  c.height = 400;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = "#000";
  ctx.font = "48px Helvetica, Arial, sans-serif";
  ctx.fillText("The quick brown fox", 60, 120);
  ctx.fillText("jumps over the lazy dog", 60, 200);
  // A figure: axes and three jagged series, no text at all. OCR reads shapes like this as nonsense at low confidence.
  const f = document.createElement("canvas");
  f.width = 1200;
  f.height = 900;
  const fx = f.getContext("2d")!;
  fx.fillStyle = "#fff";
  fx.fillRect(0, 0, f.width, f.height);
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  fx.strokeStyle = "#333";
  fx.lineWidth = 2;
  fx.beginPath();
  fx.moveTo(100, 800);
  fx.lineTo(100, 100);
  fx.lineTo(1100, 800);
  fx.stroke();
  for (const color of ["#c00", "#06c", "#090"]) {
    fx.strokeStyle = color;
    fx.beginPath();
    for (let i = 0; i <= 40; i++) {
      const px = 100 + i * 25, py = 700 - rnd() * 500;
      if (i) fx.lineTo(px, py);
      else fx.moveTo(px, py);
    }
    fx.stroke();
  }
  return { jpeg: c.toDataURL("image/jpeg", 0.92).split(",")[1]!, png: c.toDataURL("image/png").split(",")[1]!, w: c.width, h: c.height, figure: f.toDataURL("image/jpeg", 0.92).split(",")[1]! };
});
const scanJpeg = { bytes: Uint8Array.from(atob(shot.jpeg), (ch) => ch.charCodeAt(0)), width: shot.w, height: shot.h };
const figureJpeg = { bytes: Uint8Array.from(atob(shot.figure), (ch) => ch.charCodeAt(0)), width: 1200, height: 900 };
const docFixtures: Record<string, Uint8Array> = {
  "text.pdf": buildPdf([{ text: ["Hello from a text PDF.", "Second line here.", "Third line."] }]),
  "scan.pdf": buildPdf([{ jpeg: scanJpeg }]),
  "mixed.pdf": buildPdf([
    { text: ["Page one has text.", "It goes on for a few lines,", "enough to look like a page."] },
    { jpeg: scanJpeg },
    { text: ["Page three has text too.", "Also several lines long,", "so the converter trusts it."] },
  ]),
  "refused.pdf": buildPdf([
    { text: ["Page one has text.", "It goes on for a few lines,", "enough to look like a page."] },
    { jpeg: scanJpeg },
    { jpeg: scanJpeg },
  ]),
  "figure.pdf": buildPdf([
    { text: ["Page one has text.", "It goes on for a few lines,", "enough to look like a page."] },
    { jpeg: scanJpeg },
    { jpeg: figureJpeg },
  ]),
  "six.pdf": buildPdf(Array.from({ length: 6 }, () => ({ jpeg: scanJpeg }))),
  "photo.png": Uint8Array.from(atob(shot.png), (ch) => ch.charCodeAt(0)),
  "note.docx": buildDocx("A heading", ["First paragraph.", "Second paragraph."]),
  "bad.txt": new TextEncoder().encode("hello"),
};
async function dropDoc(name: string) {
  await page.evaluate(([n, s]) => {
    const b = Uint8Array.from(atob(s!), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([b], n!, { type: "application/octet-stream" }));
    document.querySelector(".tool-doc-to-markdown")!.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, [name, Buffer.from(docFixtures[name]!).toString("base64")]);
}
const docDone = () => page.waitForFunction(() => !document.querySelector(".tool-doc-to-markdown .progress")!.classList.contains("on"), null, { timeout: 180000 });
const docOutput = () => page.locator(".tool-doc-to-markdown .output").inputValue();
const docMeta = async () => (await page.locator(".tool-doc-to-markdown .meta").textContent()) ?? "";
const docError = () => page.locator(".tool-doc-to-markdown .error-box").evaluate((e) => (e.classList.contains("on") ? e.textContent! : ""));
const docPhases: string[] = [];
await page.exposeFunction("docPhase", (t: string) => docPhases.push(t));
const watchPhases = () => page.evaluate(() => {
  const el = document.querySelector(".tool-doc-to-markdown .phase")!;
  new MutationObserver(() => (window as unknown as { docPhase(t: string): void }).docPhase(el.textContent ?? "")).observe(el, { childList: true, characterData: true, subtree: true });
});
await watchPhases();

await dropDoc("note.docx");
await docDone();
check("docx converts through anydoc", (await docOutput()) === "# A heading\n\nFirst paragraph.\n\nSecond paragraph.\n" && (await docMeta()) === "Word", (await docOutput()).replace(/\n/g, "⏎"));

await dropDoc("text.pdf");
await docDone();
check("text PDF converts without OCR, page marked", (await docOutput()).startsWith("<!-- page 1 -->\n\nHello from a text PDF.") && (await docMeta()) === "PDF · 1 page" && !(await docOutput()).includes("OCR"), (await docMeta()) + " " + (await docOutput()).slice(0, 60));

await dropDoc("scan.pdf");
await docDone();
check("scanned PDF goes through OCR and is marked", (await docOutput()).startsWith("<!-- page 1, OCR -->\n\n") && /quick brown fox/.test(await docOutput()) && (await docMeta()) === "PDF · 1 page · 1 via OCR (eng)", (await docMeta()) + " " + (await docOutput()).slice(0, 80));

// A text document with a picture-only page in the middle: the converter
// accepts it, so no page is Scanned, OCR never runs, pdf.js never loads.
docPhases.length = 0;
await dropDoc("mixed.pdf");
await docDone();
const mixedOut = await docOutput();
const mixedOrder = [mixedOut.indexOf("<!-- page 1 -->\n\nPage one has text."), mixedOut.indexOf("<!-- page 2, no text -->"), mixedOut.indexOf("<!-- page 3 -->\n\nPage three has text too.")];
check("mid picture page in a text PDF: converter's verdict stands, no OCR, every page marked",
  mixedOrder.every((i, k) => i >= 0 && (k === 0 || i > mixedOrder[k - 1]!)) && !mixedOut.includes("OCR") && (await docMeta()) === "PDF · 3 pages" &&
  !docPhases.some((p) => p.startsWith("Downloading pdf.js") || p.startsWith("Starting OCR")),
  mixedOrder.join(",") + " " + (await docMeta()) + " | " + docPhases.join(" | ").slice(0, 120));

// One text page then two scans: the converter refuses with pages 2 and 3, which are OCR'd and spliced after page 1.
await dropDoc("refused.pdf");
await docDone();
const refusedOut = await docOutput();
const refusedOrder = [refusedOut.indexOf("<!-- page 1 -->\n\nPage one has text."), refusedOut.indexOf("<!-- page 2, OCR -->"), refusedOut.indexOf("quick brown fox"), refusedOut.indexOf("<!-- page 3, OCR -->")];
check("refused PDF: text page converted, listed pages OCR'd, spliced in page order",
  refusedOrder.every((i, k) => i >= 0 && (k === 0 || i > refusedOrder[k - 1]!)) && (await docMeta()) === "PDF · 3 pages · 2 via OCR (eng)",
  refusedOrder.join(",") + " " + (await docMeta()));

// Page markers off: the same PDF, not a comment in sight, and the choice rides in the Deep Link.
await page.locator(".tool-doc-to-markdown .markers-box").uncheck();
await dropDoc("refused.pdf");
await docDone();
const bareOut = await docOutput();
check("page markers off: no comments at all, state in the Deep Link",
  !bareOut.includes("<!--") && bareOut.startsWith("Page one has text.") && /quick brown fox/.test(bareOut) &&
  (await page.evaluate(() => location.hash)) === "#doc-to-markdown/eng.p0" &&
  (await page.evaluate(() => localStorage.getItem("html-tools:doc-to-markdown:markers"))) === "0",
  (await page.evaluate(() => location.hash)) + " " + bareOut.slice(0, 40).replace(/\n/g, "⏎"));
await page.locator(".tool-doc-to-markdown .markers-box").check();
check("page markers back on clears the flag", (await page.evaluate(() => location.hash)) === "#doc-to-markdown");

// Same shape, but the third page is a chart: listed by the converter and OCR'd, it yields nothing confident.
await dropDoc("figure.pdf");
await docDone();
const figureOut = await docOutput();
check("a figure page OCR'd comes out as no text, not gibberish",
  /quick brown fox/.test(figureOut) && figureOut.includes("<!-- page 2, OCR -->") && figureOut.trimEnd().endsWith("<!-- page 3, OCR: no text found -->") && (await docMeta()) === "PDF · 3 pages · 2 via OCR (eng)",
  figureOut.slice(-120).replace(/\n/g, "⏎"));

await dropDoc("photo.png");
await docDone();
check("image goes straight to OCR", (await docOutput()).startsWith("<!-- image, OCR -->") && /quick brown fox/.test(await docOutput()) && (await docMeta()) === "png · OCR eng", (await docMeta()));

await dropDoc("bad.txt");
await docDone();
check("unsupported file refused by name", (await docError()).startsWith(".txt is not a supported format") &&
  !(await page.locator(".tool-doc-to-markdown .result").evaluate((e) => e.classList.contains("on"))), await docError());

// Cancel mid-way through a six-page scan: no error, empty state back, and the next run is unaffected.
await dropDoc("six.pdf");
await page.waitForFunction(() => (document.querySelector(".tool-doc-to-markdown .phase")!.textContent ?? "").startsWith("OCR page 2"), null, { timeout: 60000 });
await page.locator(".tool-doc-to-markdown .cancel-btn").click();
await docDone();
check("cancel leaves a clean screen", (await docError()) === "" &&
  !(await page.locator(".tool-doc-to-markdown .result").evaluate((e) => e.classList.contains("on"))) &&
  (await page.locator(".tool-doc-to-markdown .empty-hint").evaluate((e) => getComputedStyle(e).display)) === "block");
await dropDoc("scan.pdf");
await docDone();
check("conversion works again after cancel", (await docMeta()) === "PDF · 1 page · 1 via OCR (eng)" && /quick brown fox/.test(await docOutput()));

// Languages: picked in the picker, carried in the Deep Link and localStorage, model fetched on next OCR.
await page.locator(".tool-doc-to-markdown .langs summary").click();
await page.locator(".tool-doc-to-markdown .lang-filter").fill("germ");
check("language filter narrows the list", (await page.locator(".tool-doc-to-markdown .lang-list label:not([hidden])").count()) === 2);
await page.locator(".tool-doc-to-markdown .lang-list input[value=deu]").check();
await page.keyboard.press("Escape");
check("languages picked land in the Deep Link and are remembered",
  (await page.evaluate(() => location.hash)) === "#doc-to-markdown/eng+deu" &&
  (await page.evaluate(() => localStorage.getItem("html-tools:doc-to-markdown:langs"))) === "eng+deu" &&
  (await page.locator(".tool-doc-to-markdown .langs summary").textContent()) === "OCR: English, German" &&
  !(await page.locator(".tool-doc-to-markdown .langs").evaluate((e) => (e as HTMLDetailsElement).open)));
docPhases.length = 0;
await dropDoc("photo.png");
await docDone();
check("OCR runs with both models, fetching only the new one",
  (await docMeta()) === "png · OCR eng+deu" && /quick brown fox/.test(await docOutput()) &&
  docPhases.some((p) => p.startsWith("Downloading tesseract deu")) && !docPhases.some((p) => p.startsWith("Downloading tesseract eng")),
  docPhases.filter((p) => p.startsWith("Downloading")).map((p) => p.split(" (")[0]).filter((v, i, a) => a.indexOf(v) === i).join(", "));
await page.evaluate(() => { localStorage.removeItem("html-tools:doc-to-markdown:langs"); localStorage.removeItem("html-tools:doc-to-markdown:markers"); });

// Second visit: every engine comes from IndexedDB, nothing is downloaded.
await page.goto("about:blank");
await page.goto(url + "#doc-to-markdown/eng+ron.p0");
await page.waitForFunction(() => (document.querySelector(".tool-doc-to-markdown .engines-text")!.textContent ?? "").startsWith("Engines cached"));
check("deep link restores the languages and the markers flag",
  (await page.locator(".tool-doc-to-markdown .langs summary").textContent()) === "OCR: English, Romanian" &&
  !(await page.locator(".tool-doc-to-markdown .markers-box").isChecked()));
await page.locator(".tool-doc-to-markdown .markers-box").check();
await page.evaluate(() => { const b = document.querySelector(".tool-doc-to-markdown .lang-list input[value=ron]") as HTMLInputElement; b.checked = false; b.dispatchEvent(new Event("change", { bubbles: true })); });
await watchPhases();
docPhases.length = 0;
await dropDoc("refused.pdf");
await docDone();
check("second visit converts from cached engines with no download",
  (await docMeta()) === "PDF · 3 pages · 2 via OCR (eng)" && !docPhases.some((p) => p.startsWith("Downloading")),
  docPhases.join(" | ").slice(0, 200));
const cachedText = await page.locator(".tool-doc-to-markdown .engines-text").textContent();
const cachedTitle = await page.locator(".tool-doc-to-markdown .engines-text").getAttribute("title");
check("engines footer shows the cached total, breakdown on hover", /^Engines cached: [\d.]+ MB$/.test(cachedText!) && cachedTitle!.includes("anydoc") && cachedTitle!.includes("tesseract eng"), cachedText! + " | " + cachedTitle!.slice(0, 60));
await page.locator(".tool-doc-to-markdown .engines-clear").click();
await page.waitForFunction(() => (document.querySelector(".tool-doc-to-markdown .engines-text")!.textContent ?? "").startsWith("No engines cached"));
check("clear cached engines empties the store", true);
await page.evaluate(() => { localStorage.removeItem("html-tools:doc-to-markdown:langs"); localStorage.removeItem("html-tools:doc-to-markdown:markers"); });

// Whoami: both Traces answered from canned bodies, one per IP literal. What
// this proves is that each protocol is asked on its own, that the four cards
// fill from the traces and nothing else, and that a failed protocol is
// reported as unreachable rather than as a missing address.
const traceBody = (ip: string, loc: string) =>
  "fl=1\nh=1.1.1.1\nip=" + ip + "\nts=1.0\nvisit_scheme=https\nuag=Mozilla/5.0 (smoke)\ncolo=MXP\nhttp=http/2\nloc=" + loc + "\ntls=TLSv1.3\n";
let traceMode: "both" | "v4only" | "split" = "both";
const traceHits: string[] = [];
await page.route(/^https:\/\/(1\.0\.0\.1|\[2606:4700:4700::1001\])\/cdn-cgi\/trace/, (route) => {
  const v6 = route.request().url().includes("[2606");
  traceHits.push(v6 ? "ipv6" : "ipv4");
  if (v6 && traceMode === "v4only") return route.abort("connectionfailed");
  const body = v6 ? traceBody("2001:db8::1", traceMode === "split" ? "DE" : "IT") : traceBody("203.0.113.9", "IT");
  return route.fulfill({ status: 200, contentType: "text/plain", headers: cors, body });
});
const whoamiValue = (row: string) => page.locator('.tool-whoami [data-row="' + row + '"] .value').textContent();
await page.goto(url + "#whoami");
await page.waitForSelector(".tool-whoami .value");
await page.waitForFunction(() => !document.querySelector(".tool-whoami .value.pending"));
check("whoami asks each protocol once on selection", traceHits.join(",") === "ipv4,ipv6" || traceHits.join(",") === "ipv6,ipv4", traceHits.join(","));
check("whoami shows both addresses", (await whoamiValue("ipv4")) === "203.0.113.9" && (await whoamiValue("ipv6")) === "2001:db8::1");
check("whoami shows the user agent Cloudflare received", (await whoamiValue("ua")) === "Mozilla/5.0 (smoke)");
check("whoami names the country", (await whoamiValue("country")) === "IT · Italy");
check("whoami copy all lists the four rows", await page.evaluate(() => {
  let out = "";
  navigator.clipboard.writeText = async (t: string) => { out = t; };
  (document.querySelector(".tool-whoami .btn-copy-all") as HTMLButtonElement).click();
  return new Promise<boolean>((resolve) => setTimeout(() =>
    resolve(out === "IPv4: 203.0.113.9\nIPv6: 2001:db8::1\nCountry: IT · Italy\nUser agent: Mozilla/5.0 (smoke)"), 50));
}));

// IPv6 failing is "not reachable", never "no address"; the shared rows still fill from IPv4.
traceMode = "v4only";
await page.locator(".tool-whoami .btn-refresh").click();
await page.waitForFunction(() => !document.querySelector(".tool-whoami .value.pending"));
check("whoami reports an unreachable protocol without claiming no address",
  (await whoamiValue("ipv6"))!.startsWith("Not reachable over IPv6") &&
  (await page.locator('.tool-whoami [data-row="ipv6"] .btn-copy').isDisabled()) &&
  (await whoamiValue("ipv4")) === "203.0.113.9" && (await whoamiValue("country")) === "IT · Italy",
  (await whoamiValue("ipv6")) ?? "");

// The two traces disagreeing on the country shows both, labeled.
traceMode = "split";
await page.locator(".tool-whoami .btn-refresh").click();
await page.waitForFunction(() => !document.querySelector(".tool-whoami .value.pending"));
check("whoami shows both countries when the traces disagree",
  (await whoamiValue("country"))!.startsWith("IT · Italy via IPv4, DE · Germany via IPv6"), (await whoamiValue("country")) ?? "");

// Markdown Editor: the welcome Draft on a first visit, Preview with Contents
// open, then edits that reach the preview, the stats, the draft, and the Deep
// Link. Math and diagrams fetch their Engines over the real CDN from file://,
// and a second visit fetches nothing. Contents jumps and follows the scroll;
// the Light Document is a Preference that survives a reload.
await page.goto("about:blank");
await page.goto(url + "#markdown-editor");
const mv = ".tool-markdown-editor ";
const mvHost = () => page.locator(mv.trim());
await page.waitForSelector(mv + ".doc h1");
check("markdown editor opens in Preview with Contents open",
  (await mvHost().getAttribute("data-view")) === "preview" &&
  (await mvHost().evaluate((el) => el.classList.contains("toc-open"))) &&
  (await page.locator(mv + ".toc-link").count()) >= 8 &&
  (await page.locator(mv + ".doc h1").textContent()) === "Markdown Editor");
check("welcome draft renders a table, a task list, a callout, highlighted code, and a footnote",
  (await page.locator(mv + ".doc table").count()) === 1 &&
  (await page.locator(mv + ".doc li.task input[type=checkbox]").count()) === 2 &&
  (await page.locator(mv + ".doc blockquote.callout-tip .callout-title").textContent()) === "Tip" &&
  (await page.locator(mv + ".doc pre code.hljs .hljs-keyword").count()) >= 1 &&
  (await page.locator(mv + ".doc .footnotes li").count()) === 1);

// A code block's Copy button puts the block on the clipboard and says so briefly.
await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
await page.locator(mv + ".doc .code-wrap .copy-btn").first().click();
await page.waitForFunction(() => document.querySelector(".tool-markdown-editor .doc .copy-btn")?.textContent === "Copied");
const copiedText = await page.evaluate(() => navigator.clipboard.readText());
check("copy button copies the code block", copiedText.startsWith("export function slug"), copiedText.slice(0, 40));

// Engines: the welcome Draft has math and a diagram, so both load, from the CDN the first time.
await page.waitForFunction(() => document.querySelectorAll(".tool-markdown-editor .doc .katex").length >= 2, null, { timeout: 120000 });
await page.waitForFunction(() => document.querySelector(".tool-markdown-editor .doc .mermaid-block svg"), null, { timeout: 120000 });
check("math and diagrams render once their engines load", true);

// Contents: a click jumps, the entry for the heading at the top is highlighted.
await page.locator(mv + ".toc-link[data-id='md-callouts']").click();
await page.waitForFunction(() => document.querySelector(".tool-markdown-editor .toc-link.active")?.getAttribute("data-id") === "md-callouts");
check("contents jumps to the heading and highlights it",
  (await page.locator(mv + ".preview-pane").evaluate((p) => p.scrollTop)) > 100);

// Edit: the preview, the stats, the draft, and the Deep Link follow the editor.
await page.locator(mv + ".seg button[data-mode=split]").click();
await page.locator(mv + ".editor").fill("# Smoke\n\nSome *text* with `code`.\n\n## Second\n\n- [ ] todo\n");
await page.waitForFunction(() => document.querySelector(".tool-markdown-editor .doc h1")?.textContent === "Smoke");
await page.waitForFunction(() => JSON.parse(localStorage.getItem("html-tools:markdown-editor:draft") ?? "{}").text?.startsWith("# Smoke"));
check("editing updates the preview, contents, stats, and draft",
  (await page.locator(mv + ".toc-link").allTextContents()).join("|") === "Smoke|Second" &&
  (await page.locator(mv + ".stat-words").textContent()) === "12 words");
await page.locator(mv + ".filename").fill("notes");
await page.locator(mv + ".filename").press("Enter");
check("a renamed file gets its extension back", (await page.locator(mv + ".filename").inputValue()) === "notes.md");
await page.waitForFunction(() => location.hash.startsWith("#markdown-editor/notes.md."));
const mvLink = await page.evaluate(() => location.href);

// Light Document: a Preference, remembered, applied to the preview only.
await page.locator(mv + ".light-btn").click();
check("light document toggles the preview palette and is remembered",
  (await page.locator(mv + ".preview-pane").evaluate((p) => p.classList.contains("light"))) &&
  (await page.evaluate(() => localStorage.getItem("html-tools:markdown-editor:light"))) === "1");

// Second visit through the Deep Link: the document comes back with its name,
// the mode and the light page come back from the Preferences, and the
// engines come back from IndexedDB with nothing downloaded.
const mvRequests: string[] = [];
const mvSpy = (r: { url(): string }) => { if (r.url().startsWith("http")) mvRequests.push(r.url()); };
page.on("request", mvSpy);
await page.goto("about:blank");
await page.goto(mvLink);
await page.waitForFunction(() => document.querySelector(".tool-markdown-editor .doc h1")?.textContent === "Smoke");
check("markdown deep link restores the draft, its name, and the preferences",
  (await page.locator(mv + ".editor").inputValue()).startsWith("# Smoke") &&
  (await page.locator(mv + ".filename").inputValue()) === "notes.md" &&
  (await mvHost().getAttribute("data-view")) === "split" &&
  (await page.locator(mv + ".preview-pane").evaluate((p) => p.classList.contains("light"))),
  [(await page.locator(mv + ".editor").inputValue()).slice(0, 12), await page.locator(mv + ".filename").inputValue(), await mvHost().getAttribute("data-view"), await page.locator(mv + ".preview-pane").getAttribute("class")].join(" | "));
await page.locator(mv + ".editor").fill("Inline $x^2$ and\n\n```mermaid\nflowchart LR\n  A --> B\n```\n");
await page.waitForFunction(() => document.querySelector(".tool-markdown-editor .doc .mermaid-block svg") && document.querySelector(".tool-markdown-editor .doc .katex"));
page.off("request", mvSpy);
check("second visit renders math and diagrams from cached engines with no download", mvRequests.length === 0, mvRequests.join(" ").slice(0, 200));

// Find and replace: one match stepped to, replaced, the count following.
await page.locator(mv + ".editor").fill("alpha beta alpha\n");
await page.locator(mv + ".editor").click();
await page.keyboard.press(process.platform === "darwin" ? "Meta+f" : "Control+f");
await page.locator(mv + ".find-input").fill("alpha");
await page.keyboard.press("Enter");
check("find counts matches and keeps focus in the find box",
  (await page.locator(mv + ".find-count").textContent()) === "2/2" &&
  (await page.locator(mv + ".find-input").evaluate((i) => i === document.activeElement)));
await page.locator(mv + ".replace-input").fill("gamma");
await page.locator(mv + ".find-all").click();
check("replace all rewrites the draft",
  (await page.locator(mv + ".editor").inputValue()) === "gamma beta gamma\n" &&
  (await page.locator(mv + ".find-count").textContent()) === "0/0");
await page.locator(mv + ".find-close").click();

// Mod+E trades Edit for Preview and back; the choice is remembered like the buttons'.
await page.keyboard.press(process.platform === "darwin" ? "Meta+e" : "Control+e");
check("mod+e switches to preview", (await mvHost().getAttribute("data-view")) === "preview");
await page.keyboard.press(process.platform === "darwin" ? "Meta+e" : "Control+e");
check("mod+e switches back to edit with the editor focused",
  (await mvHost().getAttribute("data-view")) === "edit" &&
  (await page.locator(mv + ".editor").evaluate((t) => t === document.activeElement)) &&
  (await page.evaluate(() => localStorage.getItem("html-tools:markdown-editor:view"))) === "edit");

// A hidden pane forgets where it was scrolled; the Tool remembers for it.
await page.locator(mv + ".editor").fill("line\n".repeat(400));
await page.locator(mv + ".editor").evaluate((t) => (t.scrollTop = 900));
await page.keyboard.press(process.platform === "darwin" ? "Meta+e" : "Control+e");
await page.keyboard.press(process.platform === "darwin" ? "Meta+e" : "Control+e");
check("the editor keeps its scroll position across preview and back",
  (await page.locator(mv + ".editor").evaluate((t) => t.scrollTop)) === 900);

// Format: the formatter is fetched on first use, the Draft comes back in one style, math untouched.
await page.locator(mv + ".editor").fill("# Title\nText with *emph* and __strong__.\n* one\n* two\n\n|a|b|\n|-|-|\n|1|2|\n\nMath $x_1 * y$ stays.\n");
await page.locator(mv + ".format-btn").click();
await page.waitForFunction(() => (document.querySelector(".tool-markdown-editor .editor") as HTMLTextAreaElement).value.startsWith("# Title\n\n"), null, { timeout: 120000 });
check("format rewrites the draft in one style",
  (await page.locator(mv + ".editor").inputValue()) === "# Title\n\nText with _emph_ and **strong**.\n\n- one\n- two\n\n| a   | b   |\n| --- | --- |\n| 1   | 2   |\n\nMath $x_1 * y$ stays.\n",
  JSON.stringify(await page.locator(mv + ".editor").inputValue()));

// New asks first when there is text: the button becomes the confirmation, a second click discards.
const beforeNew = await page.locator(mv + ".editor").inputValue();
await page.locator(mv + ".new-btn").click();
check("new arms a confirmation and keeps the text",
  (await page.locator(mv + ".new-btn").textContent()) === "Discard?" &&
  (await page.locator(mv + ".editor").inputValue()) === beforeNew && beforeNew.length > 0);
await page.locator(mv + ".editor").click();
check("clicking elsewhere disarms it", (await page.locator(mv + ".new-btn").textContent()) === "New");
await page.locator(mv + ".new-btn").click();
await page.locator(mv + ".new-btn").click();
check("a second click starts a new document",
  (await page.locator(mv + ".editor").inputValue()) === "" &&
  (await page.locator(mv + ".filename").inputValue()) === "untitled.md" &&
  (await page.locator(mv + ".new-btn").textContent()) === "New");

// Contents in the Narrow Layout is a drawer, closed on load, opened by the button.
await page.setViewportSize({ width: 600, height: 800 });
await page.locator(mv + ".seg button[data-mode=preview]").click();
await page.waitForFunction(() => document.querySelector(".tool-markdown-editor")!.classList.contains("toc-drawer"));
check("narrow: contents becomes a drawer and closes", !(await mvHost().evaluate((el) => el.classList.contains("toc-open"))));
await page.locator(mv + ".toc-btn").click();
check("narrow: the contents button opens the drawer", await page.locator(mv + ".toc-backdrop").isVisible());
await page.locator(mv + ".toc-backdrop").click({ position: { x: 550, y: 400 } });
check("narrow: the backdrop closes the drawer", !(await page.locator(mv + ".toc-backdrop").isVisible()));
await page.setViewportSize({ width: 1200, height: 800 });
await page.waitForFunction(() => document.querySelector(".tool-markdown-editor")!.classList.contains("toc-open"));
check("wide again: contents comes back as a column", true);
await page.evaluate(() => {
  for (const k of ["draft", "view", "contents", "light"]) localStorage.removeItem("html-tools:markdown-editor:" + k);
});

// Narrow layout: below 768px the sidebar becomes an on-demand drawer.
await page.setViewportSize({ width: 375, height: 667 });
await page.goto(url + "#jsonc-sorter");
// waitFor, not isVisible: shrinking the viewport hides the sidebar via a
// transition, and this goto is a same-document hash navigation, not a reload.
await page.locator(".sidebar").waitFor({ state: "hidden" });
check("narrow: drawer starts closed", true);
check("narrow: hamburger visible", await page.locator(".menu-btn").isVisible());

await page.locator(".menu-btn").click();
await page.locator(".sidebar").waitFor({ state: "visible" });
check("narrow: hamburger opens drawer",
  (await page.locator(".menu-btn").getAttribute("aria-expanded")) === "true");
check("narrow: main pane inert while open",
  await page.locator(".content").evaluate((el) => (el as HTMLElement).inert));

await page.locator(".tool-list button", { hasText: "Base64" }).click();
await page.locator(".sidebar").waitFor({ state: "hidden" });
check("narrow: selecting a tool closes drawer", await page.evaluate(() => location.hash === "#base64-to-image"));
check("narrow: main pane usable again", !(await page.locator(".content").evaluate((el) => (el as HTMLElement).inert)));

// Re-selecting the current tool fires no hashchange but must still close the drawer.
await page.locator(".menu-btn").click();
await page.locator(".sidebar").waitFor({ state: "visible" });
await page.locator(".tool-list button", { hasText: "Base64" }).click();
await page.locator(".sidebar").waitFor({ state: "hidden" });
check("narrow: re-selecting current tool closes drawer", true);

// The drawer overlays the left edge, so aim the backdrop click at the right side.
await page.locator(".menu-btn").click();
await page.locator(".sidebar").waitFor({ state: "visible" });
await page.locator(".drawer-backdrop").click({ position: { x: 340, y: 400 } });
await page.locator(".sidebar").waitFor({ state: "hidden" });
check("narrow: backdrop closes drawer", true);

await page.locator(".menu-btn").click();
await page.locator(".sidebar").waitFor({ state: "visible" });
await page.keyboard.press("Escape");
await page.locator(".sidebar").waitFor({ state: "hidden" });
check("narrow: escape closes drawer", true);

// The collapse button is a wide-layout control; the drawer has none.
await page.locator(".menu-btn").click();
await page.locator(".sidebar").waitFor({ state: "visible" });
check("narrow: no collapse button in the drawer", !(await page.locator(".collapse-btn").isVisible()));
await page.keyboard.press("Escape");
await page.locator(".sidebar").waitFor({ state: "hidden" });

// Widening across the breakpoint restores the inline sidebar; the hamburger
// gives way to the collapse button in the sidebar's corner.
await page.setViewportSize({ width: 1200, height: 800 });
await page.locator(".sidebar").waitFor({ state: "visible" });
// CSS shows the sidebar before the matchMedia change event syncs the button.
await page.waitForFunction(() => document.querySelector(".menu-btn")!.getAttribute("aria-expanded") === "true");
check("wide: sidebar visible, hamburger gone, collapse button shown",
  !(await page.locator(".menu-btn").isVisible()) && (await page.locator(".collapse-btn").isVisible()));

// Wide layout: the corner button collapses the sidebar and the main pane
// takes the full width.
const paneLeft = async () => (await page.locator(".content").boundingBox())!.x;
await page.waitForFunction(() => document.querySelector(".content")!.getBoundingClientRect().x === 220);
check("wide: main pane sits beside the sidebar", true);

// Clicking a tool while the filter has focus must land: the blur must not
// rebuild the list under the pointer.
await page.locator(".filter-wrap input").focus();
await page.locator(".tool-list button", { hasText: "DNS" }).click();
check("wide: click on tool lands while filter is focused",
  await page.evaluate(() => location.hash === "#dns-lookup"));

await page.locator(".collapse-btn").click();
await page.locator(".sidebar").waitFor({ state: "hidden" });
await page.waitForFunction(() => document.querySelector(".content")!.getBoundingClientRect().x === 0);
check("wide: corner button collapses sidebar, focus moves to the reveal button",
  (await page.locator(".menu-btn").isVisible()) &&
  (await page.locator(".menu-btn").getAttribute("aria-expanded")) === "false" &&
  (await page.locator(".menu-btn").evaluate((el) => el === document.activeElement)) &&
  !(await page.locator(".content").evaluate((el) => (el as HTMLElement).inert)));

// While collapsed, the filter shortcut opens the sidebar as the drawer
// without disturbing the collapse.
await page.keyboard.press("Meta+k");
await page.locator(".sidebar").waitFor({ state: "visible" });
check("wide collapsed: cmd+k opens drawer",
  (await page.locator(".content").evaluate((el) => (el as HTMLElement).inert)) &&
  (await page.locator(".filter-wrap input").evaluate((el) => el === document.activeElement)) &&
  (await paneLeft()) === 0);
await page.locator(".tool-list button", { hasText: "JSONC" }).click();
await page.locator(".sidebar").waitFor({ state: "hidden" });
check("wide collapsed: selecting a tool closes drawer, stays collapsed",
  (await page.evaluate(() => location.hash === "#jsonc-sorter" && document.body.classList.contains("sidebar-collapsed"))));

// The collapse is a preference: it survives a reload, with no slide-out.
await page.reload();
await page.waitForSelector(".tool-list button", { state: "attached" });
check("wide collapsed: remembered across reloads",
  !(await page.locator(".sidebar").isVisible()) && (await paneLeft()) === 0);

await page.locator(".menu-btn").click();
await page.locator(".sidebar").waitFor({ state: "visible" });
await page.waitForFunction(() => document.querySelector(".content")!.getBoundingClientRect().x === 220);
check("wide: reveal button expands sidebar again, focus moves to the corner button",
  !(await page.locator(".menu-btn").isVisible()) &&
  (await page.locator(".collapse-btn").evaluate((el) => el === document.activeElement)) &&
  (await page.evaluate(() => localStorage.getItem("html-tools:sidebar"))) === "expanded");

// Narrowing while expanded still starts the drawer closed; the collapse
// preference is a wide-layout thing and does not leak into it.
await page.evaluate(() => localStorage.setItem("html-tools:sidebar", "collapsed"));
await page.setViewportSize({ width: 375, height: 667 });
await page.reload();
await page.waitForSelector(".menu-btn");
await page.locator(".menu-btn").click();
await page.locator(".sidebar").waitFor({ state: "visible" });
check("narrow: drawer opens regardless of collapse preference", true);
await page.keyboard.press("Escape");
await page.locator(".sidebar").waitFor({ state: "hidden" });
await page.setViewportSize({ width: 1200, height: 800 });
await page.waitForFunction(() => document.querySelector(".content")!.getBoundingClientRect().x === 0);
await page.waitForFunction(() => document.querySelector(".menu-btn")!.getAttribute("aria-expanded") === "false");
check("wide: collapse preference applies again after widening", !(await page.locator(".sidebar").isVisible()));
await page.evaluate(() => localStorage.removeItem("html-tools:sidebar"));

check("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
process.exit(failed ? 1 : 0);
