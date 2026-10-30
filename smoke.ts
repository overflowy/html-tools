// Browser smoke test for the built dist/index.html. Run: bun run smoke.ts
// Uses the Playwright headless Chromium already present in ~/Library/Caches/ms-playwright.
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import jsQR from "jsqr";
import { chromium } from "playwright-core";
import type { Locator, Worker as PageWorker } from "playwright-core";

import osvFixtures from "./src/tools/dependency-audit/fixtures/osv.json";
import { DKIM_SELECTORS } from "./src/tools/dns-lookup/email";
import dnsFixtures from "./src/tools/dns-lookup/fixtures.json";
import { buildDocx, buildPdf } from "./src/tools/doc-to-markdown/fixtures";
import { imagesToPdf } from "./src/tools/pdf-toolkit/pdf/images";
import { protect } from "./src/tools/pdf-toolkit/pdf/security";
import { makeSigner, signPdf } from "./src/tools/pdf-toolkit/pdf/sign-fixture";
import {
  makePdf,
  openTest,
  pageTexts,
  testEnv,
} from "./src/tools/pdf-toolkit/test-env";

const exe =
  process.env.CHROMIUM_PATH ??
  `${
    process.env.HOME
  }/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`;

// Speech to Text's fixtures: speech synthesized by macOS `say` as 16 kHz
// 16-bit WAV, so no audio is committed. The English clip is also what the
// fake microphone hears.
const speechDir = mkdtempSync(path.join(tmpdir(), "html-tools-speech-"));
const SPEECH: Record<string, [voice: string, rate: string, text: string]> = {
  de: [
    "Anna",
    "175",
    "Der Zug nach Berlin fährt heute um halb zehn vom zweiten Gleis ab.",
  ],
  en: [
    "Samantha",
    "175",
    "The quick brown fox jumps over the lazy dog. Please turn off the kitchen lights at nine thirty.",
  ],
  long: [
    "Samantha",
    "105",
    "Welcome to the weekly planning meeting. First, the release is scheduled for the twelfth of March. The design team finished the new onboarding screens last Friday. Second, we still need volunteers for the customer interviews next week. Please send me an email if you can help. Third, the office will be closed on Monday because of the public holiday. The kitchen renovation should be done by the end of the month. Finally, remember that the quarterly report is due on Thursday afternoon. If anything is unclear, ask in the team channel. Thank you all, and have a great week. One more thing: the parking garage will be repainted on Wednesday, so please park on the street that day.",
  ],
};
for (const [name, [voice, rate, text]] of Object.entries(SPEECH)) {
  const aiff = path.join(speechDir, `${name}.aiff`);
  for (const cmd of [
    ["say", "-v", voice, "-r", rate, "-o", aiff, text],
    [
      "afconvert",
      "-f",
      "WAVE",
      "-d",
      "LEI16@16000",
      "-c",
      "1",
      aiff,
      path.join(speechDir, `${name}.wav`),
    ],
  ]) {
    const run = Bun.spawnSync(cmd);
    if (run.exitCode !== 0) {
      throw new Error(`${cmd[0]} failed: ${run.stderr.toString()}`);
    }
  }
}

const browser = await chromium.launch({
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${path.join(speechDir, "en.wav")}%noloop`,
  ],
  executablePath: exe,
});
const page = await browser.newPage();
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  // Probing a repository for lockfiles that are not there is a 404 by design, and the
  // Whoami test cuts the IPv6 trace on purpose; the browser logs each one.
  const byDesign =
    m.location().url.startsWith("https://raw.githubusercontent.com/") ||
    m.location().url.startsWith("https://[2606:4700:4700::1001]/");
  if (m.type() === "error" && !byDesign) {
    errors.push(`console: ${m.text()}`);
  }
});

const url = `file://${import.meta.dir}/dist/index.html`;
let failed = false;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(
    `${ok ? "ok  " : "FAIL"}  ${label}${detail ? `  [${detail}]` : ""}`
  );
  if (!ok) {
    failed = true;
  }
};

/**
 * A locator's text content. Every element has one; only a document or a
 * doctype has none, so null means the selector matched the wrong node.
 */
const textOf = async (locator: Locator): Promise<string> => {
  const text = await locator.textContent();
  if (text === null) {
    throw new Error(`${String(locator)} has no text content`);
  }
  return text;
};

/** An attribute the element must have. */
const attributeOf = async (locator: Locator, name: string): Promise<string> => {
  const value = await locator.getAttribute(name);
  if (value === null) {
    throw new Error(`${String(locator)} has no ${name} attribute`);
  }
  return value;
};

// Elements a page callback acts on are handed to it with
// `locator(...).first().evaluate`, the first match as querySelector picks.

/** `v`, which the test cannot go on without. */
const present = <T>(v: T | null | undefined, what: string): T => {
  if (v === null || v === undefined) {
    throw new Error(`Expected ${what}`);
  }
  return v;
};

await page.goto(url);
const names = await page.locator(".tool-list button").allTextContents();
check("sidebar lists all tools", names.length === 18, names.join(", "));

// base64 tool: paste a tiny valid png via direct input.
await page.goto(`${url}#base64-to-image`);
await page
  .locator(".b64-input")
  .fill(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
  );
await page.waitForSelector(".tool-base64-to-image .output", {
  state: "visible",
});
const b64Meta = await textOf(page.locator(".tool-base64-to-image .meta"));
check("base64 decodes", b64Meta.includes("image/png"));

// image paste -> base64 (encode direction), via a synthetic clipboard event
await page.evaluate((b64: string) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.codePointAt(0) ?? 0);
  const dt = new DataTransfer();
  dt.items.add(new File([bytes], "pixel.png", { type: "image/png" }));
  document.dispatchEvent(
    new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: dt,
    })
  );
}, "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==");
await page.waitForFunction(() =>
  (
    document.querySelector(
      ".tool-base64-to-image .b64-input"
    ) as HTMLTextAreaElement
  ).value.startsWith("data:image/png;base64,")
);
await page.waitForSelector(".tool-base64-to-image .output", {
  state: "visible",
});
check("pasted image encodes to base64", true);

// image drop -> base64
await page.locator(".b64-input").fill("");
await page
  .locator(".tool-base64-to-image")
  .first()
  .evaluate((host, b64: string) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.codePointAt(0) ?? 0);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], "pixel.png", { type: "image/png" }));
    host.dispatchEvent(
      new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: dt,
      })
    );
  }, "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==");
await page.waitForFunction(() =>
  (
    document.querySelector(
      ".tool-base64-to-image .b64-input"
    ) as HTMLTextAreaElement
  ).value.startsWith("data:image/png;base64,")
);
check("dropped image encodes to base64", true);

// jsonc tool: sort a snippet with a comment.
await page.goto(`${url}#jsonc-sorter`);
await page
  .locator(".tool-jsonc-sorter .src")
  .fill('{\n  // b first\n  "b": 1,\n  "a": 2\n}');
await page.waitForSelector(".tool-jsonc-sorter .statusbar.ok");
const jsoncStatus = await textOf(
  page.locator(".tool-jsonc-sorter .status-text")
);
check(
  "jsonc sorts",
  jsoncStatus.includes("2 keys sorted · 1 comment preserved")
);

// Plain JSON, with trailing commas at every depth, comes out as strict JSON.
await page
  .locator(".tool-jsonc-sorter .src")
  .fill('{"b": [1, {"y": 2, "x": 3,},], "a": {"d": {"f": 1,}, "c": 2,},}');
await page.waitForFunction(() =>
  document
    .querySelector(".tool-jsonc-sorter .status-text")
    ?.textContent?.includes("7 keys")
);
const jsonOut = await textOf(page.locator(".tool-jsonc-sorter .output"));
let jsonOk = false;
try {
  jsonOk =
    JSON.stringify(JSON.parse(jsonOut)) ===
    '{"a":{"c":2,"d":{"f":1}},"b":[1,{"x":3,"y":2}]}';
} catch {
  /* invalid */
}
check(
  "jsonc accepts plain JSON, drops nested trailing commas",
  jsonOk,
  jsonOut.replaceAll(/\s+/gu, " ")
);
check(
  "jsonc status omits comment count when there are none",
  (await page.locator(".tool-jsonc-sorter .status-text").textContent()) ===
    "7 keys sorted"
);

// save decoder: encode JSON on the right, verify base64 appears, then round-trip it back.
await page.goto(`${url}#save-decoder`);
await page
  .locator(".tool-save-decoder .dec")
  .fill('{"resources": {"catnip": 5000}, "day": 12}');
await page.waitForSelector(".tool-save-decoder .dec-status.ok");
const encoded = await page.locator(".tool-save-decoder .enc").inputValue();
check("save encodes", encoded.length > 0, `${encoded.slice(0, 24)}…`);
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
await page
  .locator(".tool-save-decoder .dec")
  .fill('{\n    resources: "unquoted key"\n}');
await page.waitForSelector(".tool-save-decoder .dec-status.error");
const decErr = await textOf(
  page.locator(".tool-save-decoder .dec-status .status-text")
);
check(
  "invalid JSON refuses to encode",
  decErr.includes("Not valid JSON"),
  decErr.slice(0, 60)
);
check(
  "encoded pane untouched on bad JSON",
  (await page.locator(".tool-save-decoder .enc").inputValue()) === encoded
);

// image metadata: minimal hand-crafted fixtures, one per container, each with
// EXIF GPS 52.520008 N, 13.404954 E. Drop each one, expect the GPS highlight,
// then strip and expect the self-verification to pass.
// - jpeg: SOI, APP0 JFIF, APP1 EXIF (Orientation 6), COM, DQT/SOF0/DHT/SOS 1x1, EOI, trailing junk
// - png: 1x1 gray with eXIf + tEXt + tIME chunks
// - webp: VP8X (EXIF flag) + VP8L stub + EXIF chunk
// - tiff: 1x1 gray with Software/DateTime tags + GPS IFD
// - heic: ftyp + meta (hdlr/pitm/iinf/iref/iprp/iloc) + mdat with Exif item
const FIXTURES: [format: string, base64: string][] = [
  [
    "jpeg",
    "/9j/4AAQSkZJRgABAQAASABIAAD/4QEaRXhpZgAASUkqAAgAAAAGAA8BAgAFAAAAVgAAABABAgAJAAAAXAAAABIBAwABAAAABgAAADIBAgAUAAAAZgAAAGmHBAABAAAAegAAACWIBAABAAAAoAAAAAAAAABBY21lAABDYW0gOTAwMAAAMjAyNDowNTowMSAxMjowMDowMAABAAOQAgAUAAAAjAAAAAAAAAAyMDI0OjA1OjAxIDEyOjAwOjAwAAUAAQACAAIAAABOAAAAAgAFAAMAAADiAAAAAwACAAIAAABFAAAABAAFAAMAAAD6AAAABQABAAEAAAAAAAAAAAAAADQAAAABAAAAHwAAAAEAAADg1QEAECcAAA0AAAABAAAAGAAAAAEAAACouAIAECcAAP/+ABJzaG90IG9uIGEgcG90YXRv/9sAQwABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB/8AACwgAAQABAQERAP/EABQAAAEAAAAAAAAAAAAAAAAAAAD/xAAUEAABAAAAAAAAAAAAAAAAAAAA/9oACAEBAAA/AA//2VRSQUlMSU5HSlVOSw==",
  ],
  [
    "png",
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAABEmVYSWZJSSoACAAAAAYADwECAAUAAABWAAAAEAECAAkAAABcAAAAEgEDAAEAAAABAAAAMgECABQAAABmAAAAaYcEAAEAAAB6AAAAJYgEAAEAAACgAAAAAAAAAEFjbWUAAENhbSA5MDAwAAAyMDI0OjA1OjAxIDEyOjAwOjAwAAEAA5ACABQAAACMAAAAAAAAADIwMjQ6MDU6MDEgMTI6MDA6MDAABQABAAIAAgAAAE4AAAACAAUAAwAAAOIAAAADAAIAAgAAAEUAAAAEAAUAAwAAAPoAAAAFAAEAAQAAAAAAAAAAAAAANAAAAAEAAAAfAAAAAQAAAODVAQAQJwAADQAAAAEAAAAYAAAAAQAAAKi4AgAQJwAAASqWTAAAABV0RVh0U29mdHdhcmUAbWFkZSBieSBoYW5kDW494gAAAAd0SU1FB+gFAQwAAE+FIj4AAAANSURBVHgBAQIA/f8AgACCAIHDbiXgAAAAAElFTkSuQmCC",
  ],
  [
    "webp",
    "UklGRkABAABXRUJQVlA4WAoAAAAIAAAAAAAAAAAAVlA4TAgAAAAvAAAAAIiICEVYSUYSAQAASUkqAAgAAAAGAA8BAgAFAAAAVgAAABABAgAJAAAAXAAAABIBAwABAAAAAQAAADIBAgAUAAAAZgAAAGmHBAABAAAAegAAACWIBAABAAAAoAAAAAAAAABBY21lAABDYW0gOTAwMAAAMjAyNDowNTowMSAxMjowMDowMAABAAOQAgAUAAAAjAAAAAAAAAAyMDI0OjA1OjAxIDEyOjAwOjAwAAUAAQACAAIAAABOAAAAAgAFAAMAAADiAAAAAwACAAIAAABFAAAABAAFAAMAAAD6AAAABQABAAEAAAAAAAAAAAAAADQAAAABAAAAHwAAAAEAAADg1QEAECcAAA0AAAABAAAAGAAAAAEAAACouAIAECcAAA==",
  ],
  [
    "tiff",
    "SUkqAAgAAAAKAAABAwABAAAAAQAAAAEBAwABAAAAAQAAAAIBAwABAAAACAAAAAMBAwABAAAAAQAAAAYBAwABAAAAAQAAABEBBAABAAAAhgAAABcBBAABAAAAAQAAADEBAgASAAAAiAAAADIBAgAUAAAAmgAAACWIBAABAAAArgAAAAAAAACAAGhhbmRtYWRlIGZpeHR1cmUAADIwMjQ6MDU6MDEgMTI6MDA6MDAABQABAAIAAgAAAE4AAAACAAUAAwAAAPAAAAADAAIAAgAAAEUAAAAEAAUAAwAAAAgBAAAFAAEAAQAAAAAAAAAAAAAANAAAAAEAAAAfAAAAAQAAAODVAQAQJwAADQAAAAEAAAAYAAAAAQAAAKi4AgAQJwAA",
  ],
  [
    "heic",
    "AAAAGGZ0eXBoZWljAAAAAG1pZjFoZWljAAAA8W1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAHBpY3QAAAAAAAAAAAAAAAAAAAAADnBpdG0AAAAAAAEAAAA4aWluZgAAAAAAAgAAABVpbmZlAgAAAAABAABodmMxAAAAABVpbmZlAgAAAAACAABFeGlmAAAAABppcmVmAAAAAAAAAA5jZHNjAAIAAQABAAAAOGlwcnAAAAAcaXBjbwAAABRpc3BlAAAAAAAAAEAAAAAwAAAAFGlwbWEAAAAAAAAAAQABAYEAAAAsaWxvYwAAAABEAAACAAEAAAABAAABEQAAABAAAgAAAAEAAAEhAAABHAAAATRtZGF0RkFLRUhFVkNQQVlMT0FEIQAAAAZFeGlmAABJSSoACAAAAAYADwECAAUAAABWAAAAEAECAAkAAABcAAAAEgEDAAEAAAABAAAAMgECABQAAABmAAAAaYcEAAEAAAB6AAAAJYgEAAEAAACgAAAAAAAAAEFjbWUAAENhbSA5MDAwAAAyMDI0OjA1OjAxIDEyOjAwOjAwAAEAA5ACABQAAACMAAAAAAAAADIwMjQ6MDU6MDEgMTI6MDA6MDAABQABAAIAAgAAAE4AAAACAAUAAwAAAOIAAAADAAIAAgAAAEUAAAAEAAUAAwAAAPoAAAAFAAEAAQAAAAAAAAAAAAAANAAAAAEAAAAfAAAAAQAAAODVAQAQJwAADQAAAAEAAAAYAAAAAQAAAKi4AgAQJwAA",
  ],
];

await page.goto(`${url}#image-metadata`);
for (const [fmt, b64] of FIXTURES) {
  await page
    .locator(".tool-image-metadata")
    .first()
    .evaluate(
      (host, [n, s]) => {
        const bytes = Uint8Array.from(atob(s), (c) => c.codePointAt(0) ?? 0);
        const dt = new DataTransfer();
        dt.items.add(
          new File([bytes], `fixture.${n}`, {
            type: "application/octet-stream",
          })
        );
        host.dispatchEvent(
          new DragEvent("drop", {
            bubbles: true,
            cancelable: true,
            dataTransfer: dt,
          })
        );
      },
      [fmt, b64]
    );
  await page.waitForFunction(
    (n) =>
      document.querySelector(".tool-image-metadata .status")?.textContent ===
      `fixture.${n}`,
    fmt
  );
  const gpsText = await textOf(
    page.locator(".tool-image-metadata .hl.gps .hl-val")
  );
  check(
    `${fmt} shows GPS coordinates`,
    gpsText.includes("52.520008") && gpsText.includes("13.404954"),
    gpsText.trim().slice(0, 40)
  );
  const hlText = await textOf(page.locator(".tool-image-metadata .highlights"));
  check(
    `${fmt} shows dashed date`,
    hlText.includes("2024-05-01 12:00:00"),
    hlText.trim().slice(0, 60)
  );
  await page.locator(".tool-image-metadata .strip-btn").click();
  await page.waitForSelector(".tool-image-metadata .strip-ok");
  const verdict = await textOf(page.locator(".tool-image-metadata .strip-ok"));
  check(
    `${fmt} strips clean`,
    verdict.startsWith("Re-parsed the stripped copy"),
    verdict.slice(0, 70)
  );
  if (fmt === "jpeg") {
    // The JPEG fixture has Orientation 6: the strip must keep it and say so.
    check(
      "jpeg keeps orientation",
      verdict.includes("orientation (6)"),
      verdict.slice(0, 90)
    );
  }
}

// qr generator: render codes for every payload type and error correction level,
// then prove they scan by decoding the canvas pixels with jsQR.
const decodeQrCanvas = async (): Promise<{
  text: string;
  bytes: Uint8Array;
} | null> => {
  const img = await page.evaluate(() => {
    const c = document.querySelector(
      ".tool-qr-generator .qr-canvas"
    ) as HTMLCanvasElement | null;
    if (!c || c.hidden) {
      return null;
    }
    const ctx = c.getContext("2d");
    if (!ctx) {
      throw new Error("The QR canvas has no 2D context");
    }
    const d = ctx.getImageData(0, 0, c.width, c.height);
    return { data: [...d.data], height: d.height, width: d.width };
  });
  if (!img) {
    return null;
  }
  const res = jsQR(new Uint8ClampedArray(img.data), img.width, img.height);
  return res ? { bytes: new Uint8Array(res.binaryData), text: res.data } : null;
};

/** Poll until the rendered code decodes to `expected` (the tool debounces regeneration). */
const checkQrDecodes = async (
  label: string,
  expected: string,
  utf8 = false
) => {
  const deadline = Date.now() + 5000;
  let got = "";
  for (;;) {
    const res = await decodeQrCanvas();
    if (res) {
      got = utf8 ? new TextDecoder().decode(res.bytes) : res.text;
    }
    if (got === expected || Date.now() > deadline) {
      break;
    }
    await Bun.sleep(100);
  }
  check(label, got === expected, got.slice(0, 50) || "(no decode)");
};

await page.goto(`${url}#qr-generator`);
await page.locator(".tool-qr-generator .opt-size").fill("192");
await page
  .locator(".tool-qr-generator .f-text")
  .fill("https://example.com/some/path?q=1");
await checkQrDecodes("qr text scans back", "https://example.com/some/path?q=1");
for (const ecl of ["L", "Q", "H", "M"]) {
  await page.locator(".tool-qr-generator .opt-ecl").selectOption(ecl);
  await checkQrDecodes(
    `qr scans at level ${ecl}`,
    "https://example.com/some/path?q=1"
  );
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
await checkQrDecodes(
  "qr wifi payload scans back",
  "WIFI:T:WPA;S:Home Network;P:s3cret\\;pass;H:true;;"
);

await page.locator('.tool-qr-generator [data-type="contact"]').click();
await page.locator(".tool-qr-generator .f-ct-first").fill("Jane");
await page.locator(".tool-qr-generator .f-ct-last").fill("Doe");
await page.locator(".tool-qr-generator .f-ct-phone").fill("+1 555 0100");
await page.locator(".tool-qr-generator .f-ct-email").fill("jane@example.com");
await checkQrDecodes(
  "qr vcard payload scans back",
  "BEGIN:VCARD\r\nVERSION:3.0\r\nN:Doe;Jane;;;\r\nFN:Jane Doe\r\nTEL:+1 555 0100\r\nEMAIL:jane@example.com\r\nEND:VCARD"
);

await page.locator('.tool-qr-generator [data-type="email"]').click();
await page.locator(".tool-qr-generator .f-em-to").fill("jane@example.com");
await page.locator(".tool-qr-generator .f-em-subject").fill("Hi there");
await checkQrDecodes(
  "qr email payload scans back",
  "mailto:jane@example.com?subject=Hi%20there"
);

await page.locator('.tool-qr-generator [data-type="sms"]').click();
await page.locator(".tool-qr-generator .f-sms-num").fill("+1 555 0100");
await page.locator(".tool-qr-generator .f-sms-msg").fill("See you at 6");
await checkQrDecodes(
  "qr sms payload scans back",
  "SMSTO:+15550100:See you at 6"
);

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
const qrTooLongStatus = await textOf(
  page.locator(".tool-qr-generator .status-text")
);
check(
  "qr too-long payload reports error",
  qrTooLongStatus.includes("too long")
);

// inverted colors get a warning
await page.locator(".tool-qr-generator .f-text").fill("contrast check");
await page.evaluate(() => {
  const fg = document.querySelector(
    ".tool-qr-generator .opt-fg"
  ) as HTMLInputElement;
  const bg = document.querySelector(
    ".tool-qr-generator .opt-bg"
  ) as HTMLInputElement;
  fg.value = "#ffffff";
  bg.value = "#000000";
  fg.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.waitForSelector(".tool-qr-generator .statusbar.warn");
const qrInvertedStatus = await textOf(
  page.locator(".tool-qr-generator .status-text")
);
check("qr inverted colors warn", qrInvertedStatus.includes("inverted"));

// Deep links: a tool's state lives in the URL hash and a fresh load restores it.
await page.goto(`${url}#jsonc-sorter`);
await page.locator(".tool-jsonc-sorter .src").fill('{"z": 1, "a": 2}');
await page.locator(".tool-jsonc-sorter .opt-order").selectOption("desc");
await page.waitForSelector(".tool-jsonc-sorter .statusbar.ok");
await page.waitForFunction(() => location.hash.startsWith("#jsonc-sorter/"));
const jsoncLink = await page.evaluate(() => location.href);
await page.goto("about:blank");
await page.goto(jsoncLink);
await page.waitForSelector(".tool-jsonc-sorter .statusbar.ok");
check(
  "jsonc deep link restores input",
  (await page.locator(".tool-jsonc-sorter .src").inputValue()) ===
    '{"z": 1, "a": 2}'
);
check(
  "jsonc deep link restores options",
  (await page.locator(".tool-jsonc-sorter .opt-order").inputValue()) === "desc"
);
const sortedOut = await textOf(page.locator(".tool-jsonc-sorter .output"));
check(
  "jsonc deep link sorts on load",
  sortedOut.includes('"z"') &&
    sortedOut.indexOf('"z"') < sortedOut.indexOf('"a"')
);

// Switching tools via the sidebar keeps each tool's state in its deep link.
await page.locator(".tool-list button", { hasText: "Base64" }).click();
await page.waitForFunction(() => location.hash === "#base64-to-image");
await page.locator(".tool-list button", { hasText: "JSONC" }).click();
await page.waitForFunction(() => location.hash.startsWith("#jsonc-sorter/"));
check("switching tools keeps state in the deep link", true);

await page.goto(`${url}#save-decoder`);
await page.locator(".tool-save-decoder .dec").fill('{"day": 7}');
await page.waitForSelector(".tool-save-decoder .dec-status.ok");
const savedEnc = await page.locator(".tool-save-decoder .enc").inputValue();
await page.waitForFunction(() => location.hash.startsWith("#save-decoder/"));
const saveLink = await page.evaluate(() => location.href);
await page.goto("about:blank");
await page.goto(saveLink);
await page.waitForSelector(".tool-save-decoder .enc-status.ok");
check(
  "save deep link restores encoded pane",
  (await page.locator(".tool-save-decoder .enc").inputValue()) === savedEnc
);
check(
  "save deep link decodes on load",
  JSON.parse(await page.locator(".tool-save-decoder .dec").inputValue()).day ===
    7
);

await page.goto(`${url}#qr-generator`);
await page.locator('.tool-qr-generator [data-type="wifi"]').click();
await page.locator(".tool-qr-generator .f-wifi-ssid").fill("Cafe Guest");
await page.locator(".tool-qr-generator .f-wifi-pass").fill("espresso99");
await page.locator(".tool-qr-generator .opt-ecl").selectOption("Q");
await page.waitForFunction(() =>
  location.hash.startsWith("#qr-generator/wifi.")
);
await page.waitForSelector(".tool-qr-generator .statusbar.ok");
const qrLink = await page.evaluate(() => location.href);
await page.goto("about:blank");
await page.goto(qrLink);
await page.waitForSelector(".tool-qr-generator .statusbar.ok");
check(
  "qr deep link restores type",
  await page
    .locator('.tool-qr-generator [data-type="wifi"]')
    .evaluate((b) => b.classList.contains("active"))
);
check(
  "qr deep link restores fields",
  (await page.locator(".tool-qr-generator .f-wifi-ssid").inputValue()) ===
    "Cafe Guest" &&
    (await page.locator(".tool-qr-generator .f-wifi-pass").inputValue()) ===
      "espresso99"
);
check(
  "qr deep link restores options",
  (await page.locator(".tool-qr-generator .opt-ecl").inputValue()) === "Q"
);
await checkQrDecodes(
  "qr deep link renders a scannable code",
  "WIFI:T:WPA;S:Cafe Guest;P:espresso99;;"
);

// dns lookup: the only tool that talks to the network. Every endpoint is
// intercepted and answered from the unit-test fixtures, so this stays offline
// and deterministic; what it proves is the wiring from input to table to URL.
const dnsHits: string[] = [];
const cors = { "access-control-allow-origin": "*" };
await page.route(
  /^https:\/\/(?:cloudflare-dns\.com|security\.cloudflare-dns\.com|family\.cloudflare-dns\.com|dns\.google)\//u,
  (route) => {
    const u = new URL(route.request().url());
    const name = u.searchParams.get("name");
    // Known types travel as numbers; map the ones this test dispatches on back to names.
    // The tool always sends a type; without one, nothing below matches.
    const wire = u.searchParams.get("type") ?? "";
    const type =
      (
        {
          "1": "A",
          "12": "PTR",
          "15": "MX",
          "16": "TXT",
          "2": "NS",
          "33": "SRV",
        } as Record<string, string>
      )[wire] ?? wire;
    dnsHits.push(
      `${u.host} ${name} ${type}${u.searchParams.get("do") ? " do" : ""}`
    );
    let body: unknown;
    if (name === "doesnotexist.example.com") {
      body = dnsFixtures.cloudflare_nxdomain;
    } else if (name === "8.8.8.8.in-addr.arpa") {
      body = dnsFixtures.cloudflare_ptr;
    } else if (type === "A") {
      body =
        u.host === "dns.google"
          ? dnsFixtures.google_a
          : dnsFixtures.cloudflare_a;
    } else if (type === "MX") {
      body = dnsFixtures.cloudflare_mx;
    } else if (type === "NS" && name === "example.com") {
      // Matches the delegation in the RDAP fixture, so the whois card can report agreement.
      body = {
        ...dnsFixtures.cloudflare_empty,
        Answer: ["elliott.ns.cloudflare.com.", "hera.ns.cloudflare.com."].map(
          (data) => ({ TTL: 300, data, name, type: 2 })
        ),
        Authority: [],
        Question: [{ name, type: 2 }],
      };
    } else if (type === "TXT") {
      // TXT is served per name so the email check sees SPF, DMARC, and DKIM where they belong and nothing elsewhere.
      const strings = (dnsFixtures.txt_by_name as Record<string, string[]>)[
        name ?? ""
      ];
      body = strings
        ? {
            ...dnsFixtures.cloudflare_empty,
            Answer: strings.map((data) => ({ TTL: 300, data, name, type: 16 })),
            Authority: [],
            Question: [{ name, type: 16 }],
          }
        : dnsFixtures.cloudflare_empty;
    } else if (type === "NOTIMPTYPE") {
      body = dnsFixtures.cloudflare_notimp;
    } else {
      body = dnsFixtures.cloudflare_empty;
    }
    return route.fulfill({
      body: JSON.stringify(body),
      contentType: "application/dns-json",
      headers: cors,
      status: 200,
    });
  }
);
await page.route(/^https:\/\/api\.certspotter\.com\//u, (route) => {
  const u = new URL(route.request().url());
  dnsHits.push(
    `certspotter ${u.searchParams.get(
      "domain"
    )}${u.searchParams.get("after") ? " after" : ""}`
  );
  const body = u.searchParams.get("after") ? [] : dnsFixtures.certspotter_page;
  return route.fulfill({
    body: JSON.stringify(body),
    contentType: "application/json",
    headers: cors,
    status: 200,
  });
});
await page.route(/^https:\/\/example\.com\/brand\//u, (route) => {
  const { pathname } = new URL(route.request().url());
  dnsHits.push(`asset ${pathname}`);
  if (pathname.endsWith("logo.svg")) {
    return route.fulfill({
      body: dnsFixtures.bimi_logo,
      contentType: "image/svg+xml",
      headers: cors,
      status: 200,
    });
  }
  if (pathname.endsWith("vmc.pem")) {
    return route.fulfill({
      body: dnsFixtures.bimi_cert,
      contentType: "application/x-pem-file",
      headers: cors,
      status: 200,
    });
  }
  return route.fulfill({ body: "", headers: cors, status: 404 });
});
await page.route(
  /^https:\/\/(?:data\.iana\.org|rdap\.verisign\.com|rdap\.arin\.net)\//u,
  (route) => {
    const u = new URL(route.request().url());
    dnsHits.push(`rdap ${u.host}${u.pathname}`);
    const bodies: Record<string, unknown> = {
      "data.iana.org/rdap/dns.json": dnsFixtures.rdap_bootstrap_dns,
      "data.iana.org/rdap/ipv4.json": dnsFixtures.rdap_bootstrap_ipv4,
      "data.iana.org/rdap/ipv6.json": dnsFixtures.rdap_bootstrap_ipv6,
      "rdap.arin.net/registry/ip/8.8.8.8": dnsFixtures.rdap_ip,
      "rdap.verisign.com/com/v1/domain/example.com": dnsFixtures.rdap_domain,
    };
    const body = bodies[u.host + u.pathname];
    // Unknown names get an RDAP-shaped 404 body, but a 200 status: Chromium logs a console error for
    // any 404 and this harness treats console errors as failures. The tool keys off the status alone,
    // so the walk-up path is covered in the unit tests instead.
    return route.fulfill({
      body: JSON.stringify(body ?? { errorCode: 404 }),
      contentType: "application/rdap+json",
      headers: cors,
      status: 200,
    });
  }
);
await page.route(/^https:\/\/api\.whois\.vu\//u, (route) => {
  dnsHits.push(
    `whois.vu ${new URL(route.request().url()).searchParams.get("q")}`
  );
  return route.fulfill({
    body: JSON.stringify(dnsFixtures.whois_text),
    contentType: "text/plain",
    headers: cors,
    status: 200,
  });
});
await page.route(/^https:\/\/api\.hackertarget\.com\//u, (route) => {
  dnsHits.push(
    `hackertarget ${new URL(route.request().url()).searchParams.get("q")}`
  );
  return route.fulfill({
    body: dnsFixtures.hackertarget_text,
    contentType: "text/plain",
    headers: cors,
    status: 200,
  });
});

