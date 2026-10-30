import "./tool.css";
import ICON_CHECK from "lucide-static/icons/check.svg";
import ICON_FILE from "lucide-static/icons/file.svg";
import ICON_INFO from "lucide-static/icons/info.svg";
import ICON_LIST from "lucide-static/icons/list-checks.svg";
import ICON_X from "lucide-static/icons/x.svg";

import { readDrop, readInput } from "../../shared/dropped-files";
import type { Picked } from "../../shared/dropped-files";
import type { Tool, ToolContext } from "../../shell/types";
import {
  ALGORITHMS,
  DEFAULT_ALGORITHMS,
  algorithmById,
  algorithmsOfLength,
  inOrder,
} from "./algorithms";
import type { AlgorithmId } from "./algorithms";
import {
  formatSums,
  isSumsFileName,
  matchListed,
  normalizeDigest,
  parseSums,
} from "./sums";
import type { Listed } from "./sums";
import { CANCELLED, HashWorker } from "./worker-client";

const ALGORITHMS_KEY = "html-tools:file-hashes:algorithms";
/** A dropped checksum list bigger than this is hashed like any file, not read as a list. */
const LIST_LIMIT = 1024 * 1024;
/** Typing pauses this long before the text is hashed again. */
const TEXT_DEBOUNCE_MS = 120;

type Mode = "files" | "text";

/** A file to hash and what is known of it so far. */
interface Item {
  id: number;
  path: string;
  file: File;
  digests: Map<AlgorithmId, string>;
  /** Bytes read in the pass under way. */
  read: number;
  ms: number;
  error: string;
}

/** A checksum file the user dropped, to check the hashed files against. */
interface SumsList {
  fileName: string;
  entries: Listed[];
}

