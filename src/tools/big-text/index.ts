import "./tool.css";
import type { Tool } from "../../shell/types";
import { parseDuration, formatDuration } from "./countdown";
import { Display } from "./display";
import { DEFAULTS, LIMITS, decode, encode } from "./state";
import type {
  Countdown,
  End,
  Font,
  Settings,
  Speed,
  Transition,
} from "./state";
import { hasCountdown, slideAt } from "./text";

/** How long the hint and the pointer stay up after the pointer last moved. */
const CHROME_MS = 2500;

/** A datetime-local value, in local time, for an instant. */
const localValue = (ms: number): string => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  const secs = d.getSeconds() ? `:${p(d.getSeconds())}` : "";
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}${secs}`;
};

const tool: Tool = {
  id: "big-text",
  keywords: [
    "big",
    "text",
    "fullscreen",
    "full screen",
    "sign",
    "display",
    "banner",
    "marquee",
    "ticker",
    "countdown",
    "timer",
    "slides",
    "kiosk",
    "message",
    "present",
  ],
  mount(el, ctx) {
    el.innerHTML = `
      <div class="options">
        <label class="opt">Font
          <select class="o-font"><option value="sans">Sans</option><option value="serif">Serif</option><option value="mono">Mono</option></select>
        </label>
        <label class="opt">Text <span class="swatch"><input type="color" class="o-fg"></span></label>
        <label class="opt">Background <span class="swatch"><input type="color" class="o-bg"></span></label>
        <label class="opt">Margin <input type="number" class="o-pad" min="${LIMITS.pad[0]}" max="${LIMITS.pad[1]}" step="1"> %</label>
        <label class="opt" data-when="wrap"><input type="checkbox" class="o-wrap">Wrap lines</label>
        <label class="opt"><input type="checkbox" class="o-scroll">Scroll</label>
        <label class="opt" data-when="scroll">Speed
          <select class="o-speed"><option value="slow">Slow</option><option value="normal">Normal</option><option value="fast">Fast</option></select>
        </label>
        <div class="opt-group">
          <label class="opt">Countdown
            <select class="o-cd"><option value="none">None</option><option value="until">Until</option><option value="timer">Timer</option></select>
          </label>
          <input type="datetime-local" class="o-until" aria-label="Count down until" data-when="until">
          <input type="text" class="o-timer" aria-label="Timer length" placeholder="10m, 1h30m" spellcheck="false" autocomplete="off" data-when="timer" title="Starts when you present">
        </div>
        <label class="opt" data-when="countdown">Style
          <select class="o-style"><option value="label">1h 5m 0s</option><option value="clock">1:05:00</option></select>
        </label>
        <div class="opt-group" data-when="countdown">
          <label class="opt">At zero
            <select class="o-end"><option value="freeze">Stay at zero</option><option value="hide">Go blank</option><option value="text">Show text</option></select>
          </label>
          <input type="text" class="o-endtext" aria-label="Text at zero" placeholder="Time's up" spellcheck="false" autocomplete="off" data-when="endtext">
        </div>
        <label class="opt" data-when="slides">Each slide <input type="number" class="o-secs" min="${LIMITS.secs[0]}" max="${LIMITS.secs[1]}" step="0.5"> s</label>
        <label class="opt" data-when="slides">Transition
          <select class="o-trans"><option value="fade">Fade</option><option value="slide">Slide</option><option value="none">None</option></select>
        </label>
      </div>
      <div class="panes">
        <section class="pane">
          <div class="pane-head"><span>Message</span></div>
          <textarea class="o-message" spellcheck="false" autocomplete="off" aria-label="Message" placeholder="Type your message."></textarea>
          <div class="foot">
            <span class="note" role="status"></span>
            <dl class="syntax">
              <div><dt>**bold**</dt><dd><strong>bold</strong></dd></div>
              <div><dt>*italic*</dt><dd><em>italic</em></dd></div>
              <div><dt>~~strike~~</dt><dd><del>strike</del></dd></div>
              <div><dt># Heading</dt><dd class="h">Heading</dd></div>
              <div><dt>||</dt><dd>next slide</dd></div>
              <div><dt>{countdown}</dt><dd>time left</dd></div>
            </dl>
          </div>
        </section>
        <section class="pane">
          <div class="pane-head">
            <span>Preview</span>
            <span class="slide-pos"></span>
            <span class="spacer"></span>
            <button type="button" class="btn-link" title="Copy a link that opens straight to the display" disabled>Copy link</button>
            <button type="button" class="btn-present primary" title="Show full screen (click for the next slide, Esc to exit)" disabled>Present</button>
          </div>
          <div class="frame">
            <div class="stage" tabindex="-1">
              <div class="chrome"><span class="hint">Press F for full screen</span></div>
            </div>
          </div>
        </section>
      </div>`;

    const $ = <T extends HTMLElement>(sel: string) =>
      el.querySelector(sel) as T;
    const $message = $<HTMLTextAreaElement>(".o-message");
    const $font = $<HTMLSelectElement>(".o-font");
    const $fg = $<HTMLInputElement>(".o-fg");
    const $bg = $<HTMLInputElement>(".o-bg");
    const $pad = $<HTMLInputElement>(".o-pad");
    const $wrap = $<HTMLInputElement>(".o-wrap");
    const $scroll = $<HTMLInputElement>(".o-scroll");
    const $speed = $<HTMLSelectElement>(".o-speed");
    const $cd = $<HTMLSelectElement>(".o-cd");
    const $until = $<HTMLInputElement>(".o-until");
    const $timer = $<HTMLInputElement>(".o-timer");
    const $style = $<HTMLSelectElement>(".o-style");
    const $end = $<HTMLSelectElement>(".o-end");
    const $endText = $<HTMLInputElement>(".o-endtext");
    const $secs = $<HTMLInputElement>(".o-secs");
    const $trans = $<HTMLSelectElement>(".o-trans");
    const $note = $(".note");
    const $pos = $(".slide-pos");
    const $link = $<HTMLButtonElement>(".btn-link");
    const $present = $<HTMLButtonElement>(".btn-present");
    const $frame = $(".frame");
    const $stage = $(".stage");
    const $hint = $(".hint");

    const display = new Display($stage);
    let settings: Settings = { ...DEFAULTS };
    let presenting = false;
    let wake: WakeLockSentinel | null = null;

    /* ---------------- settings ⇄ fields ---------------- */

    const countdownField = (): Countdown => {
      $until.removeAttribute("aria-invalid");
      $timer.removeAttribute("aria-invalid");
      if ($cd.value === "until") {
        const at = new Date($until.value).getTime();
        if (Number.isFinite(at)) {
          return { at, kind: "until" };
        }
        $until.setAttribute("aria-invalid", "true");
      } else if ($cd.value === "timer") {
        const secs = parseDuration($timer.value);
        if (secs) {
          return { kind: "timer", secs };
        }
        if ($timer.value.trim()) {
          $timer.setAttribute("aria-invalid", "true");
        }
      }
      return { kind: "none" };
    };

    const read = (): Settings => {
      const n = (
        input: HTMLInputElement,
        [lo, hi]: readonly [number, number],
        fallback: number
      ) => {
        const v = Number(input.value);
        return input.value.trim() && Number.isFinite(v)
          ? Math.min(hi, Math.max(lo, v))
          : fallback;
      };
      return {
        bg: $bg.value,
        countdown: countdownField(),
        end: $end.value as End,
        endText: $endText.value,
        fg: $fg.value,
        font: $font.value as Font,
        message: $message.value,
        pad: n($pad, LIMITS.pad, DEFAULTS.pad),
        scroll: $scroll.checked,
        secs: n($secs, LIMITS.secs, DEFAULTS.secs),
        speed: $speed.value as Speed,
        style: $style.value === "clock" ? "clock" : "label",
        transition: $trans.value as Transition,
        wrap: $wrap.checked,
      };
    };

    const fill = (s: Settings) => {
      $message.value = s.message;
      $font.value = s.font;
      $fg.value = s.fg;
      $bg.value = s.bg;
      $pad.value = String(s.pad);
      $wrap.checked = s.wrap;
      $scroll.checked = s.scroll;
      $speed.value = s.speed;
      $secs.value = String(s.secs);
      $trans.value = s.transition;
      $cd.value = s.countdown.kind;
      $until.value =
        s.countdown.kind === "until" ? localValue(s.countdown.at) : "";
      $timer.value =
        s.countdown.kind === "timer" ? formatDuration(s.countdown.secs) : "";
      $style.value = s.style;
      $end.value = s.end;
      $endText.value = s.endText;
    };

    /** Shows only the fields that apply, and says what is missing. */
    const sync = () => {
      const s = settings;
      const cd = $cd.value;
      const on: Record<string, boolean> = {
        countdown: cd !== "none",
        endtext: cd !== "none" && s.end === "text",
        scroll: s.scroll,
        slides: !s.scroll && display.count > 1,
        timer: cd === "timer",
        until: cd === "until",
        wrap: !s.scroll,
      };
      for (const f of el.querySelectorAll<HTMLElement>("[data-when]")) {
        f.hidden = !on[f.dataset.when ?? ""];
      }
      const empty = !s.message.trim() && s.countdown.kind === "none";
      $link.disabled = empty;
      $present.disabled = empty;
      $note.textContent =
        s.countdown.kind !== "none" &&
        s.message.trim() &&
        !hasCountdown(s.message)
          ? "Put {countdown} where the time should go."
          : "";
    };

    const publish = () => {
      ctx.setState(encode(settings, presenting));
    };

    const update = () => {
      settings = read();
      display.set(settings);
      sync();
      publish();
    };

    /* ---------------- preview ---------------- */

    // The preview has the shape of this screen, as large as the pane allows.
    new ResizeObserver(([entry]) => {
      if (presenting || !entry) {
        return;
      }
      const { width: w, height: h } = entry.contentRect;
      const ratio = screen.width / screen.height || 16 / 9;
      const sw = Math.min(w, h * ratio);
      $stage.style.setProperty("--w", `${Math.floor(sw)}px`);
      $stage.style.setProperty("--h", `${Math.floor(sw / ratio)}px`);
    }).observe($frame);

    display.onSlide = (i, count) => {
      $pos.textContent = count > 1 ? `${i + 1} / ${count}` : "";
      sync();
    };

    // The preview follows the caret: editing a Slide shows it.
    let caretSlide = 0;
    const followCaret = () => {
      const i = slideAt($message.value, $message.selectionStart);
      if (i !== caretSlide) {
        caretSlide = i;
        display.goTo(i);
      }
    };

    /* ---------------- present ---------------- */

    let chromeTimer = 0;
    const wakeChrome = () => {
      $stage.classList.add("awake");
      clearTimeout(chromeTimer);
      chromeTimer = window.setTimeout(
        () => $stage.classList.remove("awake"),
        CHROME_MS
      );
    };

    const syncHint = () => {
      $hint.hidden =
        !document.fullscreenEnabled || !!document.fullscreenElement;
    };

    const keepAwake = async () => {
      try {
        wake = await navigator.wakeLock?.request("screen");
      } catch {
        wake = null;
      }
    };

    const fullscreen = () => {
      if (document.fullscreenEnabled && !document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {
          // The browser may refuse; presenting works in the window too.
        });
      }
    };

    /**
     * Covers the window with the Display. Full screen needs a click or a key,
     * and a click is taken by the Slides, so a Present Link opens covering
     * the window and goes full screen on F.
     */
    const present = (clicked: boolean) => {
      presenting = true;
      $stage.classList.add("presenting");
      display.startTimer();
      publish();
      if (clicked) {
        fullscreen();
      }
      // Asked for already: no hint while the browser answers.
      $hint.hidden = clicked || !document.fullscreenEnabled;
      wakeChrome();
      void keepAwake();
      $stage.focus();
    };

    const exitPresent = () => {
      if (!presenting) {
        return;
      }
      presenting = false;
      $stage.classList.remove("presenting", "awake");
      display.resetTimer();
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {
          // Already left, e.g. with Esc.
        });
      }
      void wake?.release();
      wake = null;
      publish();
      $present.focus();
    };

    // Leaving full screen (Esc, or the browser's own control) ends the presentation.
    let wasFullscreen = false;
    document.addEventListener("fullscreenchange", () => {
      if (document.fullscreenElement) {
        wasFullscreen = true;
      } else if (wasFullscreen) {
        wasFullscreen = false;
        exitPresent();
      }
      syncHint();
    });
    document.addEventListener("visibilitychange", () => {
      if (presenting && document.visibilityState === "visible") {
        void keepAwake();
      }
    });
    // Switching to another Tool hides the Display; the presentation ends with it.
    new ResizeObserver(() => {
      if (presenting && !$stage.clientWidth) {
        exitPresent();
      }
    }).observe($stage);

    // While presenting, keys go to the Display alone: none reach the Shell's
    // shortcuts or anything behind it.
    window.addEventListener(
      "keydown",
      (e) => {
        if (!presenting) {
          return;
        }
        e.stopPropagation();
        if (e.key === "Escape") {
          exitPresent();
        } else if (e.key === "f" || e.key === "F") {
          fullscreen();
        } else if (
          ["ArrowRight", "ArrowDown", "PageDown", " "].includes(e.key)
        ) {
          display.step(1);
        } else if (["ArrowLeft", "ArrowUp", "PageUp"].includes(e.key)) {
          display.step(-1);
        } else if (e.key !== "Tab") {
          return;
        }
        e.preventDefault();
      },
      true
    );

    $stage.addEventListener("pointermove", () => presenting && wakeChrome());
    $stage.addEventListener("pointerdown", () => presenting && wakeChrome());
    // A click moves on to the next Slide; with only one, it leaves, so a
    // screen with no keyboard can still get out.
    $stage.addEventListener("click", () => {
      if (!presenting) {
        return;
      }
      if (display.count > 1) {
        display.step(1);
      } else {
        exitPresent();
      }
    });
    $present.addEventListener("click", () => present(true));

    $link.addEventListener("click", async () => {
      const url = new URL(location.href);
      url.search = "";
      url.hash = `big-text/${encode(settings, true)}`;
      let label = "Copied";
      try {
        await navigator.clipboard.writeText(url.href);
      } catch {
        label = "Copy failed";
      }
      $link.textContent = label;
      setTimeout(() => {
        $link.textContent = "Copy link";
      }, 1200);
    });

    /* ---------------- fields ---------------- */

    // A new Countdown starts filled in, so it shows at once.
    const prefillCountdown = () => {
      if ($cd.value === "until" && !$until.value) {
        const next = new Date();
        next.setHours(next.getHours() + 1, 0, 0, 0);
        $until.value = localValue(next.getTime());
      }
      if ($cd.value === "timer" && !$timer.value.trim()) {
        $timer.value = "10m";
      }
    };

    // Selects and checkboxes fire input too, so one listener sees every change.
    el.addEventListener("input", (e) => {
      const t = e.target as HTMLElement;
      if (t === $cd) {
        prefillCountdown();
      }
      if (t === $message || t.closest(".options")) {
        update();
      }
    });
    for (const type of ["input", "keyup", "pointerup", "focus"]) {
      $message.addEventListener(type, followCaret);
    }

    ctx.onRestore((payload) => {
      const { settings: s, show } = decode(payload);
      fill(s);
      update();
      caretSlide = 0;
      if (show && !presenting) {
        present(false);
      }
    });

    // Drawn, not published: the Shell restores a Deep Link right after mount,
    // and an empty State now would clear it first.
    fill(settings);
    settings = read();
    display.set(settings);
    sync();
  },
  name: "Big Text",
  subtitle:
    "Show a message as large as the screen allows, with slides and a countdown.",
};

export default tool;
