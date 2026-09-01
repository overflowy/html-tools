// Browser smoke test for the built dist/index.html. Run: bun run smoke.ts
// Uses the Playwright headless Chromium already present in ~/Library/Caches/ms-playwright.
import { chromium } from "playwright-core";
import jsQR from "jsqr";
import dnsFixtures from "./src/tools/dns-lookup/fixtures.json";
import { DKIM_SELECTORS } from "./src/tools/dns-lookup/email";

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
check("sidebar lists all tools", names.length === 6, names.join(", "));

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

// Widening across the breakpoint restores the always-visible sidebar.
await page.setViewportSize({ width: 1200, height: 800 });
await page.locator(".sidebar").waitFor({ state: "visible" });
check("wide: sidebar visible, hamburger gone", !(await page.locator(".menu-btn").isVisible()));

check("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
process.exit(failed ? 1 : 0);
