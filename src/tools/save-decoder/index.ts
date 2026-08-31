// Adopted from coderpatsy's save decoder (coderpatsy.bitbucket.io/decoder.html).
import LZString from "lz-string";
import "./tool.css";
import type { Tool } from "../../shell/types";

function formatBytes(n: number) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(2) + " MB";
}

/** Longest encoded save we are willing to put in the Deep Link. */
const STATE_CAP = 30000;

const tool: Tool = {
  id: "save-decoder",
  name: "LZString Save Decoder",
  subtitle: "Decode and encode LZString-compressed base64 saves from incremental games.",
  keywords: ["lzstring", "lz-string", "save", "decode", "encode", "base64", "json", "compress", "kittens"],
  mount(el, ctx) {
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
            <span>encoded</span>
            <span class="spacer"></span>
            <button class="btn-paste-enc" type="button">Paste<span class="wide-only"> from clipboard</span></button>
            <button class="btn-clear-enc" type="button">Clear</button>
            <button class="btn-copy-enc primary" type="button">Copy</button>
          </div>
          <textarea class="src enc" spellcheck="false" autocapitalize="off" autocomplete="off"
            placeholder="Paste an LZString-compressed base64 save here to decode it."></textarea>
          <div class="statusbar enc-status"><span class="dot">&#9679;</span><span class="status-text">Waiting for input</span></div>
        </section>
        <section class="pane">
          <div class="pane-head">
            <span>decoded</span>
            <span class="spacer"></span>
            <button class="btn-paste-dec" type="button">Paste<span class="wide-only"> from clipboard</span></button>
            <button class="btn-clear-dec" type="button">Clear</button>
            <button class="btn-copy-dec primary" type="button">Copy</button>
          </div>
          <textarea class="src dec" spellcheck="false" autocapitalize="off" autocomplete="off"
            placeholder="Paste or edit JSON here to encode it."></textarea>
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

    /** State layout: `<indent>.<encoded save, base64 with + and / made URL-safe>`. */
    function publishState(): boolean {
      const raw = $enc.value.replace(/\s+/g, "");
      let packed = "";
      let fits = true;
      if (raw && /^[A-Za-z0-9+/=]+$/.test(raw)) {
        if (raw.length <= STATE_CAP) packed = raw.replace(/\+/g, "-").replace(/\//g, "_");
        else fits = false;
      }
      ctx.setState($optIndent.value + "." + packed);
      return fits;
    }

    function decode() {
      const raw = $enc.value.replace(/\s+/g, "");
      const linked = publishState();
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
      setStatus($encStatus, "ok", formatBytes(raw.length) + " decoded to " + formatBytes(out.length) + " (" + note + ")" +
        (linked ? "" : " · too large to keep in the URL"));
      setStatus($decStatus, "", "Decoded output");
    }

    function encode() {
      const raw = $dec.value.trim();
      if (!raw) {
        setStatus($decStatus, "", "Waiting for input");
        return;
      }
      let data: string;
      try {
        data = JSON.stringify(JSON.parse(raw));
      } catch (e) {
        // Refuse rather than compress broken text: games JSON.parse the
        // decompressed payload and would surface this error on import.
        setStatus($decStatus, "error", "Not valid JSON, not encoding. " + (e as Error).message);
        return;
      }
      const encoded = LZString.compressToBase64(data);
      $enc.value = encoded;
      const linked = publishState();
      setStatus($decStatus, "ok", formatBytes(raw.length) + " encoded to " + formatBytes(encoded.length) + " (JSON, minified)" +
        (linked ? "" : " · too large to keep in the URL"));
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
      else publishState();
    });

    ctx.onRestore((payload) => {
      const dot = payload.indexOf(".");
      const indent = dot === -1 ? payload : payload.slice(0, dot);
      const packed = dot === -1 ? "" : payload.slice(dot + 1);
      if (["2", "4", "tab", "off"].includes(indent)) $optIndent.value = indent;
      if (packed) $enc.value = packed.replace(/-/g, "+").replace(/_/g, "/");
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
      publishState();
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
