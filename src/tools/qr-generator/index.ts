import LZString from "lz-string";

import "./tool.css";
import type { Tool, ToolContext } from "../../shell/types";
import {
  emailPayload,
  geoPayload,
  phonePayload,
  smsPayload,
  vcardPayload,
  wifiPayload,
} from "./payload";
import type { ContactFields, WifiAuth } from "./payload";
import { encode } from "./qrcode";
import type { Ecl, Encoded } from "./qrcode";

/** Longest compressed field blob we are willing to put in the Deep Link. */
const STATE_CAP = 30_000;

const QUIET_ZONE = 4;

const TYPES = [
  "text",
  "wifi",
  "contact",
  "email",
  "sms",
  "phone",
  "geo",
] as const;
type PayloadType = (typeof TYPES)[number];

/* ---------------- color helpers ---------------- */

const luminance = (hex: string): number => {
  const channel = (i: number) => {
    const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
};

/** "" when the colors scan fine, otherwise a status-bar warning. */
const contrastWarning = (fg: string, bg: string): string => {
  const lumFg = luminance(fg);
  const lumBg = luminance(bg);
  if (lumFg >= lumBg) {
    return "inverted colors: scanners expect a dark code on a light background";
  }
  const ratio = (lumBg + 0.05) / (lumFg + 0.05);
  if (ratio < 2.5) {
    return "low contrast: may not scan";
  }
  return "";
};

/* ---------------- rendering ---------------- */

/** Draw at an integer scale nearest the requested size; returns the actual pixel size. */
const drawCanvas = (
  canvas: HTMLCanvasElement,
  qr: Encoded,
  target: number,
  fg: string,
  bg: string
): number => {
  const total = qr.size + QUIET_ZONE * 2;
  const scale = Math.max(1, Math.round(target / total));
  const px = scale * total;
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("This browser cannot draw on a canvas.");
  }
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = fg;
  for (let y = 0; y < qr.size; y += 1) {
    for (let x = 0; x < qr.size; x += 1) {
      if (qr.matrix[y * qr.size + x]) {
        ctx.fillRect(
          (x + QUIET_ZONE) * scale,
          (y + QUIET_ZONE) * scale,
          scale,
          scale
        );
      }
    }
  }
  return px;
};

const svgString = (qr: Encoded, fg: string, bg: string): string => {
  const total = qr.size + QUIET_ZONE * 2;
  const parts: string[] = [];
  for (let y = 0; y < qr.size; y += 1) {
    for (let x = 0; x < qr.size; x += 1) {
      if (qr.matrix[y * qr.size + x]) {
        parts.push(`M${x + QUIET_ZONE} ${y + QUIET_ZONE}h1v1h-1z`);
      }
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${
      total
    }" shape-rendering="crispEdges">` +
    `<rect width="${total}" height="${total}" fill="${bg}"/>` +
    `<path d="${parts.join("")}" fill="${fg}"/></svg>`
  );
};

const downloadBlob = (blob: Blob, filename: string) => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};

/* ---------------- payload composition ---------------- */

/** A finished Payload, or why there is none: fields still empty, or an error to show. */
type Composed = { payload: string } | { waiting: true } | { error: string };

const WAITING: Composed = { waiting: true };

const composeEmail = ([to, subject, body]: string[]): Composed => {
  if (!to.trim()) {
    return subject || body
      ? { error: "Enter the destination address." }
      : WAITING;
  }
  return { payload: emailPayload(to.trim(), subject, body) };
};

const composeGeo = ([lat, lng]: string[]): Composed => {
  const latText = lat.trim();
  const lngText = lng.trim();
  if (!latText && !lngText) {
    return WAITING;
  }
  const latValue = Number(lat);
  const lngValue = Number(lng);
  if (
    !latText ||
    !lngText ||
    !Number.isFinite(latValue) ||
    !Number.isFinite(lngValue)
  ) {
    return { error: "Enter numeric latitude and longitude." };
  }
  if (Math.abs(latValue) > 90 || Math.abs(lngValue) > 180) {
    return {
      error: "Latitude must be within ±90 and longitude within ±180.",
    };
  }
  return { payload: geoPayload(lat, lng) };
};

