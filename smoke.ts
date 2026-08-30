// Browser smoke test for the built index.html. Run: bun run smoke.ts
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

const url = "file://" + import.meta.dir + "/index.html";
let failed = false;
function check(label: string, ok: boolean, detail = "") {
  console.log((ok ? "ok  " : "FAIL") + "  " + label + (detail ? "  [" + detail + "]" : ""));
  if (!ok) failed = true;
}

await page.goto(url);
const names = await page.locator(".tool-list button").allTextContents();
check("sidebar lists all tools", names.length === 3, names.join(", "));

// base64 tool: paste a tiny valid png via direct input.
await page.goto(url + "#base64-to-image");
await page.locator(".b64-input").fill("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==");
await page.waitForSelector(".tool-base64-to-image .output", { state: "visible" });
check("base64 decodes", (await page.locator(".tool-base64-to-image .meta").textContent())!.includes("image/png"));

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

check("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
process.exit(failed ? 1 : 0);
