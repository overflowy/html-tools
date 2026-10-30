import "./tool.css";
import ICON_PLAY from "lucide-static/icons/play.svg";
import ICON_PAUSE from "lucide-static/icons/pause.svg";
import ICON_STOP from "lucide-static/icons/square.svg";
import ICON_SETTINGS from "lucide-static/icons/settings-2.svg";
import ICON_DELETE from "lucide-static/icons/delete.svg";
import type { Tool } from "../../shell/types";
import { Player } from "./audio";
import { draw, daily, type Metric } from "./chart";
import {
  JAEGGI, OP_SYMBOL, answerRight, defaultTrialSeconds, generate, isMatch, modalities, modeKey, modeName, nextLevel, normalize,
  parseModeKey, percent, sessionScore, stimulusSeconds, tally, trialCount, verdict,
  type Level, type Modality, type Mode, type Response, type Tally, type Thresholds, type Toggle, type Trial,
} from "./engine";
import { exportJson, lastDay, levelFor, load, merge, parseJson, save, today, totalSeconds, type Session } from "./history";
import { DEFAULTS, LIMITS, clamp, clone, decode, effective, encode, type Settings } from "./settings";
import { COLORS, IDENTITY_COLORS, IDENTITY_SHAPES, OPERATIONS, sample, shapeSvg, type ShapeSetId, type SoundItem } from "./stimuli";

const SETTINGS_KEY = "html-tools:dual-n-back:settings";

/** The eight outer cells of the 3×3 grid, row by row; 4 is the centre. */
const OUTER = [0, 1, 2, 3, 5, 6, 7, 8];
const CENTER = 4;
/** Before the first trial: a moment to settle. */
const LEAD_MS = 1000;
/** How long before the next trial a missed match is shown. */
const MISSED_MS = 250;
/** Self-paced: the gap between advancing and the next trial. */
const ADVANCE_GAP_MS = 300;

const KEYS: Record<Modality, string> = {
  position1: "a", position2: "s", position3: "d", position4: "f",
  vis1: "g", vis2: "h", vis3: "j", vis4: "k",
  color: "f", shape: "j", visvis: "s", visaudio: "d", audiovis: "j",
  arithmetic: "", sound: "l",
};

const LABELS: Record<Modality, string> = {
  position1: "Position", position2: "Position", position3: "Position", position4: "Position",
  vis1: "", vis2: "", vis3: "", vis4: "",
  color: "Color", shape: "Shape", visvis: "Letter seen", visaudio: "Seen = heard", audiovis: "Heard = seen",
  arithmetic: "Answer", sound: "Sound",
};

const TOGGLES: [Toggle, string, string][] = [
  ["position", "Position", "Where the square is"],
  ["color", "Color", "Its color"],
  ["shape", "Shape", "Its shape"],
  ["sound", "Sound", "What is said or played"],
  ["combination", "Combination", "A letter is shown and another is heard; match each against both, N back"],
  ["arithmetic", "Arithmetic", "Type the number N back, combined with this one by the operation you hear"],
];