await page.goto(`${url}#dns-lookup`);
await page
  .locator(".tool-dns-lookup .name")
  .fill("https://Example.COM/some/path?x=1");
await page.locator(".tool-dns-lookup .type").selectOption("MX");
await page.locator(".tool-dns-lookup .btn-lookup").click();
await page.waitForSelector(".tool-dns-lookup .statusbar.ok");
check(
  "dns normalizes the pasted URL to a name",
  (await page.locator(".tool-dns-lookup .name").inputValue()) === "example.com"
);
check(
  "dns asks the resolver for exactly that",
  dnsHits.at(-1) === "cloudflare-dns.com example.com MX",
  dnsHits.at(-1)
);
check(
  "dns renders the answer rows",
  (await page.locator(".tool-dns-lookup .records tbody tr").count()) === 3
);
const dnsFlags = await textOf(page.locator(".tool-dns-lookup .flags"));
check("dns shows the status flags", dnsFlags.startsWith("NOERROR"));
const dnsMxStatus = await textOf(page.locator(".tool-dns-lookup .status-text"));
check("dns status counts records", dnsMxStatus.startsWith("3 records"));
check(
  "dns writes the query into the deep link",
  await page.evaluate(
    () => location.hash === "#dns-lookup/cf.00.lookup.MX.example.com"
  )
);
const dnsMxRaw = await textOf(page.locator(".tool-dns-lookup .raw"));
check(
  "dns raw pane holds the response",
  dnsMxRaw.includes('"data": "10 mail.example.com."')
);

// No records of that type is reported distinctly from NXDOMAIN, with the SOA shown.
await page.locator(".tool-dns-lookup .type").selectOption("SRV");
await page.locator(".tool-dns-lookup .btn-lookup").click();
await page.waitForFunction(() =>
  document
    .querySelector(".tool-dns-lookup .status-text")
    ?.textContent?.startsWith("no records")
);
const dnsSrvNote = await textOf(
  page.locator(".tool-dns-lookup .results .note")
);
check(
  "dns empty answer says so",
  dnsSrvNote.includes("No SRV records for example.com")
);
check(
  "dns empty answer still shows the authority SOA",
  (await page.locator(".tool-dns-lookup .results .section").textContent()) ===
    "authority" &&
    (await page
      .locator(".tool-dns-lookup .records .type-badge")
      .first()
      .textContent()) === "SOA"
);

await page.locator(".tool-dns-lookup .name").fill("doesnotexist.example.com");
await page.locator(".tool-dns-lookup .type").selectOption("A");
await page.locator(".tool-dns-lookup .btn-lookup").click();
await page.waitForFunction(() =>
  document
    .querySelector(".tool-dns-lookup .status-text")
    ?.textContent?.startsWith("NXDOMAIN")
);
const dnsNxdomainNote = await textOf(
  page.locator(".tool-dns-lookup .results .note")
);
check(
  "dns NXDOMAIN is its own outcome",
  dnsNxdomainNote.includes("does not exist (NXDOMAIN)")
);
check(
  "dns NXDOMAIN flags show the rcode",
  (await page.locator(".tool-dns-lookup .flags .status").textContent()) ===
    "NXDOMAIN"
);

// An IP address becomes a reverse lookup regardless of the picked type.
await page.locator(".tool-dns-lookup .name").fill("8.8.8.8");
await page.locator(".tool-dns-lookup .btn-lookup").click();
await page.waitForFunction(() =>
  document
    .querySelector(".tool-dns-lookup .status-text")
    ?.textContent?.startsWith("1 record")
);
check(
  "dns IP input queries the arpa name for PTR",
  dnsHits.at(-1) === "cloudflare-dns.com 8.8.8.8.in-addr.arpa PTR",
  dnsHits.at(-1)
);
check(
  "dns reverse lookup is labelled",
  (await page.locator(".tool-dns-lookup .results-title").textContent()) ===
    "Reverse lookup"
);
check(
  "dns reverse lookup shows the PTR",
  (await page
    .locator(".tool-dns-lookup .records .c-data")
    .first()
    .textContent()) === "dns.google."
);

// Resolver-side failure (NOTIMP with an EDE comment) renders as an error, not as "no records".
await page.locator(".tool-dns-lookup .name").fill("example.com");
await page.locator(".tool-dns-lookup .type").selectOption("custom");
await page.locator(".tool-dns-lookup .custom-type").fill("not a type");
await page.locator(".tool-dns-lookup .btn-lookup").click();
await page.waitForSelector(".tool-dns-lookup .statusbar.error");
const hitsBefore = dnsHits.length;
const dnsCustomTypeStatus = await textOf(
  page.locator(".tool-dns-lookup .status-text")
);
check(
  "dns rejects a malformed custom type before querying",
  dnsCustomTypeStatus.includes("record type name or number")
);
await page.locator(".tool-dns-lookup .custom-type").fill("notimptype");
await page.locator(".tool-dns-lookup .custom-type").press("Enter");
await page.waitForFunction(
  () => document.querySelector(".tool-dns-lookup .results .error-box") !== null
);
check(
  "dns custom type is uppercased and sent",
  dnsHits.length === hitsBefore + 1 &&
    dnsHits.at(-1) === "cloudflare-dns.com example.com NOTIMPTYPE",
  dnsHits.at(-1)
);
const dnsNotimpError = await textOf(
  page.locator(".tool-dns-lookup .results .error-box")
);
check(
  "dns resolver failure shows the rcode and EDE",
  dnsNotimpError.includes("NOTIMP: EDE(21): Not Supported")
);

// Google with DNSSEC OK: the flag reaches the wire and the string Comment is displayed.
await page.locator(".tool-dns-lookup .type").selectOption("A");
await page.locator(".tool-dns-lookup .resolver").selectOption("google");
await page.locator(".tool-dns-lookup .opt-do").check();
await page.locator(".tool-dns-lookup .btn-lookup").click();
await page.waitForFunction(() =>
  document
    .querySelector(".tool-dns-lookup .status-text")
    ?.textContent?.includes("Google 8.8.8.8")
);
check(
  "dns google resolver with DO",
  dnsHits.at(-1) === "dns.google example.com A do",
  dnsHits.at(-1)
);
check(
  "dns shows the resolver comment",
  (await page.locator(".tool-dns-lookup .results .comment").textContent()) ===
    "Response from 108.162.195.228."
);
check(
  "dns deep link carries resolver and flags",
  await page.evaluate(
    () => location.hash === "#dns-lookup/google.01.lookup.A.example.com"
  )
);

// All Types: one collapsible group per Common Type, empties collapsed.
await page.locator(".tool-dns-lookup .resolver").selectOption("cf");
await page.locator(".tool-dns-lookup .opt-do").uncheck();
const allStart = dnsHits.length;
await page.locator(".tool-dns-lookup .btn-all").click();
await page.waitForSelector(".tool-dns-lookup .statusbar.ok");
check(
  "dns all types queries the 14 common types",
  dnsHits.length - allStart === 14,
  String(dnsHits.length - allStart)
);
check(
  "dns all types renders a group per type",
  (await page.locator(".tool-dns-lookup .group").count()) === 14
);
check(
  "dns all types opens groups with records",
  (await page
    .locator('.tool-dns-lookup .group[data-type="MX"]')
    .evaluate((d) => (d as HTMLDetailsElement).open)) &&
    !(await page
      .locator('.tool-dns-lookup .group[data-type="SRV"]')
      .evaluate((d) => (d as HTMLDetailsElement).open))
);
const dnsAllTypesStatus = await textOf(
  page.locator(".tool-dns-lookup .status-text")
);
check(
  "dns all types summarises",
  dnsAllTypesStatus.startsWith("14 types · 9 records")
);
check(
  "dns all types deep link",
  await page.evaluate(
    () => location.hash === "#dns-lookup/cf.00.all.A.example.com"
  )
);

// Subdomains: both sources queried, union rendered, www. dropped, a row click looks that name up.
await page.locator(".tool-dns-lookup .name").fill("www.example.com");
await page.locator(".tool-dns-lookup .btn-subs").click();
await page.waitForSelector(".tool-dns-lookup .statusbar.ok");
check(
  "dns subdomains asks both sources without www.",
  dnsHits.includes("certspotter example.com") &&
    dnsHits.includes("hackertarget example.com"),
  dnsHits.slice(-3).join(" | ")
);
check(
  "dns subdomains walks cert spotter pages",
  dnsHits.includes("certspotter example.com after")
);
check(
  "dns subdomains unions the sources",
  (await page.locator(".tool-dns-lookup .subs tbody tr").count()) === 8
);
check(
  "dns subdomains lists the searched name first",
  (await page.locator(".tool-dns-lookup .subs .link").first().textContent()) ===
    "example.com"
);
const dnsSubdomainsStatus = await textOf(
  page.locator(".tool-dns-lookup .status-text")
);
check(
  "dns subdomains status per source",
  dnsSubdomainsStatus.includes("8 subdomains · Cert Spotter 5 · HackerTarget 5")
);
await page
  .locator(".tool-dns-lookup .subs .link", { hasText: "blog.example.com" })
  .click();
await page.waitForFunction(
  () => location.hash === "#dns-lookup/cf.00.lookup.A.blog.example.com"
);
check(
  "dns subdomain row click looks the name up",
  dnsHits.at(-1) === "cloudflare-dns.com blog.example.com A",
  dnsHits.at(-1)
);

// Email check: MX, SPF (following includes), DMARC, and a DKIM selector sweep, all from the TXT fixtures.
await page.locator(".tool-dns-lookup .name").fill("example.com");
const emailStart = dnsHits.length;
await page.locator(".tool-dns-lookup .btn-email").click();
await page.waitForFunction(() =>
  document
    .querySelector(".tool-dns-lookup .status-text")
    ?.textContent?.startsWith("SPF")
);
const emailStatus = await textOf(page.locator(".tool-dns-lookup .status-text"));
check(
  "dns email verdicts",
  emailStatus.startsWith("SPF ok · DMARC ok · DKIM ok · BIMI ok"),
  emailStatus
);
check(
  "dns email queries MX, SPF and its include, DMARC, and every selector",
  dnsHits.slice(emailStart).filter((h) => h.endsWith(" TXT")).length ===
    4 + DKIM_SELECTORS.length &&
    dnsHits.includes("cloudflare-dns.com _spf.example.net TXT") &&
    dnsHits.includes("cloudflare-dns.com _dmarc.example.com TXT") &&
    dnsHits.includes("cloudflare-dns.com google._domainkey.example.com TXT"),
  String(dnsHits.length - emailStart)
);
check(
  "dns email renders the five cards",
  (await page.locator(".tool-dns-lookup .card").count()) === 5
);
check(
  "dns email MX lists the exchangers",
  (await page
    .locator('.tool-dns-lookup .card[data-check="mx"] .mx-list li')
    .count()) === 3
);
const spfCardText = await textOf(
  page.locator('.tool-dns-lookup .card[data-check="spf"]')
);
check(
  "dns email SPF counts lookups through the include",
  spfCardText.includes("2 of the 10 allowed DNS lookups")
);
const dmarcCardText = await textOf(
  page.locator('.tool-dns-lookup .card[data-check="dmarc"]')
);
check(
  "dns email DMARC reads the policy",
  dmarcCardText.includes("p=quarantine: failing mail goes to spam")
);
const dkimCardText = await textOf(
  page.locator('.tool-dns-lookup .card[data-check="dkim"]')
);
check(
  "dns email DKIM finds the live key and the revoked one",
  (await page
    .locator('.tool-dns-lookup .card[data-check="dkim"] .dkim-key')
    .count()) === 2 &&
    dkimCardText.includes("2048-bit RSA key") &&
    dkimCardText.includes("this key is revoked")
);
check(
  "dns email BIMI fetches both assets",
  dnsHits.includes("asset /brand/logo.svg") &&
    dnsHits.includes("asset /brand/vmc.pem")
);
const bimiText = await textOf(
  page.locator('.tool-dns-lookup .card[data-check="bimi"]')
);
check(
  "dns email BIMI judges the logo and certificate",
  bimiText.includes("DMARC enforces p=quarantine") &&
    bimiText.includes("SVG Tiny Portable/Secure checks pass") &&
    bimiText.includes("Valid until 2126-08-08")
);
check(
  "dns email BIMI shows the logo",
  await page
    .locator(".tool-dns-lookup .bimi-logo")
    .evaluate(
      (img) =>
        (img as HTMLImageElement).naturalWidth > 0 &&
        !(img as HTMLImageElement).hidden
    )
);
check(
  "dns email deep link",
  await page.evaluate(
    () => location.hash === "#dns-lookup/cf.00.email.A.example.com"
  )
);

// Probing one more selector by hand.
await page.locator(".tool-dns-lookup .dkim-selector").fill("selector1");
await page.locator(".tool-dns-lookup .btn-dkim").click();
await page.waitForFunction(() =>
  document
    .querySelector(".tool-dns-lookup .status-text")
    ?.textContent?.startsWith("No key at selector selector1")
);
const dkimExtraNote = await textOf(
  page.locator(".tool-dns-lookup .dkim-extra .note")
);
check(
  "dns email DKIM probe reports a missing selector",
  dkimExtraNote.includes("selector1._domainkey.example.com")
);
await page.locator(".tool-dns-lookup .dkim-selector").fill("google");
await page.locator(".tool-dns-lookup .dkim-selector").press("Enter");
await page.waitForFunction(() =>
  document
    .querySelector(".tool-dns-lookup .status-text")
    ?.textContent?.startsWith("Key found at selector google")
);
check(
  "dns email DKIM probe renders a found key",
  (await page.locator(".tool-dns-lookup .dkim-extra .dkim-key").count()) === 1
);

// Whois over RDAP: the registry answer for a domain, cross-checked against the zone's NS set, and an IP network.
await page.locator(".tool-dns-lookup .name").fill("example.com");
await page.locator(".tool-dns-lookup .btn-whois").click();
await page.waitForFunction(() =>
  document
    .querySelector(".tool-dns-lookup .status-text")
    ?.textContent?.startsWith("registrar ")
);
const whoisText = await textOf(
  page.locator('.tool-dns-lookup .card[data-check="whois"]')
);
check(
  "dns whois loads the bootstrap and asks the registry",
  dnsHits.includes("rdap data.iana.org/rdap/dns.json") &&
    dnsHits.includes("rdap rdap.verisign.com/com/v1/domain/example.com")
);
check(
  "dns whois shows registrar and abuse contact",
  whoisText.includes("IANA ID 376") &&
    whoisText.includes("abuse@registrar.example")
);
check(
  "dns whois judges expiry, locks, and DNSSEC",
  whoisText.includes("Expires on 2099-08-13") &&
    whoisText.includes("Registrar lock against transfers") &&
    whoisText.includes("delegation is signed (1 DS record at the registry)")
);
check(
  "dns whois compares registry delegation with the zone",
  whoisText.includes("Nameservers at the registry match the zone's NS records")
);
check(
  "dns whois verdict",
  (await page
    .locator('.tool-dns-lookup .card[data-check="whois"] .card-head .verdict')
    .textContent()) === "ok"
);
check(
  "dns whois deep link",
  await page.evaluate(
    () => location.hash === "#dns-lookup/cf.00.whois.A.example.com"
  )
);
const whoisRaw = await textOf(page.locator(".tool-dns-lookup .raw"));
check(
  "dns whois raw pane skips the bootstrap",
  !whoisRaw.includes("data.iana.org")
);

await page.locator(".tool-dns-lookup .name").fill("8.8.8.8");
await page.locator(".tool-dns-lookup .btn-whois").click();
await page.waitForFunction(() =>
  document
    .querySelector(".tool-dns-lookup .status-text")
    ?.textContent?.startsWith("Google LLC")
);
const ipText = await textOf(
  page.locator('.tool-dns-lookup .card[data-check="whois"]')
);
check(
  "dns whois IP goes to the RIR from the ipv4 bootstrap",
  dnsHits.includes("rdap rdap.arin.net/registry/ip/8.8.8.8")
);
check(
  "dns whois IP shows the network and holder",
  ipText.includes("8.8.8.0/24") &&
    ipText.includes("Google LLC") &&
    ipText.includes("network-abuse@google.com")
);

// A TLD without RDAP falls back to raw WHOIS through the proxy.
await page.locator(".tool-dns-lookup .name").fill("google.it");
await page.locator(".tool-dns-lookup .btn-whois").click();
await page.waitForFunction(() =>
  document
    .querySelector(".tool-dns-lookup .status-text")
    ?.textContent?.includes("raw WHOIS via whois.vu")
);
const rawWhois = await textOf(
  page.locator('.tool-dns-lookup .card[data-check="whois"]')
);
check(
  "dns whois falls back to the proxy for a TLD without RDAP",
  dnsHits.includes("whois.vu google.it") &&
    !dnsHits.some((h) => h.includes("/domain/google.it"))
);
check(
  "dns whois fallback shows parsed fields and the registry text",
  rawWhois.includes("MarkMonitor International Limited") &&
    rawWhois.includes("Expires on 2099-04-21") &&
    rawWhois.includes("Nameservers\n  ns1.google.com")
);

// A DNS deep link restores every control and runs the query on load.
await page.goto("about:blank");
await page.goto(`${url}#dns-lookup/google.01.lookup.TXT.example.com`);
await page.waitForSelector(".tool-dns-lookup .statusbar.ok");
check(
  "dns deep link restores controls",
  (await page.locator(".tool-dns-lookup .name").inputValue()) ===
    "example.com" &&
    (await page.locator(".tool-dns-lookup .type").inputValue()) === "TXT" &&
    (await page.locator(".tool-dns-lookup .resolver").inputValue()) ===
      "google" &&
    (await page.locator(".tool-dns-lookup .opt-do").isChecked()) &&
    !(await page.locator(".tool-dns-lookup .opt-cd").isChecked())
);
check(
  "dns deep link runs the lookup",
  dnsHits.at(-1) === "dns.google example.com TXT do" &&
    (await page.locator(".tool-dns-lookup .records tbody tr").count()) === 2,
  dnsHits.at(-1)
);

// Dependency audit: OSV answered from the fixture's hit table, GitHub raw
// files from the fixture lockfiles. What this proves is the wiring from
// lockfile to OSV to cards, the filters, and the two Deep Link forms.
const auditFixture = (name: string) =>
  Bun.file(
    `${import.meta.dir}/src/tools/dependency-audit/fixtures/${name}`
  ).text();
const npmLock = await auditFixture("npm-v3.lock.json");
const uvLock = await auditFixture("uv-v1.lock");
const osvHits: string[] = [];
await page.route(/^https:\/\/api\.osv\.dev\//u, (route) => {
  const u = new URL(route.request().url());
  if (u.pathname === "/v1/querybatch") {
    const queries = JSON.parse(route.request().postData() ?? "{}").queries as {
      package: { name: string; ecosystem: string };
      version: string;
    }[];
    osvHits.push(`querybatch ${queries.length}`);
    const hits = osvFixtures.hits as Record<string, string[]>;
    const results = queries.map((q) => ({
      vulns: (
        hits[`${q.package.ecosystem}:${q.package.name}@${q.version}`] ?? []
      ).map((id) => ({ id })),
    }));
    return route.fulfill({
      body: JSON.stringify({ results }),
      contentType: "application/json",
      headers: cors,
      status: 200,
    });
  }
  const id = decodeURIComponent(
    u.pathname.slice(u.pathname.lastIndexOf("/") + 1)
  );
  osvHits.push(`vulns ${id}`);
  const rec = (osvFixtures.records as Record<string, unknown>)[id];
  return route.fulfill({
    body: JSON.stringify(rec ?? { message: "Bug not found." }),
    contentType: "application/json",
    headers: cors,
    status: rec ? 200 : 404,
  });
});
const rawHits: string[] = [];
await page.route(/^https:\/\/raw\.githubusercontent\.com\//u, (route) => {
  const { pathname } = new URL(route.request().url());
  rawHits.push(pathname);
  const body =
    new Map([
      ["/acme/demo/HEAD/package-lock.json", npmLock],
      ["/acme/demo/HEAD/uv.lock", uvLock],
    ]).get(pathname) ?? null;
  return route.fulfill({
    body: body ?? "404: Not Found",
    contentType: "text/plain",
    headers: cors,
    status: body ? 200 : 404,
  });
});

await page.goto(`${url}#dependency-audit`);
await page.locator(".tool-dependency-audit .src").fill(npmLock);
await page.waitForFunction(
  () =>
    document.querySelector(".tool-dependency-audit .kind-label")
      ?.textContent === "package-lock.json"
);
check("audit sniffs the pasted lockfile kind", true);
await page.locator(".tool-dependency-audit .btn-audit").click();
await page.waitForFunction(() =>
  document
    .querySelector(".tool-dependency-audit .status-text")
    ?.textContent?.startsWith("4 advisories in 3 packages")
);
check(
  "audit asks OSV once for the distinct packages, then each record once",
  osvHits.filter((h) => h.startsWith("querybatch")).join(",") ===
    "querybatch 3" && osvHits.filter((h) => h.startsWith("vulns")).length === 4,
  osvHits.join(" | ")
);
check(
  "audit renders one card per affected package, worst first",
  (await page.locator(".tool-dependency-audit .card").count()) === 3 &&
    (await page
      .locator(".tool-dependency-audit .card .pkg")
      .first()
      .textContent()) === "minimist@1.2.0" &&
    (await page
      .locator(".tool-dependency-audit .card .card-head .sev")
      .first()
      .textContent()) === "critical 9.8"
);
const lodashCardText = await textOf(
  page.locator(".tool-dependency-audit .card", { hasText: "lodash@4.17.20" })
);
const minimistCardText = await textOf(
  page.locator(".tool-dependency-audit .card", { hasText: "minimist@1.2.0" })
);
const minimist125Tags = await page
  .locator(".tool-dependency-audit .card", { hasText: "minimist@1.2.5" })
  .locator(".tag")
  .allTextContents();
check(
  "audit tags direct and dev, names the fix",
  (await page
    .locator('.tool-dependency-audit .card[data-scope="direct"]')
    .count()) === 2 &&
    minimist125Tags.join(",") === "direct,dev" &&
    lodashCardText.includes("Fixed in 4.17.21.") &&
    minimistCardText.includes("Fixed in 1.2.6, affected since 1.0.0.")
);
const auditSkippedList = await textOf(
  page.locator(".tool-dependency-audit .skipped-list")
);
check(
  "audit lists what was not checked, with reasons",
  (await page.locator(".tool-dependency-audit .skipped-list li").count()) ===
    3 && auditSkippedList.includes("git dependency")
);
check(
  "audit deep link holds filters and the compressed input",
  await page.evaluate(() =>
    location.hash.startsWith("#dependency-audit/11111.a.a.lz:")
  )
);

// Filters hide advisories and packages without a new Audit.
const hitsBeforeFilter = osvHits.length;
await page.locator('.tool-dependency-audit .f-sev[value="moderate"]').uncheck();
check(
  "audit severity filter hides moderate advisories",
  (await page
    .locator(".tool-dependency-audit .advisory:not([hidden])")
    .count()) === 3 &&
    (await page
      .locator(".tool-dependency-audit .card:not([hidden])")
      .count()) === 3 &&
    osvHits.length === hitsBeforeFilter
);
await page.locator(".tool-dependency-audit .f-scope").selectOption("d");
check(
  "audit scope filter hides the transitive package",
  (await page.locator(".tool-dependency-audit .card:not([hidden])").count()) ===
    2 &&
    !(await page
      .locator(".tool-dependency-audit .card", { hasText: "minimist@1.2.0" })
      .isVisible())
);
check(
  "audit deep link tracks the filters",
  await page.evaluate(() =>
    location.hash.startsWith("#dependency-audit/11011.d.a.lz:")
  )
);
await page.locator('.tool-dependency-audit .f-sev[value="moderate"]').check();
await page.locator(".tool-dependency-audit .f-scope").selectOption("a");

// A declaration file is refused with a pointer to the lockfile.
await page
  .locator(".tool-dependency-audit .src")
  .fill('{"name": "x", "dependencies": {"lodash": "^4"}}');
await page.waitForFunction(
  () =>
    document.querySelector(".tool-dependency-audit .kind-label")
      ?.textContent === "not a lockfile"
);
await page.locator(".tool-dependency-audit .btn-audit").click();
await page.waitForSelector(".tool-dependency-audit .statusbar.error");
const auditPackageJsonStatus = await textOf(
  page.locator(".tool-dependency-audit .status-text")
);
check(
  "audit refuses package.json by name",
  auditPackageJsonStatus.includes("package.json")
);

// Repository Fetch: the five names tried at the root, the two present audited together.
await page
  .locator(".tool-dependency-audit .repo")
  .fill("https://github.com/acme/demo");
await page.locator(".tool-dependency-audit .btn-fetch").click();
await page.waitForFunction(() =>
  document
    .querySelector(".tool-dependency-audit .status-text")
    ?.textContent?.startsWith("6 advisories in 4 packages")
);
check(
  "audit fetch tries every lockfile name at the repository root",
  rawHits.length === 5 &&
    rawHits.every((p) => p.startsWith("/acme/demo/HEAD/")),
  rawHits.join(" ")
);
const auditChips = await page
  .locator(".tool-dependency-audit .chip")
  .allTextContents();
check(
  "audit fetch normalizes the repo box and shows the files as chips",
  (await page.locator(".tool-dependency-audit .repo").inputValue()) ===
    "acme/demo" &&
    auditChips.join("|").replaceAll("×", "") === "package-lock.json|uv.lock"
);
const lockfileBadges = await page
  .locator(".tool-dependency-audit .lockfile .type-badge")
  .allTextContents();
