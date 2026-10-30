import "./tool.css";
import ICON_UP from "lucide-static/icons/corner-left-up.svg";
import ICON_FILE from "lucide-static/icons/file.svg";
import ICON_FOLDER from "lucide-static/icons/folder.svg";
import ICON_INFO from "lucide-static/icons/info.svg";
import ICON_LOCK from "lucide-static/icons/lock.svg";
import ICON_X from "lucide-static/icons/x.svg";

import type { Picked } from "../../shared/dropped-files";
import { readDrop, readInput } from "../../shared/dropped-files";
import type { Tool, ToolContext } from "../../shell/types";
import {
  FORMATS,
  IN,
  LEVEL_NAMES,
  baseName,
  createSteps,
  extractArgs,
  firstVolume,
  formatById,
  levelFor,
  listArgs,
  looksLikeArchive,
  readOutcome,
  testArgs,
} from "./commands";
import type { CreateOptions, FormatId, Level, Outcome } from "./commands";
import { canWriteFolders, download, pickFolder, writeFolder } from "./deliver";
import type { DirHandle } from "./deliver";
import {
  ENGINES,
  cacheAvailable,
  cachedFamilies,
  clearCached,
  getEngine,
  listCached,
} from "./engines";
import type { Progress } from "./engines";
import { parseListing } from "./listing";
import type { Listing } from "./listing";
import { renderPreview } from "./preview";
import type { Preview } from "./preview";
import { buildTree, descendants, findNode, segments, sortNodes } from "./tree";
import type { Node, SortKey } from "./tree";
import type { Input, Output } from "./worker";
import { ArchiveWorker, CANCELLED } from "./worker-client";
import type { RunRequest, RunResult } from "./worker-client";

const OPTIONS_KEY = "html-tools:archive-manager:options";
const DEFAULT_FORMAT: FormatId = "7z";
const DEFAULT_LEVEL: Level = 5;
/** A folder or a Filter result longer than this shows its first rows and a Show all. */
const ROW_LIMIT = 1000;
/** A file bigger than this is previewed only on request: it must be extracted first. */
const AUTO_PREVIEW_LIMIT = 64 * 1024 * 1024;
/** The single-stream formats a tarball comes wrapped in, by 7-Zip's type names. */
const STREAM_TYPES = new Set([
  "bzip2",
  "gzip",
  "lz4",
  "lzip",
  "lzma",
  "lzma86",
  "xz",
  "z",
  "zstd",
]);
const TAR_NAME = /\.tar$/iu;
/** A name that is one volume of a split archive. */
const VOLUME_NAME = /\.(?:\d{3}|part\d+\.rar|r\d\d|z\d\d)$/iu;

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

const count = (n: number, one: string, many: string) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

const pad = (n: number) => String(n).padStart(2, "0");

/** Milliseconds as `YYYY-MM-DD HH:MM`, local time, as 7-Zip prints them. */
const formatTime = (t: number | null) => {
  if (t === null) {
    return "";
  }
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const seconds = (ms: number) =>
  ms < 1000
    ? `${Math.max(1, Math.round(ms))} ms`
    : `${(ms / 1000).toFixed(1)} s`;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

const lastSegment = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** The first error of an Outcome, worded for the screen. */
const outcomeError = (o: Outcome, what: string): string => {
  if (o.wrongPassword) {
    return "Wrong password, or none given: the archive is encrypted.";
  }
  if (o.notArchive) {
    return `${what} is not an archive 7-Zip can read.`;
  }
  const [first = "7-Zip reported an error."] = o.errors;
  const more = o.errors.length > 1 ? ` (and ${o.errors.length - 1} more)` : "";
  const hint = o.truncated
    ? " The archive ends early: it is cut short, or a volume is missing."
    : "";
  return `${first}${more}${hint}`;
};

/** An archive on screen. */
interface Opened {
  /** What the user calls it: the file name, or the first volume's. */
  name: string;
  /** What 7-Zip reads: the dropped files (all volumes), or the tar unwrapped from its compressor. */
  inputs: Input[];
  /** The original files, for Test, which checks the compressor around an unwrapped tar too. */
  originals: Input[];
  /** Path of the file 7-Zip opens, under IN. */
  path: string;
  /** Bytes of the original files. */
  size: number;
  /** The compressor an unwrapped tar came out of, e.g. `gzip`. */
  wrapper: string;
  listing: Listing;
  tree: Node;
  /** Whether any Entry is encrypted, so extracting needs the password. */
  encrypted: boolean;
}

/** A file or folder waiting to be packed into a new archive. */
interface Staged {
  path: string;
  file?: File;
}

interface Phase {
  text: string;
  fraction: number | null;
}

/** Where an operation shows its progress and its failure, when not in the shared panels. */
interface Surface {
  phase: (p: Phase) => void;
  error: (msg: string) => void;
}

/** Runs one 7-Zip command for the current operation; `total` is what progress is measured against. */
type Exec = (
  req: RunRequest,
  total: number,
  text: string
) => Promise<RunResult>;

const fileInputs = (files: File[]): Input[] =>
  files.map((f) => ({ blob: f, mtime: f.lastModified, path: f.name }));

const outputInputs = (outputs: Output[]): Input[] =>
  outputs.map((o) => ({
    blob: o.blob,
    mode: o.mode,
    mtime: o.mtime,
    path: o.path,
  }));

const sizeOf = (inputs: Input[]) =>
  inputs.reduce((n, i) => n + (i.blob?.size ?? 0), 0);

/** The first segment of every path: what a command adds, from its working folder. */
const topLevel = (paths: string[]) => [
  ...new Set(paths.map((p) => p.split("/")[0] ?? p)),
];

const OPTIONS_MARKUP = `
  <label class="opt"><span>Format</span><select class="o-format" aria-label="Format"></select></label>
  <label class="opt o-level-wrap"><span>Level</span><select class="o-level" aria-label="Compression level"></select></label>
  <label class="opt o-pw-wrap"><span>Password</span><input type="password" class="o-pw" placeholder="None" autocomplete="new-password" spellcheck="false"></label>
  <label class="check o-names-wrap" title="Without the password, not even the list of files can be read"><input type="checkbox" class="o-names" checked>Encrypt file names</label>
  <label class="opt o-zipenc-wrap" title="AES-256 is strong; ZipCrypto is weak but opens in every unzipper, Windows Explorer included"><span>Encryption</span><select class="o-zipenc" aria-label="Zip encryption">
    <option value="aes">AES-256</option>
    <option value="zipcrypto">ZipCrypto</option>
  </select></label>`;

/** The format and options form, used by New archive and by Convert. */
class OptionsForm {
  private format: HTMLSelectElement;
  private level: HTMLSelectElement;
  private pw: HTMLInputElement;
  private names: HTMLInputElement;
  private zipEnc: HTMLSelectElement;
  private root: HTMLElement;
  /** Whether exactly one file is to be packed, which is what gzip, bzip2, and xz can take. */
  private single = false;
  /** The format last picked, kept while it is not offered, so it comes back when it is. */
  private chosen: string = DEFAULT_FORMAT;
  private listener: (() => void) | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    root.innerHTML = OPTIONS_MARKUP;
    const q = <T extends HTMLElement>(sel: string): T => {
      const node = root.querySelector<T>(sel);
      if (!node) {
        throw new Error(`Archive options markup has no ${sel}`);
      }
      return node;
    };
    this.format = q(".o-format");
    this.level = q(".o-level");
    this.pw = q(".o-pw");
    this.names = q(".o-names");
    this.zipEnc = q(".o-zipenc");
    this.format.addEventListener("change", () => {
      this.chosen = this.format.value;
      this.sync();
      this.listener?.();
    });
    this.level.addEventListener("change", () => this.listener?.());
    this.pw.addEventListener("input", () => this.sync());
    this.sync();
  }

  /** Called when the user picks another format or level. */
  listen(fn: () => void) {
    this.listener = fn;
  }

  get(): CreateOptions {
    return {
      encryptNames: this.names.checked,
      format: this.format.value as FormatId,
      level: Number(this.level.value) as Level,
      password: this.pw.value,
      zipEncryption: this.zipEnc.value === "zipcrypto" ? "zipcrypto" : "aes",
    };
  }

  set(format: FormatId, level: Level) {
    this.chosen = format;
    this.sync(level);
  }

  setSingle(single: boolean) {
    this.single = single;
    this.sync();
  }

  /** Show what the format offers; a single-file format is offered only when there is one file. */
  private sync(wanted?: Level) {
    // Only what can be made is listed: a compressor of one file only when there is one file.
    const offered = FORMATS.filter((x) => this.single || !x.single);
    const ids = offered.map((x) => x.id).join(" ");
    if ([...this.format.options].map((o) => o.value).join(" ") !== ids) {
      this.format.innerHTML = offered
        .map((x) => `<option value="${x.id}">${x.label}</option>`)
        .join("");
    }
    const f =
      offered.find((x) => x.id === this.chosen) ?? formatById(DEFAULT_FORMAT);
    if (!f) {
      return;
    }
    this.format.value = f.id;
    const current =
      wanted ?? (Number(this.level.value || DEFAULT_LEVEL) as Level);
    this.level.innerHTML = f.levels
      .map((l) => `<option value="${l}">${LEVEL_NAMES[l]}</option>`)
      .join("");
    const level = levelFor(f, current);
    if (level !== null) {
      this.level.value = String(level);
    }
    const show = (sel: string, on: boolean) =>
      this.root.querySelector<HTMLElement>(sel)?.classList.toggle("off", !on);
    show(".o-level-wrap", f.levels.length > 0);
    show(".o-pw-wrap", f.password);
    show(".o-names-wrap", f.encryptNames && this.pw.value !== "");
    show(".o-zipenc-wrap", f.id === "zip" && this.pw.value !== "");
  }
}