const durationFmt = (s: number) => {
  s = Math.round(s);
  if (s < 60) return s + " s";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min${s % 60 ? " " + (s % 60) + " s" : ""}`;
};
const clockFmt = (s: number) => Math.floor(s / 60) + ":" + String(Math.round(s % 60)).padStart(2, "0");
const whenFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

function download(text: string, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw === null ? clone(DEFAULTS) : decode(raw);
  } catch {
    return clone(DEFAULTS);
  }
}

/** One Session as it is played. */
interface Run {
  settings: ReturnType<typeof effective>;
  mode: Mode;
  key: string;
  n: number;
  level: Level;
  mods: Modality[];
  trials: Trial[];
  responses: Response[];
  trialMs: number;
  stimMs: number;
  sounds: SoundItem[];
  shapeSet: ShapeSetId;
  /** The trial on screen, -1 before the first. */
  index: number;
  /** When the trial on screen started, on the run's clock (which stops while paused). */
  trialStart: number;
  /** The first trial's start, so trial times do not drift. */
  origin: number;
  pausedAt: number | null;
  pausedTotal: number;
  timer: number;
  pending: { at: number; fn: () => void } | null;
  /** Self-paced: waiting for the player to advance. */
  waiting: boolean;
  /** Whether the trial on screen has had its misses shown. */
  closed: boolean;
}

const tool: Tool = {
  id: "dual-n-back",
  name: "Dual N-Back",
  subtitle: "Train working memory: say when what you see or hear matches what came N steps back.",
  keywords: ["n-back", "nback", "working memory", "brain training", "jaeggi", "memory", "game", "cognitive", "crab", "arithmetic"],
  mount(el, ctx) {
    el.innerHTML = `
      <div class="toolbar">
        <div class="seg view-seg" role="tablist" aria-label="View">
          <button type="button" role="tab" data-view="train" class="active" aria-selected="true">Train</button>
          <button type="button" role="tab" data-view="history" aria-selected="false">History</button>
        </div>
        <span class="spacer"></span>
        <button type="button" class="settings-btn" title="Trials, timing, sounds, shapes, and levels">${ICON_SETTINGS}<span>Settings</span></button>
      </div>
      <div class="train">
        <section class="stage">
          <div class="stage-head">
            <span class="stage-title"></span>
            <span class="stage-meta"></span>
            <span class="spacer"></span>
            <button type="button" class="pause-btn" hidden title="Pause (P)">${ICON_PAUSE}<span>Pause</span></button>
            <button type="button" class="stop-btn" hidden title="Stop and discard this session (Esc)">${ICON_STOP}<span>Stop</span></button>
            <button type="button" class="start-btn primary" title="Start (Space)">${ICON_PLAY}<span>Start</span></button>
          </div>
          <div class="board-wrap">
            <div class="board" tabindex="-1" aria-label="Grid">
              ${Array.from({ length: 9 }, (_, i) => `<div class="cell" data-cell="${i}"></div>`).join("")}
              <div class="overlay" role="status"></div>
            </div>
          </div>
          <div class="answer" hidden><span class="answer-label">Answer</span><output class="answer-value"></output></div>
          <div class="responses"></div>
          <div class="keypad" hidden>
            ${["7", "8", "9", "4", "5", "6", "1", "2", "3", "-", "0", "."].map((k) => `<button type="button" data-key="${k}">${k === "-" ? "±" : k}</button>`).join("")}
            <button type="button" data-key="Backspace" class="keypad-clear" aria-label="Clear">${ICON_DELETE}</button>
          </div>
        </section>
        <aside class="setup">
          <section class="block">
            <h2>Mode</h2>
            <div class="chips modality-chips">
              ${TOGGLES.map(([t, label, title]) => `<button type="button" class="chip" data-toggle="${t}" aria-pressed="false" title="${title}">${label}</button>`).join("")}
            </div>
            <div class="chips variant-chips">
              <button type="button" class="chip" data-variant="variable" aria-pressed="false" title="Each trial shows how far back to compare, from 1 to N">Variable</button>
              <button type="button" class="chip" data-variant="crab" aria-pressed="false" title="Within each block of N trials, look back 1, 3, 5…: each block is matched against the one before, reversed">Crab</button>
              <button type="button" class="chip" data-variant="selfPaced" aria-pressed="false" title="Each trial waits for Enter">Self-paced</button>
            </div>
            <div class="row">
              <span class="row-label">Objects</span>
              <div class="seg multi-seg" role="radiogroup" aria-label="Objects at once">
                ${[1, 2, 3, 4].map((m) => `<button type="button" role="radio" data-multi="${m}" aria-checked="false">${m}</button>`).join("")}
              </div>
            </div>
            <label class="check" title="The original study's task: Dual, letters, a fixed number of matches, no feedback, scored on the worst modality, 90% to go up and under 75% to go down"><input type="checkbox" class="jaeggi">Jaeggi mode</label>
          </section>
          <section class="block">
            <h2>Level</h2>
            <div class="seg level-seg" role="radiogroup" aria-label="Level">
              <button type="button" role="radio" data-level="auto">Automatic</button>
              <button type="button" role="radio" data-level="manual">Manual</button>
            </div>
            <div class="level-auto"><span class="level-n"></span><span class="strikes"></span></div>
            <div class="level-manual">
              <button type="button" class="n-down" aria-label="Lower N">−</button>
              <input type="text" inputmode="numeric" class="n-input" aria-label="N" autocomplete="off">
              <button type="button" class="n-up" aria-label="Raise N">+</button>
              <span class="n-suffix">-back</span>
            </div>
            <p class="level-note"></p>
          </section>
          <section class="block today">
            <h2>Today</h2>
            <p class="today-time"></p>
            <ol class="today-list"></ol>
          </section>
        </aside>
      </div>
      <div class="history" hidden>
        <div class="history-head">
          <select class="history-mode" aria-label="Mode"></select>
          <div class="seg metric-seg" role="radiogroup" aria-label="Chart">
            <button type="button" role="radio" data-metric="level" title="N, plus how far the Score went from the lower threshold to the upper">Level</button>
            <button type="button" role="radio" data-metric="score">Score</button>
          </div>
          <span class="spacer"></span>
          <button type="button" class="import-btn" title="Add sessions from an export">Import</button>
          <button type="button" class="export-btn" title="Download every session as JSON">Export</button>
          <button type="button" class="clear-btn" title="Delete every session">Clear</button>
        </div>
        <div class="history-note" role="status"></div>
        <div class="tiles"></div>
        <section class="pane chart-pane">
          <div class="pane-head"><span class="chart-title">Daily progress</span><span class="spacer"></span><span class="legend"><span class="key mean"></span>Mean <span class="key best"></span>Best</span></div>
          <div class="chart"></div>
        </section>
        <section class="pane sessions-pane">
          <div class="pane-head"><span>Sessions</span><span class="averages"></span></div>
          <div class="table-wrap"><table class="sessions"><thead><tr><th>When</th><th>Mode</th><th class="num">N</th><th class="num">Score</th><th>Modalities</th><th class="num">Length</th></tr></thead><tbody></tbody></table></div>
          <button type="button" class="more-btn" hidden>Show more</button>
        </section>
        <input type="file" class="import-input" accept=".json,application/json" hidden>
      </div>
      <dialog class="settings-dialog" aria-label="Settings"><div class="dialog-inner">
        <div class="dialog-head"><h2>Settings</h2><span class="spacer"></span><button type="button" class="reset-btn">Reset to defaults</button><button type="button" class="close-btn primary">Done</button></div>
        <div class="dialog-body">
          <fieldset>
            <legend>Session</legend>
            <label>Trials <span class="field-line"><input type="number" class="s-trials" min="${LIMITS.baseTrials[0]}" max="${LIMITS.baseTrials[1]}" step="1"> <span class="muted s-trials-note">+ N²</span></span></label>
            <label>Seconds per trial <input type="number" class="s-secs" min="${LIMITS.trialSeconds[0]}" max="${LIMITS.trialSeconds[1]}" step="0.5"></label>
            <label>Lures
              <select class="s-lures">${Array.from({ length: 9 }, (_, i) => `<option value="${i}">${(i * 12.5).toFixed(1).replace(".0", "")}%</option>`).join("")}</select>
            </label>
            <label class="check"><input type="checkbox" class="s-feedback">Show whether each press was right</label>
            <label class="check"><input type="checkbox" class="s-grid">Grid lines</label>
          </fieldset>
          <fieldset>
            <legend>Shapes</legend>
            <label>Set
              <select class="s-shapes"><option value="shapes">Shapes</option><option value="pentominoes">Pentominoes</option><option value="either">Either, picked per session</option></select>
            </label>
          </fieldset>
          <fieldset>
            <legend>Arithmetic</legend>
            <label>Largest number <input type="number" class="s-max" min="${LIMITS.max[0]}" max="${LIMITS.max[1]}" step="1"></label>
            <label class="check"><input type="checkbox" class="s-neg">Negative numbers</label>
            <div class="ops">
              ${(["add", "subtract", "multiply", "divide"] as const).map((op) => `<label class="check"><input type="checkbox" class="s-op" value="${op}">${OP_SYMBOL[op]} ${op[0]!.toUpperCase() + op.slice(1)}</label>`).join("")}
            </div>
          </fieldset>
          <fieldset>
            <legend>Automatic level</legend>
            <label>Raise N at a score of <span class="field-line"><input type="number" class="s-raise" min="0" max="100" step="1"> <span class="muted">% or more</span></span></label>
            <label>A strike below <span class="field-line"><input type="number" class="s-lower" min="0" max="100" step="1"> <span class="muted">%</span></span></label>
            <label>Strikes at one N that lower it <input type="number" class="s-strikes" min="${LIMITS.strikes[0]}" max="${LIMITS.strikes[1]}" step="1"></label>
            <p class="muted fieldset-note">Jaeggi mode uses its own: 90% to raise, a single session under 75% to lower.</p>
          </fieldset>
        </div>
      </div></dialog>
      <dialog class="confirm-dialog" aria-label="Clear history"><div class="dialog-inner">
        <p class="confirm-text"></p>
        <div class="confirm-actions"><button type="button" class="confirm-cancel">Cancel</button><button type="button" class="confirm-ok danger">Delete</button></div>
      </div></dialog>`;

    const $ = <T extends HTMLElement = HTMLElement>(sel: string) => el.querySelector(sel) as T;
    const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => [...el.querySelectorAll(sel)] as T[];

    const train = $(".train");
    const history = $(".history");
    const stageTitle = $(".stage-title");
    const stageMeta = $(".stage-meta");
    const startBtn = $<HTMLButtonElement>(".start-btn");
    const pauseBtn = $<HTMLButtonElement>(".pause-btn");
    const stopBtn = $<HTMLButtonElement>(".stop-btn");
    const board = $(".board");
    const cells = $$(".cell");
    const overlay = $(".overlay");
    const answerRow = $(".answer");
    const answerValue = $(".answer-value");
    const responsesEl = $(".responses");
    const keypad = $(".keypad");
    const setup = $(".setup");
    const nInput = $<HTMLInputElement>(".n-input");
    const settingsDialog = $<HTMLDialogElement>(".settings-dialog");
    const confirmDialog = $<HTMLDialogElement>(".confirm-dialog");

    let settings = loadSettings();
    let sessions = load();
    const player = new Player();
    let run: Run | null = null;
    /** The last finished Session, shown on the board until the next starts or the Mode changes. */
    let result: { session: Session; tallies: [Modality, Tally][]; before: Level; th: Thresholds } | null = null;
    let view: "train" | "history" = "train";
    let metric: Metric = "level";
    let historyMode = "";
    let shownRows = 50;

    /* ---------------- State ---------------- */

    function publish() {
      const payload = encode(settings);
      try {
        localStorage.setItem(SETTINGS_KEY, payload);
      } catch { /* storage off: the Deep Link still carries it */ }
      ctx.setState(payload);
    }

    let restored = false;
    ctx.onRestore((payload) => {
      restored = true;
      if (run) stopRun();
      settings = decode(payload);
      result = null;
      publish();
      refresh();
    });
    // The Shell restores a Deep Link right after mount; only without one do the remembered Settings go in the URL.
    queueMicrotask(() => {
      if (!restored) publish();
    });

    function change(fn: (s: Settings) => void) {
      fn(settings);
      result = null;
      publish();
      refresh();
    }

    /* ---------------- what the next Session will be ---------------- */

    function plan() {
      const e = effective(settings);
      const key = modeKey(e.mode);
      const level = levelFor(sessions, key);
      const n = e.manual ? e.manualN : level.n;
      const trials = trialCount(n, e.baseTrials, e.jaeggi);
      const secs = e.trialSeconds ?? defaultTrialSeconds(e.mode);
      return { e, key, level, n, trials, secs };
    }

    function sessionTitle(mode: Mode, n: number, manual: boolean, jaeggi: boolean) {
      return (jaeggi ? "Jaeggi " : "") + modeName(mode) + " " + n + "-Back" + (manual ? " · Manual" : "");
    }

    /* ---------------- rendering: setup ---------------- */

    function refresh() {
      const p = plan();
      const m = settings.mode;
      const locked = settings.jaeggi;
      for (const b of $$<HTMLButtonElement>(".modality-chips .chip")) {
        const t = b.dataset.toggle as Toggle;
        const pressed = locked ? (t === "position" || t === "sound") : m[t];
        b.setAttribute("aria-pressed", String(pressed));
        b.disabled = locked;
      }
      for (const b of $$<HTMLButtonElement>(".variant-chips .chip")) {
        const v = b.dataset.variant as "variable" | "crab" | "selfPaced";
        b.setAttribute("aria-pressed", String(!locked && m[v]));
        b.disabled = locked;
      }
      for (const b of $$<HTMLButtonElement>(".multi-seg button")) {
        const on = Number(b.dataset.multi) === (locked ? 1 : m.multi);
        b.classList.toggle("active", on);
        b.setAttribute("aria-checked", String(on));
        b.disabled = locked;
      }
      $<HTMLInputElement>(".jaeggi").checked = settings.jaeggi;
      for (const b of $$<HTMLButtonElement>(".level-seg button")) {
        const on = (b.dataset.level === "manual") === settings.manual;
        b.classList.toggle("active", on);
        b.setAttribute("aria-checked", String(on));
      }
      $(".level-auto").hidden = settings.manual;
      $(".level-manual").hidden = !settings.manual;
      if (document.activeElement !== nInput) nInput.value = String(settings.manualN);
      $(".level-n").textContent = p.level.n + "-back";
      const th = p.e.thresholdsInForce;
      $(".strikes").textContent = p.level.strikes ? `${p.level.strikes} of ${th.strikes} strikes` : "";
      $(".level-note").textContent = settings.manual
        ? "Manual sessions are kept in the history but never change the level."
        : `Raised at ${th.advance}% or more. A session under ${th.fallback}% is a strike; ${th.strikes === 1 ? "one lowers" : th.strikes + " at one N lower"} it.`;

      stageTitle.textContent = sessionTitle(p.e.mode, p.n, p.e.manual, p.e.jaeggi);
      stageMeta.textContent = `${p.trials} trials · ${p.secs.toFixed(1)} s · ${clockFmt(p.trials * p.secs)}`;
      board.classList.toggle("grid-lines", settings.gridLines);
      renderResponses(p.e.mode, null);
      renderToday();
      if (!run) idleBoard();
      if (view === "history") renderHistory();
    }

    function renderToday() {
      const now = Date.now();
      const t = today(sessions, now);
      const d = lastDay(sessions, now);
      $(".today-time").textContent = t.length
        ? `${durationFmt(totalSeconds(t))} in ${t.length} session${t.length === 1 ? "" : "s"}` + (d.length > t.length ? ` · ${durationFmt(totalSeconds(d))} in the last 24 hours` : "")
        : "No sessions yet today.";
      const list = $(".today-list");
      list.replaceChildren();
      t.slice(-20).toReversed().forEach((s, i) => {
        const li = document.createElement("li");
        const mode = parseModeKey(s.mode)!;
        const th = s.jaeggi ? JAEGGI : settings.thresholds;
        const up = !s.manual && s.score >= th.advance;
        const down = !s.manual && s.score < th.fallback;
        li.className = s.manual ? "" : up ? "up" : down ? "down" : "";
        li.innerHTML = `<span class="num">${t.length - i}</span><span class="name"></span><span class="pct">${s.score}%</span>`;
        li.querySelector(".name")!.textContent = (s.manual ? "M · " : "") + modeName(mode) + " " + s.n;
        li.title = whenFmt.format(s.at) + (up ? " · raised the level" : down ? " · a strike" : "");
        list.appendChild(li);
      });
    }

    /** One button per Modality, with its key; Arithmetic has the answer field instead. */
    function renderResponses(mode: Mode, r: Run | null) {
      const mods = modalities(mode);
      responsesEl.replaceChildren();
      for (const mod of mods) {
        if (mod === "arithmetic") continue;
        const b = document.createElement("button");
        b.type = "button";
        b.className = "resp";
        b.dataset.mod = mod;
        const key = KEYS[mod];
        b.innerHTML = `<kbd>${key.toUpperCase()}</kbd><span class="resp-label"></span>`;
        const label = b.querySelector(".resp-label")!;
        const index = /\d$/.test(mod) ? Number(mod.slice(-1)) - 1 : -1;
        let text = LABELS[mod];
        // A multi-stimulus object's visual stream is whichever of Color and Shape is on.
        if (/^vis\d$/.test(mod)) text = mode.color ? "Color" : "Shape";
        if (mode.multi > 1 && index >= 0) {
          // Which object: a swatch in its color, or its shape.
          const mark = document.createElement("span");
          mark.className = "ident";
          if (mode.color) mark.innerHTML = shapeSvg("shapes", IDENTITY_SHAPES[index]!, "currentColor");
          else mark.style.background = COLORS[IDENTITY_COLORS[index]!].hex;
          b.insertBefore(mark, label);
        }
        label.textContent = text;
        b.title = `${text}: press ${key.toUpperCase()} when it matches`;
        responsesEl.appendChild(b);
      }
      if (mode.selfPaced) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "resp next";
        b.innerHTML = `<kbd>↵</kbd><span class="resp-label">Next</span>`;
        b.title = "Show the next trial (Enter)";
        responsesEl.appendChild(b);
      }
      answerRow.hidden = !mode.arithmetic;
      keypad.hidden = !mode.arithmetic;
      if (!r) answerValue.textContent = "";
    }

    /* ---------------- rendering: the board ---------------- */

    function clearBoard() {
      for (const c of cells) c.replaceChildren();
      board.classList.remove("crosshair");
    }

    function showOverlay(html: string, kind: string) {
      overlay.innerHTML = html;
      overlay.className = "overlay " + kind;
      overlay.hidden = false;
    }

    function idleBoard() {
      clearBoard();
      if (result) {
        showResult();
        return;
      }
      const p = plan();
      const mods = modalities(p.e.mode);
      const keys = mods.filter((m) => m !== "arithmetic").map((m) => KEYS[m].toUpperCase());
      const lines: string[] = [];
      if (p.e.mode.arithmetic) lines.push(`Type the number from ${p.n} back, ${["plus", "minus", "times", "divided by"].join(", ")} this one, as the voice says.`);
      if (keys.length) lines.push(`Press ${keys.map((k) => `<kbd>${k}</kbd>`).join(" ")} when what you see or hear matches ${p.n} back.`);
      if (p.e.mode.variable) lines.push("The number in the grid says how far back to compare.");
      if (p.e.mode.crab) lines.push(`Crab: look back 1, 3, 5… within each block of ${p.n}.`);
      if (p.e.mode.selfPaced) lines.push("Each trial waits for <kbd>Enter</kbd>.");
      showOverlay(`<div class="overlay-title">Press <kbd>Space</kbd> to start</div>${lines.map((l) => `<p>${l}</p>`).join("")}`, "idle");
    }

    function showResult() {
      if (!result) return;
      const { session: s, tallies, before, th } = result;
      let moved = "";
      if (!s.manual && s.level) {
        if (s.level.n > before.n) moved = `N-Back raised to ${s.level.n}.`;
        else if (s.level.n < before.n) moved = `N-Back lowered to ${s.level.n}.`;
        else if (s.level.strikes > before.strikes) moved = `Strike ${s.level.strikes} of ${th.strikes} at ${s.n}-back.`;
      }
      const rows = tallies.map(([mod, t]) => {
        const right = t.hits + (s.jaeggi ? t.correctRejections : 0);
        const wrong = t.misses + t.falseAlarms;
        return `<tr><td>${escapeHtml(buttonLabel(mod))}</td><td class="num">${right}–${wrong}</td><td class="num">${percent(t, { jaeggi: s.jaeggi })}%</td></tr>`;
      }).join("");
      showOverlay(`
        <div class="score">${s.score}%</div>
        <div class="score-label">${s.jaeggi ? "Lowest score" : "Score"}${s.manual ? "" : " · " + escapeHtml(verdict(s.score, th))}</div>
        ${moved ? `<div class="change">${moved}</div>` : ""}
        <table class="tallies"><thead><tr><th></th><th class="num" title="Right and wrong">Right–wrong</th><th class="num"></th></tr></thead><tbody>${rows}</tbody></table>
        <p class="again">Press <kbd>Space</kbd> to play again</p>`, "result");
    }

    /** A Modality's name in the Score's table; with several objects, which one. */
    function buttonLabel(mod: Modality): string {
      if (mod === "arithmetic") return "Arithmetic";
      const b = responsesEl.querySelector(`[data-mod="${mod}"] .resp-label`);
      const object = /^(position|vis)\d$/.test(mod) && responsesEl.querySelector(".ident") ? " " + mod.slice(-1) : "";
      return (b?.textContent ?? LABELS[mod]) + object;
    }

    function drawTrial(r: Run, t: Trial) {
      clearBoard();
      const m = r.mode;
      const objects = m.position ? m.multi : 1;
      for (let i = 0; i < objects; i++) {
        const cell = m.position ? OUTER[t.positions[i]!]! : CENTER;
        const stim = document.createElement("div");
        stim.className = "stim";
        if (m.arithmetic) {
          stim.classList.add("text");
          stim.textContent = String(t.number);
          if (m.color) stim.style.color = COLORS[t.color].hex;
        } else if (m.combination) {
          stim.classList.add("text");
          stim.textContent = r.sounds[t.letter]!.label;
          if (m.color) stim.style.color = COLORS[t.color].hex;
        } else if (m.multi > 1) {
          if (m.color) stim.innerHTML = shapeSvg("shapes", IDENTITY_SHAPES[i]!, COLORS[t.vis[i]!].hex);
          else if (m.shape) stim.innerHTML = shapeSvg(r.shapeSet, t.vis[i]!, COLORS[IDENTITY_COLORS[i]!].hex);
          else stim.innerHTML = `<div class="square" style="background:${COLORS[IDENTITY_COLORS[i]!].hex}"></div>`;
        } else {
          const fill = m.color ? COLORS[t.color].hex : "var(--accent)";
          stim.innerHTML = m.shape ? shapeSvg(r.shapeSet, t.shape, fill) : `<div class="square" style="background:${fill}"></div>`;
        }
        cells[cell]!.appendChild(stim);
      }
      drawBack(r, t);
    }

    /** What stays up between stimuli: the crosshair, or Variable's back. */
    function drawBack(r: Run, t: Trial | null) {
      if (r.mode.variable && t && r.index >= r.n) {
        const b = document.createElement("div");
        b.className = "back-number";
        b.textContent = String(t.back);
        cells[r.mode.position ? CENTER : 7]!.appendChild(b);
      } else if (r.mode.position && !r.mode.variable) {
        board.classList.add("crosshair");
      }
    }

    function hideStimulus(r: Run) {
      clearBoard();
      drawBack(r, r.trials[r.index] ?? null);
    }

    /* ---------------- the Session ---------------- */

    const vnow = (r: Run) => performance.now() - r.pausedTotal;

    function arm(r: Run, at: number, fn: () => void) {
      r.pending = { at, fn };
      clearTimeout(r.timer);
      if (r.pausedAt !== null) return;
      r.timer = window.setTimeout(() => {
        const p = r.pending;
        r.pending = null;
        if (p && run === r) p.fn();
      }, Math.max(0, at - vnow(r)));
    }

    function start() {
      if (run) return;
      const p = plan();
      const e = p.e;
      player.unlock();
      const rand = Math.random;
      const shapeSet: ShapeSetId = e.shapes === "either" ? (rand() < 0.5 ? "shapes" : "pentominoes") : e.shapes;
      const trialMs = Math.round(p.secs * 1000);
      const r: Run = {
        settings: e,
        mode: e.mode,
        key: p.key,
        n: p.n,
        level: p.level,
        mods: modalities(e.mode),
        trials: generate({
          mode: e.mode, n: p.n, trials: p.trials, matchChance: 0.125, lureChance: e.lureEighths / 8,
          arithmetic: e.arithmetic, jaeggi: e.jaeggi, rand,
        }),
        responses: [],
        trialMs,
        stimMs: Math.min(stimulusSeconds(e.mode) * 1000, trialMs * 0.6),
        sounds: sample(rand),
        shapeSet,
        index: -1,
        trialStart: 0,
        origin: 0,
        pausedAt: null,
        pausedTotal: 0,
        timer: 0,
        pending: null,
        waiting: false,
        closed: false,
      };
      r.responses = r.trials.map(() => ({ pressed: {}, answer: "" }));
      run = r;
      result = null;
      el.classList.add("running");
      setup.inert = true;
      startBtn.hidden = true;
      pauseBtn.hidden = false;
      stopBtn.hidden = false;
      setPauseLabel(false);
      // Keys go to the game, not to whatever button was clicked last: Space would press it again.
      board.focus({ preventScroll: true });
      overlay.hidden = true;
      clearBoard();
      renderResponses(r.mode, r);
      stageTitle.textContent = sessionTitle(r.mode, r.n, e.manual, e.jaeggi);
      updateRemaining(r);
      // The recordings decode during the lead-in; the first Trial waits for both.
      const urls = [
        ...(r.mode.sound ? r.sounds.map((x) => x.url) : []),
        ...(r.mode.arithmetic ? Object.values(OPERATIONS) : []),
      ];
      const lead = vnow(r) + LEAD_MS;
      player.prepare(urls).then(() => {
        if (run !== r) return;
        r.origin = Math.max(lead, vnow(r));
        arm(r, r.origin, () => showTrial(r, 0));
      }, () => {
        if (run !== r) return;
        stopRun();
        overlay.insertAdjacentHTML("beforeend", `<p class="warn">This browser could not decode the sounds, so the session did not start.</p>`);
      });
    }

    function updateRemaining(r: Run) {
      const left = r.trials.length - Math.max(0, r.index);
      stageMeta.textContent = r.index < 0 ? `${r.trials.length} trials` : `${left} left`;
    }

    function showTrial(r: Run, i: number) {
      r.index = i;
      r.closed = false;
      r.trialStart = vnow(r);
      const t = r.trials[i]!;
      for (const b of $$(".resp")) b.classList.remove("hit", "wrong", "missed", "early", "pressed");
      answerValue.textContent = "";
      answerValue.className = "answer-value";
      drawTrial(r, t);
      if (r.mode.sound) void player.play(r.sounds[t.sound]!.url);
      else if (r.mode.arithmetic && t.op) void player.play(OPERATIONS[t.op]);
      updateRemaining(r);
      if (r.mode.selfPaced) {
        r.waiting = true;
        return;
      }
      const begins = r.origin + i * r.trialMs;
      arm(r, begins + r.stimMs, () => {
        hideStimulus(r);
        arm(r, begins + r.trialMs - MISSED_MS, () => {
          closeTrial(r);
          arm(r, begins + r.trialMs, () => next(r));
        });
      });
    }

    /** Shows what was missed, and how the typed answer fared; presses still count until the next trial. */
    function closeTrial(r: Run) {
      r.closed = true;
      if (!r.settings.feedback) return;
      const i = r.index;
      for (const mod of r.mods) {
        if (mod === "arithmetic") {
          if (i >= r.n) answerValue.className = "answer-value " + (answerRight(r.trials[i]!, r.responses[i]!.answer) ? "hit" : "wrong");
          continue;
        }
        if (isMatch(r.trials, i, mod, r.n) && r.responses[i]!.pressed[mod] === undefined) {
          responsesEl.querySelector(`[data-mod="${mod}"]`)?.classList.add("missed");
        }
      }
    }

    function next(r: Run) {
      if (r.index + 1 < r.trials.length) showTrial(r, r.index + 1);
      else finish(r);
    }

    function advance(r: Run) {
      if (!r.waiting || r.pausedAt !== null) return;
      r.waiting = false;
      closeTrial(r);
      hideStimulus(r);
      arm(r, vnow(r) + ADVANCE_GAP_MS, () => next(r));
    }

    function respond(mod: Modality) {
      const r = run;
      if (!r || r.index < 0 || r.pausedAt !== null || !r.mods.includes(mod)) return;
      const resp = r.responses[r.index]!;
      if (resp.pressed[mod] !== undefined) return;
      resp.pressed[mod] = Math.round(vnow(r) - r.trialStart);
      const b = responsesEl.querySelector(`[data-mod="${mod}"]`);
      if (!b) return;
      b.classList.remove("missed");
      if (!r.settings.feedback) b.classList.add("pressed");
      else if (r.index < r.n) b.classList.add("early");
      else b.classList.add(isMatch(r.trials, r.index, mod, r.n) ? "hit" : "wrong");
    }

    function typeAnswer(key: string) {
      const r = run;
      if (!r || !r.mode.arithmetic || r.index < 0 || r.pausedAt !== null) return;
      const resp = r.responses[r.index]!;
      let a = resp.answer;
      if (key === "Backspace" || key === "Delete") a = "";
      else if (key === "-") a = a.startsWith("-") ? a.slice(1) : "-" + a;
      else if (key === ".") a = a.includes(".") ? a : a + (a === "" || a === "-" ? "0." : ".");
      else if (/^\d$/.test(key) && a.replace(/[-.]/g, "").length < 6) a += key;
      else return;
      resp.answer = a;
      answerValue.textContent = a;
      // A change after the trial closed is judged again.
      if (r.closed && r.settings.feedback && r.index >= r.n) answerValue.className = "answer-value " + (answerRight(r.trials[r.index]!, a) ? "hit" : "wrong");
    }

    function setPauseLabel(paused: boolean) {
      pauseBtn.innerHTML = paused ? `${ICON_PLAY}<span>Resume</span>` : `${ICON_PAUSE}<span>Pause</span>`;
      pauseBtn.title = paused ? "Resume (P)" : "Pause (P)";
    }

    function pause() {
      const r = run;
      if (!r || r.pausedAt !== null) return;
      r.pausedAt = performance.now();
      clearTimeout(r.timer);
      player.stop();
      setPauseLabel(true);
      showOverlay(`<div class="overlay-title">Paused</div><p>Press <kbd>P</kbd> to resume, <kbd>Esc</kbd> to stop.</p>`, "paused");
    }

    function resume() {
      const r = run;
      if (!r || r.pausedAt === null) return;
      r.pausedTotal += performance.now() - r.pausedAt;
      r.pausedAt = null;
      overlay.hidden = true;
      setPauseLabel(false);
      board.focus({ preventScroll: true });
      if (r.pending) arm(r, r.pending.at, r.pending.fn);
    }

    function endRun() {
      if (run) clearTimeout(run.timer);
      run = null;
      player.stop();
      el.classList.remove("running");
      setup.inert = false;
      startBtn.hidden = false;
      pauseBtn.hidden = true;
      stopBtn.hidden = true;
      // The focus was on the board; Start is where a keyboard user carries on.
      if (el.contains(document.activeElement) || document.activeElement === document.body) startBtn.focus({ preventScroll: true });
    }

    /** Stops without keeping anything: a Session cut short has no Score. */
    function stopRun() {
      endRun();
      refresh();
    }

    function finish(r: Run) {
      const e = r.settings;
      const scoring = { jaeggi: e.jaeggi };
      const tallies = r.mods.map((mod) => [mod, tally(r.trials, r.responses, mod, r.n)] as [Modality, Tally]);
      const score = sessionScore(tallies.map(([, t]) => t), scoring);
      const th = e.thresholdsInForce;
      const before = levelFor(sessions, r.key);
      const pct: Session["pct"] = {};
      const t: Session["tallies"] = {};
      for (const [mod, tl] of tallies) {
        pct[mod] = percent(tl, scoring);
        t[mod] = tl;
      }
      const session: Session = {
        at: Date.now(),
        mode: r.key,
        n: r.n,
        manual: e.manual,
        jaeggi: e.jaeggi,
        trials: r.trials.length,
        trialMs: r.trialMs,
        seconds: Math.round((r.trials.length * r.trialMs) / 1000),
        score,
        pct,
        tallies: t,
      };
      // Strikes belong to one N: a Manual detour to another N, or a Deep Link, starts them afresh.
      const at: Level = { n: r.n, strikes: before.n === r.n ? before.strikes : 0 };
      if (!e.manual) session.level = nextLevel(at, score, th);
      sessions.push(session);
      const stored = save(sessions);
      result = { session, tallies, before: at, th };
      endRun();
      refresh();
      if (!stored) {
        overlay.insertAdjacentHTML("beforeend", `<p class="warn">The browser refused to store this session: its storage is full or turned off.</p>`);
      }
    }

    /* ---------------- input ---------------- */

    function keyFor(key: string): Modality | null {
      const r = run;
      if (!r) return null;
      return r.mods.find((m) => KEYS[m] === key) ?? null;
    }

    document.addEventListener("keydown", (e) => {
      if (el.hidden || view !== "train" || settingsDialog.open || confirmDialog.open) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement;
      const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target.isContentEditable;
      if (!run) {
        // Space starts, unless a keyboard user is on a button, which Space presses. (A clicked button gives its focus up; see below.)
        if (e.key === " " && !typing && !(target instanceof HTMLButtonElement)) {
          e.preventDefault();
          start();
        }
        return;
      }
      if (e.repeat) return;
      const key = e.key.toLowerCase();
      if (key === "escape") {
        e.preventDefault();
        stopRun();
        return;
      }
      if (key === "p") {
        e.preventDefault();
        if (run.pausedAt === null) pause();
        else resume();
        return;
      }
      if (e.key === "Enter" || (e.key === " " && run.mode.selfPaced)) {
        e.preventDefault();
        advance(run);
        return;
      }
      if (e.key === " ") {
        // Space would press whatever has the focus.
        e.preventDefault();
        return;
      }
      const mod = keyFor(key);
      if (mod) {
        e.preventDefault();
        respond(mod);
        return;
      }
      if (run.mode.arithmetic && /^(\d|-|\.|Backspace|Delete)$/.test(e.key)) {
        e.preventDefault();
        typeAnswer(e.key);
      }
    });

    // Responses fire on pointerdown, the moment the finger or button goes down, and never take the focus from the board.
    responsesEl.addEventListener("pointerdown", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>(".resp");
      if (!b || !run) return;
      e.preventDefault();
      if (b.classList.contains("next")) advance(run);
      else respond(b.dataset.mod as Modality);
    });
    // A keyboard press on a focused response button.
    responsesEl.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>(".resp");
      if (!b || !run || (e as MouseEvent).detail !== 0) return;
      if (b.classList.contains("next")) advance(run);
      else respond(b.dataset.mod as Modality);
    });
    keypad.addEventListener("pointerdown", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-key]");
      if (!b) return;
      e.preventDefault();
      typeAnswer(b.dataset.key!);
    });

    // A button clicked with the mouse lets go of the focus, so the Space that follows starts a Session instead of pressing it again.
    el.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest("button");
      if (b && e.detail > 0 && !b.closest("dialog")) b.blur();
    });

    startBtn.addEventListener("click", start);
    stopBtn.addEventListener("click", stopRun);
    pauseBtn.addEventListener("click", () => (run?.pausedAt === null ? pause() : resume()));

    // A Session does not run unseen: switching Tools or tabs pauses it.
    new MutationObserver(() => {
      if (el.hidden) pause();
    }).observe(el, { attributes: true, attributeFilter: ["hidden"] });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) pause();
    });

    /* ---------------- setup controls ---------------- */

    for (const b of $$<HTMLButtonElement>(".modality-chips .chip")) {
      b.addEventListener("click", () => {
        const t = b.dataset.toggle as Toggle;
        change((s) => {
          s.mode = normalize({ ...s.mode, [t]: !s.mode[t] }, t);
        });
      });
    }
    for (const b of $$<HTMLButtonElement>(".variant-chips .chip")) {
      b.addEventListener("click", () => {
        const v = b.dataset.variant as "variable" | "crab" | "selfPaced";
        change((s) => {
          s.mode = normalize({ ...s.mode, [v]: !s.mode[v] }, null);
        });
      });
    }
    for (const b of $$<HTMLButtonElement>(".multi-seg button")) {
      b.addEventListener("click", () => change((s) => {
        s.mode = normalize({ ...s.mode, multi: Number(b.dataset.multi) as Mode["multi"] }, "multi");
      }));
    }
    $<HTMLInputElement>(".jaeggi").addEventListener("change", (e) => change((s) => {
      s.jaeggi = (e.target as HTMLInputElement).checked;
    }));
    for (const b of $$<HTMLButtonElement>(".level-seg button")) {
      b.addEventListener("click", () => change((s) => {
        s.manual = b.dataset.level === "manual";
      }));
    }
    const setN = (n: number) => change((s) => {
      s.manualN = clamp(Math.round(n), LIMITS.n);
    });
    $(".n-down").addEventListener("click", () => setN(settings.manualN - 1));
    $(".n-up").addEventListener("click", () => setN(settings.manualN + 1));
    nInput.addEventListener("change", () => {
      const v = Number(nInput.value);
      if (Number.isFinite(v) && nInput.value.trim()) setN(v);
      nInput.value = String(settings.manualN);
    });
    nInput.addEventListener("keydown", (e) => {
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        setN(settings.manualN + (e.key === "ArrowUp" ? 1 : -1));
        nInput.value = String(settings.manualN);
      }
    });

    /* ---------------- views ---------------- */

    function setView(v: "train" | "history") {
      if (v === "history" && run) pause();
      view = v;
      for (const b of $$<HTMLButtonElement>(".view-seg button")) {
        const on = b.dataset.view === v;
        b.classList.toggle("active", on);
        b.setAttribute("aria-selected", String(on));
      }
      train.hidden = v !== "train";
      history.hidden = v !== "history";
      if (v === "history") {
        historyMode = "";
        shownRows = 50;
        renderHistory();
      }
    }
    for (const b of $$<HTMLButtonElement>(".view-seg button")) b.addEventListener("click", () => setView(b.dataset.view as "train" | "history"));

    /* ---------------- History ---------------- */

    const historySelect = $<HTMLSelectElement>(".history-mode");
    const historyNote = $(".history-note");

    function thresholdsOf(s: Session): Thresholds {
      return s.jaeggi ? JAEGGI : settings.thresholds;
    }

    function renderHistory() {
      const keys = [...new Set(sessions.map((s) => s.mode))];
      const current = plan().key;
      if (!historyMode) historyMode = keys.includes(current) ? current : (sessions[sessions.length - 1]?.mode ?? current);
      if (!keys.includes(historyMode)) keys.push(historyMode);
      const counts = new Map<string, number>();
      for (const s of sessions) counts.set(s.mode, (counts.get(s.mode) ?? 0) + 1);
      historySelect.innerHTML = keys
        .toSorted((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0))
        .map((k) => `<option value="${k}">${escapeHtml(modeName(parseModeKey(k)!))} (${counts.get(k) ?? 0})</option>`)
        .join("");
      historySelect.value = historyMode;
      for (const b of $$<HTMLButtonElement>(".metric-seg button")) {
        const on = b.dataset.metric === metric;
        b.classList.toggle("active", on);
        b.setAttribute("aria-checked", String(on));
      }
      $<HTMLButtonElement>(".export-btn").disabled = sessions.length === 0;
      $<HTMLButtonElement>(".clear-btn").disabled = sessions.length === 0;

      const now = Date.now();
      const t = today(sessions, now);
      const d = lastDay(sessions, now);
      const ofMode = sessions.filter((s) => s.mode === historyMode);
      const todayMode = today(ofMode, now).slice(-20);
      const tile = (label: string, value: string, sub: string) =>
        `<div class="tile"><div class="tile-label">${label}</div><div class="tile-value">${value}</div><div class="tile-sub">${sub}</div></div>`;
      const plural = (n: number) => n + " session" + (n === 1 ? "" : "s");
      $(".tiles").innerHTML =
        tile("Today", durationFmt(totalSeconds(t)), plural(t.length)) +
        tile("Last 24 hours", durationFmt(totalSeconds(d)), plural(d.length)) +
        tile("All time", durationFmt(totalSeconds(sessions)), plural(sessions.length)) +
        tile("Average N today", todayMode.length ? (todayMode.reduce((a, s) => a + s.n, 0) / todayMode.length).toFixed(2) : "–", "this mode, last 20");

      // The chart leaves Manual Sessions out: their N is the player's choice, not the level reached.
      const charted = ofMode.filter((s) => !s.manual);
      const chart = $(".chart");
      if (charted.length) draw(chart, daily(charted, metric, thresholdsOf), metric);
      else chart.innerHTML = `<p class="empty">No automatic sessions of this mode yet. The chart shows each day's mean and best ${metric === "score" ? "score" : "level"}.</p>`;
      $(".legend").hidden = !charted.length;
      $(".chart-title").textContent = metric === "score" ? "Daily score" : "Daily level";

      // Each Modality's mean over the last 50 Sessions of this Mode.
      const recent = ofMode.slice(-50);
      const mods = modalities(parseModeKey(historyMode)!);
      $(".averages").textContent = recent.length
        ? "Last " + recent.length + ": " + mods.map((m) => {
          const vs = recent.map((s) => s.pct[m]).filter((v): v is number => typeof v === "number");
          return shortLabel(m) + " " + (vs.length ? Math.round(vs.reduce((a, b) => a + b, 0) / vs.length) + "%" : "–");
        }).join(" · ")
        : "";

      const rows = ofMode.toReversed();
      const tbody = $("tbody");
      tbody.innerHTML = rows.slice(0, shownRows).map((s) => {
        const mode = parseModeKey(s.mode)!;
        const th = thresholdsOf(s);
        const cls = s.manual ? "" : s.score >= th.advance ? "up" : s.score < th.fallback ? "down" : "";
        const tags = (s.manual ? ' <span class="tag">Manual</span>' : "") + (s.jaeggi ? ' <span class="tag">Jaeggi</span>' : "");
        const pcts = modalities(mode).map((m) => (s.pct[m] === undefined ? "" : shortLabel(m) + " " + s.pct[m])).filter(Boolean).join(" · ");
        return `<tr class="${cls}"><td>${whenFmt.format(s.at)}</td><td>${escapeHtml(modeName(mode))}${tags}</td><td class="num">${s.n}</td><td class="num score-cell">${s.score}%</td><td class="mods">${pcts}</td><td class="num">${clockFmt(s.seconds)}</td></tr>`;
      }).join("") || `<tr><td colspan="6" class="empty">No sessions of this mode yet.</td></tr>`;
      $(".more-btn").hidden = rows.length <= shownRows;
    }

    function shortLabel(m: Modality): string {
      const short: Partial<Record<Modality, string>> = { color: "C", shape: "S", visvis: "LS", visaudio: "SH", audiovis: "HS", arithmetic: "M", sound: "A" };
      if (m.startsWith("position")) return "P" + (m.endsWith("1") ? "" : m.slice(-1));
      if (m.startsWith("vis") && /\d$/.test(m)) return "V" + m.slice(-1);
      return short[m] ?? m;
    }

    historySelect.addEventListener("change", () => {
      historyMode = historySelect.value;
      shownRows = 50;
      renderHistory();
    });
    for (const b of $$<HTMLButtonElement>(".metric-seg button")) {
      b.addEventListener("click", () => {
        metric = b.dataset.metric as Metric;
        renderHistory();
      });
    }
    $(".more-btn").addEventListener("click", () => {
      shownRows += 100;
      renderHistory();
    });
    new ResizeObserver(() => {
      if (view === "history" && !el.hidden) {
        const charted = sessions.filter((s) => s.mode === historyMode && !s.manual);
        if (charted.length) draw($(".chart"), daily(charted, metric, thresholdsOf), metric);
      }
    }).observe($(".chart"));

    let noteTimer = 0;
    function note(text: string, kind = "") {
      clearTimeout(noteTimer);
      historyNote.textContent = text;
      historyNote.className = "history-note " + kind;
      noteTimer = window.setTimeout(() => (historyNote.textContent = ""), 6000);
    }

    $(".export-btn").addEventListener("click", () => {
      const stamp = new Date().toISOString().slice(0, 10);
      download(exportJson(sessions), `dual-n-back-${stamp}.json`, "application/json");
    });
    const importInput = $<HTMLInputElement>(".import-input");
    $(".import-btn").addEventListener("click", () => importInput.click());
    importInput.addEventListener("change", async () => {
      const file = importInput.files?.[0];
      importInput.value = "";
      if (!file) return;
      const text = await file.text();
      const incoming = parseJson(text);
      if (!incoming?.length) {
        note(`${file.name} has no sessions this tool can read: it takes the JSON that Export writes.`, "error");
        return;
      }
      const merged = merge(sessions, incoming);
      sessions = merged.sessions;
      if (!save(sessions)) note("The browser refused to store the imported sessions: its storage is full or turned off.", "error");
      else note(`${merged.added} session${merged.added === 1 ? "" : "s"} added from ${file.name}` + (incoming.length > merged.added ? `, ${incoming.length - merged.added} already here` : "")  + ".", "ok");
      historyMode = "";
      refresh();
    });

    $(".clear-btn").addEventListener("click", () => {
      $(".confirm-text").textContent = `Delete all ${sessions.length} session${sessions.length === 1 ? "" : "s"} from this browser? Every mode goes back to its starting level. Export first to keep a copy.`;
      confirmDialog.showModal();
      $<HTMLButtonElement>(".confirm-cancel").focus();
    });
    $(".confirm-cancel").addEventListener("click", () => confirmDialog.close());
    $(".confirm-ok").addEventListener("click", () => {
      confirmDialog.close();
      sessions = [];
      save(sessions);
      result = null;
      historyMode = "";
      refresh();
      note("History cleared.");
    });

    /* ---------------- Settings dialog ---------------- */

    const field = <T extends HTMLElement = HTMLInputElement>(cls: string) => settingsDialog.querySelector("." + cls) as T;

    function fillSettings() {
      const s = settings;
      field("s-trials").value = String(s.baseTrials);
      field("s-trials-note").textContent = s.jaeggi ? "+ N (Jaeggi mode)" : "+ N²";
      field("s-secs").value = s.trialSeconds === null ? "" : String(s.trialSeconds);
      field("s-secs").placeholder = defaultTrialSeconds(effective(s).mode).toFixed(1) + " (the mode's own)";
      field<HTMLSelectElement>("s-lures").value = String(s.lureEighths);
      field("s-feedback").checked = s.feedback;
      field("s-grid").checked = s.gridLines;
      field<HTMLSelectElement>("s-shapes").value = s.shapes;
      field("s-max").value = String(s.arithmetic.max);
      field("s-neg").checked = s.arithmetic.negatives;
      for (const c of settingsDialog.querySelectorAll<HTMLInputElement>(".s-op")) c.checked = s.arithmetic.ops.includes(c.value as never);
      field("s-raise").value = String(s.thresholds.advance);
      field("s-lower").value = String(s.thresholds.fallback);
      field("s-strikes").value = String(s.thresholds.strikes);
    }

    function readNumber(cls: string, limits: readonly [number, number], fallback: number, tenths = false): number {
      const raw = field(cls).value.trim();
      const v = Number(raw);
      if (!raw || !Number.isFinite(v)) return fallback;
      return clamp(tenths ? Math.round(v * 10) / 10 : Math.round(v), limits);
    }

    settingsDialog.addEventListener("change", () => {
      change((s) => {
        s.baseTrials = readNumber("s-trials", LIMITS.baseTrials, DEFAULTS.baseTrials);
        const secs = field("s-secs").value.trim();
        s.trialSeconds = secs ? readNumber("s-secs", LIMITS.trialSeconds, 3, true) : null;
        s.lureEighths = Number(field<HTMLSelectElement>("s-lures").value);
        s.feedback = field("s-feedback").checked;
        s.gridLines = field("s-grid").checked;
        s.shapes = field<HTMLSelectElement>("s-shapes").value as Settings["shapes"];
        s.arithmetic.max = readNumber("s-max", LIMITS.max, DEFAULTS.arithmetic.max);
        s.arithmetic.negatives = field("s-neg").checked;
        const ops = [...settingsDialog.querySelectorAll<HTMLInputElement>(".s-op")].filter((c) => c.checked).map((c) => c.value);
        s.arithmetic.ops = (ops.length ? ops : ["add"]) as Settings["arithmetic"]["ops"];
        s.thresholds = {
          advance: readNumber("s-raise", LIMITS.percent, DEFAULTS.thresholds.advance),
          fallback: readNumber("s-lower", LIMITS.percent, DEFAULTS.thresholds.fallback),
          strikes: readNumber("s-strikes", LIMITS.strikes, DEFAULTS.thresholds.strikes),
        };
      });
      // Show what was kept: a clamped number, or the operation that cannot be unticked.
      fillSettings();
    });

    $(".settings-btn").addEventListener("click", () => {
      if (run) pause();
      fillSettings();
      settingsDialog.showModal();
    });
    $(".close-btn").addEventListener("click", () => settingsDialog.close());
    $(".reset-btn").addEventListener("click", () => {
      change((s) => {
        const d = clone(DEFAULTS);
        Object.assign(s, { ...d, mode: s.mode, manual: s.manual, manualN: s.manualN, jaeggi: s.jaeggi });
      });
      fillSettings();
    });
    // A click on the backdrop closes it, as Escape does. The dialog itself has no padding, so a click inside lands on its content.
    for (const d of [settingsDialog, confirmDialog]) {
      d.addEventListener("click", (e) => {
        if (e.target === d) d.close();
      });
    }

    refresh();
  },
};

export default tool;