check(
  "audit groups results by lockfile",
  (await page.locator(".tool-dependency-audit .lockfile").count()) === 2 &&
    lockfileBadges.join(",") === "npm,PyPI" &&
    (await page.locator(".tool-dependency-audit .f-file-wrap").isVisible())
);
const requestsCardText = await textOf(
  page.locator(".tool-dependency-audit .card", { hasText: "requests@2.30.0" })
);
check(
  "audit merges records that alias each other",
  (await page
    .locator(".tool-dependency-audit .card", { hasText: "requests@2.30.0" })
    .locator(".advisory")
    .count()) === 2 && requestsCardText.includes("PYSEC-2023-74")
);
check(
  "audit fetch deep link names the repository",
  await page.evaluate(
    () => location.hash === "#dependency-audit/11111.a.a.gh:acme%2Fdemo"
  )
);
check(
  "audit results title links the repository",
  (await page
    .locator(".tool-dependency-audit .results-title a")
    .getAttribute("href")) === "https://github.com/acme/demo"
);

// A repository Deep Link fetches and audits on load, filters restored.
await page.goto("about:blank");
await page.goto(`${url}#dependency-audit/11111.d.p.gh:acme%2Fdemo`);
await page.waitForFunction(() =>
  document
    .querySelector(".tool-dependency-audit .status-text")
    ?.textContent?.startsWith("6 advisories")
);
check(
  "audit deep link restores the repository and filters",
  (await page.locator(".tool-dependency-audit .repo").inputValue()) ===
    "acme/demo" &&
    (await page.locator(".tool-dependency-audit .f-scope").inputValue()) ===
      "d" &&
    (await page.locator(".tool-dependency-audit .f-group").inputValue()) ===
      "p" &&
    (await page
      .locator(".tool-dependency-audit .card:not([hidden])")
      .count()) === 2
);

// Document to Markdown: real conversions over the real CDN, from file://.
// The fixtures are built here: a text PDF, a scanned one (a JPEG of text
// drawn on a canvas, no text layer), a mixed one, a PNG, a DOCX. What this
// proves is that every engine loads from file:// (data: URL workers), that
// the converter's verdict decides which pages are Scanned, that OCR text is
// spliced in page order with its comment, that a cancelled run leaves a
// clean screen, and that a second visit fetches nothing.
await page.goto("about:blank");
await page.goto(`${url}#doc-to-markdown`);
const shot = await page.evaluate(() => {
  const c = document.createElement("canvas");
  c.width = 1200;
  c.height = 400;
  const ctx = c.getContext("2d");
  if (!ctx) {
    throw new Error("A new canvas has no 2D context");
  }
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
  const fx = f.getContext("2d");
  if (!fx) {
    throw new Error("A new canvas has no 2D context");
  }
  fx.fillStyle = "#fff";
  fx.fillRect(0, 0, f.width, f.height);
  let seed = 7;
  const rnd = () => (seed = (seed * 16_807) % 2_147_483_647) / 2_147_483_647;
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
    for (let i = 0; i <= 40; i += 1) {
      const px = 100 + i * 25;
      const py = 700 - rnd() * 500;
      if (i) {
        fx.lineTo(px, py);
      } else {
        fx.moveTo(px, py);
      }
    }
    fx.stroke();
  }
  // The base64 after the data: URL's one comma.
  const payload = (dataUrl: string) => dataUrl.slice(dataUrl.indexOf(",") + 1);
  return {
    figure: payload(f.toDataURL("image/jpeg", 0.92)),
    h: c.height,
    jpeg: payload(c.toDataURL("image/jpeg", 0.92)),
    png: payload(c.toDataURL("image/png")),
    w: c.width,
  };
});
const scanJpeg = {
  bytes: Uint8Array.from(atob(shot.jpeg), (ch) => ch.codePointAt(0) ?? 0),
  height: shot.h,
  width: shot.w,
};
const figureJpeg = {
  bytes: Uint8Array.from(atob(shot.figure), (ch) => ch.codePointAt(0) ?? 0),
  height: 900,
  width: 1200,
};
const docFixtures: Record<string, Uint8Array> = {
  "bad.txt": new TextEncoder().encode("hello"),
  "figure.pdf": buildPdf([
    {
      text: [
        "Page one has text.",
        "It goes on for a few lines,",
        "enough to look like a page.",
      ],
    },
    { jpeg: scanJpeg },
    { jpeg: figureJpeg },
  ]),
  "mixed.pdf": buildPdf([
    {
      text: [
        "Page one has text.",
        "It goes on for a few lines,",
        "enough to look like a page.",
      ],
    },
    { jpeg: scanJpeg },
    {
      text: [
        "Page three has text too.",
        "Also several lines long,",
        "so the converter trusts it.",
      ],
    },
  ]),
  "note.docx": buildDocx("A heading", [
    "First paragraph.",
    "Second paragraph.",
  ]),
  "photo.png": Uint8Array.from(atob(shot.png), (ch) => ch.codePointAt(0) ?? 0),
  "refused.pdf": buildPdf([
    {
      text: [
        "Page one has text.",
        "It goes on for a few lines,",
        "enough to look like a page.",
      ],
    },
    { jpeg: scanJpeg },
    { jpeg: scanJpeg },
  ]),
  "scan.pdf": buildPdf([{ jpeg: scanJpeg }]),
  "six.pdf": buildPdf(Array.from({ length: 6 }, () => ({ jpeg: scanJpeg }))),
  "text.pdf": buildPdf([
    { text: ["Hello from a text PDF.", "Second line here.", "Third line."] },
  ]),
};
const dropDoc = async (name: string) => {
  await page
    .locator(".tool-doc-to-markdown")
    .first()
    .evaluate(
      (host, [n, s]) => {
        const b = Uint8Array.from(atob(s), (c) => c.codePointAt(0) ?? 0);
        const dt = new DataTransfer();
        dt.items.add(new File([b], n, { type: "application/octet-stream" }));
        host.dispatchEvent(
          new DragEvent("drop", {
            bubbles: true,
            cancelable: true,
            dataTransfer: dt,
          })
        );
      },
      [
        name,
        Buffer.from(present(docFixtures[name], `fixture ${name}`)).toString(
          "base64"
        ),
      ]
    );
};
const docDone = () =>
  page.waitForFunction(
    () =>
      document
        .querySelector(".tool-doc-to-markdown .progress")
        ?.classList.contains("on") === false,
    null,
    { timeout: 180_000 }
  );
const docOutput = () =>
  page.locator(".tool-doc-to-markdown .output").inputValue();
const docMeta = async () =>
  (await page.locator(".tool-doc-to-markdown .meta").textContent()) ?? "";
const docError = () =>
  page
    .locator(".tool-doc-to-markdown .error-box")
    .evaluate((e) => (e.classList.contains("on") ? (e.textContent ?? "") : ""));
const docPhases: string[] = [];
await page.exposeFunction("docPhase", (t: string) => docPhases.push(t));
const watchPhases = () =>
  page.evaluate(() => {
    const el = document.querySelector(".tool-doc-to-markdown .phase");
    if (!el) {
      throw new Error("Doc to Markdown has no phase line");
    }
    new MutationObserver(() =>
      (window as unknown as { docPhase: (t: string) => void }).docPhase(
        el.textContent ?? ""
      )
    ).observe(el, { characterData: true, childList: true, subtree: true });
  });
await watchPhases();

await dropDoc("note.docx");
await docDone();
const docxOutput = await docOutput();
check(
  "docx converts through anydoc",
  (await docOutput()) ===
    "# A heading\n\nFirst paragraph.\n\nSecond paragraph.\n" &&
    (await docMeta()) === "Word",
  docxOutput.replaceAll("\n", "⏎")
);

await dropDoc("text.pdf");
await docDone();
const textPdfOutput = await docOutput();
check(
  "text PDF converts without OCR, page marked",
  textPdfOutput.startsWith("<!-- page 1 -->\n\nHello from a text PDF.") &&
    (await docMeta()) === "PDF · 1 page" &&
    !textPdfOutput.includes("OCR"),
  `${await docMeta()} ${textPdfOutput.slice(0, 60)}`
);

await dropDoc("scan.pdf");
await docDone();
const scannedPdfOutput = await docOutput();
check(
  "scanned PDF goes through OCR and is marked",
  scannedPdfOutput.startsWith("<!-- page 1, OCR -->\n\n") &&
    /quick brown fox/u.test(await docOutput()) &&
    (await docMeta()) === "PDF · 1 page · 1 via OCR (eng)",
  `${await docMeta()} ${scannedPdfOutput.slice(0, 80)}`
);

// A text document with a picture-only page in the middle: the converter
// accepts it, so no page is Scanned, OCR never runs, pdf.js never loads.
docPhases.length = 0;
await dropDoc("mixed.pdf");
await docDone();
const mixedOut = await docOutput();
const mixedOrder = [
  mixedOut.indexOf("<!-- page 1 -->\n\nPage one has text."),
  mixedOut.indexOf("<!-- page 2, no text -->"),
  mixedOut.indexOf("<!-- page 3 -->\n\nPage three has text too."),
];
check(
  "mid picture page in a text PDF: converter's verdict stands, no OCR, every page marked",
  mixedOrder.every((i, k) => i >= 0 && (k === 0 || i > mixedOrder[k - 1])) &&
    !mixedOut.includes("OCR") &&
    (await docMeta()) === "PDF · 3 pages" &&
    !docPhases.some(
      (p) => p.startsWith("Downloading pdf.js") || p.startsWith("Starting OCR")
    ),
  `${mixedOrder.join(",")} ${await docMeta()} | ${docPhases
    .join(" | ")
    .slice(0, 120)}`
);

// One text page then two scans: the converter refuses with pages 2 and 3, which are OCR'd and spliced after page 1.
await dropDoc("refused.pdf");
await docDone();
const refusedOut = await docOutput();
const refusedOrder = [
  refusedOut.indexOf("<!-- page 1 -->\n\nPage one has text."),
  refusedOut.indexOf("<!-- page 2, OCR -->"),
  refusedOut.indexOf("quick brown fox"),
  refusedOut.indexOf("<!-- page 3, OCR -->"),
];
check(
  "refused PDF: text page converted, listed pages OCR'd, spliced in page order",
  refusedOrder.every(
    (i, k) => i >= 0 && (k === 0 || i > refusedOrder[k - 1])
  ) && (await docMeta()) === "PDF · 3 pages · 2 via OCR (eng)",
  `${refusedOrder.join(",")} ${await docMeta()}`
);

// Page markers off: the same PDF, not a comment in sight, and the choice rides in the Deep Link.
await page.locator(".tool-doc-to-markdown .markers-box").uncheck();
await dropDoc("refused.pdf");
await docDone();
const bareOut = await docOutput();
check(
  "page markers off: no comments at all, state in the Deep Link",
  !bareOut.includes("<!--") &&
    bareOut.startsWith("Page one has text.") &&
    /quick brown fox/u.test(bareOut) &&
    (await page.evaluate(() => location.hash)) === "#doc-to-markdown/eng.p0" &&
    (await page.evaluate(() =>
      localStorage.getItem("html-tools:doc-to-markdown:markers")
    )) === "0",
  `${await page.evaluate(() => location.hash)} ${bareOut
    .slice(0, 40)
    .replaceAll("\n", "⏎")}`
);
await page.locator(".tool-doc-to-markdown .markers-box").check();
check(
  "page markers back on clears the flag",
  (await page.evaluate(() => location.hash)) === "#doc-to-markdown"
);

// Same shape, but the third page is a chart: listed by the converter and OCR'd, it yields nothing confident.
await dropDoc("figure.pdf");
await docDone();
const figureOut = await docOutput();
check(
  "a figure page OCR'd comes out as no text, not gibberish",
  /quick brown fox/u.test(figureOut) &&
    figureOut.includes("<!-- page 2, OCR -->") &&
    figureOut.trimEnd().endsWith("<!-- page 3, OCR: no text found -->") &&
    (await docMeta()) === "PDF · 3 pages · 2 via OCR (eng)",
  figureOut.slice(-120).replaceAll("\n", "⏎")
);

await dropDoc("photo.png");
await docDone();
const imageOcrOutput = await docOutput();
check(
  "image goes straight to OCR",
  imageOcrOutput.startsWith("<!-- image, OCR -->") &&
    /quick brown fox/u.test(await docOutput()) &&
    (await docMeta()) === "png · OCR eng",
  await docMeta()
);

await dropDoc("bad.txt");
await docDone();
const unsupportedFileError = await docError();
check(
  "unsupported file refused by name",
  unsupportedFileError.startsWith(".txt is not a supported format") &&
    !(await page
      .locator(".tool-doc-to-markdown .result")
      .evaluate((e) => e.classList.contains("on"))),
  await docError()
);

// Cancel mid-way through a six-page scan: no error, empty state back, and the next run is unaffected.
await dropDoc("six.pdf");
await page.waitForFunction(
  () =>
    (
      document.querySelector(".tool-doc-to-markdown .phase")?.textContent ?? ""
    ).startsWith("OCR page 2"),
  null,
  { timeout: 60_000 }
);
await page.locator(".tool-doc-to-markdown .cancel-btn").click();
await docDone();
check(
  "cancel leaves a clean screen",
  (await docError()) === "" &&
    !(await page
      .locator(".tool-doc-to-markdown .result")
      .evaluate((e) => e.classList.contains("on"))) &&
    (await page
      .locator(".tool-doc-to-markdown .empty-hint")
      .evaluate((e) => getComputedStyle(e).display)) === "block"
);
await dropDoc("scan.pdf");
await docDone();
check(
  "conversion works again after cancel",
  (await docMeta()) === "PDF · 1 page · 1 via OCR (eng)" &&
    /quick brown fox/u.test(await docOutput())
);

// Languages: picked in the picker, carried in the Deep Link and localStorage, model fetched on next OCR.
await page.locator(".tool-doc-to-markdown .langs summary").click();
await page.locator(".tool-doc-to-markdown .lang-filter").fill("germ");
check(
  "language filter narrows the list",
  (await page
    .locator(".tool-doc-to-markdown .lang-list label:not([hidden])")
    .count()) === 2
);
await page.locator(".tool-doc-to-markdown .lang-list input[value=deu]").check();
await page.keyboard.press("Escape");
check(
  "languages picked land in the Deep Link and are remembered",
  (await page.evaluate(() => location.hash)) === "#doc-to-markdown/eng+deu" &&
    (await page.evaluate(() =>
      localStorage.getItem("html-tools:doc-to-markdown:langs")
    )) === "eng+deu" &&
    (await page
      .locator(".tool-doc-to-markdown .langs summary")
      .textContent()) === "OCR: English, German" &&
    !(await page
      .locator(".tool-doc-to-markdown .langs")
      .evaluate((e) => (e as HTMLDetailsElement).open))
);
docPhases.length = 0;
await dropDoc("photo.png");
await docDone();
check(
  "OCR runs with both models, fetching only the new one",
  (await docMeta()) === "png · OCR eng+deu" &&
    /quick brown fox/u.test(await docOutput()) &&
    docPhases.some((p) => p.startsWith("Downloading tesseract deu")) &&
    !docPhases.some((p) => p.startsWith("Downloading tesseract eng")),
  docPhases
    .filter((p) => p.startsWith("Downloading"))
    .map((p) => p.split(" (")[0])
    .filter((v, i, a) => a.indexOf(v) === i)
    .join(", ")
);
await page.evaluate(() => {
  localStorage.removeItem("html-tools:doc-to-markdown:langs");
  localStorage.removeItem("html-tools:doc-to-markdown:markers");
});

// Second visit: every engine comes from IndexedDB, nothing is downloaded.
await page.goto("about:blank");
await page.goto(`${url}#doc-to-markdown/eng+ron.p0`);
await page.waitForFunction(() =>
  (
    document.querySelector(".tool-doc-to-markdown .engines-text")
      ?.textContent ?? ""
  ).startsWith("Engines cached")
);
check(
  "deep link restores the languages and the markers flag",
  (await page.locator(".tool-doc-to-markdown .langs summary").textContent()) ===
    "OCR: English, Romanian" &&
    !(await page.locator(".tool-doc-to-markdown .markers-box").isChecked())
);
await page.locator(".tool-doc-to-markdown .markers-box").check();
await page.evaluate(() => {
  const b = document.querySelector(
    ".tool-doc-to-markdown .lang-list input[value=ron]"
  ) as HTMLInputElement;
  b.checked = false;
  b.dispatchEvent(new Event("change", { bubbles: true }));
});
await watchPhases();
docPhases.length = 0;
await dropDoc("refused.pdf");
await docDone();
check(
  "second visit converts from cached engines with no download",
  (await docMeta()) === "PDF · 3 pages · 2 via OCR (eng)" &&
    !docPhases.some((p) => p.startsWith("Downloading")),
  docPhases.join(" | ").slice(0, 200)
);
const cachedText = await textOf(
  page.locator(".tool-doc-to-markdown .engines-text")
);
const cachedTitle = await attributeOf(
  page.locator(".tool-doc-to-markdown .engines-text"),
  "title"
);
check(
  "engines footer shows the cached total, breakdown by family on hover",
  /^Engines cached: [\d.]+ MB$/u.test(cachedText) &&
    /^anydoc \d/mu.test(cachedTitle) &&
    /^tesseract \d/mu.test(cachedTitle) &&
    !cachedTitle.includes("tesseract eng"),
  `${cachedText} | ${cachedTitle.slice(0, 60)}`
);
await page.locator(".tool-doc-to-markdown .engines-clear").click();
await page.waitForFunction(() =>
  (
    document.querySelector(".tool-doc-to-markdown .engines-text")
      ?.textContent ?? ""
  ).startsWith("No engines cached")
);
check("clear cached engines empties the store", true);
await page.evaluate(() => {
  localStorage.removeItem("html-tools:doc-to-markdown:langs");
  localStorage.removeItem("html-tools:doc-to-markdown:markers");
});

// Whoami: both Traces answered from canned bodies, one per IP literal. What
// this proves is that each protocol is asked on its own, that the four cards
// fill from the traces and nothing else, and that a failed protocol is
// reported as unreachable rather than as a missing address.
const traceBody = (ip: string, loc: string) =>
  `fl=1\nh=1.1.1.1\nip=${
    ip
  }\nts=1.0\nvisit_scheme=https\nuag=Mozilla/5.0 (smoke)\ncolo=MXP\nhttp=http/2\nloc=${
    loc
  }\ntls=TLSv1.3\n`;
let traceMode: "both" | "v4only" | "split" = "both";
const traceHits: string[] = [];
await page.route(
  /^https:\/\/(?:1\.0\.0\.1|\[2606:4700:4700::1001\])\/cdn-cgi\/trace/u,
  (route) => {
    const v6 = route.request().url().includes("[2606");
    traceHits.push(v6 ? "ipv6" : "ipv4");
    if (v6 && traceMode === "v4only") {
      return route.abort("connectionfailed");
    }
    const body = v6
      ? traceBody("2001:db8::1", traceMode === "split" ? "DE" : "IT")
      : traceBody("203.0.113.9", "IT");
    return route.fulfill({
      body,
      contentType: "text/plain",
      headers: cors,
      status: 200,
    });
  }
);
const whoamiValue = (row: string) =>
  textOf(page.locator(`.tool-whoami [data-row="${row}"] .value`));
await page.goto(`${url}#whoami`);
await page.waitForSelector(".tool-whoami .value");
await page.waitForFunction(
  () => !document.querySelector(".tool-whoami .value.pending")
);
check(
  "whoami asks each protocol once on selection",
  traceHits.join(",") === "ipv4,ipv6" || traceHits.join(",") === "ipv6,ipv4",
  traceHits.join(",")
);
check(
  "whoami shows both addresses",
  (await whoamiValue("ipv4")) === "203.0.113.9" &&
    (await whoamiValue("ipv6")) === "2001:db8::1"
);
check(
  "whoami shows the user agent Cloudflare received",
  (await whoamiValue("ua")) === "Mozilla/5.0 (smoke)"
);
check(
  "whoami names the country",
  (await whoamiValue("country")) === "IT · Italy"
);
check(
  "whoami copy all lists the four rows",
  await page.evaluate(() => {
    let out = "";
    navigator.clipboard.writeText = (t: string) => {
      out = t;
      return Promise.resolve();
    };
    (
      document.querySelector(".tool-whoami .btn-copy-all") as HTMLButtonElement
    ).click();
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(
      () =>
        resolve(
          out ===
            "IPv4: 203.0.113.9\nIPv6: 2001:db8::1\nCountry: IT · Italy\nUser agent: Mozilla/5.0 (smoke)"
        ),
      50
    );
    return promise;
  })
);

// IPv6 failing is "not reachable", never "no address"; the shared rows still fill from IPv4.
traceMode = "v4only";
await page.locator(".tool-whoami .btn-refresh").click();
await page.waitForFunction(
  () => !document.querySelector(".tool-whoami .value.pending")
);
const whoamiIpv6Text = await whoamiValue("ipv6");
check(
  "whoami reports an unreachable protocol without claiming no address",
  whoamiIpv6Text.startsWith("Not reachable over IPv6") &&
    (await page
      .locator('.tool-whoami [data-row="ipv6"] .btn-copy')
      .isDisabled()) &&
    (await whoamiValue("ipv4")) === "203.0.113.9" &&
    (await whoamiValue("country")) === "IT · Italy",
  await whoamiValue("ipv6")
);

// The two traces disagreeing on the country shows both, labeled.
traceMode = "split";
await page.locator(".tool-whoami .btn-refresh").click();
await page.waitForFunction(
  () => !document.querySelector(".tool-whoami .value.pending")
);
const whoamiCountryText = await whoamiValue("country");
check(
  "whoami shows both countries when the traces disagree",
  whoamiCountryText.startsWith("IT · Italy via IPv4, DE · Germany via IPv6"),
  await whoamiValue("country")
);

// Speech to Text: real transcriptions over the real CDN, from file://. What
// this proves is that the engine loads in its worker from a data: URL, that
// the language is detected, that audio past one Window is cut and stitched
// with nothing lost or doubled, that an option change transcribes again and
// rides in the Deep Link, that the exports and the player follow the Words,
// that the microphone is transcribed while it records, and that a second
// visit fetches nothing.
const stt = ".tool-speech-to-text ";
const sttProgress = () =>
  page
    .locator(".tool-speech-to-text .progress")
    .first()
    .evaluate((bar) => bar.classList.contains("on"));
const sttDone = () =>
  page.waitForFunction(
    () =>
      document
        .querySelector(".tool-speech-to-text .progress")
        ?.classList.contains("on") === false,
    null,
    { timeout: 180_000 }
  );
const sttText = () =>
  page.evaluate(() =>
    [...document.querySelectorAll(".tool-speech-to-text .cue p")]
      .map((p) => p.textContent)
      .join(" ")
  );
const sttMeta = () => textOf(page.locator(`${stt}.meta`));
const sttError = () =>
  page.evaluate(
    () =>
      document.querySelector(".tool-speech-to-text .error-box.on")
        ?.textContent ?? ""
  );
const dropSpeech = async (name: string) => {
  const b64 = Buffer.from(
    await Bun.file(path.join(speechDir, `${name}.wav`)).arrayBuffer()
  ).toString("base64");
  await page
    .locator(".tool-speech-to-text")
    .first()
    .evaluate(
      (host, [n, s]) => {
        const b = Uint8Array.from(atob(s), (c) => c.codePointAt(0) ?? 0);
        const dt = new DataTransfer();
        dt.items.add(new File([b], n, { type: "audio/wav" }));
        host.dispatchEvent(
          new DragEvent("drop", {
            bubbles: true,
            cancelable: true,
            dataTransfer: dt,
          })
        );
      },
      [`${name}.wav`, b64]
    );
  await page.waitForFunction(() =>
    document
      .querySelector(".tool-speech-to-text .progress")
      ?.classList.contains("on")
  );
};
const sttDownload = async (
  format: string
): Promise<{ name: string; text: string }> => {
  const [dl] = await Promise.all([
    page.waitForEvent("download"),
    page.locator(`${stt}.dl[data-format=${format}]`).click(),
  ]);
  return {
    name: dl.suggestedFilename(),
    text: await new Response(
      (await dl.createReadStream()) as unknown as ReadableStream
    ).text(),
  };
};

await page.goto("about:blank");
await page.goto(`${url}#speech-to-text`);
await page.waitForSelector(`${stt}.empty-hint`);
const sttPhases: string[] = [];
await page.exposeFunction("sttPhase", (t: string) => sttPhases.push(t));
const watchSttPhases = () =>
  page
    .locator(".tool-speech-to-text .phase")
    .first()
    .evaluate((phase) => {
      new MutationObserver(() =>
        (window as unknown as { sttPhase: (t: string) => void }).sttPhase(
          phase.textContent ?? ""
        )
      ).observe(phase, {
        characterData: true,
        childList: true,
        subtree: true,
      });
    });
await watchSttPhases();
await dropSpeech("en");
await sttDone();
const sttEnglishMeta = await sttMeta();
check(
  "speech: English is detected and transcribed",
  /quick brown fox jumps over the lazy dog\./iu.test(await sttText()) &&
    sttEnglishMeta.startsWith("English (detected) · 0:0") &&
    !(await sttError()),
  `${await sttMeta()} | ${await sttText()}${await sttError()}`
);
check(
  "speech: the engine was downloaded on first use",
  sttPhases.some((p) => p.startsWith("Downloading the engine")),
  sttPhases.slice(0, 3).join(" | ")
);
check(
  "speech: one Cue per sentence, timed from the start",
  (await page.locator(`${stt}.cue`).count()) === 2 &&
    (await page.locator(`${stt}.cue .t`).first().textContent()) === "0:00"
);

const srt = await sttDownload("srt");
check(
  "speech: SRT export",
  srt.name === "en.srt" &&
    /^1\n00:00:00,\d{3} --> 00:00:0\d,\d{3}\nThe quick brown fox/u.test(
      srt.text
    ) &&
    srt.text.includes("\n2\n"),
  srt.text.slice(0, 80)
);
const vtt = await sttDownload("vtt");
check(
  "speech: WebVTT export",
  vtt.name === "en.vtt" && vtt.text.startsWith("WEBVTT\n\n00:00:00."),
  vtt.text.slice(0, 40)
);
const jsonDownload = await sttDownload("json");
const json = JSON.parse(jsonDownload.text);
check(
  "speech: JSON export has every Word with its times",
  json.language === "en" &&
    json.words.length >= 15 &&
    json.words.every(
      (w: { start: number; end: number }, i: number, a: { start: number }[]) =>
        w.end >= w.start && (i === 0 || w.start >= a[i - 1].start)
    ),
  JSON.stringify(json).slice(0, 120)
);
const sttCopied = await page.evaluate(() => {
  let out = "";
  navigator.clipboard.writeText = (t: string) => {
    out = t;
    return Promise.resolve();
  };
  (
    document.querySelector(".tool-speech-to-text .copy-btn") as HTMLElement
  ).click();
  const { promise, resolve } = Promise.withResolvers<string>();
  setTimeout(() => resolve(out), 50);
  return promise;
});
check(
  "speech: Copy puts the text on the clipboard",
  sttCopied.startsWith("The quick brown fox") && sttCopied.endsWith("\n"),
  sttCopied.slice(0, 40)
);

// Clicking a Word puts the player at that Word.
const fox = json.words.find((w: { word: string }) => w.word === "fox");
await page.locator(`${stt}.w`, { hasText: /^fox$/u }).click();
await page.waitForFunction(
  (t: number) =>
    Math.abs(
      (
        document.querySelector(
          ".tool-speech-to-text .player"
        ) as HTMLAudioElement
      ).currentTime - t
    ) < 0.05,
  fox.start
);
check("speech: clicking a Word seeks the player to it", true);

await dropSpeech("de");
await sttDone();
const sttGermanMeta = await sttMeta();
check(
  "speech: German is detected and transcribed",
  sttGermanMeta.startsWith("German (detected)") &&
    /Berlin/u.test(await sttText()),
  `${await sttMeta()} | ${await sttText()}`
);

// Over one Window: cut at a sentence end and stitched, the times running on past 30 s.
await dropSpeech("long");
await sttDone();
const sttLong = await sttText();
const longDownload = await sttDownload("json");
const longJson = JSON.parse(longDownload.text);
const longStarts: number[] = longJson.words.map(
  (w: { start: number }) => w.start
);
check(
  "speech: audio past one Window is stitched with nothing lost or doubled",
  sttLong.startsWith("Welcome to the weekly planning meeting.") &&
    sttLong.endsWith("park on the street that day.") &&
    (sttLong.match(/quarterly report/gu) ?? []).length === 1 &&
    (sttLong.match(/public holiday/gu) ?? []).length === 1 &&
    (longStarts.at(-1) ?? 0) > 40 &&
    longStarts.every((s, i) => i === 0 || s >= longStarts[i - 1]),
  `${sttLong.slice(0, 60)} … ${sttLong.slice(-60)}`
);

