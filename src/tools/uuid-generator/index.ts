import type { Tool } from "../../shell/types";

import "./tool.css";

const copyText = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // file:// is not a secure context everywhere; the old way still works there.
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
};

const tool: Tool = {
  id: "uuid-generator",
  keywords: ["guid", "v4", "uuid4", "random"],
  mount(el) {
    el.innerHTML = `
      <div class="toolbar">
        <button class="btn-generate primary" type="button">Generate</button>
        <button class="btn-copy" type="button">Copy</button>
      </div>
      <section class="pane">
        <div class="pane-head"><span>UUID</span></div>
        <div class="value" role="button" tabindex="0" title="Click to copy"></div>
      </section>`;

    const $value = el.querySelector(".value") as HTMLElement;
    const $btnCopy = el.querySelector(".btn-copy") as HTMLButtonElement;
    const $btnGenerate = el.querySelector(".btn-generate") as HTMLButtonElement;

    let uuid = "";

    // A second click inside the flash must not capture "Copied" as the label to
    // restore, so the label is fixed and the pending restore is replaced.
    let copyTimer = 0;
    const flash = (btn: HTMLButtonElement) => {
      clearTimeout(copyTimer);
      btn.textContent = "Copied";
      copyTimer = window.setTimeout(() => {
        btn.textContent = "Copy";
      }, 1200);
    };

    const generate = () => {
      uuid = crypto.randomUUID();
      $value.textContent = uuid;
    };

    let valueTimer = 0;
    const copyFromValue = async () => {
      await copyText(uuid);
      clearTimeout(valueTimer);
      $value.textContent = "Copied";
      // Restore whatever is current, so a Generate during the flash is not undone.
      valueTimer = window.setTimeout(() => {
        $value.textContent = uuid;
      }, 1200);
    };

    $btnCopy.addEventListener("click", async () => {
      await copyText(uuid);
      flash($btnCopy);
    });
    $value.addEventListener("click", () => {
      // A click that ends a drag across the text is a selection, not a request to copy.
      if (document.getSelection()?.toString()) {
        return;
      }
      void copyFromValue();
    });
    $value.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") {
        return;
      }
      e.preventDefault();
      void copyFromValue();
    });
    $btnGenerate.addEventListener("click", generate);

    generate();
  },
  name: "UUID Generator",
  subtitle: "Generate a random UUID.",
};

export default tool;
