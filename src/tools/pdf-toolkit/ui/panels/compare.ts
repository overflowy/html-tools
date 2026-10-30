// Compare: the Current Document against another PDF, page by page. Four
// views take the place of the pages: side by side, overlaid (one in red,
// the other in cyan, so what is the same turns grey), the differences
// alone, and the text, line by line.

import type { Rendered } from "../../worker";
import type { Api, PanelDef } from "../api";
import { changes, diffLines } from "../diff";
import { button, count, el, message, quietly } from "../dom";

const GROUP = "Inspect and optimize";
const row = (...children: (Node | string)[]) =>
  el("div", { class: "row" }, ...children);

type CompareView = "side" | "overlay" | "diff" | "text";

/** How different two pixels must be, on any channel, to count. */
const THRESHOLD = 48;
/** Rendering scale for comparing: enough to see a changed word, small enough to be quick. */
const SCALE = 1;

interface Doc {
  id: string;
  name: string;
  pages: { w: number; h: number }[];
}

/** One page rendered onto a white canvas of the given size, so two pages of different sizes line up at the top left. */
const onCanvas = (r: Rendered | null, w: number, h: number): ImageData => {
  const out = new ImageData(w, h);
  out.data.fill(255);
  if (!r) {
    return out;
  }
  for (let y = 0; y < Math.min(h, r.height); y += 1) {
    out.data.set(
      r.pixels.subarray(
        y * r.width * 4,
        y * r.width * 4 + Math.min(w, r.width) * 4
      ),
      y * w * 4
    );
  }
  return out;
};

const luma = (d: Uint8ClampedArray, i: number) =>
  ((d[i] ?? 255) * 3 + (d[i + 1] ?? 255) * 6 + (d[i + 2] ?? 255)) / 10;

/** The composite for a view, and how much of the page differs, 0..1. */
const compose = (
  a: ImageData,
  b: ImageData,
  view: CompareView
): { image: ImageData; changed: number } => {
  const out = new ImageData(a.width, a.height);
  let changed = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const differs =
      Math.abs((a.data[i] ?? 0) - (b.data[i] ?? 0)) > THRESHOLD ||
      Math.abs((a.data[i + 1] ?? 0) - (b.data[i + 1] ?? 0)) > THRESHOLD ||
      Math.abs((a.data[i + 2] ?? 0) - (b.data[i + 2] ?? 0)) > THRESHOLD;
    if (differs) {
      changed += 1;
    }
    const la = luma(a.data, i);
    const lb = luma(b.data, i);
    if (view === "overlay") {
      out.data[i] = la;
      out.data[i + 1] = lb;
      out.data[i + 2] = lb;
    } else if (differs) {
      // Removed (dark in the first only) in red, added in green.
      const added = lb < la;
      out.data[i] = added ? 30 : 220;
      out.data[i + 1] = added ? 160 : 40;
      out.data[i + 2] = 40;
    } else {
      // What is the same, faded back.
      const v = 235 + (la / 255) * 20;
      out.data[i] = v;
      out.data[i + 1] = v;
      out.data[i + 2] = v;
    }
    out.data[i + 3] = 255;
  }
  return { changed: changed / (a.width * a.height), image: out };
};

/** What a row's badge says of the two pages. */
const badgeText = (inA: boolean, inB: boolean, changed: number): string => {
  if (!inA || !inB) {
    return inA ? "only in the first" : "only in the second";
  }
  if (changed === 0) {
    return "identical";
  }
  return `${(changed * 100).toFixed(changed < 0.001 ? 2 : 1)}% differs`;
};

const canvasOf = (img: ImageData): HTMLCanvasElement => {
  const c = el("canvas");
  c.width = img.width;
  c.height = img.height;
  c.getContext("2d")?.putImageData(img, 0, 0);
  return c;
};