// An option change transcribes the same audio again, and goes in the Deep Link.
await page.locator(`${stt}.lang-select`).selectOption("en");
await page.waitForFunction(() =>
  document
    .querySelector(".tool-speech-to-text .progress")
    ?.classList.contains("on")
);
await sttDone();
const sttPickedMeta = await sttMeta();
check(
  "speech: picking a language transcribes again in it",
  sttPickedMeta.startsWith("English · 0:4") &&
    (await page.evaluate(() => location.hash)) === "#speech-to-text/en",
  `${await sttMeta()} ${await page.evaluate(() => location.hash)}`
);
await page.locator(`${stt}.keywords`).fill("Kubernetes, Nowak");
await page.locator(`${stt}.keywords`).press("Enter");
await page.waitForFunction(() =>
  document
    .querySelector(".tool-speech-to-text .progress")
    ?.classList.contains("on")
);
await sttDone();
check(
  "speech: keywords go in the Deep Link",
  (await page.evaluate(() => location.hash)) ===
    "#speech-to-text/en.Kubernetes%2C%20Nowak",
  await page.evaluate(() => location.hash)
);

// Cancel mid-way: the words so far stay, with a note saying where it stopped.
// Clicked the moment the first Window lands, since the whole clip takes about two seconds.
await page
  .locator(".tool-speech-to-text .phase")
  .first()
  .evaluate((phase) => {
    const obs = new MutationObserver(() => {
      if (!/Transcribing \(0:[1-9]/u.test(phase.textContent ?? "")) {
        return;
      }
      obs.disconnect();
      (
        document.querySelector(
          ".tool-speech-to-text .cancel-btn"
        ) as HTMLElement
      ).click();
    });
    obs.observe(phase, { characterData: true, childList: true, subtree: true });
  });
await page.locator(`${stt}.lang-select`).selectOption("");
await page.waitForFunction(
  () => document.querySelector(".tool-speech-to-text .note.on"),
  null,
  { timeout: 60_000 }
);
check(
  "speech: cancel keeps the words so far and says where it stopped",
  !(await sttProgress()) &&
    /^Stopped at 0:\d\d of 0:46/u.test(
      await textOf(page.locator(`${stt}.note`))
    ) &&
    (await page.locator(`${stt}.cue`).count()) > 0,
  await textOf(page.locator(`${stt}.note`))
);

// The microphone: Chromium's fake device plays the English clip once.
await page.locator(`${stt}.record-btn`).click();
await page.waitForFunction(
  () =>
    /quick brown fox/iu.test(
      [
        ...document.querySelectorAll(
          ".tool-speech-to-text .cue p, .tool-speech-to-text .pending"
        ),
      ]
        .map((p) => p.textContent)
        .join(" ")
    ),
  null,
  { timeout: 60_000 }
);
check(
  "speech: the microphone is transcribed while it records",
  (await page.locator(`${stt}.record-btn`).textContent()) === "Stop" &&
    /^Recording 0:\d\d$/u.test(await textOf(page.locator(`${stt}.phase`)))
);
// Past the clip's end (5 s), so the speaker has finished when Stop is pressed.
await page.waitForFunction(
  () =>
    /^Recording 0:0[7-9]$/u.test(
      document.querySelector(".tool-speech-to-text .phase")?.textContent ?? ""
    ),
  null,
  { timeout: 30_000 }
);
await page.locator(`${stt}.record-btn`).click();
await sttDone();
const recordedText = await sttText();
const sttRecordingSrt = await sttDownload("srt");
check(
  "speech: stopping finishes the Recording and makes it playable",
  /quick brown fox jumps over the lazy dog\. Please turn off the kitchen lights/iu.test(
    recordedText
  ) &&
    (await page.locator(`${stt}.status`).textContent()) ===
      "Microphone recording" &&
    (await page.evaluate(() =>
      (
        document.querySelector(
          ".tool-speech-to-text .player"
        ) as HTMLAudioElement
      ).src.startsWith("blob:")
    )) &&
    /^recording-\d{4}-\d\d-\d\d-\d{4}\.srt$/u.test(sttRecordingSrt.name),
  recordedText
);

// Second visit: the Deep Link restores the options, and the engine comes from IndexedDB.
await page.goto("about:blank");
await page.goto(`${url}#speech-to-text/de.Berlin`);
await page.waitForFunction(() =>
  (
    document.querySelector(".tool-speech-to-text .engines-text")?.textContent ??
    ""
  ).startsWith("Engines cached")
);
check(
  "speech: a Deep Link restores language and keywords",
  (await page.locator(`${stt}.lang-select`).inputValue()) === "de" &&
    (await page.locator(`${stt}.keywords`).inputValue()) === "Berlin"
);
const hfRequests: string[] = [];
const hfSpy = (r: { url: () => string }) => {
  if (r.url().includes("huggingface.co")) {
    hfRequests.push(r.url());
  }
};
page.on("request", hfSpy);
await dropSpeech("de");
await sttDone();
page.off("request", hfSpy);
const sttCachedMeta = await sttMeta();
check(
  "speech: second visit transcribes from the cached engine with no download",
  hfRequests.length === 0 &&
    /Berlin/u.test(await sttText()) &&
    sttCachedMeta.startsWith("German · "),
  `${hfRequests.join(" ")} ${await sttMeta()}`
);
await page.evaluate(() => {
  localStorage.removeItem("html-tools:speech-to-text:language");
  localStorage.removeItem("html-tools:speech-to-text:keywords");
});

// Big Text: the Message fitted as large as it goes, Slides, the Countdown,
// and Present, from the button and from a Present Link.
const bt = ".tool-big-text ";
// Pairs rather than an object where the order of the parameters is the
// order the link should have.
const btLink = (params: Record<string, string> | string[][]) =>
  `${url}#big-text/${new URLSearchParams(params).toString()}`;
/** Whether the Slide on screen fits its area, and would not at 4% larger. */
const btFit = () =>
  page.evaluate(() => {
    const slide = document.querySelector(
      ".tool-big-text .slide"
    ) as HTMLElement;
    const text = slide.querySelector(".text") as HTMLElement;
    // The tool sets the size as `<n>px`; anything else reads as NaN.
    const { fontSize } = text.style;
    const size = fontSize.endsWith("px")
      ? Number(fontSize.slice(0, -2))
      : Number.NaN;
    const fits = () =>
      text.scrollHeight <= slide.clientHeight &&
      text.scrollWidth <= text.clientWidth;
    text.style.overflow = "hidden";
    const now = fits();
    text.style.fontSize = `${size * 1.04}px`;
    const bigger = fits();
    text.style.fontSize = `${size}px`;
    text.style.overflow = "";
    return { bigger, now, size };
  });
/** The Slide's text as rendered, line breaks included; the first Slide while two cross-fade. */
const btText = async () => {
  const [text] = await page.locator(`${bt}.slide .text`).allInnerTexts();
  return present(text, "a Slide on the Big Text stage").trim();
};

await page.goto(`${url}#big-text`);
await page.waitForSelector(`${bt}.stage`);
check(
  "big text: nothing to show, nothing to present or share",
  (await page.locator(`${bt}.btn-present`).isDisabled()) &&
    (await page.locator(`${bt}.btn-link`).isDisabled())
);
await page
  .locator(`${bt}.o-message`)
  .fill("# Welcome\n**Big** *words* ~~small~~ `x*y*` snake_case");
const btFirst = await btFit();
check(
  "big text: the message is as large as it fits",
  btFirst.now && !btFirst.bigger && btFirst.size > 20,
  JSON.stringify(btFirst)
);
check(
  "big text: markdown subset renders",
  await page.evaluate(() => {
    const t = document.querySelector(".tool-big-text .slide .text");
    if (!t) {
      throw new Error("No Slide on the Big Text stage");
    }
    return (
      t.querySelector(".h1")?.textContent === "Welcome" &&
      t.querySelector("strong")?.textContent === "Big" &&
      t.querySelector("em")?.textContent === "words" &&
      t.querySelector("del")?.textContent === "small" &&
      t.querySelector("code")?.textContent === "x*y*" &&
      (t.textContent ?? "").includes("snake_case")
    );
  })
);
check(
  "big text: state goes in the deep link",
  await page.evaluate(() => location.hash.startsWith("#big-text/m=%23+Welcome"))
);

await page
  .locator(`${bt}.o-message`)
  .fill("Supercalifragilisticexpialidocious");
const btWord = await btFit();
check(
  "big text: a long word shrinks, never splits",
  btWord.now &&
    !btWord.bigger &&
    (await page.evaluate(() => {
      const t = document.querySelector(
        ".tool-big-text .slide .text"
      ) as HTMLElement;
      // The tool sets the size as `<n>px`; anything else reads as NaN.
      const { fontSize } = t.style;
      const size = fontSize.endsWith("px")
        ? Number(fontSize.slice(0, -2))
        : Number.NaN;
      return t.getClientRects().length === 1 && t.offsetHeight < size * 1.5;
    })),
  JSON.stringify(btWord)
);

// Slides rotate on their own, and the preview follows the caret.
await page.goto(btLink({ m: "One || Two || Three", secs: "0.5" }));
await page.waitForFunction(
  () =>
    document.querySelector(".tool-big-text .slide-pos")?.textContent === "2 / 3"
);
check(
  "big text: slides rotate",
  (await page.locator(`${bt}.o-secs`).isVisible()) &&
    (await page.locator(`${bt}.o-trans`).isVisible())
);
await page.goto(btLink({ m: "One || Two || Three", secs: "60" }));
await page.locator(`${bt}.o-message`).click();
await page.keyboard.press("End");
await page.waitForFunction(
  () =>
    document.querySelector(".tool-big-text .slide-pos")?.textContent === "3 / 3"
);
check(
  "big text: the preview shows the slide under the caret",
  (await btText()) === "Three"
);

// Countdown: a Timer waits at full length in the preview and runs once presented.
await page.goto(btLink({ m: "Back in {countdown}", timer: "10m" }));
await page.waitForSelector(`${bt}.cd`);
check(
  "big text: a timer waits at full length",
  (await page.locator(`${bt}.cd`).textContent()) === "10m\u00A00s" &&
    (await page.locator(`${bt}.o-timer`).inputValue()) === "10m"
);
await page.locator(`${bt}.btn-present`).click();
await page.waitForFunction(
  () =>
    document.querySelector(".tool-big-text .cd")?.textContent === "9m\u00A059s",
  null,
  { timeout: 3000 }
);
check("big text: presenting starts the timer", true);
const btCover = await page
  .locator(`${bt}.stage`)
  .first()
  .evaluate((stage) => {
    const r = stage.getBoundingClientRect();
    return (
      r.x === 0 &&
      r.y === 0 &&
      r.width === innerWidth &&
      r.height === innerHeight &&
      location.hash.endsWith("&show=1")
    );
  });
check("big text: present covers the window and is in the link", btCover);
await page.keyboard.press("Escape");
await page.waitForFunction(
  () =>
    document
      .querySelector(".tool-big-text .stage")
      ?.classList.contains("presenting") === false
);
const btHashAfterEscape = await page.evaluate(() => location.hash);
check(
  "big text: escape ends it, and the timer waits again",
  (await page.locator(`${bt}.cd`).textContent()) === "10m\u00A00s" &&
    !btHashAfterEscape.includes("show=1")
);

// At zero: Until in the past swaps the Slides with the Countdown for the end text.
await page.goto(
  btLink([
    ["m", "Sale ends in {countdown} || Visit us"],
    ["until", "2020-01-01T00:00:00Z"],
    ["end", "text"],
    ["endtext", "**Sold out**"],
  ])
);
await page.waitForSelector(`${bt}.slide strong`);
check(
  "big text: at zero the end text takes the countdown's place",
  (await btText()) === "Sold out" &&
    (await page.locator(`${bt}.slide-pos`).textContent()) === "1 / 2"
);
await page.goto(btLink({ m: "Big news", timer: "5m" }));
await page.waitForSelector(`${bt}.slide`);
const btNote = await textOf(page.locator(`${bt}.note`));
check(
  "big text: a message without {countdown} says where it goes",
  btNote.includes("{countdown}")
);

// Copy link: a Present Link, without the Shell's query string.
await page.goto(
  `${url}?sidebar=collapsed#big-text/${new URLSearchParams({
    m: "Hi there",
  }).toString()}`
);
await page.waitForSelector(`${bt}.slide`);
const btCopied = await page.evaluate(() => {
  let out = "";
  navigator.clipboard.writeText = (t: string) => {
    out = t;
    return Promise.resolve();
  };
  (document.querySelector(".tool-big-text .btn-link") as HTMLElement).click();
  const { promise, resolve } = Promise.withResolvers<string>();
  setTimeout(() => resolve(out), 50);
  return promise;
});
check(
  "big text: copy link makes a present link",
  new URL(btCopied).search === "" &&
    new URL(btCopied).hash === "#big-text/m=Hi+there&show=1",
  btCopied
);
check(
  "big text: copy link says so",
  (await page.locator(`${bt}.btn-link`).textContent()) === "Copied"
);

// A Present Link opens straight onto the display; arrows step, and leaving the Tool ends it.
await page.goto(btLink({ m: "A || B", secs: "60", show: "1" }));
await page.waitForSelector(`${bt}.stage.presenting`);
check(
  "big text: a present link opens presenting, with the full screen hint",
  (await btText()) === "A" &&
    (await page.locator(`${bt}.hint`).isVisible()) &&
    (await page
      .locator(`${bt}.stage`)
      .evaluate((s) => getComputedStyle(s).userSelect)) === "none"
);
await page.keyboard.press("ArrowRight");
await page.waitForFunction(
  () =>
    document.querySelector(".tool-big-text .slide-pos")?.textContent === "2 / 2"
);
await page.keyboard.press("/");
check(
  "big text: keys step slides and stay away from the shell",
  !(await page.evaluate(() => document.body.classList.contains("drawer-open")))
);
await page.keyboard.press("f");
await page.waitForFunction(() => !!document.fullscreenElement);
await page.mouse.click(300, 300);
await page.waitForFunction(
  () =>
    document.querySelector(".tool-big-text .slide-pos")?.textContent === "1 / 2"
);
check(
  "big text: F goes full screen, and a click moves to the next slide",
  !!(await page.evaluate(() => document.fullscreenElement))
);
await page.keyboard.press("Escape");
// Firefox clears fullscreenElement before it fires fullscreenchange, so wait for the presentation itself.
await page.waitForFunction(
  () =>
    !document.fullscreenElement &&
    !document.querySelector(".tool-big-text .stage.presenting")
);
const btHashAfterPresentEscape = await page.evaluate(() => location.hash);
check(
  "big text: escape ends it",
  !(await page.locator(`${bt}.stage.presenting`).count()) &&
    !btHashAfterPresentEscape.includes("show=1")
);
await page.goto(btLink({ m: "A", show: "1" }));
await page.waitForSelector(`${bt}.stage.presenting`);
await page.mouse.click(300, 300);
check(
  "big text: with one slide, a click ends it",
  !(await page.locator(`${bt}.stage.presenting`).count())
);
await page.goto(btLink({ m: "A", show: "1" }));
await page.waitForSelector(`${bt}.stage.presenting`);
await page.evaluate(() => {
  location.hash = "uuid-generator";
});
await page.waitForFunction(
  () => !document.querySelector(".tool-big-text .stage.presenting")
);
check("big text: switching tools ends the presentation", true);

// UUID Generator: one version 4 UUID on selection, another on Generate, and
// both Copy and the value itself put it on the clipboard. No State, so the
// Deep Link stays bare.
const uuidValue = () =>
  page.locator(".tool-uuid-generator .value").textContent();
const V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
await page.goto(`${url}#uuid-generator`);
await page.waitForSelector(".tool-uuid-generator .value");
const firstUuid = (await uuidValue()) ?? "";
check(
  "uuid shows a version 4 UUID on selection",
  V4.test(firstUuid),
  firstUuid
);
await page.locator(".tool-uuid-generator .btn-generate").click();
const secondUuid = (await uuidValue()) ?? "";
check(
  "uuid generate makes a different one",
  V4.test(secondUuid) && secondUuid !== firstUuid,
  secondUuid
);
check(
  "uuid deep link carries no state",
  await page.evaluate(() => location.hash === "#uuid-generator")
);
const copiedVia = (selector: string) =>
  page.evaluate((sel: string) => {
    let out = "";
    navigator.clipboard.writeText = (t: string) => {
      out = t;
      return Promise.resolve();
    };
    (document.querySelector(sel) as HTMLElement).click();
    const { promise, resolve } = Promise.withResolvers<string>();
    setTimeout(() => resolve(out), 50);
    return promise;
  }, selector);
check(
  "uuid copy button copies it",
  (await copiedVia(".tool-uuid-generator .btn-copy")) === secondUuid
);
check(
  "uuid copy button says so",
  (await page.locator(".tool-uuid-generator .btn-copy").textContent()) ===
    "Copied"
);
check(
  "uuid clicking the value copies it",
  (await copiedVia(".tool-uuid-generator .value")) === secondUuid
);
check("uuid value says so", (await uuidValue()) === "Copied");
await page.waitForFunction(
  (u: string) =>
    document.querySelector(".tool-uuid-generator .value")?.textContent === u,
  secondUuid
);
check("uuid value comes back after the flash", true);

// Archive Manager: real 7-Zip over the real CDN (this repository's vendored
// build, pinned by commit), from file://. The fixtures are made here with
// the system's zip and tar, so nothing binary is committed. What this proves
// is that the engine loads in its worker from a data: URL, that names with
// wildcards and leading dashes reach 7-Zip as names, that a tarball is
// unwrapped, that passwords are asked for where they are needed and wrong
// ones said to be wrong, that a split archive opens from its volumes, that
// a new archive and a conversion come out right and open again, that Extract
// writes a folder tree without overwriting, and that a second visit fetches
// nothing.
const archiveDir = mkdtempSync(path.join(tmpdir(), "html-tools-archive-"));
const archiveSrc = path.join(archiveDir, "src");
const README = "hello world\n".repeat(200);
const archiveFiles: Record<string, string> = {
  "-dash.txt": "dash",
  "docs/a b.md": "# Title\n",
  "docs/code.js": "const x = 1;\n",
  "docs/we*ird.txt": "star",
  "readme.txt": README,
};
for (const [name, body] of Object.entries(archiveFiles)) {
  await Bun.write(path.join(archiveSrc, name), body);
}
for (const cmd of [
  ["zip", "-qr", "../plain.zip", "."],
  ["zip", "-qr", "-P", "secret", "../locked.zip", "readme.txt"],
  ["tar", "-czf", "../src.tar.gz", "."],
]) {
  const run = Bun.spawnSync(cmd, {
    cwd: archiveSrc,
    // macOS tar adds AppleDouble files otherwise.
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  if (run.exitCode !== 0) {
    throw new Error(`${cmd[0]} failed: ${run.stderr.toString()}`);
  }
}
const am = ".tool-archive-manager ";
const amIdle = () =>
  page.waitForFunction(
    () =>
      !document
        .querySelector(".tool-archive-manager")
        ?.classList.contains("busy"),
    undefined,
    { timeout: 120_000 }
  );
const amOpen = async (files: string[]) => {
  await page.setInputFiles(
    `${am}.open-input`,
    files.map((f) => path.join(archiveDir, f))
  );
  await page.waitForFunction(
    () =>
      document.querySelector(
        ".tool-archive-manager .archive.listed, .tool-archive-manager .archive.is-locked, .tool-archive-manager .error-box.on"
      ),
    undefined,
    { timeout: 120_000 }
  );
  await amIdle();
};
const amRows = async () => {
  const shown = await page
    .locator(`${am}tbody tr .open-node span`)
    .allTextContents();
  return shown.join(" | ");
};
const amText = (sel: string) => textOf(page.locator(`${am}${sel}`));
const amPreview = async (row: string) => {
  await page.locator(`${am}tbody tr[data-path="${row}"] .open-node`).click();
  await page.waitForSelector(`${am}.pv-body pre`, { timeout: 60_000 });
  await amIdle();
  return textOf(page.locator(`${am}.pv-body`));
};
const amVerdict = async () => {
  await page.locator(`${am}.test-btn`).click();
  await page.waitForSelector(`${am}.report.on .verdict`, { timeout: 60_000 });
  return textOf(page.locator(`${am}.report .verdict`));
};

await page.goto("about:blank");
await page.goto(`${url}#archive-manager`);
await page.evaluate(() =>
  localStorage.removeItem("html-tools:archive-manager:options")
);
await amOpen(["plain.zip"]);
check(
  "archive: a zip lists its folders first, then its files",
  (await amRows()) === "docs | -dash.txt | readme.txt",
  await amRows()
);
check(
  "archive: the facts count files and folders",
  /^zip · .* · 5 files · 1 folder · /u.test(
    await textOf(page.locator(`${am}.facts`))
  ),
  await textOf(page.locator(`${am}.facts`))
);
await page.locator(`${am}tbody tr[data-path="docs"] .open-node`).click();
check(
  "archive: a folder opens, with the way back up",
  (await amRows()) === "a b.md | code.js | we*ird.txt" &&
    (await page.locator(`${am}tbody .go-up`).count()) === 1,
  await amRows()
);
check(
  "archive: a name with a wildcard is extracted as itself",
  (await amPreview("docs/we*ird.txt")) === "star"
);
check(
  "archive: code is previewed highlighted",
  (await amPreview("docs/code.js")) === "const x = 1;\n" &&
    (await page.locator(`${am}.pv-body .hljs-keyword`).count()) > 0
);
await page.locator(`${am}.crumbs .crumb`).first().click();
check(
  "archive: a name with a leading dash is extracted as itself",
  (await amPreview("-dash.txt")) === "dash"
);
const zipVerdict = await amVerdict();
check(
  "archive: test passes on an intact zip",
  zipVerdict.startsWith("Everything is OK: 5 files"),
  zipVerdict
);
await page.locator(`${am}.filter`).fill("we*");
check(
  "archive: the filter finds files in any folder, by path",
  (await amRows()) === "docs/we*ird.txt",
  await amRows()
);
await page.locator(`${am}.filter`).fill("");

// Extract all: written as a tree into the picked folder, which a person picks
// in real use; here an in-memory folder stands in for the picker.
await page.evaluate(() => {
  interface Fake {
    kind: "directory" | "file";
    kids: Map<string, Fake>;
    size: number;
  }
  const make = (kind: Fake["kind"]): Fake => ({
    kids: new Map(),
    kind,
    size: 0,
  });
  const child = (
    parent: Fake,
    name: string,
    kind: Fake["kind"],
    create: boolean
  ): Fake => {
    const found = parent.kids.get(name);
    if (found?.kind === kind) {
      return found;
    }
    if (found || !create) {
      throw new DOMException(name, "NotFoundError");
    }
    const made = make(kind);
    parent.kids.set(name, made);
    return made;
  };
  const handle = (node: Fake): object => ({
    createWritable: () => {
      const parts: Blob[] = [];
      return Promise.resolve({
        close: () => {
          node.size = new Blob(parts).size;
          return Promise.resolve();
        },
        write: (b: Blob) => {
          parts.push(b);
          return Promise.resolve();
        },
      });
    },
    getDirectoryHandle: (n: string, o?: { create?: boolean }) =>
      handle(child(node, n, "directory", o?.create === true)),
    getFileHandle: (n: string, o?: { create?: boolean }) =>
      handle(child(node, n, "file", o?.create === true)),
    name: "Downloads",
  });
  const root = make("directory");
  const list = (node: Fake, prefix: string): string[] =>
    [...node.kids].flatMap(([n, k]) =>
      k.kind === "directory"
        ? [`${prefix}${n}/`, ...list(k, `${prefix}${n}/`)]
        : [`${prefix}${n} ${k.size}`]
    );
  Object.assign(window, {
    listPicked: () => list(root, "").toSorted(),
    showDirectoryPicker: () => Promise.resolve(handle(root)),
  });
});
const amExtract = async () => {
  await page.locator(`${am}.extract-btn`).click();
  await page.waitForSelector(`${am}.note.on`, { timeout: 60_000 });
  await amIdle();
  return textOf(page.locator(`${am}.note-text`));
};
const extracted = await amExtract();
const picked = await page.evaluate(() =>
  (window as unknown as { listPicked: () => string[] }).listPicked()
);
check(
  "archive: extract all writes the tree into a new folder",
  extracted.startsWith("Extracted 5 files into Downloads/plain ") &&
    picked.join(", ") ===
      `plain/, plain/-dash.txt 4, plain/docs/, plain/docs/a b.md 8, plain/docs/code.js 13, plain/docs/we*ird.txt 4, plain/readme.txt ${README.length}`,
  `${extracted} | ${picked.join(", ")}`
);
const extractedAgain = await amExtract();
check(
  "archive: a second extract never overwrites the first",
  extractedAgain.includes("Downloads/plain (2) "),
  extractedAgain
);

// Encrypted files: listed without the password, extracted only with it.
await amOpen(["locked.zip"]);
const lockedFacts = await amText(".facts");
check(
  "archive: encrypted files are listed and ask for a password",
  lockedFacts.endsWith("· encrypted") &&
    (await page.locator(`${am}.pw`).isVisible()),
  lockedFacts
);
await page.locator(`${am}tbody tr[data-path="readme.txt"] .open-node`).click();
await page.waitForSelector(`${am}.pv-error`, { timeout: 60_000 });
await amIdle();
const noPassword = await amText(".pv-error");
check(
  "archive: no password says so, in the preview, with nothing else moving",
  noPassword.startsWith("Wrong password") &&
    !(await page.locator(`${am}.error-box`).isVisible()),
  noPassword
);
await page.locator(`${am}.pw`).fill("secret");
check(
  "archive: the password opens the file",
  (await amPreview("readme.txt")) === README
);

// A tarball shows the tar's contents, not the one tar inside the gzip.
await amOpen(["src.tar.gz"]);
const tgzFacts = await amText(".facts");
check(
  "archive: a tar.gz is unwrapped",
  tgzFacts.startsWith("tar in gzip · ") &&
    (await amRows()) === "docs | -dash.txt | readme.txt",
  `${tgzFacts} | ${await amRows()}`
);
const tgzVerdict = await amVerdict();
check(
  "archive: test checks the gzip around the tar",
  tgzVerdict.startsWith("Everything is OK"),
  tgzVerdict
);

// Convert to 7z with a password that hides the names too, then open it again.
await page.locator(`${am}.convert-btn`).click();
await page.locator(`${am}.convert-opts .o-format`).selectOption("7z");
await page.locator(`${am}.convert-opts .o-pw`).fill("pw");
await page.locator(`${am}.convert-go`).click();
await page.waitForSelector(`${am}.made.on`, { timeout: 120_000 });
await amIdle();
const converted = await amText(".made-text");
check(
  "archive: convert makes a 7z",
  converted.startsWith("src.7z "),
  converted
);
const madeBytes = await page.evaluate(async () => {
  let blob: Blob | null = null;
  const real = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (b: Blob | MediaSource) => {
    blob = b instanceof Blob ? b : null;
    return real(b);
  };
  (
    document.querySelector(
      ".tool-archive-manager .made-download"
    ) as HTMLElement
  ).click();
  URL.createObjectURL = real;
  const got = blob as Blob | null;
  return got ? [...new Uint8Array(await got.arrayBuffer())] : [];
});
const made7z = path.join(archiveDir, "src.7z");
await Bun.write(made7z, new Uint8Array(madeBytes));
await amOpen(["src.7z"]);
check(
  "archive: names encrypted by the conversion ask for the password first",
  await page.locator(`${am}.archive.is-locked`).isVisible()
);
await page.locator(`${am}.unlock-pw`).fill("nope");
await page.locator(`${am}.unlock-btn`).click();
await page.waitForFunction(
  () =>
    document
      .querySelector(".tool-archive-manager .locked-text")
      ?.textContent?.startsWith("Wrong password"),
  undefined,
  { timeout: 60_000 }
);
await amIdle();
check("archive: a wrong password is said to be wrong", true);
await page.locator(`${am}.unlock-pw`).fill("pw");
await page.locator(`${am}.unlock-btn`).click();
await page.waitForSelector(`${am}.archive.listed`, { timeout: 60_000 });
await amIdle();
const convertedFacts = await amText(".facts");
check(
  "archive: the converted 7z holds what the tarball held",
  (await amRows()) === "docs | -dash.txt | readme.txt" &&
    convertedFacts.includes("solid · encrypted"),
  convertedFacts
);

// A split archive opens from all its volumes, and says so when one is missing.
const splitBytes = await Bun.file(made7z).bytes();
const third = Math.ceil(splitBytes.length / 3);
for (const n of [0, 1, 2]) {
  await Bun.write(
    path.join(archiveDir, `split.7z.00${n + 1}`),
    splitBytes.slice(n * third, (n + 1) * third)
  );
}
await page.locator(`${am}.clear-btn`).click();
await amOpen(["split.7z.003", "split.7z.001", "split.7z.002"]);
await page.locator(`${am}.unlock-pw`).fill("pw");
await page.locator(`${am}.unlock-btn`).click();
await page.waitForSelector(`${am}.archive.listed`, { timeout: 60_000 });
await amIdle();
check(
  "archive: a split archive opens by its first volume",
  (await textOf(page.locator(`${am}.crumbs-archive`))) === "split.7z.001" &&
    (await amRows()) === "docs | -dash.txt | readme.txt",
  await textOf(page.locator(`${am}.crumbs-archive`))
);
await page.locator(`${am}.clear-btn`).click();
await amOpen(["split.7z.001", "split.7z.002"]);
const missingVolume = await amText(".error-box");
check(
  "archive: a missing volume is named as the likely cause",
  missingVolume.includes("one is missing"),
  missingVolume
);

// New archive: files in, tar.gz out, opened again; the format rides in the Deep Link.
await page.locator(`${am}.clear-btn`).click();
await page.locator(`${am}.new-btn`).click();
await page.setInputFiles(`${am}.add-input`, [
  path.join(archiveSrc, "readme.txt"),
  path.join(archiveSrc, "-dash.txt"),
]);
await page.locator(`${am}.create-opts .o-format`).selectOption("tar.gz");
await page.locator(`${am}.create-opts .o-level`).selectOption("9");
check(
  "archive: the format and level go in the Deep Link",
  await page.evaluate(() => location.hash === "#archive-manager/tar.gz.9")
);
await page.locator(`${am}.create-go`).click();
await page.waitForSelector(`${am}.made.on`, { timeout: 120_000 });
await amIdle();
const madeTgz = await amText(".made-text");
check(
  "archive: a new tar.gz is made",
  madeTgz.startsWith("archive.tar.gz "),
  madeTgz
);
await page.locator(`${am}.made-open`).click();
await page.waitForSelector(`${am}.archive.listed`, { timeout: 60_000 });
await amIdle();
check(
  "archive: the new tar.gz opens to the files put in",
  (await amRows()) === "-dash.txt | readme.txt" &&
    (await amPreview("readme.txt")) === README,
  await amRows()
);

// Second visit: the options come back from the Deep Link, the engine from IndexedDB.
const amRequests: string[] = [];
const amSpy = (r: { url: () => string }) => {
  if (r.url().includes("cdn.jsdelivr.net/gh/overflowy/html-tools")) {
    amRequests.push(r.url());
  }
};
page.on("request", amSpy);
await page.goto("about:blank");
await page.goto(`${url}#archive-manager/zip.0`);
await page.locator(`${am}.new-btn`).click();
check(
  "archive: a Deep Link restores the format and level",
  (await page.locator(`${am}.create-opts .o-format`).inputValue()) === "zip" &&
    (await page.locator(`${am}.create-opts .o-level`).inputValue()) === "0"
);
await amOpen(["plain.zip"]);
page.off("request", amSpy);
check(
  "archive: a second visit loads 7-Zip from the cache",
  amRequests.length === 0 &&
    (await amRows()) === "docs | -dash.txt | readme.txt",
  amRequests.join(", ")
);
await page.evaluate(() =>
  localStorage.removeItem("html-tools:archive-manager:options")
);

// File Hashes: every Digest checked against node:crypto and Bun's CRC32,
// a dropped checksum list judged line by line, an expected hash matched,
// and text hashed as it is typed, its State in the Deep Link.
const fh = ".tool-file-hashes ";
const hashDir = mkdtempSync(path.join(tmpdir(), "html-tools-hashes-"));
const hashBodies: Record<string, Uint8Array> = {
  "a.txt": new TextEncoder().encode("abc"),
  "b.bin": new Uint8Array(5_000_000).map((_, i) => (i * 7919) % 251),
};
for (const [name, body] of Object.entries(hashBodies)) {
  await Bun.write(path.join(hashDir, name), body);
}
const digestOf = (algo: string, body: Uint8Array) =>
  createHash(algo).update(body).digest("hex");
const [aBody, bBody] = [hashBodies["a.txt"], hashBodies["b.bin"]].map((b) =>
  present(b, "a fixture body")
);
await Bun.write(
  path.join(hashDir, "SHA256SUMS"),
  `${digestOf("sha256", aBody)}  a.txt\n${"0".repeat(64)}  b.bin\n${"1".repeat(64)}  gone.txt\n`
);
const fhIdle = () =>
  page.waitForFunction(
    () =>
      !document.querySelector(".tool-file-hashes .progress.on") &&
      !document.querySelector(".tool-file-hashes .digest-row.pending"),
    undefined,
    { timeout: 60_000 }
  );
/** Every card's Digests, `algorithm=digest`, by file. */
const fhDigests = () =>
  page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll(".tool-file-hashes .card")].map((c) => [
        c.querySelector(".card-name")?.textContent ?? "",
        Object.fromEntries(
          [...c.querySelectorAll(".digest-row")].map((r) => [
            r.querySelector(".algo-name")?.textContent ?? "",
            r.querySelector(".digest")?.textContent ?? "",
          ])
        ),
      ])
    )
  );
