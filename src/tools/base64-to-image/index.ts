import "./tool.css";
import type { Tool } from "../../shell/types";

function detectMime(b64: string) {
  const sig = b64.slice(0, 16);
  if (sig.startsWith("iVBORw0KGgo")) return { mime: "image/png", ext: "png" };
  if (sig.startsWith("/9j/")) return { mime: "image/jpeg", ext: "jpg" };
  if (sig.startsWith("R0lGOD")) return { mime: "image/gif", ext: "gif" };
  if (sig.startsWith("UklGR")) return { mime: "image/webp", ext: "webp" };
  if (sig.startsWith("PHN2Zy") || sig.startsWith("PD94bW")) return { mime: "image/svg+xml", ext: "svg" };
  if (sig.startsWith("Qk")) return { mime: "image/bmp", ext: "bmp" };
  if (sig.startsWith("AAABAA")) return { mime: "image/x-icon", ext: "ico" };
  return { mime: "image/png", ext: "png" };
}

function formatBytes(n: number) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(2) + " MB";
}

const tool: Tool = {
  id: "base64-to-image",
  name: "Base64 to Image",
  subtitle: "Paste a base64 string or data URI.",
  keywords: ["base64", "image", "decode", "convert", "data uri", "png", "preview"],
  mount(el) {
    el.innerHTML = `
      <div class="container">
        <div class="toolbar">
          <button type="button" class="paste-btn">Paste from clipboard</button>
          <button type="button" class="clear-btn">Clear</button>
          <span class="status"></span>
        </div>
        <textarea class="b64-input" placeholder="Paste your base64 string here. Data URI prefix (data:image/png;base64,...) is fine; it'll be stripped automatically."></textarea>
        <div class="drop-zone">
          Or drop a .txt file containing base64 here
          <input type="file" accept=".txt,text/plain" hidden>
        </div>
        <div class="output">
          <div class="output-header">
            <div class="meta"></div>
            <div class="actions">
              <button type="button" class="copy-btn">Copy data URI</button>
              <button type="button" class="download-btn">Download</button>
            </div>
          </div>
          <div class="preview-frame">
            <img class="preview" alt="Decoded preview">
          </div>
        </div>
        <div class="error-box"></div>
      </div>`;

    const $ = (sel: string) => el.querySelector(sel) as HTMLElement;
    const input = $(".b64-input") as HTMLTextAreaElement;
    const status = $(".status");
    const outputArea = $(".output");
    const preview = $(".preview") as HTMLImageElement;
    const meta = $(".meta");
    const errorBox = $(".error-box");
    const dropZone = $(".drop-zone");
    const fileInput = $(".drop-zone input") as HTMLInputElement;
    const copyBtn = $(".copy-btn");

    let currentDataUri = "";
    let currentExt = "png";

    function showError(msg: string) {
      errorBox.textContent = msg;
      errorBox.style.display = "block";
      outputArea.style.display = "none";
      status.textContent = "";
    }

    function clearError() {
      errorBox.style.display = "none";
    }

    function convert(raw: string) {
      clearError();
      if (!raw || !raw.trim()) {
        outputArea.style.display = "none";
        status.textContent = "";
        return;
      }

      let b64 = raw.trim();
      let declaredMime: string | null = null;
      const dataUriMatch = b64.match(/^data:([^;]+);base64,(.+)$/);
      if (dataUriMatch) {
        declaredMime = dataUriMatch[1]!;
        b64 = dataUriMatch[2]!;
      }
      b64 = b64.replace(/\s+/g, "");

      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
        showError("Invalid base64: contains characters outside the base64 alphabet.");
        return;
      }

      let byteCount: number;
      try {
        byteCount = atob(b64).length;
      } catch {
        showError("Failed to decode base64. The string may be malformed or truncated.");
        return;
      }

      let detected;
      if (declaredMime) {
        const ext = (declaredMime.split("/")[1] || "png").replace("+xml", "").replace("jpeg", "jpg");
        detected = { mime: declaredMime, ext };
      } else {
        detected = detectMime(b64);
      }

      const dataUri = "data:" + detected.mime + ";base64," + b64;
      currentDataUri = dataUri;
      currentExt = detected.ext;

      preview.onload = () => {
        meta.textContent =
          detected.mime + " • " + formatBytes(byteCount) + " • " +
          preview.naturalWidth + " × " + preview.naturalHeight + " px";
        outputArea.style.display = "block";
        status.textContent = "Decoded successfully";
      };
      preview.onerror = () => {
        showError("Decoded successfully, but the result is not a valid image. Check that the base64 actually represents image data.");
      };
      preview.src = dataUri;
    }

    let debounce: ReturnType<typeof setTimeout>;
    input.addEventListener("input", () => {
      clearTimeout(debounce);
      status.textContent = "Decoding…";
      debounce = setTimeout(() => convert(input.value), 200);
    });

    $(".paste-btn").addEventListener("click", async () => {
      try {
        const text = await navigator.clipboard.readText();
        input.value = text;
        convert(text);
      } catch {
        showError("Clipboard access denied. Paste manually into the text area instead.");
      }
    });

    $(".clear-btn").addEventListener("click", () => {
      input.value = "";
      outputArea.style.display = "none";
      clearError();
      status.textContent = "";
    });

    $(".download-btn").addEventListener("click", () => {
      if (!currentDataUri) return;
      const a = document.createElement("a");
      a.href = currentDataUri;
      a.download = "image." + currentExt;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    });

    copyBtn.addEventListener("click", async () => {
      if (!currentDataUri) return;
      try {
        await navigator.clipboard.writeText(currentDataUri);
        const orig = copyBtn.textContent;
        copyBtn.textContent = "Copied";
        setTimeout(() => { copyBtn.textContent = orig; }, 1200);
      } catch {
        showError("Could not copy to clipboard.");
      }
    });

    function readFile(file: File) {
      const reader = new FileReader();
      reader.onload = (e) => {
        const text = String(e.target?.result ?? "");
        input.value = text;
        convert(text);
      };
      reader.readAsText(file);
    }

    dropZone.addEventListener("click", (e) => {
      if (e.target !== fileInput) fileInput.click();
    });
    fileInput.addEventListener("change", () => {
      if (fileInput.files?.[0]) readFile(fileInput.files[0]);
    });
    dropZone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropZone.classList.add("dragging");
    });
    dropZone.addEventListener("dragleave", () => {
      dropZone.classList.remove("dragging");
    });
    dropZone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropZone.classList.remove("dragging");
      if (e.dataTransfer?.files[0]) readFile(e.dataTransfer.files[0]);
    });
  },
};

export default tool;
