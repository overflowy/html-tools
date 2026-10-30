// OCR: a Text Layer for scanned pages. Each page is rendered by MuPDF,
// read by Tesseract (in its own worker, started from the shared engine
// cache), and what Tesseract read comes back as an invisible text-only PDF
// page that the worker lays over the scan.

import type { Worker as TessWorker } from "tesseract.js";

import { getEngine } from "../../../../shared/engines";
import type { Progress } from "../../../../shared/engines";
import { LANGUAGES, languageName } from "../../../../shared/ocr-languages";
import {
  TESSERACT_ENGINES,
  languageAsset,
  startTesseract,
  tesseractCore,
} from "../../../../shared/tesseract";
import type { TextLayer } from "../../pdf/ocr";
import { parseRanges } from "../../ranges";
import type { PanelDef } from "../api";
import { button, count, el, formatBytes, message, quietly } from "../dom";
import { Form } from "../form";
import type { Values } from "../form";
import { describeResult, resultFoot } from "../panel-kit";

const row = (...children: (Node | string)[]) =>
  el("div", { class: "row" }, ...children);

const CANCELLED = "Cancelled.";

/** A language picker: a filter and a list of check boxes, the chosen ones first. */
const languagePicker = (values: Values, changed: () => void) => {
  const filter = el("input", {
    attrs: {
      "aria-label": "Filter languages",
      placeholder: "Filter languages",
      spellcheck: "false",
      type: "search",
    },
  });
  const list = el("div", {
    attrs: { "aria-label": "Languages", role: "group" },
    class: "langs",
  });
  const chosen = () => String(values.langs).split(",").filter(Boolean);
  const render = () => {
    const picked = new Set(chosen());
    const q = filter.value.trim().toLowerCase();
    list.replaceChildren();
    const order = LANGUAGES.toSorted(
      (a, b) => Number(picked.has(b.code)) - Number(picked.has(a.code))
    );
    for (const l of order) {
      if (q && !l.name.toLowerCase().includes(q) && !l.code.includes(q)) {
        continue;
      }
      const box = el("input", { attrs: { type: "checkbox" } });
      box.checked = picked.has(l.code);
      box.addEventListener("change", () => {
        const next = new Set(chosen());
        if (box.checked) {
          next.add(l.code);
        } else {
          next.delete(l.code);
        }
        values.langs = [...next].join(",");
        changed();
      });
      list.append(el("label", { class: "check" }, box, l.name));
    }
  };
  filter.addEventListener("input", render);
  render();
  return el(
    "div",
    { class: "field" },
    el("label", { text: "Languages on the pages" }),
    filter,
    list
  );
};