await page.goto(`${url}#file-hashes`);
await page.evaluate(() =>
  localStorage.removeItem("html-tools:file-hashes:algorithms")
);
await page.reload();
await page.setInputFiles(`${fh}.file-input`, [
  path.join(hashDir, "a.txt"),
  path.join(hashDir, "b.bin"),
]);
await fhIdle();
await page.locator(`${fh}.more-algos summary`).click();
for (const label of ["CRC32", "SHA-512", "SHA3-256", "BLAKE2b"]) {
  await page.locator(`${fh}.algo`, { hasText: label }).first().click();
}
await fhIdle();
const fhGot = await fhDigests();
/** An object's entries in key order, nested one level, so key order cannot matter. */
const fhCanon = (o: Record<string, Record<string, string>>) =>
  JSON.stringify(
    Object.entries(o)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [
        k,
        Object.entries(v).toSorted(([a], [b]) => a.localeCompare(b)),
      ])
  );
const fhWant = (body: Uint8Array) => ({
  BLAKE2b: digestOf("blake2b512", body),
  CRC32: Bun.hash.crc32(body).toString(16).padStart(8, "0"),
  MD5: digestOf("md5", body),
  "SHA-1": digestOf("sha1", body),
  "SHA-256": digestOf("sha256", body),
  "SHA-512": digestOf("sha512", body),
  "SHA3-256": digestOf("sha3-256", body),
});
check(
  "hashes: every Digest agrees with node:crypto",
  fhCanon(fhGot) ===
    fhCanon({ "a.txt": fhWant(aBody), "b.bin": fhWant(bBody) }),
  JSON.stringify(fhGot).slice(0, 300)
);
await page.locator(`${fh}.expected`).fill(
  digestOf("sha1", bBody)
    .toUpperCase()
    .replaceAll(/(?<four>.{4})/gu, "$<four> ")
);
check(
  "hashes: an expected hash matches however it is grouped",
  (await textOf(page.locator(`${fh}.verdict`))) === "Matches b.bin (SHA-1)." &&
    (await page.locator(`${fh}.digest-row.match`).count()) === 1
);
await page.locator(`${fh}.expected`).fill("ab".repeat(48));
await page.locator(`${fh}.verdict .turn-on`).click();
await fhIdle();
const fhAfterTurnOn = await fhDigests();
check(
  "hashes: a hash of another length offers its Algorithm, which hashes the files",
  (await page.locator(`${fh}.algo.on`, { hasText: "SHA-384" }).count()) === 1 &&
    fhAfterTurnOn["a.txt"]?.["SHA-384"] === digestOf("sha384", aBody)
);
await page.locator(`${fh}.expected`).fill("");
await page.setInputFiles(`${fh}.file-input`, path.join(hashDir, "SHA256SUMS"));
// The list is read before anything shows, so there is no pass to wait for.
await page.waitForSelector(`${fh}.check-row`);
await fhIdle();
const fhChecks = await page.evaluate(() =>
  [...document.querySelectorAll(".tool-file-hashes .check-row")].map((r) =>
    [...r.children].map((c) => c.textContent).join(" ")
  )
);
check(
  "hashes: a checksum list is judged line by line",
  fhChecks.join(" ; ") ===
    "a.txt SHA-256 OK ; b.bin SHA-256 Differs ; gone.txt SHA-256 Not dropped" &&
    (await textOf(page.locator(`${fh}.check-list .meta`))) ===
      "1 of 3 OK · 1 differ · 1 not dropped",
  fhChecks.join(" ; ")
);
const fhSaved = await page.evaluate(() => {
  let blob: Blob | null = null;
  const real = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (b: Blob | MediaSource) => {
    blob = b instanceof Blob ? b : null;
    return real(b);
  };
  (
    document.querySelector(".tool-file-hashes .save-all") as HTMLElement
  ).click();
  URL.createObjectURL = real;
  const got = blob as Blob | null;
  return got ? got.text() : "";
});
check(
  "hashes: download writes BSD tags for several Algorithms",
  fhSaved.split("\n")[0] === `CRC32 (a.txt) = ${fhWant(aBody).CRC32}` &&
    fhSaved.includes(`SHA256 (b.bin) = ${digestOf("sha256", bBody)}`),
  fhSaved.split("\n")[0]
);
await page.locator(`${fh}.mode button[data-mode="text"]`).click();
await page.locator(`${fh}.text-input`).fill("hello");
await page.waitForFunction(
  (want: string) =>
    [...document.querySelectorAll(".tool-file-hashes .digest")].some(
      (d) => d.textContent === want
    ),
  digestOf("sha256", new TextEncoder().encode("hello"))
);
check("hashes: text is hashed as it is typed", true);
await page.waitForFunction(() => location.hash.includes("t=hello"));
const fhLink = await page.evaluate(() => location.href);
await page.goto("about:blank");
await page.goto(fhLink);
await page.waitForFunction(
  (want: string) =>
    [...document.querySelectorAll(".tool-file-hashes .digest")].some(
      (d) => d.textContent === want
    ),
  digestOf("md5", new TextEncoder().encode("hello"))
);
check(
  "hashes: the Deep Link restores the text and the Algorithms",
  (await page.locator(`${fh}.text-input`).inputValue()) === "hello" &&
    (await page.locator(`${fh}.algo.on`, { hasText: "BLAKE2b" }).count()) === 1
);
await page.evaluate(() =>
  localStorage.removeItem("html-tools:file-hashes:algorithms")
);

// Dual N-Back: an in-page player watches the board and listens in on Web
// Audio, then answers perfectly, never, or for Arithmetic types the result.
// The tool decodes each recording once, so a letter is known by its buffer;
// some letters' files are the same size. Each decoded buffer is also tagged
// with the byte length of its file, which tells the four operation words
// apart. Sessions are short through the Deep Link: 5 + N² trials of a second
// each, so the player seeds Math.random before each one: a session left to
// chance can draw no matches at all, and that scores 0%.
const dnb = ".tool-dual-n-back ";
const dnbOps: Record<number, string> = {};
for (const op of ["add", "subtract", "multiply", "divide"]) {
  dnbOps[Bun.file(`src/tools/dual-n-back/sounds/operations/${op}.mp3`).size] =
    op;
}
check(
  "dual n-back: the operation recordings differ in size, so the test can tell them apart",
  Object.keys(dnbOps).length === 4
);
type DnbStyle = "perfect" | "silent";
/** Draws a 2-back Session with matches in both Position and Sound. */
const DNB_SEED = 1;
const dnbPlay = (style: DnbStyle) =>
  page
    .locator(".tool-dual-n-back")
    .first()
    .evaluate(
      (host, [how, ops, seed]) => {
        type Tagged = AudioBuffer & { dnbLen?: number };
        const w = window as unknown as {
          dnbHeard: (Tagged | null)[];
          dnbPlayer?: MutationObserver;
          dnbRandom?: () => number;
          dnbTapped?: boolean;
        };
        w.dnbHeard = [];
        w.dnbPlayer?.disconnect();
        // Park-Miller: the Session's trials and letters are drawn from it.
        // Every product stays below 2⁵³, so the doubles are exact.
        const modulus = 2_147_483_647;
        w.dnbRandom ??= Math.random;
        let state = seed;
        Math.random = () => {
          state = (state * 48_271) % modulus;
          return state / modulus;
        };
        if (!w.dnbTapped) {
          w.dnbTapped = true;
          const decode = BaseAudioContext.prototype.decodeAudioData;
          BaseAudioContext.prototype.decodeAudioData = function decodeAudioData(
            this: BaseAudioContext,
            data: ArrayBuffer
          ) {
            const len = data.byteLength;
            return decode.call(this, data).then((buf: Tagged) => {
              buf.dnbLen = len;
              return buf;
            });
          } as typeof decode;
          const { start: nativeStart } = AudioBufferSourceNode.prototype;
          AudioBufferSourceNode.prototype.start = function start(
            this: AudioBufferSourceNode,
            ...args: Parameters<typeof nativeStart>
          ) {
            w.dnbHeard.push(this.buffer);
            return nativeStart.apply(this, args);
          };
        }
        const title = host.querySelector(".stage-title")?.textContent ?? "";
        const level = /(?<n>\d+)-Back/u.exec(title)?.groups?.n;
        if (level === undefined) {
          throw new Error(`No N in the stage title "${title}"`);
        }
        const n = Number(level);
        const arithmetic = host.querySelector(".answer:not([hidden])") !== null;
        const cells: number[] = [];
        const sounds: (Tagged | null)[] = [];
        const numbers: number[] = [];
        let heard = 0;
        const key = (k: string) =>
          document.dispatchEvent(
            new KeyboardEvent("keydown", { bubbles: true, key: k })
          );
        const apply: Record<string, (a: number, b: number) => number> = {
          add: (a, b) => a + b,
          divide: (a, b) => a / b,
          multiply: (a, b) => a * b,
          subtract: (a, b) => a - b,
        };
        // A sound starts a moment after its trial is drawn, once its buffer is in hand; the player answers after both.
        const answer = (cell: number, text: string) => {
          const t = cells.length;
          cells.push(cell);
          const played = w.dnbHeard.slice(heard);
          heard = w.dnbHeard.length;
          if (arithmetic) {
            numbers.push(Number(text));
            if (how === "perfect" && t >= n) {
              const op = apply[ops[played[0]?.dnbLen ?? 0] ?? ""];
              if (!op) {
                throw new Error(`No operation recognised for trial ${t}`);
              }
              for (const c of String(op(numbers[t - n], numbers[t]))) {
                key(c);
              }
            }
            return;
          }
          sounds.push(played[0] ?? null);
          if (how !== "perfect" || t < n) {
            return;
          }
          if (cells[t] === cells[t - n]) {
            key("a");
          }
          if (sounds[t] === sounds[t - n]) {
            key("l");
          }
        };
        w.dnbPlayer = new MutationObserver((records) => {
          const stim = records
            .flatMap((r) => [...r.addedNodes])
            .find(
              (x) => x instanceof HTMLElement && x.classList.contains("stim")
            ) as HTMLElement | undefined;
          if (!stim) {
            return;
          }
          const { parentElement } = stim;
          if (!parentElement) {
            throw new Error("A stimulus outside the board");
          }
          setTimeout(
            answer,
            50,
            Number(parentElement.dataset.cell),
            stim.textContent ?? ""
          );
        });
        const board = host.querySelector(".board");
        if (!board) {
          throw new Error("Dual N-Back has no board");
        }
        w.dnbPlayer.observe(board, {
          childList: true,
          subtree: true,
        });
      },
      [style, dnbOps, DNB_SEED] as [DnbStyle, Record<number, string>, number]
    );
const dnbResult = async () => {
  await page.waitForSelector(`${dnb}.overlay.result`, { timeout: 60_000 });
  await page.evaluate(() => {
    const w = window as unknown as {
      dnbPlayer?: MutationObserver;
      dnbRandom?: () => number;
    };
    w.dnbPlayer?.disconnect();
    if (w.dnbRandom) {
      Math.random = w.dnbRandom;
    }
  });
  return (await page.locator(`${dnb}.overlay`).textContent()) ?? "";
};

await page.goto(`${url}#dual-n-back/trials=5&secs=1`);
await page.waitForSelector(`${dnb}.overlay.idle`);
const dnbStartMeta = await textOf(page.locator(`${dnb}.stage-meta`));
check(
  "dual n-back starts at Dual 2-back with 9 trials",
  (await page.locator(`${dnb}.stage-title`).textContent()) === "Dual 2-Back" &&
    dnbStartMeta.startsWith("9 trials"),
  `${await page.locator(`${dnb}.stage-title`).textContent()} | ${await page
    .locator(`${dnb}.stage-meta`)
    .textContent()}`
);
await dnbPlay("perfect");
await page.keyboard.press("Space");
await page.waitForFunction(() =>
  document.querySelector(".tool-dual-n-back")?.classList.contains("running")
);
check(
  "dual n-back: Space starts, and the setup is out of reach while it runs",
  await page.evaluate(
    () =>
      (document.querySelector(".tool-dual-n-back .setup") as HTMLElement).inert
  )
);
await page.keyboard.press("p");
await page.waitForSelector(`${dnb}.overlay.paused`);
await page.waitForTimeout(1200);
const pausedLeft = await page.locator(`${dnb}.stage-meta`).textContent();
await page.keyboard.press("p");
await page.waitForSelector(`${dnb}.overlay.paused`, { state: "hidden" });
check(
  "dual n-back: P pauses the clock and resumes it",
  pausedLeft === "9 trials" || pausedLeft === "9 left",
  pausedLeft ?? ""
);
const perfect = await dnbResult();
check(
  "dual n-back: a perfect session scores 100% and raises N",
  (await page.locator(`${dnb}.overlay .score`).textContent()) === "100%" &&
    perfect.includes("N-Back raised to 3") &&
    /Position[1-9]\d*–0/u.test(perfect) &&
    /Sound[1-9]\d*–0/u.test(perfect),
  perfect
);
check(
  "dual n-back: the next session is 3-back, and the level shows it",
  (await page.locator(`${dnb}.stage-title`).textContent()) === "Dual 3-Back" &&
    (await page.locator(`${dnb}.level-n`).textContent()) === "3-back"
);
check(
  "dual n-back: today lists the session",
  (await page.locator(`${dnb}.today-list li`).count()) === 1 &&
    (await page.locator(`${dnb}.today-list li.up`).count()) === 1
);
check(
  "dual n-back: the session is kept across a reload",
  await page.evaluate(() => {
    const h = JSON.parse(
      localStorage.getItem("html-tools:dual-n-back:history") ?? "[]"
    );
    return (
      h.length === 1 &&
      h[0].score === 100 &&
      h[0].level.n === 3 &&
      h[0].tallies.position1.misses === 0
    );
  })
);

// Manual: the player's N, never a level change, and a player who never
// presses scores nothing.
await page.goto(`${url}#dual-n-back/manual=1&n=1&trials=5&secs=1`);
await page.waitForFunction(
  () =>
    document.querySelector(".tool-dual-n-back .stage-title")?.textContent ===
    "Dual 1-Back · Manual"
);
await dnbPlay("silent");
await page.locator(`${dnb}.start-btn`).click();
const silent = await dnbResult();
check(
  "dual n-back: a manual session that never answers scores 0% and leaves the level",
  silent.includes("0%") && !silent.includes("N-Back"),
  silent
);
await page.locator(`${dnb}.level-seg button`, { hasText: "Automatic" }).click();
check(
  "dual n-back: back on Automatic, the level is still 3",
  (await page.locator(`${dnb}.level-n`).textContent()) === "3-back" &&
    (await page.evaluate(() => location.hash)) ===
      "#dual-n-back/trials=5&secs=1"
);

// Arithmetic: typed answers, from the number on the board and the spoken operation.
await page.goto(
  `${url}#dual-n-back/mode=m&manual=1&n=1&trials=5&secs=1&ops=asm`
);
await page.waitForFunction(
  () =>
    document.querySelector(".tool-dual-n-back .stage-title")?.textContent ===
    "Arithmetic 1-Back · Manual"
);
await dnbPlay("perfect");
await page.keyboard.press("Space");
const arith = await dnbResult();
check(
  "dual n-back: arithmetic answered right scores 100%",
  arith.includes("100%"),
  arith
);

// Self-paced: a trial waits for Enter; Stop discards the Session.
await page.goto(`${url}#dual-n-back/mode=pa-t&manual=1&n=1&trials=5`);
await page.waitForFunction(
  () =>
    document.querySelector(".tool-dual-n-back .stage-title")?.textContent ===
    "Self-paced Dual 1-Back · Manual"
);
await page.keyboard.press("Space");
await page.waitForSelector(`${dnb}.stim`);
await page.waitForTimeout(3500);
const waited = await page.locator(`${dnb}.stage-meta`).textContent();
await page.keyboard.press("Enter");
await page.waitForFunction(
  () =>
    document.querySelector(".tool-dual-n-back .stage-meta")?.textContent ===
    "5 left"
);
check(
  "dual n-back: self-paced waits for Enter",
  waited === "6 left" && (await page.locator(`${dnb}.stim`).count()) === 1,
  waited ?? ""
);
await page.keyboard.press("Escape");
await page.waitForSelector(`${dnb}.overlay.idle`);
check(
  "dual n-back: Stop discards the session",
  await page.evaluate(
    () =>
      JSON.parse(
        localStorage.getItem("html-tools:dual-n-back:history") ?? "null"
      ).length === 3
  )
);

// The mode toggles settle on a playable Mode and reach the Deep Link.
await page.goto(`${url}#dual-n-back/trials=5&secs=1`);
await page.locator(`${dnb}.chip`, { hasText: "Arithmetic" }).click();
const dnbArithmeticHash = await page.evaluate(() => location.hash);
check(
  "dual n-back: Arithmetic turns Sound off",
  (await page
    .locator(`${dnb}.chip[data-toggle="sound"]`)
    .getAttribute("aria-pressed")) === "false" &&
    dnbArithmeticHash.includes("mode=pm")
);
await page.locator(`${dnb}.multi-seg button`, { hasText: "3" }).click();
const dnbThreeBackHash = await page.evaluate(() => location.hash);
check(
  "dual n-back: three objects turn Arithmetic off and add a button per object",
  dnbThreeBackHash.includes("mode=p-3") &&
    (await page.locator(`${dnb}.resp`).count()) === 3
);

// History: the chart, the table, export, clearing, and importing the export back.
await page.goto(`${url}#dual-n-back/trials=5&secs=1`);
await page.locator(`${dnb}.view-seg button`, { hasText: "History" }).click();
await page.waitForSelector(`${dnb}.chart svg`);
check(
  "dual n-back history: the automatic session is charted, and both Dual sessions are listed",
  (await page.locator(`${dnb}.chart .dot`).count()) === 2 &&
    (await page.locator(`${dnb}.sessions tbody tr`).count()) === 2,
  `${await page.locator(`${dnb}.chart .dot`).count()} dots, ${await page
    .locator(`${dnb}.sessions tbody tr`)
    .count()} rows`
);
const [dnbExport] = await Promise.all([
  page.waitForEvent("download"),
  page.locator(`${dnb}.export-btn`).click(),
]);
const exported = JSON.parse(
  await new Response(
    (await dnbExport.createReadStream()) as unknown as ReadableStream
  ).text()
);
check(
  "dual n-back history: export holds every session",
  exported.format === "html-tools/dual-n-back" &&
    exported.sessions.length === 3,
  dnbExport.suggestedFilename()
);
const exportFile = {
  buffer: Buffer.from(JSON.stringify(exported)),
  mimeType: "application/json",
  name: "export.json",
};
await page.locator(`${dnb}.import-input`).setInputFiles(exportFile);
await page.waitForSelector(`${dnb}.history-note.ok`);
check(
  "dual n-back history: importing what is already here adds nothing",
  (await page.locator(`${dnb}.history-note`).textContent()) ===
    "0 sessions added from export.json, 3 already here.",
  (await page.locator(`${dnb}.history-note`).textContent()) ?? ""
);
await page.locator(`${dnb}.clear-btn`).click();
await page.locator(`${dnb}.confirm-ok`).click();
check(
  "dual n-back history: clearing deletes every session and resets the level",
  (await page.evaluate(() =>
    localStorage.getItem("html-tools:dual-n-back:history")
  )) === "[]" &&
    (await page.locator(`${dnb}.level-n`).textContent()) === "2-back"
);
await page.locator(`${dnb}.import-input`).setInputFiles(exportFile);
await page.waitForFunction(() =>
  document
    .querySelector(".tool-dual-n-back .history-note")
    ?.textContent?.startsWith("3 sessions added")
);
check(
  "dual n-back history: the export brings every session and the level back",
  (await page.locator(`${dnb}.sessions tbody tr`).count()) === 2 &&
    (await page.locator(`${dnb}.level-n`).textContent()) === "3-back"
);
await page.locator(`${dnb}.view-seg button`, { hasText: "Train" }).click();

// Markdown Editor: the welcome Draft on a first visit, Preview with Contents
// open, then edits that reach the preview, the stats, the draft, and the Deep
// Link. Math and diagrams fetch their Engines over the real CDN from file://,
// and a second visit fetches nothing. Contents jumps and follows the scroll;
// the Light Document is a Preference that survives a reload.
await page.goto("about:blank");
await page.goto(`${url}#markdown-editor`);
const mv = ".tool-markdown-editor ";
const mvHost = () => page.locator(mv.trim());
await page.waitForSelector(`${mv}.doc h1`);
check(
  "markdown editor opens in Preview with Contents open",
  (await mvHost().getAttribute("data-view")) === "preview" &&
    (await mvHost().evaluate((el) => el.classList.contains("toc-open"))) &&
    (await page.locator(`${mv}.toc-link`).count()) >= 8 &&
    (await page.locator(`${mv}.doc h1`).textContent()) === "Markdown Editor"
);
check(
  "welcome draft renders a table, a task list, a callout, highlighted code, and a footnote",
  (await page.locator(`${mv}.doc table`).count()) === 1 &&
    (await page.locator(`${mv}.doc li.task input[type=checkbox]`).count()) ===
      2 &&
    (await page
      .locator(`${mv}.doc blockquote.callout-tip .callout-title`)
      .textContent()) === "Tip" &&
    (await page.locator(`${mv}.doc pre code.hljs .hljs-keyword`).count()) >=
      1 &&
    (await page.locator(`${mv}.doc .footnotes li`).count()) === 1
);

// A code block's Copy button puts the block on the clipboard and says so briefly.
await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
await page.locator(`${mv}.doc .code-wrap .copy-btn`).first().click();
await page.waitForFunction(
  () =>
    document.querySelector(".tool-markdown-editor .doc .copy-btn")
      ?.textContent === "Copied"
);
const copiedText = await page.evaluate(() => navigator.clipboard.readText());
check(
  "copy button copies the code block",
  copiedText.startsWith("export function slug"),
  copiedText.slice(0, 40)
);

// Engines: the welcome Draft has math and a diagram, so both load, from the CDN the first time.
await page.waitForFunction(
  () =>
    document.querySelectorAll(".tool-markdown-editor .doc .katex").length >= 2,
  null,
  { timeout: 120_000 }
);
await page.waitForFunction(
  () => document.querySelector(".tool-markdown-editor .doc .mermaid-block svg"),
  null,
  { timeout: 120_000 }
);
check("math and diagrams render once their engines load", true);

// Contents: a click jumps, the entry for the heading at the top is highlighted.
await page.locator(`${mv}.toc-link[data-id='md-callouts']`).click();
await page.waitForFunction(
  () =>
    document.querySelector<HTMLElement>(
      ".tool-markdown-editor .toc-link.active"
    )?.dataset.id === "md-callouts"
);
check(
  "contents jumps to the heading and highlights it",
  (await page.locator(`${mv}.preview-pane`).evaluate((p) => p.scrollTop)) > 100
);

// Edit: the preview, the stats, the draft, and the Deep Link follow the editor.
await page.locator(`${mv}.seg button[data-mode=split]`).click();
await page
  .locator(`${mv}.editor`)
  .fill("# Smoke\n\nSome *text* with `code`.\n\n## Second\n\n- [ ] todo\n");
