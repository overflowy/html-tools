import LZString from "lz-string";

import type { Tool, ToolContext } from "../../shell/types";

import "./tool.css";
import {
  countStats,
  highlight,
  parse,
  serialize,
  sortTree,
  tokenize,
} from "./jsonc";

/** Longest compressed input we are willing to put in the Deep Link. */
const STATE_CAP = 30_000;

const mount = (el: HTMLElement, ctx: ToolContext) => {
  el.innerHTML = `
      <div class="options">
        <label class="opt">Indent
          <select class="opt-indent">
            <option value="2" selected>2 spaces</option>
            <option value="4">4 spaces</option>
            <option value="tab">Tab</option>
          </select>
        </label>
        <label class="opt">Order
          <select class="opt-order">
            <option value="asc" selected>A to Z</option>
            <option value="desc">Z to A</option>
          </select>
        </label>
        <label class="opt">
          <input type="checkbox" class="opt-brackets" checked>
          Sort [bracket] segments in keys
        </label>
      </div>
      <div class="panes">
        <section class="pane">
          <div class="pane-head">
            <span>Input</span>
            <span class="spacer"></span>
            <button class="btn-paste" type="button">Paste<span class="wide-only"> from clipboard</span></button>
            <button class="btn-clear" type="button">Clear</button>
          </div>
          <textarea class="src" spellcheck="false" autocapitalize="off" autocomplete="off"
            placeholder="Paste JSON or JSONC. Trailing commas are dropped."></textarea>
          <div class="statusbar"><span class="status-text"></span></div>
        </section>
        <section class="pane">
          <div class="pane-head">
            <span>Output</span>
            <span class="spacer"></span>
            <button class="btn-copy primary" type="button" disabled>Copy</button>
          </div>
          <pre class="output"></pre>
        </section>
      </div>`;

  const $input = el.querySelector(".src") as HTMLTextAreaElement;
  const $output = el.querySelector(".output") as HTMLElement;
  const $status = el.querySelector(".statusbar") as HTMLElement;
  const $statusText = el.querySelector(".status-text") as HTMLElement;
  const $optIndent = el.querySelector(".opt-indent") as HTMLSelectElement;
  const $optOrder = el.querySelector(".opt-order") as HTMLSelectElement;
  const $optBrackets = el.querySelector(".opt-brackets") as HTMLInputElement;
  const $btnCopy = el.querySelector(".btn-copy") as HTMLButtonElement;
  const $btnPaste = el.querySelector(".btn-paste") as HTMLButtonElement;
  const $btnClear = el.querySelector(".btn-clear") as HTMLButtonElement;

  let lastResult = "";

  const setStatus = (kind: string, msg: string) => {
    $status.className = `statusbar ${kind}`;
    $statusText.textContent = msg;
  };

  /** State layout: `<indent>.<order>.<brackets>.<compressed input>` (input may be empty). */
  const publishState = (): boolean => {
    const src = $input.value;
    let packed = "";
    let fits = true;
    if (src.trim()) {
      const compressed = LZString.compressToEncodedURIComponent(src);
      if (compressed.length <= STATE_CAP) {
        packed = compressed;
      } else {
        fits = false;
      }
    }
    ctx.setState(
      [
        $optIndent.value,
        $optOrder.value,
        $optBrackets.checked ? "1" : "0",
        packed,
      ].join(".")
    );
    return fits;
  };

  const run = () => {
    const src = $input.value;
    if (!src.trim()) {
      $output.innerHTML = "";
      lastResult = "";
      $btnCopy.disabled = true;
      setStatus("", "");
      publishState();
      return;
    }
    try {
      const doc = parse(tokenize(src));
      sortTree(doc.root, $optOrder.value, $optBrackets.checked);
      const indent =
        $optIndent.value === "tab"
          ? "\t"
          : " ".repeat(Number($optIndent.value));
      lastResult = serialize(doc, indent);
      $output.innerHTML = highlight(lastResult);
      $btnCopy.disabled = false;
      const s = countStats(doc.root, { comments: 0, keys: 0 });
      const linked = publishState();
      setStatus(
        "ok",
        `${s.keys} key${s.keys === 1 ? "" : "s"} sorted${
          s.comments
            ? ` · ${s.comments} comment${s.comments === 1 ? "" : "s"} preserved`
            : ""
        }${linked ? "" : " · too large to keep in the URL"}`
      );
    } catch (error) {
      publishState();
      setStatus("error", (error as Error).message);
      // keep last good output visible
    }
  };

  ctx.onRestore((payload) => {
    const parts = payload.split(".");
    const [indent, order, brackets] = parts;
    const packed = parts.slice(3).join(".");
    if (indent === "2" || indent === "4" || indent === "tab") {
      $optIndent.value = indent;
    }
    if (order === "asc" || order === "desc") {
      $optOrder.value = order;
    }
    if (brackets === "0" || brackets === "1") {
      $optBrackets.checked = brackets === "1";
    }
    if (packed) {
      const text = LZString.decompressFromEncodedURIComponent(packed);
      if (text) {
        $input.value = text;
      }
    }
    run();
  });

  let timer: ReturnType<typeof setTimeout>;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(run, 120);
  };

  $input.addEventListener("input", schedule);
  $optIndent.addEventListener("change", run);
  $optOrder.addEventListener("change", run);
  $optBrackets.addEventListener("change", run);

  $btnCopy.addEventListener("click", async () => {
    if (!lastResult) {
      return;
    }
    try {
      await navigator.clipboard.writeText(lastResult);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = lastResult;
      document.body.append(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    const old = $btnCopy.textContent;
    $btnCopy.textContent = "Copied";
    setTimeout(() => {
      $btnCopy.textContent = old;
    }, 1200);
  });

  $btnPaste.addEventListener("click", async () => {
    try {
      $input.value = await navigator.clipboard.readText();
      run();
    } catch {
      setStatus(
        "error",
        "The browser blocked clipboard access. Paste with the keyboard instead."
      );
    }
  });

  $btnClear.addEventListener("click", () => {
    $input.value = "";
    run();
    $input.focus();
  });
};

const tool: Tool = {
  id: "jsonc-sorter",
  keywords: ["json", "jsonc", "sort", "keys", "comments", "settings", "format"],
  mount,
  name: "JSON/JSONC Key Sorter",
  subtitle: "Sort JSON or JSONC keys without losing comments.",
};

export default tool;
