import "./tool.css";
import type { Tool } from "../../shell/types";
import { inspect, strip, EXT, type Inspection } from "./containers";

function formatBytes(n: number) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(2) + " MB";
}

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function stripName(name: string, format: Inspection["format"]): string {
  const dot = name.lastIndexOf(".");
  if (dot > 0) return name.slice(0, dot) + ".stripped" + name.slice(dot);
  return (name || "image") + ".stripped." + EXT[format];
}

/** After a Strip, the only acceptable leftover is the minimal Orientation EXIF. */
function onlyOrientationRemains(i: Inspection): boolean {
  const stripped = i.sections.filter((s) => !s.kept);
  if (stripped.length !== 1 || stripped[0].label !== "EXIF") return false;
  return !!i.tiff && i.tiff.tags.length === 1 && i.tiff.tags[0].name === "Orientation";
}

const GROUP_TITLES: Record<string, string> = {
  Image: "Image (IFD0)",
  Photo: "Photo (EXIF)",
  GPS: "GPS",
  Interop: "Interoperability",
  Thumbnail: "Thumbnail (IFD1)",
};

const tool: Tool = {
  id: "image-metadata",
  name: "Image Metadata",
  subtitle: "Inspect EXIF, GPS and other metadata; download a losslessly stripped copy.",
  keywords: ["exif", "metadata", "gps", "strip", "privacy", "xmp", "iptc", "icc", "jpeg", "png", "webp", "heic", "avif", "tiff", "location"],
  mount(el) {
    el.innerHTML = `
      <div class="container">
        <div class="toolbar">
          <button type="button" class="choose-btn">Choose file</button>
          <button type="button" class="clear-btn">Clear</button>
          <span class="status"></span>
        </div>
        <input type="file" class="file-input" accept="image/*,.heic,.heif,.avif,.tif,.tiff" hidden>
        <div class="empty-hint">
          <strong>Drop an image anywhere here</strong>, choose a file, or paste with &#8984;V.
          <span>JPEG, PNG, WebP, TIFF, HEIC and AVIF. Nothing leaves the browser.</span>
        </div>
        <div class="report">
          <div class="summary">
            <div class="thumb-frame">
              <img class="preview" alt="Image preview">
              <div class="thumb-fallback"></div>
            </div>
            <div class="facts"></div>
          </div>
          <div class="clip-note note"></div>
          <div class="partial-note note"></div>
          <div class="highlights"></div>
          <div class="sections"></div>
          <div class="strip-panel">
            <div class="strip-row">
              <button type="button" class="strip-btn primary">Strip metadata</button>
              <span class="strip-note"></span>
            </div>
            <div class="strip-result"></div>
          </div>
          <div class="tags"></div>
        </div>
        <div class="error-box"></div>
      </div>`;

    const $ = (sel: string) => el.querySelector(sel) as HTMLElement;
    const fileInput = $(".file-input") as HTMLInputElement;
    const status = $(".status");
    const emptyHint = $(".empty-hint");
    const report = $(".report");
    const preview = $(".preview") as HTMLImageElement;
    const thumbFallback = $(".thumb-fallback");
    const facts = $(".facts");
    const clipNote = $(".clip-note");
    const partialNote = $(".partial-note");
    const highlights = $(".highlights");
    const sections = $(".sections");
    const stripBtn = $(".strip-btn") as HTMLButtonElement;
    const stripNote = $(".strip-note");
    const stripResult = $(".strip-result");
    const tags = $(".tags");
    const errorBox = $(".error-box");

    let currentBytes: Uint8Array | null = null;
    let currentInsp: Inspection | null = null;
    let currentName = "";
    let urls: string[] = [];

    function freeUrls() {
      for (const u of urls) URL.revokeObjectURL(u);
      urls = [];
    }

    function makeUrl(bytes: Uint8Array, mime: string): string {
      const u = URL.createObjectURL(new Blob([bytes.slice() as Uint8Array<ArrayBuffer>], { type: mime }));
      urls.push(u);
      return u;
    }

    function showError(msg: string) {
      errorBox.textContent = msg;
      errorBox.style.display = "block";
      report.style.display = "none";
      emptyHint.style.display = "none";
      status.textContent = "";
    }

    function reset() {
      freeUrls();
      currentBytes = null;
      currentInsp = null;
      currentName = "";
      errorBox.style.display = "none";
      report.style.display = "none";
      emptyHint.style.display = "block";
      stripResult.innerHTML = "";
      status.textContent = "";
    }

    function renderHighlights(insp: Inspection) {
      const rows: string[] = [];
      const t = insp.tiff;
      const camera = t && (t.make || t.model) ? [t.make, t.model].filter(Boolean).join(" ") : null;
      if (camera) rows.push(`<div class="hl"><span class="hl-key">Camera</span><span class="hl-val">${esc(camera)}</span></div>`);
      if (t?.dateTaken) rows.push(`<div class="hl"><span class="hl-key">Date taken</span><span class="hl-val">${esc(t.dateTaken)}</span></div>`);
      if (t?.gps) {
        const lat = t.gps.lat.toFixed(6);
        const lon = t.gps.lon.toFixed(6);
        rows.push(`<div class="hl gps"><span class="hl-key">GPS</span><span class="hl-val">${lat}, ${lon}
          <a href="https://www.google.com/maps/search/?api=1&amp;query=${lat},${lon}" target="_blank" rel="noopener noreferrer">View on map</a></span></div>`);
      }
      highlights.innerHTML = rows.join("");
      highlights.style.display = rows.length ? "block" : "none";
    }

    function renderSections(insp: Inspection) {
      if (insp.sections.length === 0) {
        sections.style.display = "none";
        return;
      }
      sections.style.display = "block";
      sections.innerHTML = "<div class='sec-title'>Metadata found</div>" + insp.sections.map((s) =>
        `<div class="sec"><span class="sec-label">${esc(s.label)}</span>` +
        (s.kept ? `<span class="sec-kept">kept</span>` : "") +
        `<span class="sec-bytes">${s.bytes ? formatBytes(s.bytes) : ""}</span></div>`,
      ).join("");
    }

    function renderTags(insp: Inspection) {
      const parts: string[] = [];
      if (insp.tiff && insp.tiff.tags.length) {
        const groups = ["Image", "Photo", "GPS", "Interop", "Thumbnail"];
        for (const g of groups) {
          const rows = insp.tiff.tags.filter((t) => t.group === g);
          if (!rows.length) continue;
          parts.push(`<div class="tag-group">${esc(GROUP_TITLES[g] ?? g)}</div>`);
          for (const r of rows) {
            parts.push(`<div class="tag-row"><span class="tag-name">${esc(r.name)}</span><span class="tag-val">${esc(r.value)}</span></div>`);
          }
        }
      }
      if (insp.iptc.length) {
        parts.push(`<div class="tag-group">IPTC</div>`);
        for (const r of insp.iptc) {
          parts.push(`<div class="tag-row"><span class="tag-name">${esc(r.name)}</span><span class="tag-val">${esc(r.value)}</span></div>`);
        }
      }
      if (insp.comments.length) {
        parts.push(`<div class="tag-group">Comments</div>`);
        for (const c of insp.comments) {
          parts.push(`<div class="tag-row"><span class="tag-val">${esc(c)}</span></div>`);
        }
      }
      if (insp.xmp) {
        parts.push(`<details class="xmp"><summary>XMP (${formatBytes(insp.xmp.length)})</summary><pre>${esc(insp.xmp)}</pre></details>`);
      }
      tags.innerHTML = parts.join("");
      tags.style.display = parts.length ? "block" : "none";
    }

    function renderStripPanel(insp: Inspection) {
      stripResult.innerHTML = "";
      if (!insp.clean) {
        stripBtn.disabled = true;
        stripNote.textContent = "Strip refused: the file doesn't parse cleanly (" + (insp.walkError ?? "unknown error") + "), so a safe copy can't be produced.";
      } else if (!insp.hasMetadata) {
        stripBtn.disabled = true;
        stripNote.textContent = "No metadata found. This file is already clean.";
      } else {
        stripBtn.disabled = false;
        stripNote.textContent = insp.strippableBytes
          ? "Removes ~" + formatBytes(insp.strippableBytes) + " of metadata. Pixels stay byte-identical."
          : "Pixels stay byte-identical.";
      }
    }

    function load(bytes: Uint8Array, name: string, fromClipboard: boolean) {
      freeUrls();
      stripResult.innerHTML = "";
      errorBox.style.display = "none";
      currentBytes = bytes;
      currentName = name;

      let insp: Inspection;
      try {
        insp = inspect(bytes);
      } catch (e) {
        currentInsp = null;
        showError(e instanceof Error ? e.message : String(e));
        return;
      }
      currentInsp = insp;
      emptyHint.style.display = "none";
      report.style.display = "block";
      status.textContent = name ? name : "clipboard image";

      thumbFallback.style.display = "none";
      preview.style.display = "block";
      preview.onerror = () => {
        preview.style.display = "none";
        thumbFallback.style.display = "flex";
        thumbFallback.textContent = insp.format.toUpperCase() + "\nno preview";
      };
      preview.src = makeUrl(bytes, insp.mime);

      const dims = insp.width && insp.height ? insp.width + " × " + insp.height + " px" : null;
      facts.innerHTML =
        `<div class="fact-name">${esc(name || "Pasted image")}</div>` +
        `<div class="fact-line">${esc(insp.mime)} · ${formatBytes(bytes.length)}${dims ? " · " + dims : ""}</div>`;

      clipNote.style.display = fromClipboard && !insp.hasMetadata ? "block" : "none";
      clipNote.textContent = "Pasted images usually arrive re-encoded by the clipboard, with metadata already removed. Load the original file to see what it really carries.";

      partialNote.style.display = insp.clean ? "none" : "block";
      partialNote.textContent = "Parsed partially: " + (insp.walkError ?? "unknown error") + ". Showing what was readable.";

      renderHighlights(insp);
      renderSections(insp);
      renderTags(insp);
      renderStripPanel(insp);
    }

    stripBtn.addEventListener("click", () => {
      if (!currentBytes || !currentInsp) return;
      let out: Uint8Array;
      let keptOrientation: number | null;
      try {
        const res = strip(currentBytes);
        out = res.out;
        keptOrientation = res.keptOrientation;
      } catch (e) {
        stripResult.innerHTML = `<div class="strip-fail">Strip failed: ${esc(e instanceof Error ? e.message : String(e))}</div>`;
        return;
      }

      // Proof, not promise: run the stripped bytes back through our own parser.
      let verdict: string;
      let ok = false;
      try {
        const re = inspect(out);
        if (!re.hasMetadata) {
          ok = true;
          verdict = "Re-parsed the stripped copy: no metadata found.";
        } else if (keptOrientation !== null && onlyOrientationRemains(re)) {
          ok = true;
          verdict = "Re-parsed the stripped copy: only the kept Orientation tag remains.";
        } else {
          verdict = "Warning: re-parsing the stripped copy still finds metadata (" +
            re.sections.filter((s) => !s.kept).map((s) => s.label).join(", ") + ").";
        }
      } catch {
        verdict = "Warning: the stripped copy could not be re-parsed.";
      }

      const saved = currentBytes.length - out.length;
      const name = stripName(currentName, currentInsp.format);
      const url = makeUrl(out, currentInsp.mime);
      stripResult.innerHTML =
        `<div class="strip-sizes">${formatBytes(currentBytes.length)} &rarr; ${formatBytes(out.length)}` +
        (saved > 0 ? ` <span class="saved">(${formatBytes(saved)} removed)</span>` : "") + `</div>` +
        `<div class="${ok ? "strip-ok" : "strip-fail"}">${esc(verdict)}` +
        (keptOrientation !== null ? ` <span class="kept-note">Kept: orientation (${keptOrientation}).</span>` : "") + `</div>` +
        `<a class="download-link" href="${url}" download="${esc(name)}">Download ${esc(name)}</a>`;
    });

    function loadBlob(blob: Blob, name: string, fromClipboard: boolean) {
      blob.arrayBuffer().then(
        (buf) => load(new Uint8Array(buf), name, fromClipboard),
        () => showError("Could not read the file."),
      );
    }

    $(".choose-btn").addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      if (file) loadBlob(file, file.name, false);
      fileInput.value = "";
    });

    $(".clear-btn").addEventListener("click", reset);

    // Drop an image anywhere on the tool
    let dragDepth = 0;
    el.addEventListener("dragenter", (e) => {
      e.preventDefault();
      dragDepth++;
      el.classList.add("dragging");
    });
    el.addEventListener("dragover", (e) => e.preventDefault());
    el.addEventListener("dragleave", () => {
      if (--dragDepth <= 0) {
        dragDepth = 0;
        el.classList.remove("dragging");
      }
    });
    el.addEventListener("drop", (e) => {
      e.preventDefault();
      dragDepth = 0;
      el.classList.remove("dragging");
      const file = e.dataTransfer?.files[0];
      if (file) loadBlob(file, file.name, false);
    });

    // Cmd+V anywhere in the tool with an image on the clipboard
    document.addEventListener("paste", (e) => {
      if (el.hidden) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            loadBlob(file, file.name || "", true);
            return;
          }
        }
      }
    });
  },
};

export default tool;
