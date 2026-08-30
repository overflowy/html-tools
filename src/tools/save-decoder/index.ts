// Adopted from coderpatsy's save decoder (coderpatsy.bitbucket.io/decoder.html).
import LZString from "lz-string";
import "./tool.css";
import type { Tool } from "../../shell/types";

function formatBytes(n: number) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(2) + " MB";
}

const tool: Tool = {
  id: "save-decoder",
  name: "LZString Save Decoder",
  subtitle: "Decode and encode LZString-compressed base64 saves from incremental games.",
  keywords: ["lzstring", "lz-string", "save", "decode", "encode", "base64", "json", "compress", "kittens"],
  mount(el) {
    el.innerHTML = `
      <div class="options">
        <label class="opt">indent
          <select class="opt-indent">
            <option value="2">2 spaces</option>
            <option value="4" selected>4 spaces</option>
            <option value="tab">tab</option>
            <option value="off">off</option>
          </select>
        </label>
      </div>
      <div class="panes">
        <section class="pane">
          <div class="pane-head">
            <span>encoded.txt</span>
            <span class="spacer"></span>
            <button class="btn-paste-enc" type="button">Paste from clipboard</button>
            <button class="btn-clear-enc" type="button">Clear</button>
            <button class="btn-copy-enc" type="button">Copy</button>
          </div>
          <textarea class="src enc" spellcheck="false" autocapitalize="off" autocomplete="off"
            placeholder="Paste an LZString-compressed base64 save here to decode it."></textarea>
          <div class="statusbar enc-status"><span class="dot">&#9679;</span><span class="status-text">Waiting for input</span></div>
        </section>
        <section class="pane">
          <div class="pane-head">
            <span>decoded.json</span>
            <span class="spacer"></span>
            <button class="btn-paste-dec" type="button">Paste from clipboard</button>
            <button class="btn-clear-dec" type="button">Clear</button>
            <button class="btn-copy-dec primary" type="button">Copy</button>
          </div>
          <textarea class="src dec" spellcheck="false" autocapitalize="off" autocomplete="off"
            placeholder="Paste JSON (or any text) here to encode it."></textarea>
          <div class="statusbar dec-status"><span class="dot">&#9679;</span><span class="status-text">Waiting for input</span></div>
        </section>
      </div>`;

    const $enc = el.querySelector(".enc") as HTMLTextAreaElement;
    const $dec = el.querySelector(".dec") as HTMLTextAreaElement;
    const $encStatus = el.querySelector(".enc-status") as HTMLElement;
    const $decStatus = el.querySelector(".dec-status") as HTMLElement;
    const $optIndent = el.querySelector(".opt-indent") as HTMLSelectElement;

    function setStatus(bar: HTMLElement, kind: string, msg: string) {
      bar.className = bar.className.replace(/ (ok|error)$/, "");
      if (kind) bar.className += " " + kind;
      (bar.querySelector(".status-text") as HTMLElement).textContent = msg;
    }

    function indentValue(): string | null {
      const v = $optIndent.value;
      if (v === "off") return null;
      return v === "tab" ? "\t" : " ".repeat(Number(v));
    }

    function decode() {
      const raw = $enc.value.replace(/\s+/g, "");
      if (!raw) {
        setStatus($encStatus, "", "Waiting for input");
        return;
      }
      let decoded: string | null = null;
      try {
        decoded = LZString.decompressFromBase64(raw);
      } catch {
        decoded = null;
      }
      if (decoded === null || decoded === "") {
        setStatus($encStatus, "error", "Not a valid LZString base64 save");
        return;
      }
      let out = decoded;
      let note = "plain text";
      const indent = indentValue();
      try {
        const json = JSON.parse(decoded);
        note = "JSON";
        out = indent === null ? JSON.stringify(json) : JSON.stringify(json, null, indent);
      } catch {
        // not JSON: show the raw decoded string
      }
      $dec.value = out;
      setStatus($encStatus, "ok", formatBytes(raw.length) + " decoded to " + formatBytes(out.length) + " (" + note + ")");
      setStatus($decStatus, "", "Decoded output");
    }

    function encode() {
      const raw = $dec.value.trim();
      if (!raw) {
        setStatus($decStatus, "", "Waiting for input");
        return;
      }
      let data = raw;
      let note = "plain text";
      try {
        data = JSON.stringify(JSON.parse(raw));
        note = "JSON, minified";
      } catch {
        // not JSON: compress as-is
      }
      const encoded = LZString.compressToBase64(data);
      $enc.value = encoded;
      setStatus($decStatus, "ok", formatBytes(raw.length) + " encoded to " + formatBytes(encoded.length) + " (" + note + ")");
      setStatus($encStatus, "", "Encoded output");
    }

    let timer: ReturnType<typeof setTimeout>;
    function schedule(fn: () => void) {
      clearTimeout(timer);
      timer = setTimeout(fn, 120);
    }

    $enc.addEventListener("input", () => schedule(decode));
    $dec.addEventListener("input", () => schedule(encode));
    $optIndent.addEventListener("change", () => {
      if ($enc.value.trim()) decode();
    });

    async function pasteInto(area: HTMLTextAreaElement, run: () => void, bar: HTMLElement) {
      try {
        area.value = await navigator.clipboard.readText();
        run();
      } catch {
        setStatus(bar, "error", "Clipboard access denied. Paste manually into the text area instead.");
      }
    }

    function copyFrom(area: HTMLTextAreaElement, btn: HTMLButtonElement) {
      if (!area.value) return;
      navigator.clipboard.writeText(area.value).then(() => {
        const old = btn.textContent;
        btn.textContent = "Copied";
        setTimeout(() => { btn.textContent = old; }, 1200);
      });
    }

    (el.querySelector(".btn-paste-enc") as HTMLButtonElement).addEventListener("click", () => pasteInto($enc, decode, $encStatus));
    (el.querySelector(".btn-paste-dec") as HTMLButtonElement).addEventListener("click", () => pasteInto($dec, encode, $decStatus));
    (el.querySelector(".btn-copy-enc") as HTMLButtonElement).addEventListener("click", function () { copyFrom($enc, this); });
    (el.querySelector(".btn-copy-dec") as HTMLButtonElement).addEventListener("click", function () { copyFrom($dec, this); });
    (el.querySelector(".btn-clear-enc") as HTMLButtonElement).addEventListener("click", () => {
      $enc.value = "";
      setStatus($encStatus, "", "Waiting for input");
      $enc.focus();
    });
    (el.querySelector(".btn-clear-dec") as HTMLButtonElement).addEventListener("click", () => {
      $dec.value = "";
      setStatus($decStatus, "", "Waiting for input");
      $dec.focus();
    });
  },
};

export default tool;
