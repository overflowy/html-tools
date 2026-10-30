// The shape most panels share: a form of options, an Operation run with
// them on the Current Document, its Result previewed in the Viewer (again
// whenever an option changes, for the quick ones), and Apply and Download.

import type { OpName, OpOptions } from "../ops";
import type { OutFile } from "../pdf/doc";
import type { RunResult } from "../worker";
import type { Api, PanelDef, PanelInstance, Ran } from "./api";
import { button, count, debounce, el, formatBytes, pdfBlob } from "./dom";
import { Form } from "./form";
import type { Field, Values } from "./form";

/** How long after the last change a live preview runs. */
const SETTLE_MS = 350;

export interface Runner<R> {
  /** Run now (and again once if asked again while running). */
  run: () => Promise<void>;
  /** Run once the options stop changing. */
  schedule: () => void;
  result: () => R | null;
  /** Forget the Result: the options no longer make one. */
  clear: (why?: string) => void;
  destroy: () => void;
}

export interface FootOptions {
  /** What the Result is to the user: "the booklet", "3 files". */
  applyLabel?: string;
  /** No Apply: the Result is files to download (split parts, images), or a PDF that must not be worked on further (encrypted, linearized). */
  downloadOnly?: boolean;
  /** The download's file name. */
  fileName: (api: Api) => string;
}

/**
 * The foot of a panel with a Result: what happened, Download, and Apply.
 * Returns the function that shows a Result there.
 */
export const resultFoot = (api: Api, o: FootOptions) => {
  const status = el("span", {
    attrs: { "aria-live": "polite" },
    class: "foot-status",
  });
  let current: RunResult | null = null;
  const dl = button("Download", () => {
    if (!current) {
      return;
    }
    if (current.doc) {
      api.download(pdfBlob(current.doc.bytes), o.fileName(api));
    } else if (current.files?.length) {
      void api.downloadFiles(current.files, o.fileName(api));
    }
  });
  const apply = button(
    "Apply",
    () => {
      if (current?.doc) {
        api.apply(current, o.applyLabel ?? "the change");
      }
    },
    { primary: true, title: "Make this the document you are working on" }
  );
  api.foot.replaceChildren(status, el("span", { class: "spacer" }), dl);
  if (!o.downloadOnly) {
    api.foot.append(apply);
  }
  const show = (r: RunResult | null, text = "") => {
    current = r;
    const has = Boolean(r?.doc ?? r?.files?.length);
    dl.disabled = !has;
    apply.disabled = !r?.doc;
    status.textContent = text;
  };
  show(null);
  // A Result is of the pages it was made from: once they change, there is nothing to Apply.
  api.onPagesChanged(() => show(null));
  return {
    show,
    status: (text: string) => {
      status.textContent = text;
    },
  };
};

/** What a Result is, in a few words: its pages and size, or its files. */
export const describeResult = (r: RunResult): string => {
  if (r.doc) {
    return `${count(r.doc.pages.length, "page", "pages")} · ${formatBytes(r.doc.size)}`;
  }
  const files: OutFile[] = r.files ?? [];
  let total = 0;
  for (const f of files) {
    total += f.bytes.length;
  }
  return `${count(files.length, "file", "files")} · ${formatBytes(total)}`;
};

/**
 * Runs `once` (an Operation and what to do with its Result), live or on
 * demand: changes while it runs ask for one more run after, not one each.
 */
export const runner = <R>(
  once: () => Promise<R | null>,
  onResult: (r: R | null) => void
): Runner<R> => {
  let running = false;
  let again = false;
  let last: R | null = null;
  let dead = false;
  const run = async () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      for (;;) {
        again = false;
        const r = await once();
        // `dead` and `again` change while `once` runs: the panel closed, or the options changed.
        if (dead) {
          return;
        }
        if (r !== null || !again) {
          last = r;
          onResult(r);
        }
        if (!again) {
          return;
        }
      }
    } finally {
      running = false;
    }
  };
  const settle = debounce(() => {
    void run();
  }, SETTLE_MS);
  return {
    clear: () => {
      last = null;
      onResult(null);
    },
    destroy: () => {
      dead = true;
      settle.cancel();
    },
    result: () => last,
    run,
    schedule: settle,
  };
};