const ocr: PanelDef = {
  defaults: { dpi: "300", langs: "eng", pages: "", which: "needed" },
  fields: [
    {
      key: "which",
      kind: "seg",
      label: "Pages",
      options: [
        ["needed", "Without text"],
        ["all", "All"],
        ["range", "These"],
      ],
    },
    {
      key: "pages",
      kind: "pages",
      label: "Which",
      show: (v) => v.which === "range",
    },
    {
      key: "dpi",
      kind: "seg",
      label: "Read at",
      options: [
        ["200", "200 dpi, faster"],
        ["300", "300 dpi, better"],
      ],
    },
  ],
  group: "Convert",
  id: "ocr",
  mount: (api, values) => {
    /** Ends the run going on: Cancel, a new run, or the panel closing. */
    let stopRun: (() => void) | null = null;
    const foot = resultFoot(api, {
      applyLabel: "the text layer",
      fileName: (a) => `${a.name()}-ocr.pdf`,
    });
    const info = el("p", {
      attrs: { "aria-live": "polite" },
      class: "sel-info",
    });
    const unhook = api.onCancel(() => stopRun?.());
    const recognize = async () => {
      const langs = String(values.langs).split(",").filter(Boolean);
      if (langs.length === 0) {
        api.error("Choose at least one language.");
        return;
      }
      stopRun?.();
      // Each run's own: one stopped must not resume, or end Tesseract, when the next starts.
      let stopped = false;
      let tess: TessWorker | null = null;
      const stop = () => {
        stopped = true;
        void quietly(tess?.terminate());
        tess = null;
      };
      stopRun = stop;
      const check = () => {
        if (stopped) {
          throw new Error(CANCELLED);
        }
      };
      const engine = async (asset: Parameters<typeof getEngine>[0]) => {
        const bytes = await getEngine(asset, (p: Progress) => {
          // A download outlives Cancel; its progress must not bring the bar back.
          if (!(p.fromCache || stopped)) {
            api.progress(
              `Downloading ${p.asset.label} (${formatBytes(p.loaded)} of ${formatBytes(p.total)})`,
              p.total ? p.loaded / p.total : null
            );
          }
        });
        check();
        return bytes;
      };
      api.clearMessages();
      foot.show(null, "");
      info.textContent = "";
      try {
        api.progress("Looking at the pages", null);
        const w = await api.worker();
        const doc = await api.current();
        let targets: number[];
        if (values.which === "range") {
          const r = parseRanges(String(values.pages), doc.pages.length);
          if (!r.ok) {
            api.progress("", 1);
            api.error(r.error);
            return;
          }
          targets = r.pages;
        } else if (values.which === "all") {
          targets = doc.pages.map((_, i) => i);
        } else {
          const withText = await w.call("textPages", [doc.id]);
          targets = withText.flatMap((has, i) => (has ? [] : [i]));
        }
        check();
        if (targets.length === 0) {
          api.progress("", 1);
          api.note(
            "Every page already has text to select. Choose All to read them again."
          );
          return;
        }
        const text = (b: ArrayBuffer) => new TextDecoder().decode(b);
        const workerSrc = text(await engine(TESSERACT_ENGINES.worker));
        const coreSrc = text(await engine(tesseractCore()));
        const models: { code: string; data: Uint8Array }[] = [];
        for (const code of langs) {
          models.push({
            code,
            data: new Uint8Array(await engine(languageAsset(code))),
          });
        }
        api.progress(
          `Starting OCR (${langs.map(languageName).join(", ")})`,
          null
        );
        tess = await startTesseract({ coreSrc, models, workerSrc });
        check();
        const layers: TextLayer[] = [];
        const scale = Number(values.dpi) / 72;
        // Every page in order: the page is its place in the run, said once.
        const everyPage =
          targets.length === doc.pages.length &&
          targets.every((page, k) => page === k);
        for (const [k, page] of targets.entries()) {
          api.progress(
            everyPage
              ? `Reading page ${page + 1} of ${targets.length}`
              : `Reading page ${page + 1} (${k + 1} of ${targets.length})`,
            k / targets.length
          );
          const png = await w.call("png", [doc.id, page, scale]);
          check();
          const res = await tess.recognize(
            png as never,
            { pdfTextOnly: true },
            { pdf: true, text: false } as never
          );
          check();
          const { pdf } = res.data as unknown as { pdf: number[] | null };
          if (pdf) {
            layers.push({ page, pdf: new Uint8Array(pdf) });
          }
        }
        await tess.terminate();
        tess = null;
        api.progress("", 1);
        const r = await api.run(
          "textLayers",
          { layers },
          "Adding the text layer"
        );
        check();
        if (r?.doc) {
          api.showResult(r);
          foot.show(
            r,
            `${count(layers.length, "page", "pages")} read. ${describeResult(r)}`
          );
          info.textContent =
            "The After view looks the same: the text is invisible. Search it, or select it in any reader.";
        }
      } catch (error) {
        // Stopped, the bar is Cancel's or the next run's.
        if (!stopped) {
          api.progress("", 1);
        }
        await quietly(tess?.terminate());
        tess = null;
        if (!stopped && message(error) !== CANCELLED) {
          api.error(message(error));
        }
      } finally {
        if (stopRun === stop) {
          stopRun = null;
        }
      }
    };
    const form = new Form(ocr.fields ?? [], values, () => api.persist());
    api.body.replaceChildren(
      el("p", { class: "summary", text: ocr.summary }),
      languagePicker(values, () => api.persist()),
      form.root,
      row(
        button(
          "Recognize",
          () => {
            void recognize();
          },
          { primary: true }
        )
      ),
      info,
      el("p", {
        class: "hint",
        text: "Tesseract (4 MB) and each language's model (about 4 MB) download on first use and stay cached, shared with Document to Markdown.",
      })
    );
    return {
      destroy: () => {
        unhook();
        if (stopRun) {
          stopRun();
          api.progress("", 1);
        }
      },
      docChanged: () => {
        info.textContent = "";
        // What it read is of pages no longer there: laid over these, it would be in the wrong places.
        if (stopRun) {
          stopRun();
          api.progress("", 1);
          info.textContent =
            "OCR stopped: the pages changed while it read them. Recognize again to read them as they are now.";
        }
      },
    };
  },
  name: "OCR: make text searchable",
  summary:
    "Read scanned pages and give them a text layer: invisible, exactly over the words, so the scan can be searched, selected, and copied. The scan itself is not changed.",
};

export const OCR_PANELS: PanelDef[] = [ocr];