const compareView = (api: Api, a: Doc, b: Doc, onClose: () => void) => {
  const root = el("div", { class: "compare" });
  const seg = el("div", {
    attrs: { "aria-label": "Compare view", role: "group" },
    class: "seg",
  });
  const body = el("div", { class: "compare-body" });
  let view: CompareView = "side";
  const views: [CompareView, string][] = [
    ["side", "Side by side"],
    ["overlay", "Overlay"],
    ["diff", "Differences"],
    ["text", "Text"],
  ];
  root.append(
    el(
      "div",
      { class: "pane-head" },
      seg,
      el("span", { class: "legend", text: "" }),
      el("span", { class: "spacer" }),
      button("Close", onClose)
    ),
    body
  );
  const legend = root.querySelector<HTMLElement>(".legend");
  let observer: IntersectionObserver | null = null;
  let gen = 0;

  const renderPage = async (doc: Doc, i: number): Promise<Rendered | null> => {
    if (i >= doc.pages.length) {
      return null;
    }
    const w = await api.worker();
    return w.call("render", [
      doc.id,
      i,
      SCALE * (window.devicePixelRatio || 1),
    ]);
  };

  const fillRow = async (rowEl: HTMLElement, i: number, mine: number) => {
    const [ra, rb] = [await renderPage(a, i), await renderPage(b, i)];
    if (mine !== gen) {
      return;
    }
    const w = Math.max(ra?.width ?? 1, rb?.width ?? 1);
    const h = Math.max(ra?.height ?? 1, rb?.height ?? 1);
    const ia = onCanvas(ra, w, h);
    const ib = onCanvas(rb, w, h);
    const { image, changed } = compose(ia, ib, view);
    const badge = rowEl.querySelector<HTMLElement>(".badge");
    if (badge) {
      badge.textContent = badgeText(ra !== null, rb !== null, changed);
      badge.classList.toggle("same", changed === 0 && Boolean(ra && rb));
    }
    const shots = rowEl.querySelector<HTMLElement>(".shots");
    shots?.replaceChildren(
      ...(view === "side" ? [canvasOf(ia), canvasOf(ib)] : [canvasOf(image)])
    );
  };

  const fillRowShowingErrors = async (rowEl: HTMLElement, mine: number) => {
    try {
      await fillRow(rowEl, Number(rowEl.dataset.page), mine);
    } catch (error) {
      api.error(message(error));
    }
  };

  const drawPages = () => {
    const n = Math.max(a.pages.length, b.pages.length);
    gen += 1;
    const mine = gen;
    observer?.disconnect();
    observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            observer?.unobserve(e.target);
            void fillRowShowingErrors(e.target as HTMLElement, mine);
          }
        }
      },
      { root: body, rootMargin: "400px 0px" }
    );
    body.replaceChildren();
    for (let i = 0; i < n; i += 1) {
      const r = el(
        "div",
        {
          attrs: { "data-page": String(i) },
          class: `compare-row view-${view}`,
        },
        el(
          "div",
          { class: "row-head" },
          el("span", { text: `Page ${i + 1}` }),
          el("span", { class: "badge", text: "…" })
        ),
        el("div", { class: "shots" })
      );
      body.append(r);
      observer.observe(r);
    }
    if (legend) {
      legend.textContent = {
        diff: "Red: only in the first. Green: only in the second.",
        overlay:
          "Grey: the same. Red: only in the first. Cyan: only in the second.",
        side: `${a.name} | ${b.name}`,
        text: "",
      }[view];
    }
  };

  const drawText = async () => {
    gen += 1;
    const mine = gen;
    observer?.disconnect();
    body.replaceChildren(
      el("p", { class: "sel-info", text: "Reading both texts…" })
    );
    const w = await api.worker();
    const [ta, tb] = [
      await w.call("texts", [a.id]),
      await w.call("texts", [b.id]),
    ];
    // Another view was chosen while the texts were read.
    if (mine !== gen) {
      return;
    }
    const lines = (pages: string[]) =>
      pages.flatMap((t, p) =>
        t
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => ({ page: p + 1, text: l }))
      );
    const la = lines(ta);
    const lb = lines(tb);
    const ops = diffLines(
      la.map((l) => l.text),
      lb.map((l) => l.text)
    );
    const { added, removed } = changes(ops);
    const list = el("ol", { class: "text-diff" });
    let shown = 0;
    for (const [k, op] of ops.entries()) {
      // Unchanged lines only next to changes, for context.
      const near = ops
        .slice(Math.max(0, k - 2), k + 3)
        .some((o) => o.kind !== "same");
      if (op.kind === "same" && !near) {
        continue;
      }
      if (shown > 3000) {
        list.append(el("li", { class: "more", text: "and more" }));
        break;
      }
      shown += 1;
      if (op.kind === "same") {
        list.append(
          el(
            "li",
            { class: "same" },
            el("span", { class: "pg", text: `p. ${la[op.a]?.page}` }),
            la[op.a]?.text ?? ""
          )
        );
      } else if (op.kind === "removed") {
        list.append(
          el(
            "li",
            { class: "removed" },
            el("span", { class: "pg", text: `p. ${la[op.a]?.page}` }),
            la[op.a]?.text ?? ""
          )
        );
      } else {
        list.append(
          el(
            "li",
            { class: "added" },
            el("span", { class: "pg", text: `p. ${lb[op.b]?.page}` }),
            lb[op.b]?.text ?? ""
          )
        );
      }
    }
    body.replaceChildren(
      el("p", {
        class: "sel-info",
        text:
          added + removed === 0
            ? "The texts are the same."
            : `${count(removed, "line", "lines")} only in the first, ${count(added, "line", "lines")} only in the second.`,
      }),
      list
    );
  };

  const draw = async () => {
    try {
      if (view === "text") {
        await drawText();
      } else {
        drawPages();
      }
    } catch (error) {
      api.error(message(error));
    }
  };
  const setView = (v: CompareView) => {
    view = v;
    for (const x of seg.querySelectorAll("button")) {
      x.classList.toggle("active", x.dataset.view === v);
    }
    void draw();
  };
  for (const [v, label] of views) {
    seg.append(button(label, () => setView(v), { attrs: { "data-view": v } }));
  }
  setView("side");
  return { destroy: () => observer?.disconnect(), root };
};