export interface TransformSpec<K extends OpName> {
  id: string;
  name: string;
  group: string;
  summary: string;
  fields: Field[];
  defaults: Values;
  op: K;
  /** The Operation's options from the form, or why there are none yet. */
  options: (v: Values, api: Api) => OpOptions<K> | string;
  /** Preview on every change (cheap Operations), or only when asked. */
  live: boolean;
  /** The button that runs a non-live Operation. */
  runLabel?: string;
  applyLabel: string;
  /** Appended to the download's name: "report-4up.pdf". */
  suffix: string;
  downloadOnly?: boolean;
  /** Something above the form: an explanation, a picker. */
  intro?: (api: Api) => HTMLElement | null;
  /** What the Result's report says, under the form. */
  report?: (r: Ran<K>, api: Api) => HTMLElement | null;
  /** Extra wiring: drawing on pages, reacting to the selection and to option changes. */
  extend?: (ctx: TransformContext<K>) => Extension;
}

export type Extension = Partial<PanelInstance> & {
  changed?: (key: string) => void;
};

export interface TransformContext<K extends OpName> {
  api: Api;
  values: Values;
  form: Form;
  run: Runner<Ran<K>>;
  area: HTMLElement;
}

/** A panel for one Operation: its form, its preview, its Result. */
export const transformPanel = <K extends OpName>(
  spec: TransformSpec<K>
): PanelDef => ({
  defaults: spec.defaults,
  fields: spec.fields,
  group: spec.group,
  id: spec.id,
  mount: (api, values) => {
    const intro = spec.intro?.(api) ?? null;
    const reportArea = el("div", { class: "report" });
    /** The Result on screen, for naming its download. */
    let shown: Ran<K> | null = null;
    const foot = resultFoot(api, {
      applyLabel: spec.applyLabel,
      downloadOnly: spec.downloadOnly,
      fileName: (a) => {
        const r = shown;
        const files = r?.files ?? [];
        const [only] = files;
        if (!r?.doc && files.length === 1 && only) {
          return only.name;
        }
        return `${a.name()}${spec.suffix}.${r?.doc ? "pdf" : "zip"}`;
      },
    });
    /** Why there is no Result, when the options say: shown in the foot. */
    let why = "";
    const once = (): Promise<Ran<K> | null> => {
      const options = spec.options(values, api);
      if (typeof options === "string") {
        why = options;
        return Promise.resolve(null);
      }
      why = "";
      foot.status(spec.live ? "Updating the preview…" : "Working…");
      return api.run(spec.op, options, spec.name, { quiet: spec.live });
    };
    const run = runner(once, (r) => {
      const had = shown;
      shown = r;
      reportArea.replaceChildren();
      if (!r) {
        // No options, a failed run (its error is shown), or a cleared one: nothing to Apply.
        foot.show(null, why);
        if (had) {
          api.showResult(null);
        }
        return;
      }
      api.showResult(r.doc ? r : null);
      foot.show(r, describeResult(r));
      const extra = spec.report?.(r, api);
      if (extra) {
        reportArea.append(extra);
      }
    });
    let ext: Extension = {};
    const form = new Form(spec.fields, values, (key) => {
      api.persist();
      ext.changed?.(key);
      if (spec.live) {
        run.schedule();
      } else {
        why = "";
        run.clear();
      }
    });
    api.body.replaceChildren(
      ...(intro ? [intro] : []),
      el("p", { class: "summary", text: spec.summary }),
      form.root
    );
    if (!spec.live) {
      api.body.append(
        el(
          "div",
          { class: "row" },
          button(
            spec.runLabel ?? "Run",
            () => {
              void run.run();
            },
            { primary: true }
          )
        )
      );
    }
    api.body.append(reportArea);
    ext = spec.extend?.({ api, area: reportArea, form, run, values }) ?? {};
    if (spec.live) {
      void run.run();
    }
    return {
      destroy: () => {
        run.destroy();
        ext.destroy?.();
      },
      docChanged: () => {
        ext.docChanged?.();
        why = "";
        run.clear();
        if (spec.live) {
          void run.run();
        }
      },
      selectionChanged: ext.selectionChanged,
    };
  },
  name: spec.name,
  summary: spec.summary,
});