const mount = (el: HTMLElement, ctx: ToolContext) => {
  el.innerHTML = `
      <div class="toolbar">
        <button type="button" class="open-btn">Open archive</button>
        <button type="button" class="new-btn">New archive</button>
        <button type="button" class="clear-btn">Clear</button>
        <span class="status"></span>
      </div>
      <input type="file" class="open-input" multiple hidden>
      <input type="file" class="add-input" multiple hidden>
      <input type="file" class="folder-input" webkitdirectory hidden>
      <div class="empty-hint">
        <strong>Drop an archive to open it, or files and folders to pack them</strong>, or use the buttons above.
        <span>Opens 7z, zip, rar, tar, gz, xz, iso, dmg, cab and some fifty more formats; makes 7z, zip, tar, gzip, bzip2, and xz. Nothing leaves the browser. 7-Zip (1.6 MB) downloads on first use and stays cached.</span>
      </div>
      <div class="progress">
        <span class="phase"></span>
        <div class="bar"><div class="fill"></div></div>
        <button type="button" class="cancel-btn">Cancel</button>
      </div>
      <div class="note" role="status">${ICON_INFO}<span class="note-text"></span></div>
      <div class="error-box" role="alert"></div>

      <section class="archive">
        <div class="summary">
          <div class="crumbs-archive"></div>
          <div class="facts"></div>
          <details class="props"><summary>Properties</summary><dl></dl></details>
        </div>
        <div class="locked">
          ${ICON_LOCK}
          <span class="locked-text">The file names in this archive are encrypted.</span>
          <input type="password" class="unlock-pw" placeholder="Password" aria-label="Password" autocomplete="off" spellcheck="false">
          <button type="button" class="unlock-btn primary">Open</button>
        </div>
        <div class="actions">
          <button type="button" class="extract-btn primary">Extract all</button>
          <button type="button" class="test-btn" title="Check every file's data against its checksum">Test</button>
          <button type="button" class="convert-btn" aria-expanded="false">Convert</button>
          <label class="pw-wrap">${ICON_LOCK}<input type="password" class="pw" placeholder="Password" aria-label="Password" autocomplete="off" spellcheck="false"></label>
        </div>
        <div class="panel convert-panel">
          <div class="opts convert-opts"></div>
          <button type="button" class="convert-go primary">Convert</button>
        </div>
        <div class="panel report"></div>
        <div class="split">
          <div class="browser">
            <div class="pane-head">
              <nav class="crumbs" aria-label="Folder"></nav>
              <span class="spacer"></span>
              <input type="search" class="filter" placeholder="Filter" aria-label="Filter files" spellcheck="false" autocomplete="off">
            </div>
            <div class="table-wrap">
              <table class="entries">
                <thead><tr>
                  <th class="c-check"><input type="checkbox" class="check-all" aria-label="Select all shown"></th>
                  <th class="c-name"><button type="button" class="sort" data-sort="name">Name</button></th>
                  <th class="c-size"><button type="button" class="sort" data-sort="size">Size</button></th>
                  <th class="c-packed">Packed</th>
                  <th class="c-time"><button type="button" class="sort" data-sort="modified">Modified</button></th>
                </tr></thead>
                <tbody></tbody>
              </table>
              <div class="table-foot"></div>
            </div>
          </div>
          <aside class="preview" aria-label="Preview">
            <div class="pane-head">
              <span class="pv-name"></span>
              <span class="spacer"></span>
              <button type="button" class="pv-open" title="Open this archive">Open</button>
              <button type="button" class="pv-download">Download</button>
              <button type="button" class="pv-close icon" title="Close the preview" aria-label="Close the preview">${ICON_X}</button>
            </div>
            <div class="pv-meta"></div>
            <div class="pv-body"></div>
            <div class="pv-note"></div>
          </aside>
        </div>
      </section>

      <section class="create">
        <div class="staging">
          <div class="pane-head">
            <span>Files to pack</span>
            <span class="meta staged-meta"></span>
            <span class="spacer"></span>
            <button type="button" class="add-files">Add files</button>
            <button type="button" class="add-folder">Add folder</button>
          </div>
          <div class="staged-list"></div>
        </div>
        <div class="panel create-panel">
          <label class="opt name-wrap"><span>Name</span><input type="text" class="name" aria-label="Archive name" spellcheck="false" autocomplete="off"><span class="ext"></span></label>
          <div class="opts create-opts"></div>
          <button type="button" class="create-go primary">Create</button>
        </div>
      </section>

      <div class="panel made">
        <div class="made-text"></div>
        <button type="button" class="made-download primary">Download</button>
        <button type="button" class="made-open">Open</button>
      </div>

      <div class="engines">
        <span class="engines-text"></span>
        <button type="button" class="engines-clear" hidden>Clear cached engines</button>
      </div>`;

  const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => {
    const node = el.querySelector<T>(sel);
    if (!node) {
      throw new Error(`Archive Manager markup has no ${sel}`);
    }
    return node;
  };
  const status = $(".status");
  const openInput = $<HTMLInputElement>(".open-input");
  const addInput = $<HTMLInputElement>(".add-input");
  const folderInput = $<HTMLInputElement>(".folder-input");
  const emptyHint = $(".empty-hint");
  const progress = $(".progress");
  const phase = $(".phase");
  const bar = $(".bar");
  const fill = $(".fill");
  const note = $(".note");
  const noteText = $(".note-text");
  const errorBox = $(".error-box");
  const archiveView = $(".archive");
  const crumbsArchive = $(".crumbs-archive");
  const facts = $(".facts");
  const props = $<HTMLDetailsElement>(".props");
  const lockedText = $(".locked-text");
  const unlockPw = $<HTMLInputElement>(".unlock-pw");
  const extractBtn = $<HTMLButtonElement>(".extract-btn");
  const testBtn = $<HTMLButtonElement>(".test-btn");
  const convertBtn = $<HTMLButtonElement>(".convert-btn");
  const pwWrap = $(".pw-wrap");
  const pw = $<HTMLInputElement>(".pw");
  const convertPanel = $(".convert-panel");
  const report = $(".report");
  const split = $(".split");
  const crumbs = $(".crumbs");
  const filterInput = $<HTMLInputElement>(".filter");
  const checkAll = $<HTMLInputElement>(".check-all");
  const tbody = $("tbody");
  const tableFoot = $(".table-foot");
  const pvName = $(".pv-name");
  const pvOpen = $<HTMLButtonElement>(".pv-open");
  const pvDownload = $<HTMLButtonElement>(".pv-download");
  const pvMeta = $(".pv-meta");
  const pvBody = $(".pv-body");
  const pvNote = $(".pv-note");
  const createView = $(".create");
  const stagedMeta = $(".staged-meta");
  const stagedList = $(".staged-list");
  const nameInput = $<HTMLInputElement>(".name");
  const extLabel = $(".ext");
  const made = $(".made");
  const madeText = $(".made-text");
  const enginesText = $(".engines-text");
  const enginesClear = $<HTMLButtonElement>(".engines-clear");

  let worker: ArchiveWorker | null = null;
  /** Whether the worker is busy for the current operation, so stopping it must stop the worker. */
  let working = false;
  /** Which operation owns the screen; a superseded one must not touch it. */
  let runId = 0;
  let busy = false;
  /** What the running operation is, so a second preview can replace the first. */
  let running: "open" | "preview" | "other" | null = null;

  let opened: Opened | null = null;
  /** Archives the one on screen was opened from, outermost first. */
  let parents: Opened[] = [];
  /** The files a locked archive came from, so its password can be tried. */
  let pendingLocked: File[] | null = null;
  /** Password for the archive on screen; never stored. */
  let password = "";
  /** Folder of the archive shown, as a normalized path. */
  let cwd = "";
  const selected = new Set<string>();
  let sortKey: SortKey = "name";
  let sortDesc = false;
  let showAll = false;
  /** The node in the preview, and what the preview holds. */
  let previewed: Node | null = null;
  let previewBlob: Blob | null = null;
  let shown: Preview | null = null;

  const staged = new Map<string, Staged>();
  /** The last archive made or converted, for Download and Open. */
  let result: { blob: Blob; name: string } | null = null;

  /* ---- options, the Deep Link, and the Preference ---- */

  let format: FormatId = DEFAULT_FORMAT;
  let level: Level = DEFAULT_LEVEL;

  const parseOptions = (s: string | null): [FormatId, Level] | null => {
    if (!s) {
      return null;
    }
    const cut = s.lastIndexOf(".");
    const f = formatById(cut === -1 ? s : s.slice(0, cut));
    if (!f) {
      return null;
    }
    const asked =
      cut === -1 ? DEFAULT_LEVEL : (Number(s.slice(cut + 1)) as Level);
    return [f.id, levelFor(f, asked) ?? DEFAULT_LEVEL];
  };

  const createForm = new OptionsForm($(".create-opts"));
  const convertForm = new OptionsForm($(".convert-opts"));

  /**
   * The name a new archive gets unless the user types one: one folder is
   * named after itself, and one file after itself, without its extension
   * for an archive format and with it for a compressor (`notes.txt.gz`,
   * as gzip itself names it). Several items make an `archive`.
   */
  const defaultName = (): string => {
    const tops = topLevel([...staged.keys()]);
    const [only] = tops;
    if (tops.length === 1 && only) {
      const isFolder = [...staged.keys()].some((p) => p.startsWith(`${only}/`));
      const keepsExt = formatById(createForm.get().format)?.single === true;
      return isFolder || keepsExt ? only : baseName(only);
    }
    return "archive";
  };

  let nameTouched = false;

  /** The extension beside the name field, and the name itself while the user has not typed one. */
  const syncName = () => {
    const f = formatById(createForm.get().format);
    extLabel.textContent = f ? `.${f.ext}` : "";
    if (!nameTouched) {
      nameInput.value = defaultName();
    }
  };

  nameInput.addEventListener("input", () => {
    nameTouched = nameInput.value.trim() !== "";
  });

  const syncCreate = () => {
    const items = [...staged.values()];
    const files = items.filter((s) => s.file);
    const bytes = files.reduce((n, s) => n + (s.file?.size ?? 0), 0);
    stagedMeta.textContent = items.length
      ? `${count(files.length, "file", "files")} · ${formatBytes(bytes)}`
      : "";
    const single =
      files.length === 1 && items.length === 1 && !files[0]?.path.includes("/");
    createForm.setSingle(single);
    ({ format, level } = createForm.get());
    syncName();
    const go = el.querySelector<HTMLButtonElement>(".create-go");
    if (go) {
      go.disabled = busy || items.length === 0;
    }
  };

  /** State layout: `format.level` (`zip.9`); the defaults leave the Deep Link empty. Passwords never go in. */
  const publishState = () => {
    const value = `${format}.${level}`;
    try {
      localStorage.setItem(OPTIONS_KEY, value);
    } catch {
      // A private window: the options still apply for this visit.
    }
    ctx.setState(
      format === DEFAULT_FORMAT && level === DEFAULT_LEVEL ? "" : value
    );
  };

  const applyOptions = ([f, l]: [FormatId, Level]) => {
    format = f;
    level = l;
    createForm.set(f, l);
    convertForm.set(f, l);
  };

  createForm.listen(() => {
    ({ format, level } = createForm.get());
    publishState();
    syncName();
  });

  ctx.onRestore((payload) => {
    applyOptions(parseOptions(payload) ?? [DEFAULT_FORMAT, DEFAULT_LEVEL]);
    publishState();
    syncName();
  });
  // Only the controls: publishing here would replace a Deep Link the Shell is about to restore.
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(OPTIONS_KEY);
  } catch {
    stored = null;
  }
  applyOptions(parseOptions(stored) ?? [DEFAULT_FORMAT, DEFAULT_LEVEL]);

  /* ---- engines footer ---- */

  const renderEngines = async () => {
    if (!(await cacheAvailable())) {
      enginesText.textContent =
        "Engines cannot be kept here (no IndexedDB); they download on every visit.";
      enginesClear.hidden = true;
      return;
    }
    const rows = await listCached();
    if (rows.length === 0) {
      enginesText.textContent = "No engines cached";
      enginesClear.hidden = true;
      return;
    }
    enginesText.textContent = `Engines cached: ${formatBytes(rows.reduce((n, r) => n + r.bytes, 0))}`;
    // The breakdown is a hover away, not in the way.
    enginesText.title = cachedFamilies(rows)
      .map((f) => `${f.label} ${formatBytes(f.bytes)}`)
      .join("\n");
    enginesClear.hidden = false;
  };
  enginesClear.addEventListener("click", async () => {
    if (busy) {
      return;
    }
    enginesClear.disabled = true;
    try {
      await clearCached();
    } finally {
      enginesClear.disabled = false;
    }
    void renderEngines();
  });
  void renderEngines();

  /* ---- screen ---- */

  const setPhase = (p: Phase) => {
    phase.textContent = p.text;
    if (p.fraction === null) {
      bar.classList.add("busy");
      fill.style.width = "";
    } else {
      bar.classList.remove("busy");
      fill.style.width = `${Math.round(Math.max(0, Math.min(1, p.fraction)) * 100)}%`;
    }
  };

  const showNote = (text: string) => {
    noteText.textContent = text;
    note.classList.add("on");
  };

  const showError = (msg: string) => {
    errorBox.textContent = msg;
    errorBox.classList.add("on");
  };

  const clearMessages = () => {
    note.classList.remove("on");
    errorBox.classList.remove("on");
  };

  /** `shared`: whether the shared progress panel shows; a preview keeps its progress in its own panel. */
  const setBusy = (next: boolean, shared = true) => {
    busy = next;
    el.classList.toggle("busy", next);
    progress.classList.toggle("on", next && shared);
    for (const b of el.querySelectorAll<HTMLButtonElement>(
      ".actions button, .convert-go, .create-go, .unlock-btn, .made button, .pv-open, .pv-download"
    )) {
      b.disabled = next;
    }
    if (!next) {
      running = null;
      syncCreate();
      void renderEngines();
    }
  };

  type View = "empty" | "archive" | "create";
  const setView = (v: View) => {
    emptyHint.style.display = v === "empty" ? "block" : "none";
    archiveView.classList.toggle("on", v === "archive");
    createView.classList.toggle("on", v === "create");
    if (v !== "archive") {
      status.textContent = "";
    }
  };
  setView("empty");

  const hideResult = () => {
    result = null;
    made.classList.remove("on");
  };

  const showResult = (blob: Blob, name: string, text: string) => {
    result = { blob, name };
    madeText.replaceChildren();
    const strong = document.createElement("strong");
    strong.textContent = name;
    madeText.append(strong, ` ${text}`);
    made.classList.add("on");
  };

  /* ---- the engine and the operation runner ---- */

  /** The worker with the engine loaded, downloading what the cache lacks first. */
  const engine = async (
    onPhase: (p: Phase) => void
  ): Promise<ArchiveWorker> => {
    worker ??= new ArchiveWorker();
    const w = worker;
    const seen = new Map<string, Progress>();
    const reportProgress = (p: Progress) => {
      seen.set(p.asset.id, p);
      const fetching = [...seen.values()].filter((x) => !x.fromCache);
      if (!fetching.length) {
        return;
      }
      const loaded = fetching.reduce((n, x) => n + x.loaded, 0);
      const total = fetching.reduce((n, x) => n + x.total, 0);
      onPhase({
        fraction: total ? loaded / total : null,
        text: `Downloading 7-Zip (${formatBytes(loaded)} of ${formatBytes(total)})`,
      });
    };
    const [glue, wasm] = await Promise.all([
      getEngine(ENGINES.js7zJs, reportProgress),
      getEngine(ENGINES.js7zWasm, reportProgress),
    ]);
    try {
      await w.load(new TextDecoder().decode(glue), wasm);
    } catch (error) {
      // A worker that failed to load is no use to the next operation either.
      if (worker === w) {
        worker = null;
      }
      w.terminate();
      throw error;
    }
    return w;
  };

  /** End whatever runs. A loaded, idle worker is kept. */
  const stopWork = () => {
    runId += 1;
    if (working && worker) {
      worker.terminate();
      worker = null;
    }
    working = false;
  };

  /**
   * Run an operation: the engine is loaded, `body` runs its commands
   * through `exec`, progress shows, and Cancel or a newer operation stops
   * it. Resolves with what `body` resolved with, or undefined when the
   * operation failed (the error is on screen), was cancelled, or was
   * superseded.
   */
  const perform = async <T>(
    kind: "open" | "preview" | "other",
    text: string,
    body: (exec: Exec, owns: () => boolean) => Promise<T>,
    surface?: Surface
  ): Promise<T | undefined> => {
    stopWork();
    const id = runId;
    const owns = () => id === runId;
    const show = surface?.phase ?? setPhase;
    const fail = surface?.error ?? showError;
    // Elsewhere on screen nothing moves for an operation with a surface of its own.
    if (!surface) {
      clearMessages();
    }
    setBusy(true, !surface);
    running = kind;
    show({ fraction: null, text });
    working = true;
    try {
      const w = await engine((p) => owns() && show(p));
      if (!owns()) {
        return undefined;
      }
      const exec: Exec = async (req, total, label) => {
        show({ fraction: total ? 0 : null, text: label });
        const res = await w.run(req, (read) => {
          if (owns() && total) {
            show({
              fraction: read / total,
              text: `${label} (${formatBytes(Math.min(read, total))} of ${formatBytes(total)})`,
            });
          }
        });
        if (!owns()) {
          throw new Error(CANCELLED);
        }
        return res;
      };
      const value = await body(exec, owns);
      return owns() ? value : undefined;
    } catch (error) {
      if (!owns()) {
        return undefined;
      }
      const msg = message(error);
      if (msg !== CANCELLED) {
        fail(msg);
      }
      // A worker that failed mid-run may be in any state; the next operation starts from a fresh one.
      worker?.terminate();
      worker = null;
      return undefined;
    } finally {
      if (owns()) {
        working = false;
        setBusy(false);
      }
    }
  };

  $(".cancel-btn").addEventListener("click", () => {
    if (!busy) {
      return;
    }
    const was = running;
    stopWork();
    setBusy(false);
    if (was === "open" && !opened) {
      setView("empty");
    }
    showNote("Cancelled.");
  });

  /** Packs `inputs` into an archive called `name` with the options; resolves with its bytes. */
  const pack = async (
    exec: Exec,
    name: string,
    inputs: Input[],
    o: CreateOptions
  ): Promise<Blob> => {
    const steps = createSteps(name, topLevel(inputs.map((i) => i.path)), o);
    let current = inputs;
    let archive: Blob | undefined;
    for (const [i, step] of steps.entries()) {
      const last = i === steps.length - 1;
      const res = await exec(
        { args: step.args, collect: true, cwd: step.cwd, inputs: current },
        sizeOf(current),
        last && steps.length > 1 ? "Compressing" : "Packing"
      );
      const outcome = readOutcome(res.code, res.stdout, res.stderr);
      if (!outcome.ok) {
        throw new Error(outcomeError(outcome, name));
      }
      const files = res.outputs.filter((x) => x.blob);
      current = outputInputs(files);
      archive = files.find((x) => x.path === name)?.blob;
    }
    if (!archive) {
      throw new Error("7-Zip finished without writing the archive.");
    }
    return archive;
  };

  /* ---- the archive on screen ---- */

  const resetPreview = () => {
    shown?.dispose();
    shown = null;
    previewed = null;
    previewBlob = null;
    pvBody.replaceChildren();
    pvNote.textContent = "";
    split.classList.remove("previewing");
  };

  const closeArchive = () => {
    resetPreview();
    opened = null;
    parents = [];
    password = "";
    pw.value = "";
    unlockPw.value = "";
    cwd = "";
    selected.clear();
    filterInput.value = "";
    showAll = false;
    report.classList.remove("on");
    convertPanel.classList.remove("on");
    convertBtn.setAttribute("aria-expanded", "false");
    archiveView.classList.remove("listed", "is-locked");
  };

  const renderCrumbsArchive = () => {
    crumbsArchive.replaceChildren();
    const chain = [...parents, ...(opened ? [opened] : [])];
    for (const [i, a] of chain.entries()) {
      if (i > 0) {
        crumbsArchive.append(" › ");
      }
      if (i < chain.length - 1) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "crumb";
        b.textContent = a.name;
        b.title = "Back to this archive";
        b.dataset.depth = String(i);
        crumbsArchive.append(b);
      } else {
        const s = document.createElement("strong");
        s.textContent = a.name;
        crumbsArchive.append(s);
      }
    }
  };

  const renderFacts = (a: Opened) => {
    const { info } = a.listing;
    const { files } = a.tree;
    const folders = descendants(a.tree).filter((n) => n.dir).length;
    const type = a.wrapper ? `tar in ${a.wrapper}` : info.type || "archive";
    const parts = [
      type,
      formatBytes(a.size),
      count(files, "file", "files"),
      ...(folders ? [count(folders, "folder", "folders")] : []),
      `${formatBytes(a.tree.size)} unpacked`,
    ];
    if (a.tree.size > 0 && a.size > 0 && !a.wrapper) {
      parts.push(`ratio ${Math.round((a.size / a.tree.size) * 100)}%`);
    }
    if (info.method) {
      parts.push(info.method);
    }
    if (info.solid) {
      parts.push("solid");
    }
    if (a.encrypted) {
      parts.push("encrypted");
    }
    facts.textContent = parts.join(" · ");
    const dl = props.querySelector("dl");
    if (dl) {
      dl.replaceChildren();
      for (const [k, v] of info.props) {
        if (k === "Path" || v === "") {
          continue;
        }
        const dt = document.createElement("dt");
        dt.textContent = k;
        const dd = document.createElement("dd");
        dd.textContent = v;
        dl.append(dt, dd);
      }
      props.style.display = dl.children.length ? "" : "none";
    }
  };

  const syncActions = () => {
    const a = opened;
    if (!a) {
      return;
    }
    const n = selected.size;
    extractBtn.textContent = n
      ? `Extract ${count(n, "item", "items")}`
      : "Extract all";
    pwWrap.classList.toggle("on", a.encrypted);
  };

  /** The nodes to show: the folder's children, or everything matching the Filter. */
  const visibleNodes = (a: Opened): Node[] => {
    const term = filterInput.value.trim().toLowerCase();
    if (term) {
      return sortNodes(
        descendants(a.tree).filter((n) => n.path.toLowerCase().includes(term)),
        sortKey,
        sortDesc
      );
    }
    const folder = findNode(a.tree, cwd) ?? a.tree;
    return sortNodes([...folder.children.values()], sortKey, sortDesc);
  };

  const iconFor = (n: Node) => {
    if (n.dir) {
      return ICON_FOLDER;
    }
    return n.entry?.encrypted ? ICON_LOCK : ICON_FILE;
  };

  const rowFor = (n: Node, filtered: boolean): HTMLTableRowElement => {
    const tr = document.createElement("tr");
    tr.dataset.path = n.path;
    tr.classList.toggle("dir", n.dir);
    tr.classList.toggle("active", previewed?.path === n.path);

    const check = document.createElement("td");
    check.className = "c-check";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "pick";
    box.checked = selected.has(n.path);
    box.setAttribute("aria-label", `Select ${n.name}`);
    check.append(box);

    const name = document.createElement("td");
    name.className = "c-name";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "open-node";
    btn.innerHTML = iconFor(n);
    const label = document.createElement("span");
    label.textContent = filtered ? n.path : n.name;
    btn.append(label);
    btn.title = n.dir ? "Open folder" : "Preview";
    name.append(btn);

    const size = document.createElement("td");
    size.className = "c-size";
    size.textContent = n.dir
      ? count(n.files, "file", "files")
      : formatBytes(n.size);

    const packed = document.createElement("td");
    packed.className = "c-packed";
    const p = n.entry?.packed;
    packed.textContent =
      !n.dir && p !== null && p !== undefined ? formatBytes(p) : "";

    const time = document.createElement("td");
    time.className = "c-time";
    time.textContent = n.entry?.modified
      ? n.entry.modified.slice(0, 16)
      : formatTime(n.mtime);

    tr.append(check, name, size, packed, time);
    return tr;
  };

  const renderCrumbs = (a: Opened) => {
    crumbs.replaceChildren();
    const add = (label: string, path: string, current: boolean) => {
      if (current) {
        const s = document.createElement("span");
        s.className = "here";
        s.textContent = label;
        crumbs.append(s);
        return;
      }
      const b = document.createElement("button");
      b.type = "button";
      b.className = "crumb";
      b.dataset.path = path;
      b.textContent = label;
      crumbs.append(b);
    };
    const parts = segments(cwd);
    add(a.name, "", parts.length === 0);
    for (const [i, name] of parts.entries()) {
      crumbs.append("/");
      add(name, parts.slice(0, i + 1).join("/"), i === parts.length - 1);
    }
  };

  const renderList = () => {
    const a = opened;
    if (!a) {
      return;
    }
    renderCrumbs(a);
    const filtered = filterInput.value.trim() !== "";
    const nodes = visibleNodes(a);
    const rows: HTMLTableRowElement[] = [];
    if (!filtered && cwd) {
      const up = document.createElement("tr");
      up.className = "up";
      up.innerHTML = `<td class="c-check"></td><td class="c-name" colspan="4"><button type="button" class="go-up">${ICON_UP}<span>..</span></button></td>`;
      rows.push(up);
    }
    const limit = showAll ? nodes.length : ROW_LIMIT;
    for (const n of nodes.slice(0, limit)) {
      rows.push(rowFor(n, filtered));
    }
    tbody.replaceChildren(...rows);
    tableFoot.replaceChildren();
    if (nodes.length > limit) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "show-all";
      more.textContent = `Show all ${nodes.length.toLocaleString()}`;
      tableFoot.append(
        `Showing ${limit.toLocaleString()} of ${nodes.length.toLocaleString()}. `,
        more
      );
    } else if (nodes.length === 0) {
      tableFoot.textContent = filtered
        ? "Nothing matches."
        : "This folder is empty.";
    }
    const shownPaths = nodes.slice(0, limit).map((n) => n.path);
    const picked = shownPaths.filter((p) => selected.has(p)).length;
    checkAll.checked = picked > 0 && picked === shownPaths.length;
    checkAll.indeterminate = picked > 0 && picked < shownPaths.length;
    const direction = sortDesc ? "descending" : "ascending";
    for (const th of el.querySelectorAll<HTMLButtonElement>(".sort")) {
      const on = th.dataset.sort === sortKey;
      th.classList.toggle("sorted", on);
      th.classList.toggle("desc", on && sortDesc);
      th.closest("th")?.setAttribute("aria-sort", on ? direction : "none");
    }
    syncActions();
  };

  const enter = (path: string) => {
    cwd = path;
    showAll = false;
    filterInput.value = "";
    renderList();
  };

  /** Put an opened archive on screen. */
  const showArchive = (a: Opened) => {
    opened = a;
    setView("archive");
    status.textContent = "";
    archiveView.classList.add("listed");
    archiveView.classList.remove("is-locked");
    renderCrumbsArchive();
    renderFacts(a);
    const { warnings } = a.listing.info;
    if (warnings.length) {
      showNote(`7-Zip warns: ${warnings.join(" ")}`);
    }
    renderList();
  };

  crumbsArchive.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>(".crumb");
    if (!b || busy) {
      return;
    }
    const depth = Number(b.dataset.depth);
    const back = parents[depth];
    if (!back) {
      return;
    }
    const keep = parents.slice(0, depth);
    closeArchive();
    parents = keep;
    showArchive(back);
  });

  /** Ask for the password an archive with encrypted names needs before it can be listed. */
  const showLocked = (name: string, wrong: boolean) => {
    setView("archive");
    archiveView.classList.remove("listed");
    archiveView.classList.add("is-locked");
    crumbsArchive.textContent = name;
    facts.textContent = "";
    props.style.display = "none";
    lockedText.textContent = wrong
      ? "Wrong password. The file names in this archive are encrypted."
      : "The file names in this archive are encrypted. Enter the password to open it.";
    unlockPw.focus();
    unlockPw.select();
  };

  /** What 7-Zip makes of the file at `path` under the inputs, with `pass` as the password. */
  const list = async (
    exec: Exec,
    inputs: Input[],
    path: string,
    pass: string
  ) => {
    const res = await exec(
      { args: listArgs(path, pass), collect: false, cwd: "/", inputs },
      0,
      "Reading the archive"
    );
    return {
      listing: parseListing(res.stdout),
      outcome: readOutcome(res.code, res.stdout, res.stderr),
    };
  };

  /** Why files that listed nothing could not be opened, in the user's terms. */
  const openFailure = (files: File[], main: string, o: Outcome): string => {
    if (files.length === 1 && VOLUME_NAME.test(main)) {
      return `${main} looks like one volume of a split archive, and 7-Zip could not open it alone. Open every volume together.`;
    }
    const volumes = firstVolume(files.map((f) => f.name)) !== null;
    if (volumes && (o.notArchive || o.truncated)) {
      return `${main} could not be opened with the ${count(files.length, "volume", "volumes")} given: one is missing, or they are not all of one archive.`;
    }
    return outcomeError(o, main);
  };

  /** Whether a listing is a compressor holding one tar, which is shown unwrapped. */
  const wrapsTar = (l: Listing): boolean => {
    const [only] = l.entries;
    return (
      STREAM_TYPES.has(l.info.type.toLowerCase()) &&
      l.entries.length === 1 &&
      only !== undefined &&
      !only.dir &&
      TAR_NAME.test(only.path)
    );
  };

  /** The tar inside a compressor, decompressed and listed; null when it turns out not to be a tar. */
  const unwrapTar = async (
    exec: Exec,
    originals: Input[],
    path: string,
    pass: string,
    main: string
  ): Promise<{ inputs: Input[]; path: string; listing: Listing } | null> => {
    const res = await exec(
      {
        args: extractArgs(path, pass),
        collect: true,
        cwd: "/",
        inputs: originals,
      },
      sizeOf(originals),
      "Decompressing"
    );
    const outcome = readOutcome(res.code, res.stdout, res.stderr);
    const tar = res.outputs.find((o) => o.blob);
    if (!outcome.ok || !tar?.blob) {
      throw new Error(outcomeError(outcome, main));
    }
    const name = lastSegment(tar.path);
    const inputs = [{ blob: tar.blob, mtime: tar.mtime, path: name }];
    const target = `${IN}/${name}`;
    const inner = await list(exec, inputs, target, pass);
    if (inner.listing.entries.length === 0 && !inner.outcome.ok) {
      return null;
    }
    return { inputs, listing: inner.listing, path: target };
  };

  type Opening = { opened: Opened } | { locked: "ask" | "wrong" };

  /** List the files as an archive, unwrapping a tarball; an archive with encrypted names asks for the password. */
  const readArchive = async (
    exec: Exec,
    files: File[],
    main: string,
    pass: string
  ): Promise<Opening> => {
    const originals = fileInputs(files);
    const path = `${IN}/${main}`;
    const first = await list(exec, originals, path, pass);
    if (first.outcome.wrongPassword && first.listing.entries.length === 0) {
      return { locked: pass ? "wrong" : "ask" };
    }
    if (first.listing.entries.length === 0 && !first.outcome.ok) {
      throw new Error(openFailure(files, main, first.outcome));
    }
    const tar = wrapsTar(first.listing)
      ? await unwrapTar(exec, originals, path, pass, main)
      : null;
    if (!first.outcome.ok && first.outcome.errors.length) {
      showError(
        `${outcomeError(first.outcome, main)} What could be read is shown.`
      );
    }
    const listing = tar?.listing ?? first.listing;
    return {
      opened: {
        encrypted: listing.entries.some((e) => e.encrypted),
        inputs: tar?.inputs ?? originals,
        listing,
        name: main,
        originals,
        path: tar?.path ?? path,
        size: sizeOf(originals),
        tree: buildTree(listing.entries),
        wrapper: tar ? first.listing.info.type : "",
      },
    };
  };

  /**
   * Open the files as one archive: one file, or every volume of one. A tar
   * inside a compressor (`.tar.gz` and kin) is unwrapped and the tar is
   * shown, as it is what the user means.
   */
  const openFiles = async (files: File[], nested = false) => {
    const main =
      files.length === 1
        ? files[0]?.name
        : firstVolume(files.map((f) => f.name));
    if (!main) {
      showError(
        "Open one archive at a time, or every volume of one archive together."
      );
      return;
    }
    // Read before closing: closing empties the field.
    const pass = nested ? password : unlockPw.value;
    if (!nested) {
      closeArchive();
    }
    hideResult();
    setView("archive");
    archiveView.classList.remove("listed", "is-locked");
    crumbsArchive.textContent = main;
    facts.textContent = "";
    props.style.display = "none";
    const done = await perform("open", "Loading 7-Zip", (exec) =>
      readArchive(exec, files, main, pass)
    );
    if (!done) {
      if (!opened && !nested) {
        setView("empty");
      }
      return;
    }
    if ("locked" in done) {
      // The locked panel opens the same files again with the password.
      pendingLocked = files;
      unlockPw.value = pass;
      showLocked(main, done.locked === "wrong");
      return;
    }
    if (!nested) {
      password = pass;
      pw.value = pass;
    }
    showArchive(done.opened);
  };

  const unlock = () => {
    if (busy || !pendingLocked || !unlockPw.value) {
      return;
    }
    const files = pendingLocked;
    void openFiles(files);
  };
  $(".unlock-btn").addEventListener("click", unlock);
  unlockPw.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      unlock();
    }
  });

  pw.addEventListener("input", () => {
    password = pw.value;
  });

  /** The archive paths a selection names: a folder stands for everything in it, so what is under a picked folder is not named again. */
  const selectedPaths = (a: Opened): string[] => {
    const picked = [...selected].toSorted();
    const out: string[] = [];
    for (const p of picked) {
      if (out.some((q) => p.startsWith(`${q}/`))) {
        continue;
      }
      out.push(p);
    }
    return out.map((p) => findNode(a.tree, p)?.entry?.path ?? p);
  };

  /** Files and folders a selection holds, counted as the tree knows them. */
  const selectionFiles = (a: Opened): number => {
    if (selected.size === 0) {
      return a.tree.files;
    }
    let n = 0;
    for (const p of selected) {
      const node = findNode(a.tree, p);
      if (node && ![...selected].some((q) => p.startsWith(`${q}/`))) {
        n += node.files;
      }
    }
    return n;
  };

  /** Extract `paths` (everything when empty); resolves with what came out. */
  const extract = async (
    exec: Exec,
    a: Opened,
    paths: string[],
    label: string
  ): Promise<Output[]> => {
    const res = await exec(
      {
        args: extractArgs(a.path, password, paths),
        collect: true,
        cwd: "/",
        inputs: a.inputs,
      },
      sizeOf(a.inputs),
      label
    );
    const outcome = readOutcome(res.code, res.stdout, res.stderr);
    if (!outcome.ok) {
      if (outcome.wrongPassword) {
        pw.focus();
      }
      throw new Error(outcomeError(outcome, a.name));
    }
    return res.outputs;
  };

  extractBtn.addEventListener("click", async () => {
    const a = opened;
    if (!a || busy) {
      return;
    }
    const files = selectionFiles(a);
    const paths = selectedPaths(a);
    const base = baseName(a.name);
    // The folder is asked for first, while the click still counts as a gesture.
    let dir: DirHandle | null = null;
    let refused = "";
    if (files > 1 && canWriteFolders()) {
      try {
        dir = await pickFolder();
        if (!dir) {
          return;
        }
      } catch (error) {
        // The browser would not hand over a folder (a policy, a sandbox): the zip still works.
        refused = message(error);
      }
    }
    hideResult();
    report.classList.remove("on");
    const start = performance.now();
    const done = await perform("other", "Loading 7-Zip", async (exec, owns) => {
      const outputs = await extract(exec, a, paths, "Extracting");
      const got = outputs.filter((o) => o.blob);
      const [one] = got;
      if (got.length === 0) {
        return "Nothing to extract: only empty folders were picked.";
      }
      if (got.length === 1 && one?.blob) {
        download(one.blob, lastSegment(one.path));
        return `Extracted ${lastSegment(one.path)}.`;
      }
      if (dir) {
        setPhase({ fraction: 0, text: "Writing files" });
        const folder = await writeFolder(dir, base, outputs, (n) => {
          if (owns()) {
            setPhase({
              fraction: n / got.length,
              text: `Writing files (${n.toLocaleString()} of ${got.length.toLocaleString()})`,
            });
          }
        });
        return `Extracted ${count(got.length, "file", "files")} into ${dir.name}/${folder} in ${seconds(performance.now() - start)}.`;
      }
      // No way to write a folder here: one uncompressed zip holds them all.
      const name = `${base}${selected.size ? "-selection" : ""}.zip`;
      const zip = await pack(exec, name, outputInputs(outputs), {
        encryptNames: false,
        format: "zip",
        level: 0,
        password: "",
        zipEncryption: "aes",
      });
      download(zip, name);
      const why = refused
        ? `The browser refused a folder (${refused}),`
        : "This browser cannot write a folder,";
      return `Extracted ${count(got.length, "file", "files")}. ${why} so they come as one uncompressed zip, ${name}.`;
    });
    if (done) {
      showNote(done);
    }
  });

  testBtn.addEventListener("click", async () => {
    const a = opened;
    if (!a || busy) {
      return;
    }
    hideResult();
    const start = performance.now();
    // An unwrapped tar is tested by its compressor, whose checksum covers the whole tar.
    const target = a.wrapper ? `${IN}/${a.name}` : a.path;
    const tested = await perform("other", "Loading 7-Zip", async (exec) => {
      const res = await exec(
        {
          args: testArgs(target, password),
          collect: false,
          cwd: "/",
          inputs: a.originals,
        },
        a.size,
        "Testing"
      );
      return readOutcome(res.code, res.stdout, res.stderr);
    });
    if (!tested) {
      return;
    }
    report.replaceChildren();
    report.classList.add("on");
    const head = document.createElement("div");
    const time = seconds(performance.now() - start);
    if (tested.ok) {
      head.className = "verdict ok";
      head.textContent = `Everything is OK: ${count(a.tree.files, "file", "files")}, ${formatBytes(a.tree.size)}, checked in ${time}.`;
      report.append(head);
    } else {
      head.className = "verdict bad";
      head.textContent = tested.wrongPassword
        ? "Wrong password, or none given: the encrypted files could not be checked."
        : `Errors found (${count(tested.errors.length, "message", "messages")}):`;
      report.append(head);
      if (!tested.wrongPassword) {
        const ul = document.createElement("ul");
        for (const e of tested.errors) {
          const li = document.createElement("li");
          li.textContent = e;
          ul.append(li);
        }
        report.append(ul);
      }
      if (tested.wrongPassword) {
        pw.focus();
      }
    }
    for (const w of tested.warnings) {
      const p = document.createElement("div");
      p.className = "warn";
      p.textContent = `Warning: ${w}`;
      report.append(p);
    }
  });

  convertBtn.addEventListener("click", () => {
    const on = !convertPanel.classList.contains("on");
    convertPanel.classList.toggle("on", on);
    convertBtn.setAttribute("aria-expanded", String(on));
    if (on && opened) {
      convertForm.setSingle(
        opened.tree.files === 1 && descendants(opened.tree).length === 1
      );
    }
  });

  $(".convert-go").addEventListener("click", async () => {
    const a = opened;
    if (!a || busy) {
      return;
    }
    const o = convertForm.get();
    const f = formatById(o.format);
    if (!f) {
      return;
    }
    const name = `${baseName(a.name)}.${f.ext}`;
    hideResult();
    report.classList.remove("on");
    const start = performance.now();
    const out = await perform("other", "Loading 7-Zip", async (exec) => {
      const outputs = await extract(exec, a, [], "Extracting");
      return pack(exec, name, outputInputs(outputs), o);
    });
    if (out) {
      showResult(
        out,
        name,
        `${formatBytes(out.size)} · was ${formatBytes(a.size)} as ${a.wrapper ? `tar in ${a.wrapper}` : a.listing.info.type} · ${seconds(performance.now() - start)}`
      );
    }
  });

  /* ---- preview ---- */

  const markActive = () => {
    for (const tr of tbody.querySelectorAll<HTMLTableRowElement>("tr")) {
      tr.classList.toggle("active", tr.dataset.path === previewed?.path);
    }
  };

  /** The button a preview waits behind: for a big file, and after a cancel. */
  const loadButton = (n: Node): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pv-load";
    b.textContent = `Preview (extracts ${formatBytes(n.size)})`;
    return b;
  };

  /** Progress and failure of a preview, drawn where the preview will be. */
  const previewSurface = (n: Node): Surface => {
    const box = document.createElement("div");
    box.className = "pv-loading";
    const text = document.createElement("span");
    text.className = "pv-phase";
    const track = document.createElement("div");
    track.className = "bar";
    const fillEl = document.createElement("div");
    fillEl.className = "fill";
    track.append(fillEl);
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "pv-cancel";
    cancel.textContent = "Cancel";
    box.append(text, track, cancel);
    delete pvBody.dataset.kind;
    pvBody.replaceChildren(box);
    return {
      error: (msg) => {
        if (previewed !== n) {
          return;
        }
        const err = document.createElement("div");
        err.className = "pv-error";
        err.textContent = msg;
        pvBody.replaceChildren(err);
      },
      phase: (p) => {
        text.textContent = p.text;
        track.classList.toggle("busy", p.fraction === null);
        fillEl.style.width =
          p.fraction === null
            ? ""
            : `${Math.round(Math.max(0, Math.min(1, p.fraction)) * 100)}%`;
      },
    };
  };

  const loadPreview = async (n: Node) => {
    const a = opened;
    if (!a) {
      return;
    }
    const done = await perform(
      "preview",
      "Loading 7-Zip",
      async (exec) => {
        const outputs = await extract(
          exec,
          a,
          [n.entry?.path ?? n.path],
          `Extracting ${n.name}`
        );
        return { blob: outputs.find((o) => o.blob)?.blob };
      },
      previewSurface(n)
    );
    if (!done || previewed !== n) {
      return;
    }
    const got = done.blob;
    if (!got) {
      pvNote.textContent = "7-Zip extracted nothing for this file.";
      return;
    }
    previewBlob = got;
    const p = await renderPreview(got, n.name);
    if (previewed !== n) {
      p.dispose();
      return;
    }
    shown?.dispose();
    shown = p;
    pvBody.replaceChildren(p.el);
    pvBody.dataset.kind = p.kind;
    pvNote.textContent = p.note;
  };

  const showPreview = async (n: Node) => {
    if (busy && running !== "preview") {
      return;
    }
    resetPreview();
    previewed = n;
    split.classList.add("previewing");
    markActive();
    pvName.textContent = n.name;
    pvName.title = n.path;
    const e = n.entry;
    pvMeta.textContent = [
      formatBytes(n.size),
      ...(e?.packed !== null && e?.packed !== undefined
        ? [`${formatBytes(e.packed)} packed`]
        : []),
      ...(e?.modified ? [e.modified.slice(0, 19)] : []),
      ...(e?.method ? [e.method] : []),
      ...(e?.crc ? [`CRC ${e.crc}`] : []),
      ...(e?.encrypted ? ["encrypted"] : []),
    ].join(" · ");
    pvOpen.hidden = !looksLikeArchive(n.name);
    if (n.size > AUTO_PREVIEW_LIMIT) {
      pvBody.replaceChildren(loadButton(n));
      return;
    }
    await loadPreview(n);
  };

  pvBody.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const n = previewed;
    if (!n) {
      return;
    }
    if (target.closest(".pv-load")) {
      void loadPreview(n);
    } else if (target.closest(".pv-cancel") && running === "preview") {
      stopWork();
      setBusy(false);
      pvBody.replaceChildren(loadButton(n));
    }
  });

  $(".pv-close").addEventListener("click", () => {
    if (running === "preview") {
      stopWork();
      setBusy(false);
    }
    resetPreview();
    markActive();
  });

  /** The previewed file's bytes, extracting it first when the preview has not. */
  const previewedBlob = async (): Promise<Blob | null> => {
    const n = previewed;
    if (previewBlob || !n) {
      return previewBlob;
    }
    await loadPreview(n);
    return previewBlob;
  };

  pvDownload.addEventListener("click", async () => {
    const n = previewed;
    const blob = await previewedBlob();
    if (n && blob) {
      download(blob, n.name);
    }
  });

  pvOpen.addEventListener("click", async () => {
    const a = opened;
    const n = previewed;
    const blob = await previewedBlob();
    if (!a || !n || !blob) {
      return;
    }
    // The archive inside is opened on its own; the outer one stays a step back.
    parents = [...parents, a];
    const outerPassword = password;
    resetPreview();
    cwd = "";
    selected.clear();
    filterInput.value = "";
    password = "";
    pw.value = "";
    await openFiles(
      [new File([blob], n.name, { lastModified: n.mtime ?? Date.now() })],
      true
    );
    if (opened === a && !archiveView.classList.contains("is-locked")) {
      // It did not open: back to where it was.
      parents = parents.slice(0, -1);
      password = outerPassword;
      pw.value = outerPassword;
      showArchive(a);
    }
  });

  /* ---- browsing ---- */

  tbody.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const a = opened;
    if (!a) {
      return;
    }
    if (target.closest(".go-up")) {
      const parts = segments(cwd);
      enter(parts.slice(0, -1).join("/"));
      return;
    }
    const tr = target.closest<HTMLTableRowElement>("tr");
    const path = tr?.dataset.path;
    if (path === undefined) {
      return;
    }
    if (
      target instanceof HTMLInputElement &&
      target.classList.contains("pick")
    ) {
      if (target.checked) {
        selected.add(path);
      } else {
        selected.delete(path);
      }
      renderList();
      return;
    }
    if (!target.closest(".open-node")) {
      return;
    }
    const node = findNode(a.tree, path);
    if (!node) {
      return;
    }
    if (node.dir) {
      enter(node.path);
    } else {
      void showPreview(node);
    }
  });

  checkAll.addEventListener("change", () => {
    const a = opened;
    if (!a) {
      return;
    }
    const nodes = visibleNodes(a).slice(0, showAll ? undefined : ROW_LIMIT);
    for (const n of nodes) {
      if (checkAll.checked) {
        selected.add(n.path);
      } else {
        selected.delete(n.path);
      }
    }
    renderList();
  });

  crumbs.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>(".crumb");
    if (b) {
      enter(b.dataset.path ?? "");
    }
  });

  $("thead").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>(".sort");
    if (!b) {
      return;
    }
    const key = (b.dataset.sort ?? "name") as SortKey;
    sortDesc = key === sortKey ? !sortDesc : key !== "name";
    sortKey = key;
    renderList();
  });

  filterInput.addEventListener("input", () => {
    showAll = false;
    renderList();
  });

  tableFoot.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest(".show-all")) {
      showAll = true;
      renderList();
    }
  });

  /* ---- a new archive ---- */

  const renderStaged = () => {
    const tops = new Map<
      string,
      { files: number; bytes: number; dir: boolean }
    >();
    for (const s of staged.values()) {
      const [top = s.path] = s.path.split("/");
      const dir = s.path.includes("/") || !s.file;
      const t = tops.get(top) ?? { bytes: 0, dir, files: 0 };
      t.dir ||= dir;
      if (s.file) {
        t.files += 1;
        t.bytes += s.file.size;
      }
      tops.set(top, t);
    }
    const rows = [...tops]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([name, t]) => {
        const row = document.createElement("div");
        row.className = "staged-row";
        row.innerHTML = t.dir ? ICON_FOLDER : ICON_FILE;
        const label = document.createElement("span");
        label.className = "s-name";
        label.textContent = name;
        const meta = document.createElement("span");
        meta.className = "s-meta";
        meta.textContent = t.dir
          ? `${count(t.files, "file", "files")} · ${formatBytes(t.bytes)}`
          : formatBytes(t.bytes);
        const rm = document.createElement("button");
        rm.type = "button";
        rm.className = "remove icon";
        rm.dataset.top = name;
        rm.title = `Remove ${name}`;
        rm.setAttribute("aria-label", `Remove ${name}`);
        rm.innerHTML = ICON_X;
        row.append(label, meta, rm);
        return row;
      });
    if (rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "staged-empty";
      empty.textContent =
        "Drop files and folders here, or add them with the buttons above.";
      stagedList.replaceChildren(empty);
    } else {
      stagedList.replaceChildren(...rows);
    }
    syncCreate();
  };

  stagedList.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>(".remove");
    const top = b?.dataset.top;
    if (top === undefined || busy) {
      return;
    }
    // Deleting the entry being visited is safe in a Map's iteration.
    for (const p of staged.keys()) {
      if (p === top || p.startsWith(`${top}/`)) {
        staged.delete(p);
      }
    }
    renderStaged();
  });

  /** Add picked files to the new archive. A path already there is replaced, and the note says how many were. */
  const stage = (items: Picked[]) => {
    closeArchive();
    hideResult();
    clearMessages();
    setView("create");
    let replaced = 0;
    for (const i of items) {
      const path = segments(i.path).join("/");
      if (!path) {
        continue;
      }
      if (staged.has(path)) {
        replaced += 1;
      }
      // A folder that now holds something no longer needs its own entry.
      for (const p of segments(path)
        .slice(0, -1)
        .map((_, n, all) => all.slice(0, n + 1).join("/"))) {
        if (!staged.get(p)?.file) {
          staged.delete(p);
        }
      }
      staged.set(path, { file: i.file, path });
    }
    renderStaged();
    if (replaced) {
      showNote(
        `${count(replaced, "file", "files")} with the same path replaced the one already added.`
      );
    }
  };

  $(".create-go").addEventListener("click", async () => {
    if (busy || staged.size === 0) {
      return;
    }
    const o = createForm.get();
    const f = formatById(o.format);
    if (!f) {
      return;
    }
    const raw = nameInput.value.trim() || defaultName();
    // A typed extension is not doubled.
    const stem = raw.toLowerCase().endsWith(`.${f.ext}`)
      ? raw.slice(0, -f.ext.length - 1)
      : raw;
    const name = `${stem.replaceAll("/", "-") || "archive"}.${f.ext}`;
    const inputs: Input[] = [...staged.values()].map((s) => ({
      blob: s.file,
      mtime: s.file?.lastModified,
      path: s.path,
    }));
    const bytes = sizeOf(inputs);
    hideResult();
    const start = performance.now();
    const out = await perform("other", "Loading 7-Zip", (exec) =>
      pack(exec, name, inputs, o)
    );
    if (out) {
      const ratio = bytes ? ` (${Math.round((out.size / bytes) * 100)}%)` : "";
      showResult(
        out,
        name,
        `${formatBytes(out.size)} from ${formatBytes(bytes)}${ratio} · ${seconds(performance.now() - start)}${o.password ? " · encrypted" : ""}`
      );
    }
  });

  $(".made-download").addEventListener("click", () => {
    if (result) {
      download(result.blob, result.name);
    }
  });
  $(".made-open").addEventListener("click", () => {
    if (result && !busy) {
      const { blob, name } = result;
      staged.clear();
      nameTouched = false;
      nameInput.value = "";
      void openFiles([new File([blob], name, { lastModified: Date.now() })]);
    }
  });

  /* ---- input ---- */

  const clearAll = () => {
    stopWork();
    setBusy(false);
    closeArchive();
    hideResult();
    clearMessages();
    staged.clear();
    nameTouched = false;
    nameInput.value = "";
    pendingLocked = null;
    renderStaged();
    setView("empty");
  };

  $(".clear-btn").addEventListener("click", clearAll);
  $(".open-btn").addEventListener("click", () => openInput.click());
  // Only the empty New archive view: files go in by drop or by its own Add buttons.
  $(".new-btn").addEventListener("click", () => {
    if (createView.classList.contains("on")) {
      return;
    }
    clearAll();
    setView("create");
  });
  $(".add-files").addEventListener("click", () => addInput.click());
  $(".add-folder").addEventListener("click", () => folderInput.click());

  openInput.addEventListener("change", () => {
    const files = [...(openInput.files ?? [])];
    openInput.value = "";
    if (files.length) {
      pendingLocked = null;
      unlockPw.value = "";
      void openFiles(files);
    }
  });
  for (const input of [addInput, folderInput]) {
    input.addEventListener("change", () => {
      const items = readInput(input.files);
      input.value = "";
      if (items.length) {
        stage(items);
      }
    });
  }

  /**
   * A drop opens an archive (one file that looks like one, or every volume
   * of one) and packs anything else. While a new archive is being put
   * together, everything dropped is added to it.
   */
  const takeDrop = async (dt: DataTransfer) => {
    const { items, folders } = await readDrop(dt);
    if (items.length === 0) {
      return;
    }
    const files = items.flatMap((i) => (i.file ? [i.file] : []));
    const names = files.map((f) => f.name);
    const [first] = files;
    const anArchive =
      !folders &&
      ((files.length === 1 && first && looksLikeArchive(first.name)) ||
        firstVolume(names) !== null);
    if (createView.classList.contains("on") || !anArchive) {
      stage(items);
      return;
    }
    pendingLocked = null;
    unlockPw.value = "";
    staged.clear();
    nameTouched = false;
    await openFiles(files);
  };

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
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0;
    el.classList.remove("dragging");
    if (e.dataTransfer && !busy) {
      void takeDrop(e.dataTransfer);
    }
  });

  renderStaged();
};

const tool: Tool = {
  id: "archive-manager",
  keywords: [
    "7z",
    "7-zip",
    "zip",
    "unzip",
    "rar",
    "tar",
    "gz",
    "tgz",
    "xz",
    "bz2",
    "iso",
    "extract",
    "compress",
    "decompress",
    "archive",
    "convert",
  ],
  mount,
  name: "Archive Manager",
  subtitle:
    "Open, preview, extract, test, and convert archives in some fifty formats, and make new 7z, zip, and tar ones.",
};

export default tool;