const compare: PanelDef = {
  group: GROUP,
  id: "compare",
  mount: (api) => {
    let other: Doc | null = null;
    let view: ReturnType<typeof compareView> | null = null;
    const choose = el("select", { attrs: { "aria-label": "Compare with" } });
    const info = el("p", { class: "sel-info" });
    const changedList = el("p", { class: "hint" });
    const closeOther = async () => {
      view?.destroy();
      view = null;
      api.takeOver(null);
      if (other) {
        const w = await api.worker();
        void quietly(w.call("close", [other.id]));
        other = null;
      }
    };
    const start = async (bytes: Uint8Array, name: string) => {
      await closeOther();
      try {
        const w = await api.worker();
        const r = await w.call("open", [bytes, null, name]);
        if (r.status !== "ok") {
          api.error(
            `${name} is password protected: open it in the Workspace first, then compare.`
          );
          return;
        }
        other = { id: r.doc.id, name, pages: r.doc.pages };
        const cur = await api.current();
        const a: Doc = {
          id: cur.id,
          name: `${api.name()}.pdf`,
          pages: cur.pages,
        };
        view = compareView(api, a, other, () => {
          void closeOther();
        });
        api.takeOver(view.root);
        info.textContent = `${a.name} (${count(a.pages.length, "page", "pages")}) against ${name} (${count(other.pages.length, "page", "pages")}).`;
      } catch (error) {
        api.error(message(error));
      }
    };
    const fromSource = async () => {
      const key = choose.value;
      if (!key) {
        return;
      }
      const src = api.sources().find((s) => s.key === key);
      // The Source's own bytes, through a round trip of the worker: read them by assembling it alone.
      const w = await api.worker();
      const cur = api.pages().filter((p) => p.src === key);
      if (!src || !cur.length) {
        return;
      }
      const doc = await api.current();
      const positions = api
        .pages()
        .flatMap((p, i) => (p.src === key ? [i] : []));
      const bytes = await w.call("extract", [
        positions.map((index) => ({ index, rotate: 0, src: doc.id })),
      ]);
      await start(bytes, src.name);
    };
    const pickFile = () => {
      const input = el("input", {
        attrs: { accept: ".pdf,application/pdf", type: "file" },
      });
      input.addEventListener("change", async () => {
        const file = input.files?.[0];
        if (file) {
          await start(new Uint8Array(await file.arrayBuffer()), file.name);
        }
      });
      input.click();
    };
    const scan = async () => {
      if (!other) {
        return;
      }
      changedList.textContent = "Comparing every page…";
      try {
        const w = await api.worker();
        const cur = await api.current();
        const n = Math.max(cur.pages.length, other.pages.length);
        const differ: number[] = [];
        for (let i = 0; i < n; i += 1) {
          const ra =
            i < cur.pages.length
              ? await w.call("render", [cur.id, i, 0.4])
              : null;
          const rb =
            i < other.pages.length
              ? await w.call("render", [other.id, i, 0.4])
              : null;
          const wd = Math.max(ra?.width ?? 1, rb?.width ?? 1);
          const ht = Math.max(ra?.height ?? 1, rb?.height ?? 1);
          if (
            !ra ||
            !rb ||
            compose(onCanvas(ra, wd, ht), onCanvas(rb, wd, ht), "diff")
              .changed > 0
          ) {
            differ.push(i + 1);
          }
          changedList.textContent = `Compared ${i + 1} of ${n}…`;
        }
        changedList.textContent = differ.length
          ? `Pages that differ: ${differ.join(", ")}.`
          : "Every page looks the same.";
      } catch (error) {
        changedList.textContent = "";
        api.error(message(error));
      }
    };
    const refresh = () => {
      choose.replaceChildren(
        el("option", { attrs: { value: "" }, text: "One of the open files…" })
      );
      for (const s of api.sources()) {
        choose.append(el("option", { attrs: { value: s.key }, text: s.name }));
      }
    };
    choose.addEventListener("change", () => {
      void fromSource();
    });
    refresh();
    api.body.replaceChildren(
      el("p", { class: "summary", text: compare.summary }),
      row(choose),
      row(
        button("Choose a PDF…", pickFile, { primary: true }),
        button("Find changed pages", () => {
          void scan();
        })
      ),
      info,
      changedList,
      el("p", {
        class: "hint",
        text: "The first document is the Workspace as it is now; to compare two files, open the first and choose the second here.",
      })
    );
    api.foot.replaceChildren();
    return {
      destroy: () => {
        void closeOther();
      },
      docChanged: () => {
        refresh();
        void closeOther();
      },
    };
  },
  name: "Compare",
  summary:
    "This document against another version of it: the pages side by side, overlaid, or as their differences, and the text line by line.",
};

export const COMPARE_PANELS: PanelDef[] = [compare];