await page.waitForFunction(
  () =>
    document.querySelector(".tool-markdown-editor .doc h1")?.textContent ===
    "Smoke"
);
await page.waitForFunction(() =>
  JSON.parse(
    localStorage.getItem("html-tools:markdown-editor:draft") ?? "{}"
  ).text?.startsWith("# Smoke")
);
const mvTocLinks = await page.locator(`${mv}.toc-link`).allTextContents();
check(
  "editing updates the preview, contents, stats, and draft",
  mvTocLinks.join("|") === "Smoke|Second" &&
    (await page.locator(`${mv}.stat-words`).textContent()) === "12 words"
);
await page.locator(`${mv}.filename`).fill("notes");
await page.locator(`${mv}.filename`).press("Enter");
check(
  "a renamed file gets its extension back",
  (await page.locator(`${mv}.filename`).inputValue()) === "notes.md"
);
await page.waitForFunction(() =>
  location.hash.startsWith("#markdown-editor/notes.md.")
);
const mvLink = await page.evaluate(() => location.href);

// Light Document: a Preference, remembered, applied to the preview only.
await page.locator(`${mv}.light-btn`).click();
check(
  "light document toggles the preview palette and is remembered",
  (await page
    .locator(`${mv}.preview-pane`)
    .evaluate((p) => p.classList.contains("light"))) &&
    (await page.evaluate(() =>
      localStorage.getItem("html-tools:markdown-editor:light")
    )) === "1"
);

// Second visit through the Deep Link: the document comes back with its name,
// the mode and the light page come back from the Preferences, and the
// engines come back from IndexedDB with nothing downloaded.
const mvRequests: string[] = [];
const mvSpy = (r: { url: () => string }) => {
  if (r.url().startsWith("http")) {
    mvRequests.push(r.url());
  }
};
page.on("request", mvSpy);
await page.goto("about:blank");
await page.goto(mvLink);
await page.waitForFunction(
  () =>
    document.querySelector(".tool-markdown-editor .doc h1")?.textContent ===
    "Smoke"
);
const mvRestoredSource = await page.locator(`${mv}.editor`).inputValue();
check(
  "markdown deep link restores the draft, its name, and the preferences",
  mvRestoredSource.startsWith("# Smoke") &&
    (await page.locator(`${mv}.filename`).inputValue()) === "notes.md" &&
    (await mvHost().getAttribute("data-view")) === "split" &&
    (await page
      .locator(`${mv}.preview-pane`)
      .evaluate((p) => p.classList.contains("light"))),
  [
    mvRestoredSource.slice(0, 12),
    await page.locator(`${mv}.filename`).inputValue(),
    await mvHost().getAttribute("data-view"),
    await page.locator(`${mv}.preview-pane`).getAttribute("class"),
  ].join(" | ")
);
await page
  .locator(`${mv}.editor`)
  .fill("Inline $x^2$ and\n\n```mermaid\nflowchart LR\n  A --> B\n```\n");
await page.waitForFunction(
  () =>
    document.querySelector(".tool-markdown-editor .doc .mermaid-block svg") &&
    document.querySelector(".tool-markdown-editor .doc .katex")
);
page.off("request", mvSpy);
check(
  "second visit renders math and diagrams from cached engines with no download",
  mvRequests.length === 0,
  mvRequests.join(" ").slice(0, 200)
);

// Find and replace: one match stepped to, replaced, the count following.
await page.locator(`${mv}.editor`).fill("alpha beta alpha\n");
await page.locator(`${mv}.editor`).click();
await page.keyboard.press(
  process.platform === "darwin" ? "Meta+f" : "Control+f"
);
await page.locator(`${mv}.find-input`).fill("alpha");
await page.keyboard.press("Enter");
check(
  "find counts matches and keeps focus in the find box",
  (await page.locator(`${mv}.find-count`).textContent()) === "2/2" &&
    (await page
      .locator(`${mv}.find-input`)
      .evaluate((i) => i === document.activeElement))
);
await page.locator(`${mv}.replace-input`).fill("gamma");
await page.locator(`${mv}.find-all`).click();
check(
  "replace all rewrites the draft",
  (await page.locator(`${mv}.editor`).inputValue()) === "gamma beta gamma\n" &&
    (await page.locator(`${mv}.find-count`).textContent()) === "0/0"
);
await page.locator(`${mv}.find-close`).click();

// Mod+E trades Edit for Preview and back; the choice is remembered like the buttons'.
await page.keyboard.press(
  process.platform === "darwin" ? "Meta+e" : "Control+e"
);
check(
  "mod+e switches to preview",
  (await mvHost().getAttribute("data-view")) === "preview"
);
await page.keyboard.press(
  process.platform === "darwin" ? "Meta+e" : "Control+e"
);
check(
  "mod+e switches back to edit with the editor focused",
  (await mvHost().getAttribute("data-view")) === "edit" &&
    (await page
      .locator(`${mv}.editor`)
      .evaluate((t) => t === document.activeElement)) &&
    (await page.evaluate(() =>
      localStorage.getItem("html-tools:markdown-editor:view")
    )) === "edit"
);

// A hidden pane forgets where it was scrolled; the Tool remembers for it.
await page.locator(`${mv}.editor`).fill("line\n".repeat(400));
await page.locator(`${mv}.editor`).evaluate((t) => (t.scrollTop = 900));
await page.keyboard.press(
  process.platform === "darwin" ? "Meta+e" : "Control+e"
);
await page.keyboard.press(
  process.platform === "darwin" ? "Meta+e" : "Control+e"
);
check(
  "the editor keeps its scroll position across preview and back",
  (await page.locator(`${mv}.editor`).evaluate((t) => t.scrollTop)) === 900
);

// Format: the formatter is fetched on first use, the Draft comes back in one style, math untouched.
await page
  .locator(`${mv}.editor`)
  .fill(
    "# Title\nText with *emph* and __strong__.\n* one\n* two\n\n|a|b|\n|-|-|\n|1|2|\n\nMath $x_1 * y$ stays.\n"
  );
await page.locator(`${mv}.format-btn`).click();
await page.waitForFunction(
  () =>
    (
      document.querySelector(
        ".tool-markdown-editor .editor"
      ) as HTMLTextAreaElement
    ).value.startsWith("# Title\n\n"),
  null,
  { timeout: 120_000 }
);
check(
  "format rewrites the draft in one style",
  (await page.locator(`${mv}.editor`).inputValue()) ===
    "# Title\n\nText with _emph_ and **strong**.\n\n- one\n- two\n\n| a   | b   |\n| --- | --- |\n| 1   | 2   |\n\nMath $x_1 * y$ stays.\n",
  JSON.stringify(await page.locator(`${mv}.editor`).inputValue())
);

// New asks first when there is text: the button becomes the confirmation, a second click discards.
const beforeNew = await page.locator(`${mv}.editor`).inputValue();
await page.locator(`${mv}.new-btn`).click();
check(
  "new arms a confirmation and keeps the text",
  (await page.locator(`${mv}.new-btn`).textContent()) === "Discard?" &&
    (await page.locator(`${mv}.editor`).inputValue()) === beforeNew &&
    beforeNew.length > 0
);
await page.locator(`${mv}.editor`).click();
check(
  "clicking elsewhere disarms it",
  (await page.locator(`${mv}.new-btn`).textContent()) === "New"
);
await page.locator(`${mv}.new-btn`).click();
await page.locator(`${mv}.new-btn`).click();
check(
  "a second click starts a new document",
  (await page.locator(`${mv}.editor`).inputValue()) === "" &&
    (await page.locator(`${mv}.filename`).inputValue()) === "untitled.md" &&
    (await page.locator(`${mv}.new-btn`).textContent()) === "New"
);

// Python IDE: every Engine comes from the CDN on this first visit (about
// 50 MB), the Interpreter boots in its worker, and a Run's output reaches
// the Terminal. A second boot must come from the caches alone.
// Workers are counted by name, and the Checker's foreground worker is timed
// from its creation to its first diagnostics, so a restart that should not
// happen, or a boot that has become slow, shows.
await page.addInitScript(() => {
  const log: { name: string; created: number; firstDiagnostics?: number }[] =
    [];
  (globalThis as unknown as { smokeWorkers: typeof log }).smokeWorkers = log;
  const Native = globalThis.Worker;
  globalThis.Worker = class extends Native {
    constructor(script: string | URL, opts?: WorkerOptions) {
      super(script, opts);
      const entry = {
        created: performance.now(),
        name: opts?.name ?? "",
      } as (typeof log)[number];
      log.push(entry);
      this.addEventListener("message", (ev: MessageEvent) => {
        if (
          entry.firstDiagnostics === undefined &&
          ev.data?.method === "textDocument/publishDiagnostics"
        ) {
          entry.firstDiagnostics = performance.now();
        }
      });
    }
  };
});
await page.goto(`${url}#python-ide`);
const ide = ".tool-python-ide ";
const ideReady = () =>
  page.waitForFunction(
    () =>
      document.querySelector(".tool-python-ide .st-interp")?.textContent ===
        "Ready" &&
      (document.querySelector(".tool-python-ide .st-checker") as HTMLElement)
        .dataset.state === "ready",
    null,
    { timeout: 300_000 }
  );
/** The Terminal's rows as rendered, one line per row. */
const ideTerm = async () => {
  const rows = page.locator(`${ide}.xterm-rows`);
  await rows.waitFor({ state: "attached" });
  const [text] = await rows.allInnerTexts();
  return present(text, "the Terminal's rows").trim();
};
await ideReady();
const idePythonStatus = await textOf(page.locator(`${ide}.st-python`));
check(
  "ide: interpreter and checker boot",
  idePythonStatus.startsWith("Python 3.")
);
check(
  "ide: a fresh project opens on main.py",
  (await page.locator(`${ide}.tab.active`).textContent()) === "main.py"
);
await page.locator(`${ide}.run-btn`).click();
await page.waitForFunction(
  () =>
    document.querySelector(".tool-python-ide .st-interp")?.textContent ===
    "Ready",
  null,
  { timeout: 60_000 }
);
await page.waitForFunction(() =>
  document
    .querySelector(".tool-python-ide .xterm-rows")
    ?.textContent?.includes("Hello from Python!")
);
const ideTermAfterRun = await ideTerm();
check(
  "ide: run prints to the terminal, then the REPL returns",
  ideTermAfterRun.endsWith(">>>")
);
await page.evaluate(() => {
  const { monaco } = globalThis as unknown as {
    monaco: {
      editor: {
        getModels: () => {
          uri: { path: string };
          setValue: (v: string) => void;
        }[];
      };
    };
  };
  const main = monaco.editor
    .getModels()
    .find((m) => m.uri.path.endsWith("main.py"));
  if (!main) {
    throw new Error("Monaco has no model for main.py");
  }
  main.setValue("import os\nx: int = 'a'\n");
});
await page.waitForFunction(
  () => {
    const { monaco } = globalThis as unknown as {
      monaco: {
        editor: { getModelMarkers: (f: object) => { owner: string }[] };
      };
    };
    const owners = new Set(
      monaco.editor.getModelMarkers({}).map((m) => m.owner)
    );
    return owners.has("ruff") && owners.has("lsp");
  },
  null,
  { timeout: 30_000 }
);
check("ide: Ruff and Pyright both report on the file", true);
await page.locator(`${ide}.terminal-host`).click();
await page.keyboard.type("6 * 7");
await page.keyboard.press("Enter");
await page.waitForFunction(
  () =>
    document
      .querySelector(".tool-python-ide .xterm-rows")
      ?.textContent?.includes("42"),
  null,
  { timeout: 30_000 }
);
check("ide: the REPL evaluates a line", true);
// A file and a folder cannot share a name: the interpreter's filesystem would refuse the Project at boot.
for (const btn of [".new-file-btn", ".new-folder-btn"]) {
  await page.locator(ide + btn).click();
  await page.locator(`${ide}.prompt-input`).fill("pkg");
  await page.locator(`${ide}.prompt-ok`).click();
  await page.waitForTimeout(300);
}
check(
  "ide: a folder cannot take a file's name",
  (await page.locator(`${ide}.st-message`).textContent()) ===
    'Cannot create pkg/: "pkg" is a file.' &&
    (await page.locator(`${ide}.tree-row.folder`).count()) === 0
);
// Tree operations, and what must follow them: the Deep Link, the Checker, the Interpreter, the folders.
const ideText = (file: string) =>
  page.evaluate((p) => {
    const { monaco } = globalThis as unknown as {
      monaco: {
        editor: {
          getModels: () => { uri: { path: string }; getValue: () => string }[];
        };
      };
    };
    return (
      monaco.editor
        .getModels()
        .find((m) => m.uri.path === `/project/${p}`)
        ?.getValue() ?? null
    );
  }, file);
const ideSetText = (file: string, text: string) =>
  page.evaluate(
    ([p, t]) => {
      const { monaco } = globalThis as unknown as {
        monaco: {
          editor: {
            getModels: () => {
              uri: { path: string };
              setValue: (v: string) => void;
            }[];
          };
        };
      };
      const model = monaco.editor
        .getModels()
        .find((m) => m.uri.path === `/project/${p}`);
      if (!model) {
        throw new Error(`Monaco has no model for ${p}`);
      }
      model.setValue(t);
    },
    [file, text] as const
  );
const ideNew = async (btn: string, name: string) => {
  await page.locator(ide + btn).click();
  await page.locator(`${ide}.prompt-input`).fill(name);
  await page.locator(`${ide}.prompt-ok`).click();
  await page.locator(`${ide}.prompt-dialog`).waitFor({ state: "hidden" });
  await page.locator(`${ide}.tree-row[data-path="${name}"]`).waitFor();
};
const ideMenu = async (file: string, label: string) => {
  await page
    .locator(`${ide}.tree-row[data-path="${file}"]`)
    .click({ button: "right" });
  await page
    .locator(`${ide}.context-menu button`)
    .filter({ hasText: new RegExp(`^${label}$`, "u") })
    .click();
};
/** Answers the IDE's own confirmation dialog with OK; returns the question it asked. */
const ideConfirm = async () => {
  const question = await page.locator(`${ide}.prompt-label`).textContent();
  const inputHidden = await page.locator(`${ide}.prompt-input`).isHidden();
  await page.locator(`${ide}.prompt-ok`).click();
  await page.locator(`${ide}.prompt-dialog`).waitFor({ state: "hidden" });
  return { inputHidden, question };
};
const ideTree = () =>
  page.evaluate(() =>
    [...document.querySelectorAll(".tool-python-ide .tree-row")]
      .map((r) => (r as HTMLElement).dataset.path ?? "")
      .toSorted()
  );
const ideRun = async (file: string, until: string) => {
  await page.locator(`${ide}.tree-row.file[data-path="${file}"]`).click();
  await page.locator(`${ide}.run-btn`).click();
  await page.waitForFunction(
    (s) =>
      document
        .querySelector(".tool-python-ide .xterm-rows")
        ?.textContent?.includes(s),
    until,
    { timeout: 30_000 }
  );
  await page.waitForFunction(
    () =>
      document.querySelector(".tool-python-ide .st-interp")?.textContent ===
      "Ready",
    null,
    { timeout: 60_000 }
  );
};
// A completion accepted replaces the word typed so far: Pyright's items carry no edit of their own.
await page.evaluate(() => {
  const { monaco } = globalThis as unknown as {
    monaco: {
      editor: {
        getModels: () => {
          uri: { path: string };
          setValue: (v: string) => void;
        }[];
        getEditors: () => {
          setModel: (m: unknown) => void;
          setPosition: (p: unknown) => void;
          focus: () => void;
        }[];
      };
    };
  };
  const model = monaco.editor
    .getModels()
    .find((m) => m.uri.path.endsWith("main.py"));
  const [editor] = monaco.editor.getEditors();
  if (!model || !editor) {
    throw new Error("Monaco has no main.py model or no editor");
  }
  model.setValue("");
  editor.setModel(model);
  editor.setPosition({ column: 1, lineNumber: 1 });
  editor.focus();
});
await page.keyboard.type("import collec", { delay: 40 });
await page.waitForSelector(`${ide}.suggest-widget.visible`, {
  timeout: 30_000,
});
await page.waitForFunction(
  () =>
    document.querySelector(
      ".tool-python-ide .suggest-widget .monaco-list-row.focused .label-name"
    )?.textContent === "collections",
  null,
  { timeout: 30_000 }
);
await page.keyboard.press("Tab");
await page.waitForTimeout(300);
check(
  "ide: an accepted completion replaces the word typed",
  (await ideText("main.py")) === "import collections",
  JSON.stringify(await ideText("main.py"))
);
page.on("dialog", (d) => {
  void d.accept();
});
await page.locator(`${ide}.tree-row.file[data-path="main.py"]`).click();
await ideMenu("main.py", "Rename");
await page.locator(`${ide}.prompt-input`).fill("app.py");
await page.locator(`${ide}.prompt-ok`).click();
await page.locator(`${ide}.tree-row[data-path="app.py"]`).waitFor();
check(
  "ide: the Deep Link follows a rename of the active file",
  decodeURIComponent(await page.evaluate(() => location.hash)).endsWith(
    ":app.py"
  ) && (await page.locator(`${ide}.tab.active`).textContent()) === "app.py"
);
await ideNew(".new-file-btn", "My File.py");
await ideSetText("My File.py", 'x: int = "a"\n');
await page.waitForFunction(
  () => {
    const { monaco } = globalThis as unknown as {
      monaco: {
        editor: {
          getModelMarkers: (
            f: object
          ) => { owner: string; resource: { path: string } }[];
        };
      };
    };
    return monaco.editor
      .getModelMarkers({})
      .some(
        (m) => m.owner === "lsp" && m.resource.path === "/project/My File.py"
      );
  },
  null,
  { timeout: 30_000 }
);
check("ide: Pyright reports on a file with a space in its name", true);
await ideNew(".new-file-btn", "lib/util.py");
await ideSetText("lib/util.py", "V = 'folder'\n");
// The Checker's worker needs encoded URIs, but Monaco retains the raw URI in a request
// and uses it again when a result such as document highlights comes back.
await ideSetText("My File.py", "value = 1\nprint(value)\n");
await page.locator(`${ide}.tree-row.file[data-path="My File.py"]`).click();
const ideErrorsBeforeSpaceMove = errors.length;
await page
  .locator(`${ide}.tree-row.folder[data-path="lib"]`)
  .first()
  .evaluate((target) => {
    const dt = new DataTransfer();
    dt.setData("text/x-pyide-path", "My File.py");
    target.dispatchEvent(
      new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: dt,
      })
    );
  });
await page
  .locator(`${ide}.tree-row.file[data-path="lib/My File.py"]`)
  .waitFor();
await page.evaluate(() => {
  const { monaco } = globalThis as unknown as {
    monaco: {
      editor: {
        getEditors: () => {
          setPosition: (p: { lineNumber: number; column: number }) => void;
        }[];
      };
    };
  };
  monaco.editor.getEditors()[0]?.setPosition({ column: 2, lineNumber: 1 });
});
await page.waitForTimeout(1000);
check(
  "ide: moving an open file with a space keeps Checker answers on its model",
  errors.length === ideErrorsBeforeSpaceMove &&
    (await ideText("lib/My File.py")) === "value = 1\nprint(value)\n" &&
    (await page.locator(`${ide}.tab.active`).getAttribute("title")) ===
      "lib/My File.py",
  errors.slice(ideErrorsBeforeSpaceMove).join(" | ")
);
await page
  .locator(`${ide}.tree`)
  .first()
  .evaluate((tree) => {
    const dt = new DataTransfer();
    dt.setData("text/x-pyide-path", "lib/My File.py");
    tree.dispatchEvent(
      new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: dt,
      })
    );
  });
await page.locator(`${ide}.tree-row.file[data-path="My File.py"]`).waitFor();
await ideNew(".new-file-btn", "recreate.py");
await ideSetText("recreate.py", "OLD = True\n");
await ideNew(".new-file-btn", "flip.txt");
await ideSetText("flip.txt", "x".repeat(256 * 1024));
await ideSetText("app.py", "import lib.util\nprint('via', lib.util.V)\n");
await ideRun("app.py", "via folder");
await ideMenu("lib", "Rename");
await page.locator(`${ide}.prompt-input`).fill("lib_old");
await page.locator(`${ide}.prompt-ok`).click();
await ideNew(".new-file-btn", "lib.py");
await ideSetText("lib.py", "V = 'module'\n");
await ideSetText(
  "app.py",
  "import lib, os, time\nos.makedirs('made/deep')\nopen('flip.txt', 'wb').write(bytes([0, 1, 2, 255]))\ntime.sleep(1.5)\nprint('via', lib.V)\n"
);
await page.locator(`${ide}.tree-row.file[data-path="app.py"]`).click();
await page.locator(`${ide}.run-btn`).click();
await page.waitForFunction(
  () =>
    document.querySelector(".tool-python-ide .st-interp")?.textContent ===
    "Running",
  null,
  { timeout: 30_000 }
);
// Two edits: the first is saved while the program still runs, the second is still in its debounce when it ends.
// A file removed from the Interpreter during the Run and recreated in the Tree must not be removed again by the Run's snapshot.
await page.waitForTimeout(150);
await ideSetText("lib.py", "V = 'module'\nTYPED_DURING_RUN = 1\n");
await ideMenu("recreate.py", "Delete");
const ideDeleteAsked = await ideConfirm();
check(
  "ide: Delete asks first, in the IDE's own dialog",
  ideDeleteAsked.question === 'Delete "recreate.py"?' &&
    ideDeleteAsked.inputHidden,
  JSON.stringify(ideDeleteAsked)
);
await page
  .locator(`${ide}.tree-row[data-path="recreate.py"]`)
  .waitFor({ state: "hidden" });
await ideNew(".new-file-btn", "recreate.py");
await ideSetText("recreate.py", "NEW = True\n");
await page.waitForTimeout(800);
await ideSetText("lib.py", "V = 'module'\nTYPED_DURING_RUN = True\n");
await page.waitForFunction(
  () =>
    document
      .querySelector(".tool-python-ide .xterm-rows")
      ?.textContent?.includes("via module"),
  null,
  { timeout: 30_000 }
);
await page.waitForFunction(
  () =>
    document.querySelector(".tool-python-ide .st-interp")?.textContent ===
    "Ready",
  null,
  { timeout: 60_000 }
);
await page.waitForTimeout(400);
check("ide: a renamed package does not shadow a new module of its name", true);
check(
  "ide: an edit typed during a Run stays",
  (await ideText("lib.py")) === "V = 'module'\nTYPED_DURING_RUN = True\n",
  JSON.stringify(await ideText("lib.py"))
);
check(
  "ide: a file deleted and recreated during a Run stays",
  (await ideText("recreate.py")) === "NEW = True\n",
  JSON.stringify(await ideText("recreate.py"))
);
check(
  "ide: a Run can rewrite a just-edited text file as binary",
  (await ideText("flip.txt")) === null &&
    (await page
      .locator(`${ide}.tree-row.file[data-path="flip.txt"]`)
      .count()) === 1,
  JSON.stringify(await ideText("flip.txt"))
);
await page.locator(`${ide}.tree-row.folder[data-path="made"]`).click();
const ideTreeWithFolders = await ideTree();
check(
  "ide: a program's folders reach the Tree",
  ideTreeWithFolders.includes("made/deep"),
  ideTreeWithFolders.join(", ")
);
await ideMenu("lib_old/util.py", "Delete");
await ideConfirm();
await page.waitForFunction(
  () =>
    !document.querySelector(
      '.tool-python-ide .tree-row[data-path="lib_old/util.py"]'
    )
);
const ideTreeAfterDelete = await ideTree();
check(
  "ide: deleting the last file leaves its folder",
  ideTreeAfterDelete.includes("lib_old"),
  ideTreeAfterDelete.join(", ")
);
await ideMenu("lib_old", "Delete");
await ideConfirm();
await page.waitForFunction(
  () =>
    !document.querySelector('.tool-python-ide .tree-row[data-path="lib_old"]')
);
await ideSetText(
  "app.py",
  "import os\nprint('recreated', open('recreate.py').read().strip())\nprint('binary', list(open('flip.txt', 'rb').read()))\nprint('dirs', sorted(d for d, _, _ in os.walk('.')))\n"
);
await ideRun("app.py", "dirs [");
const ideTermRecreated = await ideTerm();
check(
  "ide: the recreated file reaches the Interpreter",
  ideTermRecreated.includes("recreated NEW = True"),
  ideTermRecreated.split("\n").slice(-5).join(" | ")
);
const ideTermBinary = await ideTerm();
check(
  "ide: the binary rewrite reaches the Interpreter",
  ideTermBinary.includes("binary [0, 1, 2, 255]"),
  ideTermBinary.split("\n").slice(-5).join(" | ")
);
const ideTermDirs = await ideTerm();
check(
  "ide: the Interpreter's folders match the Tree",
  ideTermDirs.includes("dirs ['.', './made', './made/deep']"),
  ideTermDirs.split("\n").slice(-5).join(" | ")
);
// An edit made right before a reload is journaled and comes back.
await ideSetText("app.py", "print('edited just before the reload')\n");
await page.reload();
await ideReady();
check(
  "ide: the project comes back after a reload with its last edit",
  (await ideText("app.py")) === "print('edited just before the reload')\n",
  JSON.stringify(await ideText("app.py"))
);
check(
  "ide: the second boot downloaded nothing",
  (await page.locator(`${ide}.st-engine`).textContent()) === ""
);
// The Checker's boot, from its worker's creation to its first diagnostics: about a second here.
type WorkerLog = { name: string; created: number; firstDiagnostics?: number }[];
const checkerWorkers = () =>
  page.evaluate(() =>
    (globalThis as unknown as { smokeWorkers: WorkerLog }).smokeWorkers.filter(
      (w) => w.name === "pyright-foreground"
    )
  );
await page.waitForFunction(
  () =>
    (globalThis as unknown as { smokeWorkers: WorkerLog }).smokeWorkers.some(
      (w) => w.name === "pyright-foreground" && w.firstDiagnostics !== undefined
    ),
  null,
  { timeout: 30_000 }
);
const bootWorkers = await checkerWorkers();
const boot = present(bootWorkers.at(-1), "a foreground Checker worker");
check(
  "ide: the Checker reports within 6 s of its worker's creation",
  (boot.firstDiagnostics ?? Number.NaN) - boot.created < 6000,
  `${(((boot.firstDiagnostics ?? Number.NaN) - boot.created) / 1000).toFixed(2)}s`
);
// A settings save that changes nothing about Pyright leaves the Checker running; one that does restarts it.
const ideSaveSettings = async (change: (dialog: HTMLElement) => void) => {
  await page.locator(`${ide}.settings-btn`).click();
  await page.locator(`${ide}.settings-dialog`).evaluate(change);
  await page.locator(`${ide}.settings-dialog form button.primary`).click();
  await page.locator(`${ide}.settings-dialog`).waitFor({ state: "hidden" });
};
const workersBefore = await checkerWorkers();
const checkersBefore = workersBefore.length;
await ideSaveSettings((d) => {
  (d.querySelector("input[name=lineLength]") as HTMLInputElement).value = "100";
});
await page.waitForTimeout(1500);
const checkersAfterRuffSettings = await checkerWorkers();
check(
  "ide: a Ruff-only settings save does not restart the Checker",
  checkersAfterRuffSettings.length === checkersBefore &&
    (await page.locator(`${ide}.st-checker`).getAttribute("data-state")) ===
      "ready",
  await attributeOf(page.locator(`${ide}.st-checker`), "data-state")
);
await ideSaveSettings((d) => {
  (
    d.querySelector("select[name=typeCheckingMode]") as HTMLSelectElement
  ).value = "basic";
});
await page.waitForFunction(
  (n) =>
    (globalThis as unknown as { smokeWorkers: WorkerLog }).smokeWorkers.filter(
      (w) => w.name === "pyright-foreground"
    ).length ===
    n + 1,
  checkersBefore,
  { timeout: 10_000 }
);
await ideReady();
const checkersAfterPyrightSettings = await checkerWorkers();
check(
  "ide: a Pyright settings change restarts the Checker once",
  checkersAfterPyrightSettings.length === checkersBefore + 1
);
// The Mirror follows what is installed, not the Lock: micropip's freeze lists every Catalog
// package either way, so a Catalog package removed must still leave the Checker's view.
const ideLspMessages = (file: string) =>
  page.evaluate((p) => {
    const { monaco } = globalThis as unknown as {
      monaco: {
        editor: {
          getModelMarkers: (
            f: object
          ) => { owner: string; message: string; resource: { path: string } }[];
        };
      };
    };
    return monaco.editor
      .getModelMarkers({})
      .filter((m) => m.owner === "lsp" && m.resource.path === `/project/${p}`)
      .map((m) => m.message);
  }, file);