/** Composers by type; each receives the values of that type's FIELDS, in order. */
const COMPOSERS: Record<PayloadType, (values: string[]) => Composed> = {
  contact: (values) => {
    if (values.every((x) => !x.trim())) {
      return WAITING;
    }
    const [first, last, phone, email, org, title, url] = values.map((x) =>
      x.trim()
    );
    if (!first && !last) {
      return { error: "Enter at least a name." };
    }
    const c: ContactFields = { email, first, last, org, phone, title, url };
    return { payload: vcardPayload(c) };
  },
  email: composeEmail,
  geo: composeGeo,
  phone: ([number]) => {
    if (!number.trim()) {
      return WAITING;
    }
    return { payload: phonePayload(number) };
  },
  sms: ([number, message]) => {
    if (!number.trim()) {
      return message ? { error: "Enter the phone number." } : WAITING;
    }
    return { payload: smsPayload(number, message) };
  },
  text: ([text]) => {
    if (!text.trim()) {
      return WAITING;
    }
    return { payload: text };
  },
  wifi: ([ssid, password, auth, hidden]) => {
    if (!ssid && !password) {
      return WAITING;
    }
    if (!ssid) {
      return { error: "Enter the network name." };
    }
    return {
      payload: wifiPayload(ssid, password, auth as WifiAuth, hidden === "1"),
    };
  },
};

/* ---------------- UI ---------------- */

const textField = (cls: string, label: string, placeholder = "") =>
  `<label class="field">${label}<input type="text" class="${
    cls
  }" placeholder="${
    placeholder
  }" spellcheck="false" autocapitalize="off" autocomplete="off"></label>`;

