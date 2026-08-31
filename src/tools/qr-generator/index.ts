import LZString from "lz-string";
import "./tool.css";
import type { Tool } from "../../shell/types";
import { encode, type Ecl, type Encoded } from "./qrcode";
import {
  emailPayload, geoPayload, phonePayload, smsPayload, vcardPayload, wifiPayload,
  type ContactFields, type WifiAuth,
} from "./payload";

/** Longest compressed field blob we are willing to put in the Deep Link. */
const STATE_CAP = 30000;

const QUIET_ZONE = 4;

const TYPES = ["text", "wifi", "contact", "email", "sms", "phone", "geo"] as const;
type PayloadType = (typeof TYPES)[number];

/* ---------------- color helpers ---------------- */

function luminance(hex: string): number {
  const channel = (i: number) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** "" when the colors scan fine, otherwise a status-bar warning. */
function contrastWarning(fg: string, bg: string): string {
  const lumFg = luminance(fg);
  const lumBg = luminance(bg);
  if (lumFg >= lumBg) return "inverted colors: scanners expect a dark code on a light background";
  const ratio = (lumBg + 0.05) / (lumFg + 0.05);
  if (ratio < 2.5) return "low contrast: may not scan";
  return "";
}

/* ---------------- rendering ---------------- */

/** Draw at an integer scale nearest the requested size; returns the actual pixel size. */
function drawCanvas(canvas: HTMLCanvasElement, qr: Encoded, target: number, fg: string, bg: string): number {
  const total = qr.size + QUIET_ZONE * 2;
  const scale = Math.max(1, Math.round(target / total));
  const px = scale * total;
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = fg;
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.matrix[y * qr.size + x]) {
        ctx.fillRect((x + QUIET_ZONE) * scale, (y + QUIET_ZONE) * scale, scale, scale);
      }
    }
  }
  return px;
}

function svgString(qr: Encoded, fg: string, bg: string): string {
  const total = qr.size + QUIET_ZONE * 2;
  const parts: string[] = [];
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.matrix[y * qr.size + x]) parts.push("M" + (x + QUIET_ZONE) + " " + (y + QUIET_ZONE) + "h1v1h-1z");
    }
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + total + " " + total + '" shape-rendering="crispEdges">' +
    '<rect width="' + total + '" height="' + total + '" fill="' + bg + '"/>' +
    '<path d="' + parts.join("") + '" fill="' + fg + '"/></svg>';
}