await ideSetText("app.py", "import six\nprint(six.__version__)\n");
await page.locator(`${ide}.install-input`).fill("six");
await page.locator(`${ide}.install-btn`).click();
await page.waitForFunction(
  () =>
    document.querySelector(".tool-python-ide .st-interp")?.textContent ===
    "Installing",
  null,
  { timeout: 30_000 }
);
await ideReady();
await page.waitForFunction(
  () =>
    (document.querySelector(".tool-python-ide .st-checker") as HTMLElement)
      .dataset.state === "ready",
  null,
  { timeout: 60_000 }
);
await page.waitForFunction(
  () => {
    const { monaco } = globalThis as unknown as {
      monaco: {
        editor: {
          getModelMarkers: (
            f: object
          ) => { owner: string; message: string; resource: { path: string } }[];
        };
      };
    };
    return !monaco.editor
      .getModelMarkers({})
      .some(
        (m) =>
          m.owner === "lsp" &&
          m.resource.path === "/project/app.py" &&
          m.message.includes("six")
      );
  },
  null,
  { timeout: 30_000 }
);
check("ide: an installed package resolves for the Checker", true);
await page.evaluate(() => {
  for (const row of document.querySelectorAll(".tool-python-ide .pkg-row")) {
    if (row.textContent?.includes("six")) {
      (row.querySelector(".pkg-remove") as HTMLElement).click();
    }
  }
});
await page.waitForFunction(
  () =>
    document.querySelector(".tool-python-ide .st-interp")?.textContent !==
    "Ready",
  null,
  { timeout: 30_000 }
);
await ideReady();
await page.waitForFunction(
  () => {
    const { monaco } = globalThis as unknown as {
      monaco: {
        editor: {
          getModelMarkers: (
            f: object
          ) => { owner: string; message: string; resource: { path: string } }[];
        };
      };
    };
    return monaco.editor
      .getModelMarkers({})
      .some(
        (m) =>
          m.owner === "lsp" &&
          m.resource.path === "/project/app.py" &&
          m.message.includes("six")
      );
  },
  null,
  { timeout: 60_000 }
);
const ideMarkersAfterRemove = await ideLspMessages("app.py");
check(
  "ide: a removed package is missing for the Checker again",
  true,
  ideMarkersAfterRemove.join(" | ")
);

await page.goto(`${url}#markdown-editor`);
await page.waitForSelector(`${mv}.editor`);
// Contents in the Narrow Layout is a drawer, closed on load, opened by the button.
await page.setViewportSize({ height: 800, width: 600 });
await page.locator(`${mv}.seg button[data-mode=preview]`).click();
await page.waitForFunction(() =>
  document
    .querySelector(".tool-markdown-editor")
    ?.classList.contains("toc-drawer")
);
check(
  "narrow: contents becomes a drawer and closes",
  !(await mvHost().evaluate((el) => el.classList.contains("toc-open")))
);
await page.locator(`${mv}.toc-btn`).click();
check(
  "narrow: the contents button opens the drawer",
  await page.locator(`${mv}.toc-backdrop`).isVisible()
);
await page
  .locator(`${mv}.toc-backdrop`)
  .click({ position: { x: 550, y: 400 } });
check(
  "narrow: the backdrop closes the drawer",
  !(await page.locator(`${mv}.toc-backdrop`).isVisible())
);
await page.setViewportSize({ height: 800, width: 1200 });
await page.waitForFunction(() =>
  document
    .querySelector(".tool-markdown-editor")
    ?.classList.contains("toc-open")
);
check("wide again: contents comes back as a column", true);
await page.evaluate(() => {
  for (const k of ["draft", "view", "contents", "light"]) {
    localStorage.removeItem(`html-tools:markdown-editor:${k}`);
  }
});

// PDF Toolkit: MuPDF and qpdf over the real CDN, from file://. The fixtures
// are made here with the same engines: two text PDFs (one with a turned
// page), one encrypted with a password full of commas, one signed with a
// fresh key and one both encrypted and signed, two scans with no text layer
// (one a page full of lines), and an image and a file posing as one. What
// this proves: both engines
// start in a data: URL worker; files merge, and the grid turns, deletes,
// drags, and undoes; previews come out live and Apply makes them the
// Workspace; every download is a PDF that says what it should (checked
// here with MuPDF); redaction removes the text under a box; a password
// prompt takes a wrong password and then the right one; a fresh signature
// checks out, and so does one in an encrypted file; OCR gives a scan
// selectable text; Cancel stops what runs (the engines' start, OCR, every
// time) and the worker started next shows and keeps the same Workspace; a
// live preview that fails leaves nothing to Apply; and a Deep Link restores
// an Operation's options.
const ptk = ".tool-pdf-toolkit ";
const ptkDir = mkdtempSync(path.join(tmpdir(), "html-tools-pdf-"));
const ptkEnv = await testEnv();
const ptkFiles = {
  alpha: path.join(ptkDir, "alpha.pdf"),
  badImage: path.join(ptkDir, "bad.png"),
  beta: path.join(ptkDir, "beta.pdf"),
  locked: path.join(ptkDir, "locked.pdf"),
  logo: path.join(ptkDir, "logo.png"),
  pictures: path.join(ptkDir, "pictures.pdf"),
  scan: path.join(ptkDir, "scan.pdf"),
  scanDense: path.join(ptkDir, "scan-dense.pdf"),
  secret: path.join(ptkDir, "secret.pdf"),
  signed: path.join(ptkDir, "signed.pdf"),
  signedLocked: path.join(ptkDir, "signed-locked.pdf"),
};
await Bun.write(ptkFiles.alpha, makePdf(3, { label: "Alpha" }));
await Bun.write(ptkFiles.beta, makePdf(2, { label: "Beta", rotate: 90 }));
const PTK_PASSWORD = "open, sesame = yes";
await Bun.write(
  ptkFiles.locked,
  protect(ptkEnv, makePdf(1, { label: "Locked" }), {
    accessibility: true,
    annotate: true,
    assemble: true,
    bits: 256,
    copy: true,
    forms: true,
    modify: true,
    ownerPassword: "",
    print: "full",
    userPassword: PTK_PASSWORD,
  })
);
await Bun.write(
  ptkFiles.signed,
  await signPdf(
    makePdf(1, { label: "Signed" }),
    await makeSigner("Smoke Signer")
  )
);
await Bun.write(
  ptkFiles.signedLocked,
  await signPdf(
    protect(ptkEnv, makePdf(1, { label: "Signed and locked" }), {
      accessibility: true,
      annotate: true,
      assemble: true,
      bits: 256,
      copy: true,
      forms: true,
      modify: true,
      ownerPassword: "",
      print: "full",
      userPassword: PTK_PASSWORD,
    }),
    await makeSigner("Locked Signer"),
    PTK_PASSWORD
  )
);
{
  const pix = new ptkEnv.mupdf.Pixmap(
    ptkEnv.mupdf.ColorSpace.DeviceRGB,
    [0, 0, 40, 20],
    false
  );
  pix.clear(128);
  await Bun.write(ptkFiles.logo, pix.asPNG());
  await Bun.write(ptkFiles.badImage, "not an image at all");
  const light = new ptkEnv.mupdf.Pixmap(
    ptkEnv.mupdf.ColorSpace.DeviceRGB,
    [0, 0, 60, 40],
    false
  );
  light.clear(220);
  await Bun.write(
    ptkFiles.pictures,
    imagesToPdf(ptkEnv, [pix.asPNG(), light.asPNG()], {
      fit: "contain",
      margin: 0,
      orientation: "auto",
      page: "image",
    })
  );
}
{
  // A word on the page, in the title, and in a note stuck over it.
  const doc = openTest(makePdf(1, { label: "Codename" }));
  doc.setMetaData("info:Title", "Codename plans");
  const note = doc.loadPage(0).createAnnotation("Text");
  note.setRect([80, 50, 100, 70]);
  note.setContents("Codename, as discussed");
  note.update();
  await Bun.write(
    ptkFiles.secret,
    new Uint8Array(doc.saveToBuffer("").asUint8Array())
  );
}
/** A scan: a page of text rendered to a JPEG, made into a page with no text layer. */
const ptkScan = (pdf: Uint8Array) => {
  const pix = openTest(pdf)
    .loadPage(0)
    .toPixmap(
      [3, 0, 0, 3, 0, 0],
      ptkEnv.mupdf.ColorSpace.DeviceRGB,
      false,
      true
    );
  pix.setResolution(216, 216);
  return imagesToPdf(ptkEnv, [new Uint8Array(pix.asJPEG(90, false))], {
    fit: "contain",
    margin: 0,
    orientation: "auto",
    page: "image",
  });
};
await Bun.write(
  ptkFiles.scan,
  ptkScan(makePdf(1, { label: "The quick brown fox" }))
);
{
  // A page full of lines: Tesseract takes a while over it, long enough to cancel.
  const doc = new ptkEnv.mupdf.PDFDocument();
  const resources = doc.newDictionary();
  const fonts = doc.newDictionary();
  fonts.put("F1", doc.addSimpleFont(new ptkEnv.mupdf.Font("Helvetica")));
  resources.put("Font", fonts);
  const lines = Array.from(
    { length: 50 },
    (_, i) =>
      `BT /F1 11 Tf 40 ${800 - i * 15} Td (Line ${i + 1}: the quick brown fox jumps over the lazy dog, again and again.) Tj ET`
  );
  doc.insertPage(
    -1,
    doc.addPage([0, 0, 595, 842], 0, resources, lines.join("\n"))
  );
  await Bun.write(
    ptkFiles.scanDense,
    ptkScan(new Uint8Array(doc.saveToBuffer("compress").asUint8Array()))
  );
}

const ptkIdle = () =>
  page.waitForFunction(
    () => !document.querySelector(".tool-pdf-toolkit .progress.on"),
    undefined,
    { timeout: 180_000 }
  );
const ptkStatus = () => textOf(page.locator(`${ptk}.status`));
const ptkFoot = () => textOf(page.locator(`${ptk}.foot-status`));
const ptkPanel = async (id: string) => {
  await page.selectOption(`${ptk}.panel-select`, id);
  await ptkIdle();
};
/** A live preview settled: the Result on screen and the foot no longer updating. */
const ptkPreview = () =>
  page.waitForFunction(
    () => {
      const root = document.querySelector(".tool-pdf-toolkit");
      const foot =
        root?.querySelector(".foot-status")?.textContent ?? "Updating";
      return (
        root?.classList.contains("showing-result") &&
        !foot.startsWith("Updating") &&
        !foot.startsWith("Working")
      );
    },
    undefined,
    { timeout: 60_000 }
  );
/**
 * Make a change, then wait for the live preview it starts to settle. The
 * foot says "Updating" for as long as the preview takes, which can be less
 * than a frame: an observer set up beforehand sees it however briefly.
 */
const ptkRepreview = async (change: () => Promise<void>) => {
  await page.evaluate(() => {
    const flag = window as unknown as { ptkUpdating?: boolean };
    const foot = document.querySelector(".tool-pdf-toolkit .panel-foot");
    flag.ptkUpdating = false;
    const observer = new MutationObserver(() => {
      const text = foot?.querySelector(".foot-status")?.textContent ?? "";
      if (text.startsWith("Updating")) {
        flag.ptkUpdating = true;
        observer.disconnect();
      }
    });
    if (foot) {
      observer.observe(foot, {
        characterData: true,
        childList: true,
        subtree: true,
      });
    }
  });
  await change();
  await page.waitForFunction(
    () => (window as unknown as { ptkUpdating?: boolean }).ptkUpdating === true
  );
  await ptkPreview();
};
const ptkDownload = async (click: () => Promise<void>) => {
  const [d] = await Promise.all([page.waitForEvent("download"), click()]);
  const file = await d.path();
  return {
    bytes: new Uint8Array(await Bun.file(file).arrayBuffer()),
    name: d.suggestedFilename(),
  };
};
const ptkThumbs = () =>
  page.evaluate(() =>
    [
      ...document.querySelectorAll<HTMLCanvasElement>(
        ".tool-pdf-toolkit .thumb canvas"
      ),
    ].map((c) => (c.width > c.height ? "wide" : "tall"))
  );
/** Every thumbnail as drawn, once all are drawn and none has changed for a moment. */
const ptkThumbImages = async () => {
  const grab = () =>
    page.evaluate(() =>
      [
        ...document.querySelectorAll<HTMLCanvasElement>(
          ".tool-pdf-toolkit .thumb canvas"
        ),
      ].map((c) =>
        // A canvas not drawn yet is the default 300 by 150.
        c.width === 300 && c.height === 150 ? "" : c.toDataURL()
      )
    );
  let last = await grab();
  for (let tries = 0; tries < 60; tries += 1) {
    await page.waitForTimeout(500);
    const now = await grab();
    if (!now.includes("") && JSON.stringify(now) === JSON.stringify(last)) {
      return now;
    }
    last = now;
  }
  return last;
};
/** Press Cancel, shown or not: the worker is thrown away. */
const ptkCancel = () =>
  page
    .locator(`${ptk}.cancel-btn`)
    .evaluate((b) => (b as HTMLButtonElement).click());
/** Where points of a page in the Pages view are on screen, its top scrolled into view. */
const ptkOnScreen = async (pageIndex: number) => {
  const overlay = page.locator(`${ptk}.page .overlay`).nth(pageIndex);
  // Its top in view, where the points used are.
  await overlay.evaluate((svg) => svg.scrollIntoView({ block: "start" }));
  const box = await overlay.boundingBox();
  const size = await overlay.evaluate((svg) =>
    svg.getAttribute("viewBox")?.split(" ").map(Number)
  );
  if (!box || !size) {
    throw new Error("The page has no overlay to draw on");
  }
  return ([x, y]: [number, number]) => [
    box.x + (x / (size[2] ?? 1)) * box.width,
    box.y + (y / (size[3] ?? 1)) * box.height,
  ];
};
/** Drag across a page in the Pages view, from and to points given in page points. */
const ptkDrag = async (
  pageIndex: number,
  from: [number, number],
  to: [number, number]
) => {
  const at = await ptkOnScreen(pageIndex);
  const [x0 = 0, y0 = 0] = at(from);
  const [x1 = 0, y1 = 0] = at(to);
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 4 });
  await page.mouse.move(x1, y1, { steps: 4 });
  await page.mouse.up();
};

await page.goto("about:blank");
await page.goto(`${url}#pdf-toolkit`);
// Cancel while the engines download: that file never opens, though the
// download goes on to be cached for the next start.
await page.setInputFiles(`${ptk}.open-input`, [ptkFiles.beta]);
await page.waitForFunction(() =>
  (
    document.querySelector(".tool-pdf-toolkit .phase")?.textContent ?? ""
  ).startsWith("Downloading")
);
await ptkCancel();
await page.setInputFiles(`${ptk}.open-input`, [ptkFiles.alpha, ptkFiles.beta]);
await page.waitForSelector(`${ptk}.workspace.on`, { timeout: 180_000 });
await ptkIdle();
// Long enough for an open Cancel missed to land after this one.
await page.waitForTimeout(1000);
check(
  "pdf: Cancel during the engines' download opens nothing",
  await page.locator(`${ptk}.toolbar button[aria-label=Undo]`).isDisabled()
);
check(
  "pdf: two files open as one Workspace of five pages",
  (await ptkStatus()) === "alpha + 1 file · 5 pages" &&
    (await page.locator(`${ptk}.thumb`).count()) === 5,
  await ptkStatus()
);
await page.waitForFunction(() =>
  [
    ...document.querySelectorAll<HTMLCanvasElement>(
      ".tool-pdf-toolkit .thumb canvas"
    ),
  ].every((c) => c.width > 0)
);
check(
  "pdf: the turned file's pages are shown turned",
  JSON.stringify(await ptkThumbs()) ===
    JSON.stringify(["tall", "tall", "tall", "wide", "wide"])
);

// The grid: turn all, undo; delete with the keyboard, undo; drag the last page first.
await page.locator(`${ptk}.panel-body button`, { hasText: "All" }).click();
await page
  .locator(`${ptk}.panel-body button`, { hasText: "Turn right" })
  .click();
await page.waitForFunction(
  () =>
    (
      document.querySelector(
        ".tool-pdf-toolkit .thumb canvas"
      ) as HTMLCanvasElement
    )?.width > 0
);
await page.waitForTimeout(300);
const turnedThumbs = await ptkThumbs();
await page.keyboard.press("Meta+z");
await page.waitForTimeout(300);
check(
  "pdf: turning every page, then undo",
  JSON.stringify(turnedThumbs) ===
    JSON.stringify(["wide", "wide", "wide", "tall", "tall"]) &&
    JSON.stringify(await ptkThumbs()) ===
      JSON.stringify(["tall", "tall", "tall", "wide", "wide"]),
  JSON.stringify(turnedThumbs)
);
await page.locator(`${ptk}.thumb`).nth(1).click();
await page.keyboard.press("Delete");
const afterDelete = await page.locator(`${ptk}.thumb`).count();
await page.keyboard.press("Meta+z");
check(
  "pdf: Delete removes the selected page, undo brings it back",
  afterDelete === 4 && (await page.locator(`${ptk}.thumb`).count()) === 5
);
await page
  .locator(`${ptk}.thumb`)
  .nth(4)
  .dragTo(page.locator(`${ptk}.thumb`).nth(0), {
    targetPosition: { x: 10, y: 60 },
  });
const merged = await ptkDownload(() =>
  page.locator(`${ptk}.download-btn`).click()
);
check(
  "pdf: Download PDF is the Page List, dragged page first, turned page kept turned",
  JSON.stringify(pageTexts(merged.bytes)) ===
    JSON.stringify(["Beta 2", "Alpha 1", "Alpha 2", "Alpha 3", "Beta 1"]) &&
    openTest(merged.bytes)
      .loadPage(0)
      .getObject()
      .getInheritable("Rotate")
      .asNumber() === 90,
  JSON.stringify(pageTexts(merged.bytes))
);
await page.keyboard.press("Meta+z");

// A live preview, applied, downloaded.
await ptkPanel("watermark");
await ptkPreview();
await ptkRepreview(() =>
  page.locator(`${ptk}.panel-body input[type=text]`).first().fill("SMOKE")
);
const markedFoot = await ptkFoot();
await page.locator(`${ptk}.panel-foot button`, { hasText: "Apply" }).click();
await page.waitForFunction(
  () =>
    document.querySelector<HTMLSelectElement>(".tool-pdf-toolkit .panel-select")
      ?.value === "organize"
);
const marked = await ptkDownload(() =>
  page.locator(`${ptk}.download-btn`).click()
);
check(
  "pdf: a watermark previews live, applies, and is in every page's text",
  markedFoot.startsWith("5 pages · ") &&
    pageTexts(marked.bytes).every((t) => t.includes("SMOKE")),
  `${markedFoot} ${JSON.stringify(pageTexts(marked.bytes))}`
);

await page.keyboard.press("Meta+z");

// Split into single pages: a zip of five PDFs.
await ptkPanel("split");
const parts = await ptkDownload(() =>
  page.locator(`${ptk}.panel-body button`, { hasText: "Split" }).click()
);
{
  const zipPath = path.join(ptkDir, parts.name);
  await Bun.write(zipPath, parts.bytes);
  const listing = Bun.spawnSync([
    "python3",
    "-I",
    "-c",
    "import sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); print(z.testzip()); print(len(z.namelist()))",
    zipPath,
  ]).stdout.toString();
  check(
    "pdf: split into single pages downloads a zip of five PDFs",
    parts.name === "alpha-split.zip" && listing.trim() === "None\n5",
    `${parts.name} ${listing}`
  );
}

// Redact a box drawn over the first page's heading.
await ptkPanel("redact");
await ptkDrag(0, [60, 40], [220, 84]);
await page.locator(`${ptk}.panel-body button`, { hasText: "Preview" }).click();
await ptkIdle();
const redacted = await ptkDownload(() =>
  page.locator(`${ptk}.panel-foot button`, { hasText: "Download" }).click()
);
check(
  "pdf: redaction removes the text under the box from the file",
  pageTexts(redacted.bytes)[0] === "" &&
    !new TextDecoder("latin1").decode(redacted.bytes).includes("Alpha 1"),
  pageTexts(redacted.bytes)[0]
);

// Highlight by dragging across text, then apply.
await ptkPanel("annotate");
await ptkDrag(1, [60, 60], [200, 80]);
await page.waitForFunction(() =>
  (
    document.querySelector(".tool-pdf-toolkit .foot-status")?.textContent ?? ""
  ).startsWith("1 new")
);
const annotated = await ptkDownload(() =>
  page.locator(`${ptk}.panel-foot button`, { hasText: "Download" }).click()
);
check(
  "pdf: a highlight dragged across text is a Highlight annotation on that page",
  openTest(annotated.bytes)
    .loadPage(1)
    .getAnnotations()
    .map((a) => a.getType())
    .join(",") === "Highlight"
);
// The tools are a toolbar above the pages. Text: click on the page and type
// there; what is typed becomes a text box that fits it, where it was typed.
await page
  .locator(`${ptk}.viewer-tools [role=toolbar] button[aria-label=Text]`)
  .click();
{
  const at = await ptkOnScreen(1);
  const [cx = 0, cy = 0] = at([300, 400]);
  await page.mouse.click(cx, cy);
  const typing = page.locator(`${ptk}.sheet textarea.writing`);
  await typing.waitFor();
  await page.keyboard.type("Typed on the page");
  await page.keyboard.press("Enter");
  await page.keyboard.type("and a second line");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() =>
    (
      document.querySelector(".tool-pdf-toolkit .foot-status")?.textContent ??
      ""
    ).startsWith("2 new")
  );
  const shown = await page
    .locator(`${ptk}.page .overlay`)
    .nth(1)
    .locator(".mark-written text")
    .textContent();
  const written = await ptkDownload(() =>
    page.locator(`${ptk}.panel-foot button`, { hasText: "Download" }).click()
  );
  const box = openTest(written.bytes)
    .loadPage(1)
    .getAnnotations()
    .find((a) => a.getType() === "FreeText");
  const [x0 = 0, y0 = 0] = box?.getBounds() ?? [];
  check(
    "pdf: Text is typed on the page and becomes a text box there, as typed",
    (await typing.count()) === 0 &&
      shown === "Typed on the pageand a second line" &&
      box?.getContents() === "Typed on the page\nand a second line" &&
      // Firefox gives the pointer in whole pixels: up to a pixel off, in points.
      Math.abs(x0 - 300) < 2 &&
      Math.abs(y0 - 400) < 2,
    `${shown} / ${JSON.stringify(box?.getContents())} at ${x0},${y0}`
  );
}
// Each tool previews what it makes: a line under, through, or squiggling
// under the text (a highlight is multiplied onto the page from its own
// layer), an ellipse as an ellipse, with no names over them; their colour,
// opacity and width are set in the toolbar, and the panel says nothing of how.
{
  const ptkTool = (label: string) =>
    page
      .locator(
        `${ptk}.viewer-tools [role=toolbar] button[aria-label="${label}"]`
      )
      .click();
  const ptkNew = (n: number) =>
    page.waitForFunction(
      (want) =>
        (
          document.querySelector(".tool-pdf-toolkit .foot-status")
            ?.textContent ?? ""
        ).startsWith(`${want} new`),
      n
    );
  const sheet = page.locator(`${ptk}.page .sheet`).nth(1);
  for (const label of ["Underline", "Strike out", "Squiggle"]) {
    await ptkTool(label);
    await ptkDrag(1, [60, 60], [200, 80]);
  }
  await ptkNew(5);
  await ptkTool("Ellipse");
  await ptkDrag(1, [300, 120], [450, 220]);
  await ptkNew(6);
  const lines = await sheet.evaluate((s) =>
    ["underline", "strikeout", "squiggly"].map((k) => {
      const drawing = s.querySelector(`.overlay .mark-${k} path`);
      return `${k}:${drawing?.getAttribute("fill")}/${drawing?.getAttribute("stroke") ? "stroked" : "none"}`;
    })
  );
  check(
    "pdf: Underline, Strike out and Squiggle preview as lines, not as highlights",
    lines.join(" ") ===
      "underline:none/stroked strikeout:none/stroked squiggly:none/stroked",
    lines.join(" ")
  );
  const drawn = [
    await sheet.locator(".blend .mark-highlight path").count(),
    await sheet.locator(".overlay .mark-ellipse ellipse").count(),
    await sheet.locator(".mark:not(.mark-written) text").count(),
  ];
  check(
    "pdf: a highlight previews multiplied onto the page, an ellipse as an ellipse, neither labelled",
    drawn.join(",") === "1,1,0",
    `highlights, ellipses, labels: ${drawn.join(",")}`
  );
  check(
    "pdf: Annotate's colour, opacity and width are in the toolbar, with no how-to line",
    (await page
      .locator(`${ptk}.viewer-tools input[type=color]:visible`)
      .count()) === 1 &&
      (await page
        .locator(`${ptk}.viewer-tools input[type=range]:visible`)
        .count()) === 1 &&
      (await page
        .locator(`${ptk}.viewer-tools input[type=number]:visible`)
        .count()) === 1 &&
      (await page
        .locator(`${ptk}.panel-body input, ${ptk}.panel-body textarea`)
        .count()) === 0 &&
      (await page.locator(`${ptk}.tool-how`).count()) === 0
  );
  // Note: click, then write it beside its icon; click its icon again to rewrite it.
  await ptkTool("Note");
  const at = await ptkOnScreen(1);
  const [nx = 0, ny = 0] = at([100, 300]);
  await page.mouse.click(nx, ny);
  const noteBox = page.locator(`${ptk}.sheet textarea.note-writing`);
  await noteBox.waitFor();
  await page.keyboard.type("Check this");
  await page.keyboard.press("Escape");
  await ptkNew(7);
  const [ix = 0, iy = 0] = at([108, 308]);
  await page.mouse.click(ix, iy);
  await noteBox.waitFor();
  const before = await noteBox.inputValue();
  await page.keyboard.type(" twice");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() =>
    (
      document.querySelector(".tool-pdf-toolkit .annots")?.textContent ?? ""
    ).includes("Check this twice")
  );
  const markedUp = await ptkDownload(() =>
    page.locator(`${ptk}.panel-foot button`, { hasText: "Download" }).click()
  );
  const annots = openTest(markedUp.bytes).loadPage(1).getAnnotations();
  const footNow = await ptkFoot();
  const note = annots.find((a) => a.getType() === "Text");
  check(
    "pdf: a note is written where it was put, and rewritten from its icon",
    before === "Check this" &&
      footNow.startsWith("7 new") &&
      note?.getContents() === "Check this twice" &&
      Math.abs((note?.getBounds()[0] ?? 0) - 100) < 2,
    `${before} / ${note?.getContents()} at ${note?.getBounds()}`
  );
  check(
    "pdf: the markup and the ellipse download as their own annotation types",
    annots
      .map((a) => a.getType())
      .filter((t) => t !== "FreeText" && t !== "Text")
      .join(",") === "Highlight,Underline,StrikeOut,Squiggly,Circle",
    annots.map((a) => a.getType()).join(",")
  );
}
await ptkPanel("organize");
check(
  "pdf: the annotation tools leave with the Annotate panel",
  await page.locator(`${ptk}.viewer-tools`).isHidden()
);

// Protect with a password, then open what came out.
await ptkPanel("protect");
await page
  .locator(`${ptk}.panel-body input[type=password]`)
  .first()
  .fill(PTK_PASSWORD);
await page.locator(`${ptk}.panel-body button`, { hasText: "Encrypt" }).click();
await ptkIdle();
const protectedPdf = await ptkDownload(() =>
  page.locator(`${ptk}.panel-foot button`, { hasText: "Download" }).click()
);
{
  const doc = ptkEnv.mupdf.Document.openDocument(
    protectedPdf.bytes,
    "application/pdf"
  );
  check(
    "pdf: Protect encrypts with a password that has commas in it",
    doc.needsPassword() && doc.authenticatePassword(PTK_PASSWORD) > 0
  );
}

// An encrypted file: a wrong password, then the right one.
await page.setInputFiles(`${ptk}.add-input`, [ptkFiles.locked]);
await page.waitForSelector(`${ptk}.locked.on`);
await page.locator(`${ptk}.unlock-pw`).fill("wrong");
await page.locator(`${ptk}.unlock-btn`).click();
await page.waitForFunction(() =>
  (
    document.querySelector(".tool-pdf-toolkit .locked-text")?.textContent ?? ""
  ).startsWith("Wrong password")
);
await page.locator(`${ptk}.unlock-pw`).fill(PTK_PASSWORD);
await page.locator(`${ptk}.unlock-btn`).click();
await ptkIdle();
const lockedStatus = await ptkStatus();
const lockedNote = await textOf(page.locator(`${ptk}.note-text`));
check(
  "pdf: an encrypted file asks again after a wrong password, then joins the Workspace",
  lockedStatus.endsWith("6 pages") && lockedNote.includes("was encrypted"),
  lockedStatus
);

// Cancel while a password is asked for: the batch goes on in the worker
// started next, and every file of it reaches the Page List.
await page.setInputFiles(`${ptk}.open-input`, [
  ptkFiles.locked,
  ptkFiles.alpha,
]);
await page.waitForSelector(`${ptk}.locked.on`);
await ptkCancel();
await page.locator(`${ptk}.unlock-pw`).fill(PTK_PASSWORD);
await page.locator(`${ptk}.unlock-btn`).click();
await ptkIdle();
check(
  "pdf: Cancel while a password is asked for still opens the whole batch",
  (await ptkStatus()) === "locked + 1 file · 4 pages",
  await ptkStatus()
);