const mount = (el: HTMLElement, ctx: ToolContext) => {
  el.innerHTML = `
      <div class="type-row seg" role="tablist" aria-label="Payload type">
        <button type="button" role="tab" aria-selected="true" data-type="text" class="active">Text / URL</button>
        <button type="button" role="tab" aria-selected="false" data-type="wifi">WiFi</button>
        <button type="button" role="tab" aria-selected="false" data-type="contact">Contact</button>
        <button type="button" role="tab" aria-selected="false" data-type="email">Email</button>
        <button type="button" role="tab" aria-selected="false" data-type="sms">SMS</button>
        <button type="button" role="tab" aria-selected="false" data-type="phone">Phone</button>
        <button type="button" role="tab" aria-selected="false" data-type="geo">Geo</button>
      </div>
      <div class="options">
        <label class="opt">Error correction
          <select class="opt-ecl">
            <option value="L">L · lowest</option>
            <option value="M" selected>M · medium</option>
            <option value="Q">Q · high</option>
            <option value="H">H · highest</option>
          </select>
        </label>
        <label class="opt">Size
          <input type="number" class="opt-size" value="512" min="64" max="4096" step="16"> px
        </label>
        <label class="opt">Code
          <span class="swatch"><input type="color" class="opt-fg" value="#000000"></span>
        </label>
        <label class="opt">Background
          <span class="swatch"><input type="color" class="opt-bg" value="#ffffff"></span>
        </label>
      </div>
      <div class="panes">
        <section class="pane">
          <div class="pane-head">
            <span>Input</span>
            <span class="spacer"></span>
            <button class="btn-clear" type="button">Clear</button>
          </div>
          <div class="forms">
            <div class="form" data-form="text">
              <textarea class="f-text" spellcheck="false" autocapitalize="off" autocomplete="off"
                placeholder="Type or paste any text or URL."></textarea>
            </div>
            <div class="form" data-form="wifi" hidden>
              ${textField("f-wifi-ssid", "Network name (SSID)")}
              ${textField("f-wifi-pass", "Password")}
              <label class="field">Security
                <select class="f-wifi-auth">
                  <option value="WPA" selected>WPA / WPA2 / WPA3</option>
                  <option value="WEP">WEP</option>
                  <option value="nopass">None (open network)</option>
                </select>
              </label>
              <label class="field check"><input type="checkbox" class="f-wifi-hidden">Hidden network</label>
            </div>
            <div class="form" data-form="contact" hidden>
              <div class="field-pair">
                ${textField("f-ct-first", "First name")}
                ${textField("f-ct-last", "Last name")}
              </div>
              ${textField("f-ct-phone", "Phone", "+1 555 0100")}
              ${textField("f-ct-email", "Email")}
              ${textField("f-ct-org", "Organization")}
              ${textField("f-ct-title", "Job title")}
              ${textField("f-ct-url", "Website", "https://")}
            </div>
            <div class="form" data-form="email" hidden>
              ${textField("f-em-to", "To", "someone@example.com")}
              ${textField("f-em-subject", "Subject")}
              <label class="field">Body<textarea class="f-em-body" spellcheck="false"></textarea></label>
            </div>
            <div class="form" data-form="sms" hidden>
              ${textField("f-sms-num", "Phone number", "+1 555 0100")}
              <label class="field">Message<textarea class="f-sms-msg" spellcheck="false"></textarea></label>
            </div>
            <div class="form" data-form="phone" hidden>
              ${textField("f-ph-num", "Phone number", "+1 555 0100")}
            </div>
            <div class="form" data-form="geo" hidden>
              <div class="field-pair">
                ${textField("f-geo-lat", "Latitude", "52.520008")}
                ${textField("f-geo-lng", "Longitude", "13.404954")}
              </div>
            </div>
          </div>
          <div class="statusbar"><span class="status-text"></span></div>
        </section>
        <section class="pane">
          <div class="pane-head">
            <span>Preview</span>
            <span class="spacer"></span>
            <button class="btn-png" type="button" disabled><span class="wide-only">Download </span>PNG</button>
            <button class="btn-svg" type="button" disabled><span class="wide-only">Download </span>SVG</button>
            <button class="btn-copy primary" type="button" disabled>Copy</button>
          </div>
          <div class="preview-frame">
            <canvas class="qr-canvas" hidden></canvas>
          </div>
        </section>
      </div>`;

  const $ = (sel: string): HTMLElement => {
    const node = el.querySelector<HTMLElement>(sel);
    if (!node) {
      throw new Error(`QR generator markup has no ${sel}`);
    }
    return node;
  };
  const $status = $(".statusbar");
  const $statusText = $(".status-text");
  const $canvas = $(".qr-canvas") as HTMLCanvasElement;
  const $ecl = $(".opt-ecl") as HTMLSelectElement;
  const $size = $(".opt-size") as HTMLInputElement;
  const $fg = $(".opt-fg") as HTMLInputElement;
  const $bg = $(".opt-bg") as HTMLInputElement;
  const $btnCopy = $(".btn-copy") as HTMLButtonElement;
  // Download and Copy act on the code shown, so they wait for one.
  const $exports = [
    $(".btn-png"),
    $(".btn-svg"),
    $btnCopy,
  ] as HTMLButtonElement[];
  const typeButtons = [
    ...el.querySelectorAll(".type-row button"),
  ] as HTMLButtonElement[];

  type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  const $f = (sel: string) => $(sel) as Field;

  // Every form field, keyed by payload type, in a stable order for the Deep Link.
  const FIELDS: Record<PayloadType, Field[]> = {
    contact: [
      $f(".f-ct-first"),
      $f(".f-ct-last"),
      $f(".f-ct-phone"),
      $f(".f-ct-email"),
      $f(".f-ct-org"),
      $f(".f-ct-title"),
      $f(".f-ct-url"),
    ],
    email: [$f(".f-em-to"), $f(".f-em-subject"), $f(".f-em-body")],
    geo: [$f(".f-geo-lat"), $f(".f-geo-lng")],
    phone: [$f(".f-ph-num")],
    sms: [$f(".f-sms-num"), $f(".f-sms-msg")],
    text: [$f(".f-text")],
    wifi: [
      $f(".f-wifi-ssid"),
      $f(".f-wifi-pass"),
      $f(".f-wifi-auth"),
      $f(".f-wifi-hidden"),
    ],
  };

  let currentType: PayloadType = "text";
  let lastQr: Encoded | null = null;

  const setStatus = (kind: string, msg: string) => {
    $status.className = `statusbar ${kind}`;
    $statusText.textContent = msg;
  };

  const fieldValue = (f: Field): string => {
    if (f instanceof HTMLInputElement && f.type === "checkbox") {
      return f.checked ? "1" : "0";
    }
    return f.value;
  };

  /** The Payload for the active type, or a reason there is none yet. */
  const composePayload = (): Composed =>
    COMPOSERS[currentType](FIELDS[currentType].map(fieldValue));

  const clampedSize = (): number => {
    const n = Math.round(Number($size.value));
    if (!Number.isFinite(n)) {
      return 512;
    }
    return Math.min(4096, Math.max(64, n));
  };

  /** State layout: `<type>.<ecl>.<size>.<fg>.<bg>.<compressed field values>`. */
  const publishState = (): boolean => {
    const packed = LZString.compressToEncodedURIComponent(
      JSON.stringify(FIELDS[currentType].map(fieldValue))
    );
    const head = [
      currentType,
      $ecl.value,
      clampedSize(),
      $fg.value.slice(1),
      $bg.value.slice(1),
    ];
    const fits = packed.length <= STATE_CAP;
    ctx.setState([...head, fits ? packed : ""].join("."));
    return fits;
  };

  const clearPreview = (msg: string, kind = "") => {
    lastQr = null;
    for (const b of $exports) {
      b.disabled = true;
    }
    $canvas.hidden = true;
    setStatus(kind, msg);
  };

  const run = () => {
    const composed = composePayload();
    const linked = publishState();
    if ("waiting" in composed) {
      clearPreview("");
      return;
    }
    if ("error" in composed) {
      clearPreview(composed.error, "error");
      return;
    }
    try {
      const qr = encode(composed.payload, $ecl.value as Ecl);
      lastQr = qr;
      for (const b of $exports) {
        b.disabled = false;
      }
      const px = drawCanvas($canvas, qr, clampedSize(), $fg.value, $bg.value);
      $canvas.hidden = false;
      const warning = contrastWarning($fg.value, $bg.value);
      setStatus(
        warning ? "warn" : "ok",
        `v${qr.version} · ${qr.size}×${qr.size} modules · ${qr.mode} mode · ${
          px
        }×${px} px${
          warning ? ` · ${warning}` : ""
        }${linked ? "" : " · too large to keep in the URL"}`
      );
    } catch (error) {
      clearPreview((error as Error).message, "error");
    }
  };

  const selectType = (type: PayloadType) => {
    currentType = type;
    for (const b of typeButtons) {
      const on = b.dataset.type === type;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", String(on));
    }
    for (const f of el.querySelectorAll<HTMLElement>(".form")) {
      f.hidden = f.dataset.form !== type;
    }
    run();
  };

  ctx.onRestore((payload) => {
    const parts = payload.split(".");
    const [type, ecl, size, fg, bg] = parts;
    const packed = parts.slice(5).join(".");
    if (ecl === "L" || ecl === "M" || ecl === "Q" || ecl === "H") {
      $ecl.value = ecl;
    }
    if (/^\d+$/u.test(size ?? "")) {
      $size.value = String(Math.min(4096, Math.max(64, Number(size))));
    }
    if (fg !== undefined && /^[0-9a-fA-F]{6}$/u.test(fg)) {
      $fg.value = `#${fg.toLowerCase()}`;
    }
    if (bg !== undefined && /^[0-9a-fA-F]{6}$/u.test(bg)) {
      $bg.value = `#${bg.toLowerCase()}`;
    }
    const restored: PayloadType = TYPES.includes(type as PayloadType)
      ? (type as PayloadType)
      : "text";
    if (packed) {
      try {
        const values = JSON.parse(
          LZString.decompressFromEncodedURIComponent(packed) || "[]"
        );
        if (Array.isArray(values)) {
          for (const [i, f] of FIELDS[restored].entries()) {
            const value: unknown = values[i];
            if (typeof value !== "string") {
              continue;
            }
            if (f instanceof HTMLInputElement && f.type === "checkbox") {
              f.checked = value === "1";
            } else {
              f.value = value;
            }
          }
        }
      } catch {
        /* malformed payload: restore options only */
      }
    }
    selectType(restored);
  });

  let timer: ReturnType<typeof setTimeout>;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(run, 120);
  };

  for (const b of typeButtons) {
    b.addEventListener("click", () =>
      selectType(b.dataset.type as PayloadType)
    );
  }
  $(".forms").addEventListener("input", schedule);
  $ecl.addEventListener("change", run);
  $size.addEventListener("input", schedule);
  $fg.addEventListener("input", schedule);
  $bg.addEventListener("input", schedule);

  $(".btn-clear").addEventListener("click", () => {
    for (const f of FIELDS[currentType]) {
      if (f instanceof HTMLInputElement && f.type === "checkbox") {
        f.checked = false;
      } else if (f instanceof HTMLSelectElement) {
        f.selectedIndex = 0;
      } else {
        f.value = "";
      }
    }
    run();
    (FIELDS[currentType][0] as HTMLElement).focus();
  });

  $(".btn-png").addEventListener("click", () => {
    if (!lastQr) {
      return;
    }
    $canvas.toBlob((blob) => {
      if (blob) {
        downloadBlob(blob, "qr-code.png");
      }
    }, "image/png");
  });

  $(".btn-svg").addEventListener("click", () => {
    if (!lastQr) {
      return;
    }
    downloadBlob(
      new Blob([svgString(lastQr, $fg.value, $bg.value)], {
        type: "image/svg+xml",
      }),
      "qr-code.svg"
    );
  });

  $btnCopy.addEventListener("click", async () => {
    if (!lastQr) {
      return;
    }
    try {
      const encoded = Promise.withResolvers<Blob>();
      $canvas.toBlob(
        (b) => (b ? encoded.resolve(b) : encoded.reject(new Error("no blob"))),
        "image/png"
      );
      const blob = await encoded.promise;
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]);
      const old = $btnCopy.textContent;
      $btnCopy.textContent = "Copied";
      setTimeout(() => {
        $btnCopy.textContent = old;
      }, 1200);
    } catch {
      setStatus("error", "Could not copy the image to the clipboard.");
    }
  });
};

const tool: Tool = {
  id: "qr-generator",
  keywords: [
    "qr",
    "qr code",
    "generator",
    "wifi",
    "vcard",
    "contact",
    "barcode",
    "url",
    "link",
    "email",
    "sms",
    "phone",
    "geo",
    "share",
  ],
  mount,
  name: "QR Code Generator",
  subtitle: "Make a QR code and download it as PNG or SVG.",
};

export default tool;