function downloadBlob(blob: Blob, filename: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/* ---------------- UI ---------------- */

const textField = (cls: string, label: string, placeholder = "") =>
  '<label class="field">' + label + '<input type="text" class="' + cls + '" placeholder="' + placeholder + '" spellcheck="false" autocapitalize="off" autocomplete="off"></label>';

const tool: Tool = {
  id: "qr-generator",
  name: "QR Code Generator",
  subtitle: "Generate QR codes for links, WiFi, contacts, and more.",
  keywords: ["qr", "qr code", "generator", "wifi", "vcard", "contact", "barcode", "url", "link", "email", "sms", "phone", "geo", "share"],
  mount(el, ctx) {
    el.innerHTML = `
      <div class="type-row">
        <button type="button" data-type="text" class="active">Text / URL</button>
        <button type="button" data-type="wifi">WiFi</button>
        <button type="button" data-type="contact">Contact</button>
        <button type="button" data-type="email">Email</button>
        <button type="button" data-type="sms">SMS</button>
        <button type="button" data-type="phone">Phone</button>
        <button type="button" data-type="geo">Geo</button>
      </div>
      <div class="options">
        <label class="opt">error correction
          <select class="opt-ecl">
            <option value="L">L · lowest</option>
            <option value="M" selected>M · medium</option>
            <option value="Q">Q · high</option>
            <option value="H">H · highest</option>
          </select>
        </label>
        <label class="opt">size
          <input type="number" class="opt-size" value="512" min="64" max="4096" step="16"> px
        </label>
        <label class="opt">code
          <span class="swatch"><input type="color" class="opt-fg" value="#000000"></span>
        </label>
        <label class="opt">background
          <span class="swatch"><input type="color" class="opt-bg" value="#ffffff"></span>
        </label>
      </div>
      <div class="panes">
        <section class="pane">
          <div class="pane-head">
            <span>input</span>
            <span class="spacer"></span>
            <button class="btn-clear" type="button">Clear</button>
          </div>
          <div class="forms">
            <div class="form" data-form="text">
              <textarea class="f-text" spellcheck="false" autocapitalize="off" autocomplete="off"
                placeholder="Type or paste any text or URL."></textarea>
            </div>
            <div class="form" data-form="wifi" hidden>
              ${textField("f-wifi-ssid", "network name (SSID)")}
              ${textField("f-wifi-pass", "password")}
              <label class="field">security
                <select class="f-wifi-auth">
                  <option value="WPA" selected>WPA / WPA2 / WPA3</option>
                  <option value="WEP">WEP</option>
                  <option value="nopass">none (open network)</option>
                </select>
              </label>
              <label class="field check"><input type="checkbox" class="f-wifi-hidden">hidden network</label>
            </div>
            <div class="form" data-form="contact" hidden>
              <div class="field-pair">
                ${textField("f-ct-first", "first name")}
                ${textField("f-ct-last", "last name")}
              </div>
              ${textField("f-ct-phone", "phone", "+1 555 0100")}
              ${textField("f-ct-email", "email")}
              ${textField("f-ct-org", "organization")}
              ${textField("f-ct-title", "job title")}
              ${textField("f-ct-url", "website", "https://")}
            </div>
            <div class="form" data-form="email" hidden>
              ${textField("f-em-to", "to", "someone@example.com")}
              ${textField("f-em-subject", "subject")}
              <label class="field">body<textarea class="f-em-body" spellcheck="false"></textarea></label>
            </div>
            <div class="form" data-form="sms" hidden>
              ${textField("f-sms-num", "phone number", "+1 555 0100")}
              <label class="field">message<textarea class="f-sms-msg" spellcheck="false"></textarea></label>
            </div>
            <div class="form" data-form="phone" hidden>
              ${textField("f-ph-num", "phone number", "+1 555 0100")}
            </div>
            <div class="form" data-form="geo" hidden>
              <div class="field-pair">
                ${textField("f-geo-lat", "latitude", "52.520008")}
                ${textField("f-geo-lng", "longitude", "13.404954")}
              </div>
            </div>
          </div>
          <div class="statusbar"><span class="dot">&#9679;</span><span class="status-text">Waiting for input</span></div>
        </section>
        <section class="pane">
          <div class="pane-head">
            <span>preview</span>
            <span class="spacer"></span>
            <button class="btn-png" type="button">Download PNG</button>
            <button class="btn-svg" type="button">Download SVG</button>
            <button class="btn-copy primary" type="button">Copy</button>
          </div>
          <div class="preview-frame">
            <canvas class="qr-canvas" hidden></canvas>
            <div class="preview-empty">Your QR code will appear here</div>
          </div>
        </section>
      </div>`;

    const $ = (sel: string) => el.querySelector(sel) as HTMLElement;
    const $status = $(".statusbar");
    const $statusText = $(".status-text");
    const $canvas = $(".qr-canvas") as HTMLCanvasElement;
    const $empty = $(".preview-empty");
    const $ecl = $(".opt-ecl") as HTMLSelectElement;
    const $size = $(".opt-size") as HTMLInputElement;
    const $fg = $(".opt-fg") as HTMLInputElement;
    const $bg = $(".opt-bg") as HTMLInputElement;
    const $btnCopy = $(".btn-copy") as HTMLButtonElement;
    const typeButtons = [...el.querySelectorAll(".type-row button")] as HTMLButtonElement[];

    type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    const $f = (sel: string) => el.querySelector(sel) as Field;

    // Every form field, keyed by payload type, in a stable order for the Deep Link.
    const FIELDS: Record<PayloadType, Field[]> = {
      text: [$f(".f-text")],
      wifi: [$f(".f-wifi-ssid"), $f(".f-wifi-pass"), $f(".f-wifi-auth"), $f(".f-wifi-hidden")],
      contact: [$f(".f-ct-first"), $f(".f-ct-last"), $f(".f-ct-phone"), $f(".f-ct-email"), $f(".f-ct-org"), $f(".f-ct-title"), $f(".f-ct-url")],
      email: [$f(".f-em-to"), $f(".f-em-subject"), $f(".f-em-body")],
      sms: [$f(".f-sms-num"), $f(".f-sms-msg")],
      phone: [$f(".f-ph-num")],
      geo: [$f(".f-geo-lat"), $f(".f-geo-lng")],
    };

    let currentType: PayloadType = "text";
    let lastQr: Encoded | null = null;

    function setStatus(kind: string, msg: string) {
      $status.className = "statusbar " + kind;
      $statusText.textContent = msg;
    }

    function fieldValue(f: Field): string {
      if (f instanceof HTMLInputElement && f.type === "checkbox") return f.checked ? "1" : "0";
      return f.value;
    }

    /** The Payload for the active type, or a reason there is none yet. */
    function composePayload(): { payload: string } | { waiting: true } | { error: string } {
      const v = FIELDS[currentType].map(fieldValue);
      switch (currentType) {
        case "text":
          if (!v[0]!.trim()) return { waiting: true };
          return { payload: v[0]! };
        case "wifi": {
          if (!v[0] && !v[1]) return { waiting: true };
          if (!v[0]) return { error: "Enter the network name." };
          return { payload: wifiPayload(v[0]!, v[1]!, v[2] as WifiAuth, v[3] === "1") };
        }
        case "contact": {
          if (v.every((x) => !x.trim())) return { waiting: true };
          if (!v[0]!.trim() && !v[1]!.trim()) return { error: "Enter at least a name." };
          const c: ContactFields = { first: v[0]!.trim(), last: v[1]!.trim(), phone: v[2]!.trim(), email: v[3]!.trim(), org: v[4]!.trim(), title: v[5]!.trim(), url: v[6]!.trim() };
          return { payload: vcardPayload(c) };
        }
        case "email":
          if (!v[0]!.trim()) return v[1] || v[2] ? { error: "Enter the destination address." } : { waiting: true };
          return { payload: emailPayload(v[0]!.trim(), v[1]!, v[2]!) };
        case "sms":
          if (!v[0]!.trim()) return v[1] ? { error: "Enter the phone number." } : { waiting: true };
          return { payload: smsPayload(v[0]!, v[1]!) };
        case "phone":
          if (!v[0]!.trim()) return { waiting: true };
          return { payload: phonePayload(v[0]!) };
        case "geo": {
          if (!v[0]!.trim() && !v[1]!.trim()) return { waiting: true };
          const lat = Number(v[0]);
          const lng = Number(v[1]);
          if (!v[0]!.trim() || !v[1]!.trim() || !Number.isFinite(lat) || !Number.isFinite(lng)) return { error: "Enter numeric latitude and longitude." };
          if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return { error: "Latitude must be within ±90 and longitude within ±180." };
          return { payload: geoPayload(v[0]!, v[1]!) };
        }
      }
    }

    function clampedSize(): number {
      const n = Math.round(Number($size.value));
      if (!Number.isFinite(n)) return 512;
      return Math.min(4096, Math.max(64, n));
    }

    /** State layout: `<type>.<ecl>.<size>.<fg>.<bg>.<compressed field values>`. */
    function publishState(): boolean {
      const packed = LZString.compressToEncodedURIComponent(JSON.stringify(FIELDS[currentType].map(fieldValue)));
      const head = [currentType, $ecl.value, clampedSize(), $fg.value.slice(1), $bg.value.slice(1)];
      const fits = packed.length <= STATE_CAP;
      ctx.setState(head.concat(fits ? packed : "").join("."));
      return fits;
    }

    function showEmpty(msg: string, kind = "") {
      lastQr = null;
      $canvas.hidden = true;
      $empty.style.display = "";
      setStatus(kind, msg);
    }

    function run() {
      const composed = composePayload();
      const linked = publishState();
      if ("waiting" in composed) {
        showEmpty("Waiting for input");
        return;
      }
      if ("error" in composed) {
        showEmpty(composed.error, "error");
        return;
      }
      try {
        const qr = encode(composed.payload, $ecl.value as Ecl);
        lastQr = qr;
        const px = drawCanvas($canvas, qr, clampedSize(), $fg.value, $bg.value);
        $canvas.hidden = false;
        $empty.style.display = "none";
        const warning = contrastWarning($fg.value, $bg.value);
        setStatus(warning ? "warn" : "ok",
          "v" + qr.version + " · " + qr.size + "×" + qr.size + " modules · " + qr.mode + " mode · " + px + "×" + px + " px" +
          (warning ? " · " + warning : "") + (linked ? "" : " · too large to keep in the URL"));
      } catch (e) {
        showEmpty((e as Error).message, "error");
      }
    }

    function selectType(type: PayloadType) {
      currentType = type;
      for (const b of typeButtons) b.classList.toggle("active", b.dataset.type === type);
      for (const f of el.querySelectorAll<HTMLElement>(".form")) f.hidden = f.dataset.form !== type;
      run();
    }

    ctx.onRestore((payload) => {
      const parts = payload.split(".");
      const [type, ecl, size, fg, bg] = parts;
      const packed = parts.slice(5).join(".");
      if (ecl === "L" || ecl === "M" || ecl === "Q" || ecl === "H") $ecl.value = ecl;
      if (/^\d+$/.test(size ?? "")) $size.value = String(Math.min(4096, Math.max(64, Number(size))));
      if (/^[0-9a-fA-F]{6}$/.test(fg ?? "")) $fg.value = "#" + fg!.toLowerCase();
      if (/^[0-9a-fA-F]{6}$/.test(bg ?? "")) $bg.value = "#" + bg!.toLowerCase();
      const restored: PayloadType = TYPES.includes(type as PayloadType) ? (type as PayloadType) : "text";
      if (packed) {
        try {
          const values = JSON.parse(LZString.decompressFromEncodedURIComponent(packed) || "[]");
          if (Array.isArray(values)) {
            FIELDS[restored].forEach((f, i) => {
              if (typeof values[i] !== "string") return;
              if (f instanceof HTMLInputElement && f.type === "checkbox") f.checked = values[i] === "1";
              else f.value = values[i];
            });
          }
        } catch { /* malformed payload: restore options only */ }
      }
      selectType(restored);
    });

    let timer: ReturnType<typeof setTimeout>;
    function schedule() {
      clearTimeout(timer);
      timer = setTimeout(run, 120);
    }

    for (const b of typeButtons) b.addEventListener("click", () => selectType(b.dataset.type as PayloadType));
    el.querySelector(".forms")!.addEventListener("input", schedule);
    $ecl.addEventListener("change", run);
    $size.addEventListener("input", schedule);
    $fg.addEventListener("input", schedule);
    $bg.addEventListener("input", schedule);

    $(".btn-clear").addEventListener("click", () => {
      for (const f of FIELDS[currentType]) {
        if (f instanceof HTMLInputElement && f.type === "checkbox") f.checked = false;
        else if (f instanceof HTMLSelectElement) f.selectedIndex = 0;
        else f.value = "";
      }
      run();
      (FIELDS[currentType][0] as HTMLElement).focus();
    });

    $(".btn-png").addEventListener("click", () => {
      if (!lastQr) return;
      $canvas.toBlob((blob) => {
        if (blob) downloadBlob(blob, "qr-code.png");
      }, "image/png");
    });

    $(".btn-svg").addEventListener("click", () => {
      if (!lastQr) return;
      downloadBlob(new Blob([svgString(lastQr, $fg.value, $bg.value)], { type: "image/svg+xml" }), "qr-code.svg");
    });

    $btnCopy.addEventListener("click", async () => {
      if (!lastQr) return;
      try {
        const blob = await new Promise<Blob>((resolve, reject) => {
          $canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("no blob"))), "image/png");
        });
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        const old = $btnCopy.textContent;
        $btnCopy.textContent = "Copied";
        setTimeout(() => { $btnCopy.textContent = old; }, 1200);
      } catch {
        setStatus("error", "Could not copy the image to the clipboard.");
      }
    });
  },
};

export default tool;