const formatBytes = (n: number) => {
  if (n < 1024) {
    return `${n} B`;
  }
  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(1)} KB`;
  }
  if (n < 1024 ** 3) {
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
};

const seconds = (ms: number) =>
  ms < 1000
    ? `${Math.max(1, Math.round(ms))} ms`
    : `${(ms / 1000).toFixed(1)} s`;

const count = (n: number, one: string, many: string) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

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

const download = (text: string, name: string) => {
  // Not text/plain: Chromium would make SHA256SUMS into SHA256SUMS.txt.
  const url = URL.createObjectURL(
    new Blob([text], { type: "application/octet-stream" })
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const readStored = (): AlgorithmId[] | null => {
  try {
    const s = localStorage.getItem(ALGORITHMS_KEY);
    return s ? inOrder(s.split(".")) : null;
  } catch {
    return null;
  }
};

const mount = (el: HTMLElement, ctx: ToolContext) => {
  el.innerHTML = `
      <div class="toolbar">
        <div class="seg mode" role="group" aria-label="What to hash">
          <button type="button" data-mode="files" class="active">Files</button>
          <button type="button" data-mode="text">Text</button>
        </div>
        <button type="button" class="choose-btn">Choose files</button>
        <button type="button" class="folder-btn">Choose folder</button>
        <button type="button" class="clear-btn">Clear</button>
        <span class="status"></span>
      </div>
      <input type="file" class="file-input" multiple hidden>
      <input type="file" class="folder-input" webkitdirectory hidden>
      <div class="algos" role="group" aria-label="Algorithms">
        <div class="algo-row common"></div>
        <details class="more-algos"><summary>More algorithms</summary><div class="algo-row rare"></div></details>
      </div>
      <div class="verify">
        <input type="text" class="expected" placeholder="Expected hash, to compare against" aria-label="Expected hash" spellcheck="false" autocomplete="off">
        <span class="verdict" role="status"></span>
      </div>
      <div class="empty-hint">
        <strong>Drop files or folders anywhere here</strong>, or choose them.
        <span>Drop a checksum file (SHA256SUMS, x.iso.sha256, .md5, .sfv) with them to check every file against it. Nothing leaves the browser.</span>
      </div>
      <textarea class="text-input" placeholder="Type or paste text; its hashes update as you type" aria-label="Text to hash" spellcheck="false"></textarea>
      <div class="progress">
        <span class="phase"></span>
        <div class="bar"><div class="fill"></div></div>
        <button type="button" class="cancel-btn">Cancel</button>
      </div>
      <div class="note" role="status">${ICON_INFO}<span class="note-text"></span><button type="button" class="resume-btn" hidden>Hash the rest</button></div>
      <div class="error-box" role="alert"></div>
      <section class="checks"></section>
      <section class="results">
        <div class="pane-head">
          <span class="results-title">Hashes</span>
          <span class="meta results-meta"></span>
          <span class="spacer"></span>
          <button type="button" class="copy-all" title="Copy every hash, in a checksum file's format">Copy</button>
          <button type="button" class="save-all" title="Download a checksum file that sha256sum -c and friends can check">Download</button>
        </div>
        <div class="cards"></div>
      </section>`;

  const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => {
    const node = el.querySelector<T>(sel);
    if (!node) {
      throw new Error(`File Hashes markup has no ${sel}`);
    }
    return node;
  };
  const status = $(".status");
  const fileInput = $<HTMLInputElement>(".file-input");
  const folderInput = $<HTMLInputElement>(".folder-input");
  const commonRow = $(".algo-row.common");
  const rareRow = $(".algo-row.rare");
  const moreAlgos = $<HTMLDetailsElement>(".more-algos");
  const expectedInput = $<HTMLInputElement>(".expected");
  const verdict = $(".verdict");
  const emptyHint = $(".empty-hint");
  const textInput = $<HTMLTextAreaElement>(".text-input");
  const progress = $(".progress");
  const phase = $(".phase");
  const bar = $(".bar");
  const fill = $(".fill");
  const note = $(".note");
  const noteText = $(".note-text");
  const resumeBtn = $<HTMLButtonElement>(".resume-btn");
  const errorBox = $(".error-box");
  const checks = $(".checks");
  const results = $(".results");
  const resultsTitle = $(".results-title");
  const resultsMeta = $(".results-meta");
  const cards = $(".cards");
  const copyAll = $<HTMLButtonElement>(".copy-all");
  const saveAll = $<HTMLButtonElement>(".save-all");

  let mode: Mode = "files";
  let algorithms: AlgorithmId[] = readStored() ?? DEFAULT_ALGORITHMS;
  let items: Item[] = [];
  let lists: SumsList[] = [];
  let nextId = 1;
  let text = "";
  let textDigests = new Map<AlgorithmId, string>();
  let textMs = 0;

  let worker: HashWorker | null = null;
  let textWorker: HashWorker | null = null;
  /** The pass under way: its run, and the item it hashes. */
  let runId = 0;
  let current: Item | null = null;
  let stopped = false;

  /* ---- the algorithm picker ---- */

  const chip = (id: AlgorithmId): HTMLButtonElement => {
    const a = algorithmById(id);
    const b = document.createElement("button");
    b.type = "button";
    b.className = "algo toggle";
    b.dataset.id = id;
    b.textContent = a?.label ?? id;
    b.title = a?.note ?? "";
    return b;
  };
  commonRow.append(
    ...ALGORITHMS.filter((a) => a.common).map((a) => chip(a.id))
  );
  rareRow.append(...ALGORITHMS.filter((a) => !a.common).map((a) => chip(a.id)));

  const syncChips = () => {
    for (const b of el.querySelectorAll<HTMLButtonElement>(".algo")) {
      const on = algorithms.includes(b.dataset.id as AlgorithmId);
      b.setAttribute("aria-pressed", String(on));
    }
    // A rare Algorithm that is on keeps its row in view.
    if (ALGORITHMS.some((a) => !a.common && algorithms.includes(a.id))) {
      moreAlgos.open = true;
    }
  };

  /* ---- State: the Deep Link and the Preference ---- */

  /**
   * State layout, URL-encoded pairs, each only when it differs from the
   * default: `a` the Algorithms dot-separated, `m=text`, `t` the text, `v`
   * the expected hash. Files stay out, as binary inputs do.
   */
  const publishState = () => {
    try {
      localStorage.setItem(ALGORITHMS_KEY, algorithms.join("."));
    } catch {
      // A private window: the choice still applies for this visit.
    }
    const p = new URLSearchParams();
    if (algorithms.join(".") !== DEFAULT_ALGORITHMS.join(".")) {
      p.set("a", algorithms.join("."));
    }
    if (mode === "text") {
      p.set("m", "text");
      if (text) {
        p.set("t", text);
      }
    }
    const v = expectedInput.value.trim();
    if (v) {
      p.set("v", v);
    }
    ctx.setState(p.toString());
  };

  /* ---- screen ---- */

  const setPhase = (textLine: string, fraction: number | null) => {
    phase.textContent = textLine;
    if (fraction === null) {
      bar.classList.add("busy");
      fill.style.width = "";
    } else {
      bar.classList.remove("busy");
      fill.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
    }
  };

  const showNote = (line: string, resumable = false) => {
    noteText.textContent = line;
    resumeBtn.hidden = !resumable;
    note.classList.add("on");
  };

  const showError = (msg: string) => {
    errorBox.textContent = msg;
    errorBox.classList.add("on");
  };

  const expected = () => normalizeDigest(expectedInput.value);

  /** Whether a Digest is the one the user expects. */
  const isExpected = (digest: string) => {
    const want = expected();
    return want !== null && want === digest;
  };

  /** What a list says about the item at `path` with Algorithm `id`, if a list names it. */
  const listedFor = (item: Item, id: AlgorithmId): Listed | null => {
    for (const l of lists) {
      for (const e of l.entries) {
        if (e.algorithm === id && matchListed(e.name, [item]) === item) {
          return e;
        }
      }
    }
    return null;
  };

  const digestRow = (
    id: AlgorithmId,
    digest: string | undefined,
    listed: Listed | null
  ): HTMLElement => {
    const a = algorithmById(id);
    const row = document.createElement("div");
    row.className = "digest-row";
    const name = document.createElement("span");
    name.className = "algo-name";
    name.textContent = a?.label ?? id;
    const value = document.createElement("button");
    value.type = "button";
    value.className = "digest";
    if (digest) {
      value.textContent = digest;
      value.dataset.digest = digest;
      value.title = "Click to copy";
    } else {
      value.textContent = "";
      value.disabled = true;
      row.classList.add("pending");
    }
    row.append(name, value);
    const matchesExpected = digest !== undefined && isExpected(digest);
    const listedOk =
      listed !== null && digest !== undefined && listed.digest === digest;
    const listedBad =
      listed !== null && digest !== undefined && listed.digest !== digest;
    if (matchesExpected || listedOk) {
      row.classList.add("match");
      const mark = document.createElement("span");
      mark.className = "mark ok";
      mark.innerHTML = ICON_CHECK;
      mark.title = matchesExpected
        ? "Matches the expected hash"
        : "Matches the checksum file";
      row.append(mark);
    } else if (listedBad) {
      row.classList.add("mismatch");
      const mark = document.createElement("span");
      mark.className = "mark bad";
      mark.innerHTML = ICON_X;
      mark.title = `The checksum file says ${listed.digest}`;
      row.append(mark);
    }
    return row;
  };

  const cardFor = (item: Item): HTMLElement => {
    const card = document.createElement("article");
    card.className = "card";
    card.dataset.id = String(item.id);
    const head = document.createElement("div");
    head.className = "card-head";
    head.innerHTML = ICON_FILE;
    const name = document.createElement("span");
    name.className = "card-name";
    name.textContent = item.path;
    name.title = item.path;
    const meta = document.createElement("span");
    meta.className = "card-meta";
    const missing = algorithms.filter((id) => !item.digests.has(id));
    if (item.error) {
      meta.textContent = item.error;
      meta.classList.add("bad");
    } else if (current === item) {
      meta.textContent = `${formatBytes(item.file.size)} · ${Math.round((item.read / Math.max(1, item.file.size)) * 100)}%`;
    } else if (missing.length && stopped) {
      meta.textContent = `${formatBytes(item.file.size)} · stopped`;
    } else if (missing.length) {
      meta.textContent = `${formatBytes(item.file.size)} · waiting`;
    } else {
      meta.textContent = `${formatBytes(item.file.size)} · ${seconds(item.ms)}`;
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove icon";
    remove.title = `Remove ${item.path}`;
    remove.setAttribute("aria-label", `Remove ${item.path}`);
    remove.innerHTML = ICON_X;
    head.append(name, meta, remove);
    card.append(head);
    for (const id of algorithms) {
      card.append(digestRow(id, item.digests.get(id), listedFor(item, id)));
    }
    return card;
  };

  const textCard = (): HTMLElement => {
    const card = document.createElement("article");
    card.className = "card";
    for (const id of algorithms) {
      card.append(digestRow(id, textDigests.get(id), null));
    }
    return card;
  };

  /** The verdict beside the expected hash, and a way to turn on the Algorithm it looks like. */
  const renderVerdict = () => {
    verdict.replaceChildren();
    verdict.className = "verdict";
    const raw = expectedInput.value.trim();
    if (!raw) {
      return;
    }
    const want = expected();
    if (want === null) {
      verdict.textContent = "Not a hex hash.";
      verdict.classList.add("bad");
      return;
    }
    const sources: { label: string; digests: Map<AlgorithmId, string> }[] =
      mode === "text"
        ? [{ digests: textDigests, label: "the text" }]
        : items.map((i) => ({ digests: i.digests, label: i.path }));
    for (const s of sources) {
      for (const [id, d] of s.digests) {
        if (d === want && algorithms.includes(id)) {
          verdict.textContent = `Matches ${s.label} (${algorithmById(id)?.label ?? id}).`;
          verdict.classList.add("ok");
          return;
        }
      }
    }
    const candidates = algorithmsOfLength(want.length);
    const off = candidates.filter((a) => !algorithms.includes(a.id));
    const anything = sources.some((s) => s.digests.size > 0);
    if (candidates.length === 0) {
      verdict.textContent = `No algorithm here makes ${want.length} hex digits.`;
      verdict.classList.add("bad");
      return;
    }
    if (anything) {
      verdict.textContent = "No match.";
      verdict.classList.add("bad");
    }
    if (off.length) {
      verdict.append(
        `${anything ? " " : ""}${want.length} digits could be ${off.length === 1 ? "" : "one of "}`
      );
      for (const [i, a] of off.entries()) {
        if (i > 0) {
          verdict.append(" ");
        }
        const b = document.createElement("button");
        b.type = "button";
        b.className = "inline turn-on";
        b.dataset.id = a.id;
        b.textContent = a.label;
        b.title = `Turn ${a.label} on`;
        verdict.append(b);
      }
    }
  };

  type Tally = Record<"bad" | "missing" | "ok" | "waiting", number>;

  /** One line of a checksum list, judged against the hashed files, counted in `tally`. */
  const checkRow = (e: Listed, tally: Tally): HTMLElement => {
    const row = document.createElement("div");
    row.className = "check-row";
    const name = document.createElement("span");
    name.className = "check-name";
    name.textContent = e.name;
    const algo = document.createElement("span");
    algo.className = "check-algo";
    algo.textContent = algorithmById(e.algorithm)?.label ?? e.algorithm;
    const state = document.createElement("span");
    state.className = "check-state";
    const item = matchListed(e.name, items);
    const got = item?.digests.get(e.algorithm);
    if (!item) {
      tally.missing += 1;
      state.textContent = "Not dropped";
    } else if (!got) {
      tally.waiting += 1;
      state.textContent = item.error ? "Unreadable" : "Hashing";
    } else if (got === e.digest) {
      tally.ok += 1;
      state.textContent = "OK";
      state.classList.add("ok");
    } else {
      tally.bad += 1;
      state.textContent = "Differs";
      state.classList.add("bad");
      state.title = `Listed ${e.digest}, got ${got}`;
    }
    row.append(name, algo, state);
    return row;
  };

  const renderChecks = () => {
    checks.replaceChildren();
    checks.classList.toggle("on", lists.length > 0 && mode === "files");
    for (const l of lists) {
      const box = document.createElement("div");
      box.className = "check-list";
      const head = document.createElement("div");
      head.className = "pane-head";
      head.innerHTML = ICON_LIST;
      const title = document.createElement("span");
      title.className = "check-title";
      title.textContent = l.fileName;
      const summary = document.createElement("span");
      summary.className = "meta";
      const tally: Tally = { bad: 0, missing: 0, ok: 0, waiting: 0 };
      const rows = l.entries.map((e) => checkRow(e, tally));
      const parts = [`${tally.ok} of ${l.entries.length} OK`];
      if (tally.bad) {
        parts.push(`${tally.bad} differ`);
      }
      if (tally.missing) {
        parts.push(`${tally.missing} not dropped`);
      }
      summary.textContent = parts.join(" · ");
      summary.classList.toggle("bad", tally.bad > 0);
      summary.classList.toggle(
        "ok",
        tally.bad === 0 && tally.waiting === 0 && tally.missing === 0
      );
      head.append(title, summary);
      const body = document.createElement("div");
      body.className = "check-rows";
      body.append(...rows);
      box.append(head, body);
      checks.append(box);
    }
  };

  const renderResults = () => {
    const files = mode === "files";
    emptyHint.style.display = files && items.length === 0 ? "block" : "none";
    textInput.style.display = files ? "none" : "block";
    for (const b of el.querySelectorAll<HTMLButtonElement>(
      ".choose-btn, .folder-btn"
    )) {
      b.hidden = !files;
    }
    for (const b of el.querySelectorAll<HTMLButtonElement>(".mode button")) {
      b.classList.toggle("active", b.dataset.mode === mode);
    }
    if (files) {
      results.classList.toggle("on", items.length > 0);
      resultsTitle.textContent = "Hashes";
      const bytes = items.reduce((n, i) => n + i.file.size, 0);
      resultsMeta.textContent = items.length
        ? `${count(items.length, "file", "files")} · ${formatBytes(bytes)}`
        : "";
      cards.replaceChildren(...items.map((i) => cardFor(i)));
    } else {
      results.classList.add("on");
      resultsTitle.textContent = "Hashes of the text";
      const bytes = new TextEncoder().encode(text).length;
      resultsMeta.textContent = `${formatBytes(bytes)} as UTF-8${textMs ? ` · ${seconds(textMs)}` : ""}`;
      cards.replaceChildren(textCard());
    }
    const done = files
      ? items.some((i) => algorithms.some((id) => i.digests.has(id)))
      : textDigests.size > 0;
    copyAll.disabled = !done;
    saveAll.disabled = !done;
    status.textContent = "";
    renderChecks();
    renderVerdict();
  };

  /** Redraw one card in place, as its pass makes progress. */
  const renderCard = (item: Item) => {
    const old = cards.querySelector(`.card[data-id="${item.id}"]`);
    if (old) {
      old.replaceWith(cardFor(item));
    }
  };

  /* ---- hashing files ---- */

  /** Algorithms on that an item has no Digest for yet. */
  const missingFor = (item: Item) =>
    item.error ? [] : algorithms.filter((id) => !item.digests.has(id));

  const bytesLeft = () =>
    items.reduce((n, i) => n + (missingFor(i).length ? i.file.size : 0), 0);

  /** What a pass reports as it reads: the bar, and the card's percentage. */
  const progressOf =
    (id: number, item: Item, base: number, total: number) => (read: number) => {
      if (id !== runId) {
        return;
      }
      item.read = read;
      setPhase(
        `Hashing ${item.path} (${formatBytes(base + read)} of ${formatBytes(total)})`,
        total ? (base + read) / total : null
      );
      const meta = cards.querySelector(
        `.card[data-id="${item.id}"] .card-meta`
      );
      if (meta) {
        meta.textContent = `${formatBytes(item.file.size)} · ${Math.round((read / Math.max(1, item.file.size)) * 100)}%`;
      }
    };

  /**
   * Hash every file that lacks a Digest of an Algorithm that is on, one at
   * a time. Turning an Algorithm on later hashes each file again for that
   * one only; what is known is kept.
   */
  const pump = async () => {
    if (current || stopped) {
      return;
    }
    const id = runId;
    const total = bytesLeft();
    let done = 0;
    progress.classList.toggle(
      "on",
      total > 0 || items.some((i) => missingFor(i).length)
    );
    for (;;) {
      const item = items.find((i) => missingFor(i).length > 0);
      if (!item || id !== runId) {
        break;
      }
      const want = missingFor(item);
      current = item;
      item.read = 0;
      renderCard(item);
      worker ??= new HashWorker();
      const w = worker;
      const base = done;
      setPhase(`Hashing ${item.path}`, total ? base / total : null);
      try {
        const res = await w.hash(
          item.file,
          want,
          progressOf(id, item, base, total)
        );
        if (id !== runId) {
          return;
        }
        for (const [k, v] of Object.entries(res.digests)) {
          item.digests.set(k as AlgorithmId, v);
        }
        item.ms = res.ms;
      } catch (error) {
        if (id !== runId) {
          return;
        }
        const msg = message(error);
        if (msg === CANCELLED) {
          return;
        }
        // A file that cannot be read (moved, or a folder the browser offered as a file) fails alone.
        item.error = `Could not read: ${msg}`;
        worker?.terminate();
        worker = null;
      }
      done += item.file.size;
      current = null;
      renderCard(item);
      renderChecks();
      renderVerdict();
    }
    if (id === runId) {
      current = null;
      progress.classList.remove("on");
      renderResults();
    }
  };

  const stopHashing = () => {
    runId += 1;
    current = null;
    worker?.terminate();
    worker = null;
    progress.classList.remove("on");
  };

  $(".cancel-btn").addEventListener("click", () => {
    stopHashing();
    stopped = true;
    renderResults();
    if (items.some((i) => missingFor(i).length)) {
      showNote("Stopped. The hashes done so far are kept.", true);
    }
  });

  resumeBtn.addEventListener("click", () => {
    stopped = false;
    note.classList.remove("on");
    renderResults();
    void pump();
  });

  /* ---- hashing text ---- */

  let textTimer = 0;
  let textRun = 0;
  const hashText = async () => {
    textRun += 1;
    const run = textRun;
    textWorker ??= new HashWorker();
    try {
      const res = await textWorker.hash(text, algorithms);
      if (run !== textRun) {
        return;
      }
      textDigests = new Map(
        Object.entries(res.digests) as [AlgorithmId, string][]
      );
      textMs = res.ms;
      renderResults();
    } catch (error) {
      if (run === textRun) {
        showError(message(error));
      }
    }
  };

  textInput.addEventListener("input", () => {
    text = textInput.value;
    clearTimeout(textTimer);
    textTimer = window.setTimeout(() => {
      publishState();
      void hashText();
    }, TEXT_DEBOUNCE_MS);
  });

  /* ---- input ---- */

  /** Add files: checksum files among them are read as lists; the rest are hashed. */
  const addFiles = async (picked: Picked[]) => {
    errorBox.classList.remove("on");
    const newLists: SumsList[] = [];
    const toHash: Picked[] = [];
    for (const p of picked) {
      const { file } = p;
      if (!file) {
        continue;
      }
      if (isSumsFileName(file.name) && file.size <= LIST_LIMIT) {
        const entries = parseSums(await file.text(), file.name);
        if (entries) {
          newLists.push({ entries, fileName: p.path });
          continue;
        }
      }
      toHash.push(p);
    }
    for (const l of newLists) {
      lists = [...lists.filter((x) => x.fileName !== l.fileName), l];
    }
    // A list names the Algorithms it was made with: those are turned on.
    const needed = newLists.flatMap((l) => l.entries.map((e) => e.algorithm));
    if (needed.some((id) => !algorithms.includes(id))) {
      algorithms = inOrder([...algorithms, ...needed]);
      syncChips();
      publishState();
    }
    const byPath = new Map(items.map((i) => [i.path, i]));
    let replaced = 0;
    for (const p of toHash) {
      if (!p.file) {
        continue;
      }
      if (byPath.has(p.path)) {
        replaced += 1;
      }
      byPath.set(p.path, {
        digests: new Map(),
        error: "",
        file: p.file,
        id: nextId,
        ms: 0,
        path: p.path,
        read: 0,
      });
      nextId += 1;
    }
    // A file being hashed and then replaced is hashed again from its new contents.
    if (current && byPath.get(current.path) !== current) {
      stopHashing();
    }
    items = [...byPath.values()];
    stopped = false;
    note.classList.remove("on");
    if (replaced) {
      showNote(
        `${count(replaced, "file", "files")} with the same path replaced the one already there.`
      );
    }
    if (newLists.length && toHash.length === 0 && items.length === 0) {
      showNote(
        `${newLists.map((l) => l.fileName).join(", ")} read as a checksum list. Drop the files it names to check them.`
      );
    }
    renderResults();
    void pump();
  };

  const setMode = (next: Mode) => {
    mode = next;
    note.classList.remove("on");
    errorBox.classList.remove("on");
    publishState();
    renderResults();
    if (mode === "text") {
      textInput.focus();
      void hashText();
    }
  };

  for (const b of el.querySelectorAll<HTMLButtonElement>(".mode button")) {
    b.addEventListener("click", () =>
      setMode(b.dataset.mode === "text" ? "text" : "files")
    );
  }

  $(".algos").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>(".algo");
    const id = b?.dataset.id;
    if (!id || !algorithmById(id)) {
      return;
    }
    const on = algorithms.includes(id as AlgorithmId);
    // At least one stays on: no Algorithm, no hash.
    if (on && algorithms.length === 1) {
      return;
    }
    algorithms = on
      ? algorithms.filter((a) => a !== id)
      : inOrder([...algorithms, id]);
    syncChips();
    publishState();
    renderResults();
    if (mode === "text") {
      void hashText();
    } else {
      void pump();
    }
  });

  verdict.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>(".turn-on");
    const id = b?.dataset.id;
    if (!id || !algorithmById(id)) {
      return;
    }
    algorithms = inOrder([...algorithms, id]);
    syncChips();
    publishState();
    renderResults();
    if (mode === "text") {
      void hashText();
    } else {
      stopped = false;
      void pump();
    }
  });

  expectedInput.addEventListener("input", () => {
    publishState();
    renderResults();
  });

  cards.addEventListener("click", async (e) => {
    const target = e.target as HTMLElement;
    const remove = target.closest<HTMLButtonElement>(".remove");
    if (remove) {
      const id = Number(remove.closest<HTMLElement>(".card")?.dataset.id);
      if (current?.id === id) {
        stopHashing();
      }
      items = items.filter((i) => i.id !== id);
      renderResults();
      void pump();
      return;
    }
    const value = target.closest<HTMLButtonElement>(".digest");
    const digest = value?.dataset.digest;
    if (!value || !digest) {
      return;
    }
    // A click that ends a drag across the text is a selection, not a request to copy.
    if (document.getSelection()?.toString()) {
      return;
    }
    await copyText(digest);
    value.classList.add("copied");
    setTimeout(() => value.classList.remove("copied"), 900);
  });

  /** What Copy and Download give: a checksum file of every finished hash. */
  const sums = () =>
    mode === "text"
      ? formatSums([{ digests: textDigests, name: "-" }], algorithms)
      : formatSums(
          items.map((i) => ({ digests: i.digests, name: i.path })),
          algorithms
        );

  copyAll.addEventListener("click", async () => {
    const { text: out } = sums();
    if (!out) {
      return;
    }
    await copyText(out);
    copyAll.textContent = "Copied";
    setTimeout(() => (copyAll.textContent = "Copy"), 1200);
  });

  saveAll.addEventListener("click", () => {
    const { text: out, fileName } = sums();
    if (out) {
      download(out, fileName);
    }
  });

  $(".clear-btn").addEventListener("click", () => {
    stopHashing();
    stopped = false;
    items = [];
    lists = [];
    note.classList.remove("on");
    errorBox.classList.remove("on");
    if (mode === "text") {
      text = "";
      textInput.value = "";
      textDigests = new Map();
      textMs = 0;
      publishState();
      void hashText();
    }
    renderResults();
  });

  $(".choose-btn").addEventListener("click", () => fileInput.click());
  $(".folder-btn").addEventListener("click", () => folderInput.click());
  for (const input of [fileInput, folderInput]) {
    input.addEventListener("change", () => {
      const picked = readInput(input.files);
      input.value = "";
      if (picked.length) {
        void addFiles(picked);
      }
    });
  }

  let dragDepth = 0;
  el.addEventListener("dragenter", (e) => {
    e.preventDefault();
    dragDepth += 1;
    el.classList.add("dragging");
  });
  el.addEventListener("dragover", (e) => e.preventDefault());
  el.addEventListener("dragleave", () => {
    dragDepth -= 1;
    if (dragDepth <= 0) {
      dragDepth = 0;
      el.classList.remove("dragging");
    }
  });
  const takeDrop = async (dt: DataTransfer) => {
    const { items: picked } = await readDrop(dt);
    if (mode === "text") {
      setMode("files");
    }
    if (picked.length) {
      await addFiles(picked);
    }
  };
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0;
    el.classList.remove("dragging");
    if (e.dataTransfer) {
      void takeDrop(e.dataTransfer);
    }
  });

  ctx.onRestore((payload) => {
    const p = new URLSearchParams(payload);
    const a = inOrder((p.get("a") ?? "").split("."));
    algorithms = a.length ? a : DEFAULT_ALGORITHMS;
    mode = p.get("m") === "text" ? "text" : "files";
    text = p.get("t") ?? "";
    textInput.value = text;
    expectedInput.value = p.get("v") ?? "";
    syncChips();
    publishState();
    renderResults();
    if (mode === "text") {
      void hashText();
    } else {
      void pump();
    }
  });

  // Only the controls: publishing here would replace a Deep Link the Shell is about to restore.
  syncChips();
  renderResults();
};

const tool: Tool = {
  id: "file-hashes",
  keywords: [
    "hash",
    "checksum",
    "digest",
    "md5",
    "sha1",
    "sha256",
    "sha512",
    "sha3",
    "blake2",
    "blake3",
    "crc32",
    "xxhash",
    "verify",
    "integrity",
    "sha256sum",
  ],
  mount,
  name: "File Hashes",
  subtitle:
    "Hash files or text with MD5, SHA-1, SHA-2, SHA-3, BLAKE3, CRC32, and more, and check them against an expected hash or a checksum file.",
};

export default tool;