// A signed file on its own: the signature checks out.
await page.setInputFiles(`${ptk}.open-input`, [ptkFiles.signed]);
await ptkIdle();
await ptkPanel("signatures");
await page.waitForSelector(`${ptk}.sig-card`, { timeout: 30_000 });
const sigVerdict = await textOf(page.locator(`${ptk}.sig-card .verdict-line`));
const sigCard = await textOf(page.locator(`${ptk}.sig-card`));
check(
  "pdf: a fresh signature is valid and covers the whole file",
  sigVerdict === "Valid, and the document is unchanged since" &&
    sigCard.includes("Smoke Signer"),
  sigCard
);
// Its page turned, the file is put together anew: what is checked is no
// longer the file as signed, and the panel says so.
await ptkPanel("organize");
await page.locator(`${ptk}.view-seg button[data-view=grid]`).click();
await page
  .locator(`${ptk}.thumb-actions button[aria-label^="Turn"]`)
  .first()
  .evaluate((b) => (b as HTMLButtonElement).click());
await ptkPanel("signatures");
await page.waitForSelector(`${ptk}.sig-card`, { timeout: 30_000 });
check(
  "pdf: a signed file whose page was turned warns that the check is of a new document",
  (await page.locator(`${ptk}.sig-cards .hint.warn`).count()) === 1,
  await textOf(page.locator(`${ptk}.sig-cards`))
);
// An unsigned file, turned: there are no signatures to warn about.
await ptkPanel("organize");
await page.setInputFiles(`${ptk}.open-input`, [ptkFiles.alpha]);
await ptkIdle();
await page
  .locator(`${ptk}.thumb-actions button[aria-label^="Turn"]`)
  .first()
  .evaluate((b) => (b as HTMLButtonElement).click());
await ptkPanel("signatures");
await page.waitForFunction(() =>
  (
    document.querySelector(".tool-pdf-toolkit .sig-cards")?.textContent ?? ""
  ).includes("not signed")
);
check(
  "pdf: an unsigned file whose page was turned has no warning about signatures",
  (await page.locator(`${ptk}.sig-cards .hint.warn`).count()) === 0,
  await textOf(page.locator(`${ptk}.sig-cards`))
);

// A signed file with a password: its signature is checked against the file
// as signed, not the decrypted copy worked on, and still is after a restart.
await ptkPanel("organize");
await page.setInputFiles(`${ptk}.open-input`, [ptkFiles.signedLocked]);
await page.waitForSelector(`${ptk}.locked.on`);
await page.locator(`${ptk}.unlock-pw`).fill(PTK_PASSWORD);
await page.locator(`${ptk}.unlock-btn`).click();
await ptkIdle();
const lockedSigVerdict = async () => {
  await ptkPanel("signatures");
  await page.waitForSelector(`${ptk}.sig-card`, { timeout: 30_000 });
  const line = await textOf(page.locator(`${ptk}.sig-card .verdict-line`));
  await ptkPanel("organize");
  return line;
};
const lockedFirst = await lockedSigVerdict();
await ptkCancel();
const lockedAfterCancel = await lockedSigVerdict();
check(
  "pdf: an encrypted file's signature is valid, before and after Cancel",
  lockedFirst === "Valid, and the document is unchanged since" &&
    lockedAfterCancel === lockedFirst,
  `${lockedFirst} / ${lockedAfterCancel}`
);

// OCR a scan: the result has text to search. First, Cancel stops OCR
// every time, not only the first.
await page.setInputFiles(`${ptk}.open-input`, [ptkFiles.scanDense]);
await ptkIdle();
await ptkPanel("ocr");
{
  const recognizeThenCancel = async () => {
    // The last run's phase stays written under the hidden bar: not this run's.
    await page
      .locator(`${ptk}.phase`)
      .evaluate((phase) => phase.replaceChildren());
    await page
      .locator(`${ptk}.panel-body button`, { hasText: "Recognize" })
      .click();
    // Into Tesseract reading the page, in the main thread, where nothing
    // but its hook can stop it: the page's rendering has come back by then.
    await page.waitForFunction(
      () =>
        (
          document.querySelector(".tool-pdf-toolkit .phase")?.textContent ?? ""
        ).startsWith("Reading page"),
      undefined,
      { polling: "raf", timeout: 240_000 }
    );
    await page.waitForTimeout(500);
    await ptkCancel();
  };
  await recognizeThenCancel();
  await recognizeThenCancel();
  // A run Cancel missed goes on downloading, starting Tesseract, and reading
  // pages, each step bringing the bar back.
  let barCameBack = true;
  try {
    await page.waitForFunction(
      () => document.querySelector(".tool-pdf-toolkit .progress.on") !== null,
      undefined,
      { polling: 50, timeout: 8000 }
    );
  } catch {
    barCameBack = false;
  }
  check(
    "pdf: a second Cancel stops OCR too",
    !barCameBack &&
      !(await page.locator(".tool-pdf-toolkit.showing-result").count())
  );
}
{
  // A file asked for its password while OCR runs, then skipped: the batch
  // ends, but OCR still runs, and the bar, Cancel, and the grid say so.
  await page.setInputFiles(`${ptk}.add-input`, [ptkFiles.locked]);
  await page.waitForSelector(`${ptk}.locked.on`);
  await page
    .locator(`${ptk}.phase`)
    .evaluate((phase) => phase.replaceChildren());
  await page
    .locator(`${ptk}.panel-body button`, { hasText: "Recognize" })
    .click();
  await page.waitForFunction(
    () =>
      (
        document.querySelector(".tool-pdf-toolkit .phase")?.textContent ?? ""
      ).startsWith("Reading page"),
    undefined,
    { polling: "raf", timeout: 240_000 }
  );
  await page.locator(`${ptk}.unlock-skip`).click();
  await page.waitForTimeout(300);
  const stillBusy =
    (await page.locator(`${ptk}.progress.on`).count()) === 1 &&
    (await page.locator(".tool-pdf-toolkit.busy").count()) === 1;
  await ptkCancel();
  check(
    "pdf: skipping a password while OCR runs leaves OCR shown as running",
    stillBusy
  );
}
{
  // The pages change under OCR (a file opened once its password is given):
  // the run stops, rather than laying what it read over other pages.
  const recognize = page.locator(`${ptk}.panel-body button`, {
    hasText: "Recognize",
  });
  await page.setInputFiles(`${ptk}.open-input`, [ptkFiles.locked]);
  await page.waitForSelector(`${ptk}.locked.on`);
  await page
    .locator(`${ptk}.phase`)
    .evaluate((phase) => phase.replaceChildren());
  await recognize.click();
  await page.waitForFunction(
    () =>
      (
        document.querySelector(".tool-pdf-toolkit .phase")?.textContent ?? ""
      ).startsWith("Reading page"),
    undefined,
    { polling: "raf", timeout: 240_000 }
  );
  await page.locator(`${ptk}.unlock-pw`).fill(PTK_PASSWORD);
  await page.locator(`${ptk}.unlock-btn`).click();
  // Either the note of a stopped run, or (missed) the Result of a finished one.
  await page
    .waitForFunction(
      () =>
        document
          .querySelector(".tool-pdf-toolkit")
          ?.classList.contains("showing-result") ||
        (
          document.querySelector(".tool-pdf-toolkit .panel-body .sel-info")
            ?.textContent ?? ""
        ).includes("OCR stopped"),
      undefined,
      { timeout: 60_000 }
    )
    .catch(() => null);
  await ptkIdle();
  const said = await textOf(page.locator(`${ptk}.panel-body .sel-info`));
  check(
    "pdf: OCR stops when the pages change under it",
    !(await page.locator(".tool-pdf-toolkit.showing-result").count()) &&
      said.includes("OCR stopped") &&
      (await ptkStatus()) === "locked · 1 page",
    `${await ptkStatus()} / ${said}`
  );
}
await page.setInputFiles(`${ptk}.open-input`, [ptkFiles.scan]);
await ptkIdle();
await page
  .locator(`${ptk}.panel-body button`, { hasText: "Recognize" })
  .click();
await page.waitForFunction(
  () =>
    document
      .querySelector(".tool-pdf-toolkit")
      ?.classList.contains("showing-result"),
  undefined,
  { timeout: 240_000 }
);
const ocred = await ptkDownload(() =>
  page.locator(`${ptk}.panel-foot button`, { hasText: "Download" }).click()
);
check(
  "pdf: OCR gives a scan a text layer that reads what the scan says",
  /quick brown fox/iu.test(pageTexts(ocred.bytes)[0] ?? ""),
  pageTexts(ocred.bytes)[0]
);
{
  // A language's model that Tesseract cannot read: OCR says it could not
  // start, and the Tesseract worker started for it is ended, not left behind.
  let modelFetches = 0;
  await page.route("**/isl.traineddata", (route) => {
    modelFetches += 1;
    return route.fulfill({ body: "not a model", status: 200 });
  });
  const started: { closed: boolean }[] = [];
  const onWorker = (w: PageWorker) => {
    // Tesseract's worker is a blob: URL; the PDF worker a data: URL.
    if (w.url().startsWith("blob:")) {
      const seen = { closed: false };
      started.push(seen);
      w.on("close", () => {
        seen.closed = true;
      });
    }
  };
  page.on("worker", onWorker);
  const langs = page.locator(`${ptk}.langs`);
  await langs.getByLabel("Icelandic", { exact: true }).check();
  await langs.getByLabel("English", { exact: true }).uncheck();
  const recognizeAndFail = async () => {
    await page
      .locator(`${ptk}.panel-body button`, { hasText: "Recognize" })
      .click();
    await page.waitForSelector(`${ptk}.error-box.on`, { timeout: 120_000 });
    await ptkIdle();
  };
  await recognizeAndFail();
  await page.waitForTimeout(1000);
  page.off("worker", onWorker);
  const errorText = await textOf(page.locator(`${ptk}.error-box`));
  check(
    "pdf: OCR that cannot start ends the Tesseract worker it started",
    started.length > 0 && started.every((s) => s.closed),
    `${started.filter((s) => s.closed).length} of ${started.length} closed; ${errorText}`
  );
  // The model it could not read is not kept: the next try downloads it again.
  await recognizeAndFail();
  await page.unroute("**/isl.traineddata");
  check(
    "pdf: a model OCR could not read is fetched again, not taken from the cache",
    modelFetches === 2,
    `${modelFetches} fetches`
  );
}

// Cancel throws the worker away; the next one gets the Sources back under
// ids of its own. One file, two previews (each a document in the worker),
// the second applied: the first worker's ids for what the new one holds
// were those of the previews, so renderings kept from them must not show.
await page.goto("about:blank");
await page.goto(`${url}#pdf-toolkit/watermark`);
await page.setInputFiles(`${ptk}.open-input`, [ptkFiles.alpha]);
await ptkIdle();
await ptkPreview();
await ptkRepreview(() =>
  page.locator(`${ptk}.panel-body input[type=text]`).first().fill("AGAIN")
);
await page.locator(`${ptk}.panel-foot button`, { hasText: "Apply" }).click();
{
  const before = await ptkThumbImages();
  await ptkCancel();
  const again = await ptkDownload(() =>
    page.locator(`${ptk}.download-btn`).click()
  );
  const after = await ptkThumbImages();
  check(
    "pdf: after Cancel, a fresh worker shows and downloads the same Workspace",
    JSON.stringify(after) === JSON.stringify(before) &&
      pageTexts(again.bytes).every((t) => t.includes("AGAIN")),
    `${after.filter((u, i) => u !== before[i]).length} of ${before.length} thumbnails differ`
  );
}

// A live preview that fails takes the last one off screen: nothing left to Apply.
await ptkPanel("stamp");
await page.setInputFiles(`${ptk}.panel-body input[type=file]`, [ptkFiles.logo]);
await ptkPreview();
await page.setInputFiles(`${ptk}.panel-body input[type=file]`, [
  ptkFiles.badImage,
]);
await page.waitForSelector(`${ptk}.error-box.on`);
await page.waitForTimeout(500);
check(
  "pdf: a live preview that fails leaves no Result to Apply",
  !(await page.locator(".tool-pdf-toolkit.showing-result").count()) &&
    (await page
      .locator(`${ptk}.panel-foot button`, { hasText: "Apply" })
      .isDisabled()) &&
    (await ptkFoot()) === "",
  await ptkFoot()
);

// A Result made before Cancel, applied after the next worker started: that
// worker never had it, so it is handed over before anything reads it.
await ptkPanel("repair");
await page.locator(`${ptk}.panel-body button.primary`).last().click();
await ptkPreview();
await ptkCancel();
await ptkDownload(() => page.locator(`${ptk}.download-btn`).click());
{
  // The worker running is handed the Result: none is thrown away and started again.
  let spawned = 0;
  const onWorker = () => {
    spawned += 1;
  };
  page.on("worker", onWorker);
  await page.locator(`${ptk}.panel-foot button`, { hasText: "Apply" }).click();
  const applied = await ptkDownload(() =>
    page.locator(`${ptk}.download-btn`).click()
  );
  await ptkThumbImages();
  page.off("worker", onWorker);
  check(
    "pdf: a Result applied after Cancel restarted the worker is the Workspace",
    pageTexts(applied.bytes).length === 3 &&
      pageTexts(applied.bytes).every((t) => t.includes("AGAIN")),
    JSON.stringify(pageTexts(applied.bytes))
  );
  check(
    "pdf: applying it starts no worker",
    spawned === 0,
    `${spawned} started`
  );
}

// While an Operation runs, the pages stay as they are: neither the grid's
// buttons nor its keys change them, so the Result is of the pages shown.
await page.locator(`${ptk}.view-seg button[data-view=grid]`).click();
await ptkPanel("repair");
await page.evaluate(() => {
  const root = document.querySelector(".tool-pdf-toolkit");
  const run = [
    ...(root?.querySelectorAll<HTMLButtonElement>(
      ".panel-body button.primary"
    ) ?? []),
  ].at(-1);
  run?.click();
  root
    ?.querySelector<HTMLButtonElement>(
      '.thumb-actions button[aria-label^="Delete"]'
    )
    ?.click();
  root
    ?.querySelector<HTMLButtonElement>(
      '.thumb-actions button[aria-label^="Turn"]'
    )
    ?.click();
  root
    ?.querySelector(".thumb")
    ?.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "Delete" })
    );
});
await ptkPreview();
{
  const kept = await ptkDownload(() =>
    page.locator(`${ptk}.download-btn`).click()
  );
  check(
    "pdf: the grid does not change the pages while an Operation runs",
    pageTexts(kept.bytes).length === 3 &&
      !openTest(kept.bytes)
        .loadPage(0)
        .getObject()
        .getInheritable("Rotate")
        .asNumber(),
    JSON.stringify(pageTexts(kept.bytes))
  );
}

// A live preview whose pages changed is gone from the foot at once, not
// when the next one comes: until then there is nothing to Apply.
await ptkPanel("organize");
await page.setInputFiles(`${ptk}.open-input`, [ptkFiles.alpha]);
await ptkIdle();
await ptkPanel("watermark");
await ptkPreview();
{
  const applyOffered = await page.evaluate(() => {
    const root = document.querySelector(".tool-pdf-toolkit");
    root
      ?.querySelector<HTMLButtonElement>(
        ".result-seg button[data-show=workspace]"
      )
      ?.click();
    root
      ?.querySelector<HTMLButtonElement>(
        '.thumb-actions button[aria-label^="Delete"]'
      )
      ?.click();
    const apply = [
      ...(root?.querySelectorAll<HTMLButtonElement>(".panel-foot button") ??
        []),
    ].find((b) => b.textContent === "Apply");
    return apply ? !apply.disabled : null;
  });
  await ptkPreview();
  const foot = await ptkFoot();
  check(
    "pdf: a live preview's Apply goes the moment the pages change",
    applyOffered === false && foot.startsWith("2 pages"),
    `${applyOffered} / ${foot}`
  );
}

// Extract images: two images are downloaded together, and the foot says so.
await ptkPanel("organize");
await page.setInputFiles(`${ptk}.open-input`, [ptkFiles.pictures]);
await ptkIdle();
await ptkPanel("images-out");
await page
  .locator(`${ptk}.panel-body button`, { hasText: "Find images" })
  .click();
await page.waitForSelector(`${ptk}.gallery`);
check(
  "pdf: Extract images shows every image, and its foot offers Download all",
  (await page.locator(`${ptk}.gallery .image-tile`).count()) === 2 &&
    (await page
      .locator(`${ptk}.panel-foot button:not(.primary)`)
      .textContent()) === "Download all",
  await ptkFoot()
);

// Compress: one word a choice, and the line under them says what it does.
await ptkPanel("compress");
const imageChoices = page.locator(`${ptk}.field-seg`).first();
await imageChoices.locator("button", { hasText: "Small" }).click();
const imageLabels = await imageChoices.locator("button").allTextContents();
const imagesHint = await textOf(imageChoices.locator(".hint"));
check(
  "pdf: Compress names its image choices in a word and explains the one chosen",
  imageLabels.join(",") === "Keep,High,Medium,Small" &&
    imagesHint.includes("96 dpi"),
  imagesHint
);
await imageChoices.locator("button", { hasText: "Medium" }).click();

// A note comes over the pages, not above them: nothing moves.
await page.setInputFiles(`${ptk}.open-input`, [ptkFiles.secret]);
await ptkIdle();
await ptkPanel("redact");
const firstPage = page.locator(`${ptk}.viewer-body .page`).first();
const pageBefore = await firstPage.boundingBox();
const redactQuery = page.locator(`${ptk}.panel-body input[type=search]`);
await redactQuery.fill("nowhere");
await redactQuery.press("Enter");
await page.waitForSelector(`${ptk}.viewer .note.float.on`);
check(
  "pdf: a note shows over the pages and leaves them where they were",
  (await textOf(page.locator(`${ptk}.note-text`))) ===
    "“nowhere” is not in the document." &&
    JSON.stringify(await firstPage.boundingBox()) ===
      JSON.stringify(pageBefore),
  `${JSON.stringify(pageBefore)} → ${JSON.stringify(await firstPage.boundingBox())}`
);
await page.locator(`${ptk}.note-close`).click();
check(
  "pdf: a note's close button dismisses it",
  (await page.locator(`${ptk}.note.on`).count()) === 0
);

// Mark all marks the word on the page and lists where else it is; the note
// stuck over it goes with the redaction, and the title, out of reach, stays.
await redactQuery.fill("codename");
await redactQuery.press("Enter");
await page.waitForSelector(`${ptk}.elsewhere .places li`);
const places = await page
  .locator(`${ptk}.elsewhere .places li`)
  .allTextContents();
check(
  "pdf: Mark all lists where the text is out of the marks' reach",
  places.includes("Document information: Title") &&
    places.includes("Comment on page 1") &&
    (await page.locator(`${ptk}.annots li`).count()) === 1,
  places.join(" | ")
);
await page.locator(`${ptk}.panel-body button`, { hasText: "Preview" }).click();
await ptkIdle();
const redactBody = await textOf(page.locator(`${ptk}.panel-body`));
const secretOut = await ptkDownload(() =>
  page.locator(`${ptk}.panel-foot button`, { hasText: "Download" }).click()
);
const secretDoc = openTest(secretOut.bytes);
check(
  "pdf: redaction takes the comment over a mark with it, and says so",
  secretDoc.loadPage(0).getAnnotations().length === 0 &&
    pageTexts(secretOut.bytes)[0] === "1" &&
    secretDoc.getMetaData("info:Title") === "Codename plans" &&
    redactBody.includes("Also removed 1 comment that lay over the marks."),
  redactBody
);

// Compare: a view chosen while the text diff is still being read wins.
await ptkPanel("organize");
await page.setInputFiles(`${ptk}.open-input`, [ptkFiles.alpha, ptkFiles.beta]);
await ptkIdle();
await ptkPanel("compare");
await page.selectOption(`${ptk}.panel-body select`, { label: "beta.pdf" });
await page.waitForSelector(".tool-pdf-toolkit .compare .compare-row");
await page.evaluate(() => {
  const seg = document.querySelector(".tool-pdf-toolkit .compare .seg");
  seg?.querySelector<HTMLButtonElement>("button[data-view=text]")?.click();
  seg?.querySelector<HTMLButtonElement>("button[data-view=side]")?.click();
});
await page.waitForTimeout(1500);
check(
  "pdf: Compare shows the view chosen last, not a text diff that came after",
  (await page.locator(".tool-pdf-toolkit .compare .text-diff").count()) === 0 &&
    (await page.locator(".tool-pdf-toolkit .compare .compare-row").count()) > 0
);

// A Deep Link opens an Operation with its options.
await page.goto("about:blank");
await page.goto(`${url}#pdf-toolkit/watermark?text=SECRET&angle=30`);
await page.setInputFiles(`${ptk}.open-input`, [ptkFiles.alpha]);
await ptkIdle();
check(
  "pdf: a Deep Link restores the Operation and its options",
  (await page.locator(`${ptk}.panel-select`).inputValue()) === "watermark" &&
    (await page
      .locator(`${ptk}.panel-body input[type=text]`)
      .first()
      .inputValue()) === "SECRET" &&
    (await page
      .locator(`${ptk}.panel-body input[type=number]`)
      .nth(1)
      .inputValue()) === "30"
);
await page.waitForFunction(() =>
  (
    document.querySelector(".tool-pdf-toolkit .engines-text")?.textContent ?? ""
  ).startsWith("Engines cached")
);

// Narrow layout: below 768px the sidebar becomes an on-demand drawer.
await page.setViewportSize({ height: 667, width: 375 });
await page.goto(`${url}#jsonc-sorter`);
// waitFor, not isVisible: shrinking the viewport hides the sidebar via a
// transition, and this goto is a same-document hash navigation, not a reload.
await page.locator(".sidebar").waitFor({ state: "hidden" });
check("narrow: drawer starts closed", true);
check("narrow: hamburger visible", await page.locator(".menu-btn").isVisible());

await page.locator(".menu-btn").click();
await page.locator(".sidebar").waitFor({ state: "visible" });
check(
  "narrow: hamburger opens drawer",
  (await page.locator(".menu-btn").getAttribute("aria-expanded")) === "true"
);
check(
  "narrow: main pane inert while open",
  await page.locator(".content").evaluate((el) => (el as HTMLElement).inert)
);

await page.locator(".tool-list button", { hasText: "Base64" }).click();
await page.locator(".sidebar").waitFor({ state: "hidden" });
check(
  "narrow: selecting a tool closes drawer",
  await page.evaluate(() => location.hash === "#base64-to-image")
);
check(
  "narrow: main pane usable again",
  !(await page.locator(".content").evaluate((el) => (el as HTMLElement).inert))
);

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
check(
  "narrow: no collapse button in the drawer",
  !(await page.locator(".collapse-btn").isVisible())
);
await page.keyboard.press("Escape");
await page.locator(".sidebar").waitFor({ state: "hidden" });

// Widening across the breakpoint restores the inline sidebar; the hamburger
// gives way to the collapse button in the sidebar's corner.
await page.setViewportSize({ height: 800, width: 1200 });
await page.locator(".sidebar").waitFor({ state: "visible" });
// CSS shows the sidebar before the matchMedia change event syncs the button.
await page.waitForFunction(
  () =>
    document.querySelector(".menu-btn")?.getAttribute("aria-expanded") ===
    "true"
);
check(
  "wide: sidebar visible, hamburger gone, collapse button shown",
  !(await page.locator(".menu-btn").isVisible()) &&
    (await page.locator(".collapse-btn").isVisible())
);

// Wide layout: the corner button collapses the sidebar and the main pane
// takes the full width.
const paneLeft = async () =>
  present(
    await page.locator(".content").boundingBox(),
    "a box for the main pane"
  ).x;
await page.waitForFunction(
  () => document.querySelector(".content")?.getBoundingClientRect().x === 220
);
check("wide: main pane sits beside the sidebar", true);

// Clicking a tool while the filter has focus must land: the blur must not
// rebuild the list under the pointer.
await page.locator(".filter-wrap input").focus();
await page.locator(".tool-list button", { hasText: "DNS" }).click();
check(
  "wide: click on tool lands while filter is focused",
  await page.evaluate(() => location.hash === "#dns-lookup")
);

await page.locator(".collapse-btn").click();
await page.locator(".sidebar").waitFor({ state: "hidden" });
await page.waitForFunction(
  () => document.querySelector(".content")?.getBoundingClientRect().x === 0
);
check(
  "wide: corner button collapses sidebar, focus moves to the reveal button",
  (await page.locator(".menu-btn").isVisible()) &&
    (await page.locator(".menu-btn").getAttribute("aria-expanded")) ===
      "false" &&
    (await page
      .locator(".menu-btn")
      .evaluate((el) => el === document.activeElement)) &&
    !(await page
      .locator(".content")
      .evaluate((el) => (el as HTMLElement).inert))
);

// While collapsed, the filter shortcut opens the sidebar as the drawer
// without disturbing the collapse.
await page.keyboard.press("Meta+k");
await page.locator(".sidebar").waitFor({ state: "visible" });
check(
  "wide collapsed: cmd+k opens drawer",
  (await page
    .locator(".content")
    .evaluate((el) => (el as HTMLElement).inert)) &&
    (await page
      .locator(".filter-wrap input")
      .evaluate((el) => el === document.activeElement)) &&
    (await paneLeft()) === 0
);
await page.locator(".tool-list button", { hasText: "JSONC" }).click();
await page.locator(".sidebar").waitFor({ state: "hidden" });
check(
  "wide collapsed: selecting a tool closes drawer, stays collapsed",
  await page.evaluate(
    () =>
      location.hash === "#jsonc-sorter" &&
      document.body.classList.contains("sidebar-collapsed")
  )
);
check(
  "wide collapsed: the query string says so, the hash is untouched",
  await page.evaluate(
    () =>
      location.search === "?sidebar=collapsed" &&
      location.hash === "#jsonc-sorter"
  )
);

// The collapse lives in the URL: it survives a reload, with no slide-out.
await page.reload();
await page.waitForSelector(".tool-list button", { state: "attached" });
check(
  "wide collapsed: remembered across reloads",
  !(await page.locator(".sidebar").isVisible()) && (await paneLeft()) === 0
);

await page.locator(".menu-btn").click();
await page.locator(".sidebar").waitFor({ state: "visible" });
await page.waitForFunction(
  () => document.querySelector(".content")?.getBoundingClientRect().x === 220
);
check(
  "wide: reveal button expands sidebar again, focus moves to the corner button",
  !(await page.locator(".menu-btn").isVisible()) &&
    (await page
      .locator(".collapse-btn")
      .evaluate((el) => el === document.activeElement)) &&
    (await page.evaluate(
      () => location.search === "" && location.hash === "#jsonc-sorter"
    ))
);

// A link that carries the param opens collapsed, and the tool's own deep link still lands.
await page.goto(`${url}?sidebar=collapsed#dns-lookup`);
await page.waitForSelector(".tool-list button", { state: "attached" });
check(
  "wide: a link with ?sidebar=collapsed opens collapsed",
  !(await page.locator(".sidebar").isVisible()) &&
    (await paneLeft()) === 0 &&
    (await page.evaluate(
      () =>
        location.hash === "#dns-lookup" &&
        localStorage.getItem("html-tools:sidebar") === null
    ))
);
await page.keyboard.press("Meta+k");
await page.locator(".sidebar").waitFor({ state: "visible" });
await page.locator(".tool-list button", { hasText: "JSONC" }).click();
await page.locator(".sidebar").waitFor({ state: "hidden" });
check(
  "wide collapsed: switching tools keeps the param",
  await page.evaluate(
    () =>
      location.search === "?sidebar=collapsed" &&
      location.hash === "#jsonc-sorter"
  )
);

// Narrowing while collapsed still starts the drawer closed; the collapse is
// a wide-layout thing and does not leak into it.
await page.setViewportSize({ height: 667, width: 375 });
await page.reload();
await page.waitForSelector(".menu-btn");
await page.locator(".menu-btn").click();
await page.locator(".sidebar").waitFor({ state: "visible" });
check("narrow: drawer opens regardless of collapse preference", true);
await page.keyboard.press("Escape");
await page.locator(".sidebar").waitFor({ state: "hidden" });
await page.setViewportSize({ height: 800, width: 1200 });
await page.waitForFunction(
  () => document.querySelector(".content")?.getBoundingClientRect().x === 0
);
await page.waitForFunction(
  () =>
    document.querySelector(".menu-btn")?.getAttribute("aria-expanded") ===
    "false"
);
check(
  "wide: collapse applies again after widening",
  !(await page.locator(".sidebar").isVisible())
);

check("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
process.exit(failed ? 1 : 0);
