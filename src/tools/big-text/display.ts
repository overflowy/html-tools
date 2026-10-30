// The Display: the Message drawn as large as it fits, one Slide at a time.
// The preview and the presentation are the same element at two sizes; the
// fit is relative, so what the preview shows is what the screen shows.

import { formatRemaining, secondsLeft } from "./countdown";
import type { Settings } from "./state";
import { COUNTDOWN, parse } from "./text";
import type { Inline, Slide } from "./text";

/** Longest a transition runs; shorter when Slides change quickly. */
const TRANSITION_MS = 600;
/** Marquee speed, in ems per second. */
const SPEED = { fast: 6, normal: 4, slow: 2.5 } as const;
const EASE_OUT = "cubic-bezier(0.2, 0, 0, 1)";

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

const noListener = () => {
  // No listener until the tool sets one.
};

const inline = (
  nodes: Inline[],
  parent: ParentNode,
  countdown: string | null
) => {
  for (const n of nodes) {
    if (typeof n === "string") {
      parent.append(document.createTextNode(n));
    } else if (n.tag === "code") {
      const el = document.createElement("code");
      el.textContent = n.text;
      parent.append(el);
    } else if (n.tag === "countdown") {
      if (countdown === null) {
        parent.append(document.createTextNode(COUNTDOWN));
      } else {
        const el = document.createElement("span");
        el.className = "cd";
        el.textContent = countdown;
        parent.append(el);
      }
    } else {
      const el = document.createElement(n.tag);
      inline(n.children, el, countdown);
      parent.append(el);
    }
  }
};

export class Display {
  private s!: Settings;
  private slides: Slide[] = [];
  private endSlides: Slide[] = [];
  private index = 0;
  private current: HTMLElement | null = null;
  private marquee: Animation | null = null;
  private rotation = 0;
  private tick = 0;
  /** When the Timer started; null while it waits for Present. */
  private timerStart: number | null = null;
  private expired = false;
  /** Called whenever the Slide on screen or the number of Slides changes. */
  onSlide: (index: number, count: number) => void = noListener;
  private stage: HTMLElement;

  constructor(stage: HTMLElement) {
    this.stage = stage;
    new ResizeObserver(() => this.fit()).observe(stage);
    reduceMotion.addEventListener("change", () => this.fit());
    // A font loading late changes every measurement.
    void document.fonts.ready.then(() => this.fit());
  }

  set(s: Settings) {
    this.s = s;
    let shown = s.message;
    if (!s.message.trim()) {
      shown = s.countdown.kind === "none" ? "" : COUNTDOWN;
    }
    this.slides = parse(shown);
    this.endSlides = parse(s.endText);
    const st = this.stage;
    st.dataset.font = s.font;
    st.style.background = s.bg;
    st.style.color = s.fg;
    st.style.setProperty("--pad", String(s.pad));
    st.classList.toggle("nowrap", !s.wrap);
    st.classList.toggle("scroll", s.scroll);
    const end = this.countdownEnd();
    this.expired = end !== null && secondsLeft(end, Date.now()) === 0;
    this.show(this.index, false);
    this.runTicks();
  }

  get count() {
    return this.visible().length;
  }

  /** Shows Slide `i` at once and starts its time over. */
  goTo(i: number) {
    this.show(i, false);
  }

  step(delta: number) {
    const n = this.count;
    if (n > 1) {
      this.show((this.index + delta + n) % n, true);
    }
  }

  /** Starts the Timer now, from the first Slide. */
  startTimer() {
    this.timerStart = Date.now();
    this.expired = false;
    this.show(0, false);
    this.runTicks();
  }

  /** Puts the Timer back at its full length, waiting. */
  resetTimer() {
    this.timerStart = null;
    this.expired = false;
    this.show(this.index, false);
    this.runTicks();
  }

  /* ---------------- countdown ---------------- */

  private countdownEnd(): number | null {
    const cd = this.s.countdown;
    if (cd.kind === "until") {
      return cd.at;
    }
    if (cd.kind === "timer" && this.timerStart !== null) {
      return this.timerStart + cd.secs * 1000;
    }
    return null;
  }

  private countdownText(): string | null {
    const cd = this.s.countdown;
    if (cd.kind === "none") {
      return null;
    }
    const end = this.countdownEnd();
    if (end !== null) {
      return formatRemaining(secondsLeft(end, Date.now()), this.s.style);
    }
    return formatRemaining(cd.kind === "timer" ? cd.secs : 0, this.s.style);
  }

  /** The Slides as they stand: at zero, `hide` drops those showing the Countdown and `text` swaps them for the end text. */
  private visible(): Slide[] {
    if (!this.expired || this.s.end === "freeze") {
      return this.slides;
    }
    const atZero = this.s.end === "text" ? this.endSlides : [];
    const out = this.slides.flatMap((sl) => (sl.hasCountdown ? atZero : [sl]));
    return out.length ? out : [{ blocks: [], hasCountdown: false }];
  }

  private runTicks() {
    clearTimeout(this.tick);
    const end = this.countdownEnd();
    if (end === null || this.expired) {
      return;
    }
    const now = Date.now();
    // Wake just after the next whole second to go.
    this.tick = window.setTimeout(
      () => {
        // Never null here: a tick runs only while there is a Countdown.
        const text = this.countdownText();
        if (text !== null) {
          for (const el of this.stage.querySelectorAll(".cd")) {
            el.textContent = text;
          }
        }
        if (secondsLeft(end, Date.now()) === 0) {
          this.expired = true;
          if (this.s.end !== "freeze") {
            this.show(this.index, false);
          }
        }
        // A marquee keeps its size; refitting would start it over every second.
        if (!this.s.scroll) {
          this.fit();
        }
        this.runTicks();
      },
      ((end - now) % 1000 || 1000) + 10
    );
  }

  /* ---------------- slides ---------------- */

  private build(slide: Slide): HTMLElement {
    const el = document.createElement("div");
    el.className = "slide";
    const text = document.createElement("div");
    text.className = "text";
    const cd = this.countdownText();
    for (const b of slide.blocks) {
      const block = document.createElement("div");
      block.className = b.level ? `b h${b.level}` : "b";
      if (b.inline.length) {
        inline(b.inline, block, cd);
      } else {
        block.textContent = "\u200B";
      }
      text.append(block);
    }
    el.append(text);
    return el;
  }

  private show(i: number, animate: boolean) {
    const slides = this.visible();
    this.index = Math.max(0, Math.min(i, slides.length - 1));
    const next = this.build(
      slides[this.index] ?? { blocks: [], hasCountdown: false }
    );
    const prev = this.current;
    // Whatever is still leaving from an earlier change goes now.
    for (const el of this.stage.querySelectorAll(".slide")) {
      if (el !== prev) {
        el.remove();
      }
    }
    this.stage.prepend(next);
    this.current = next;
    this.fit();
    if (prev) {
      if (animate && this.s.transition !== "none") {
        this.transition(prev, next);
      } else {
        prev.remove();
      }
    }
    clearTimeout(this.rotation);
    if (!this.s.scroll && slides.length > 1) {
      this.rotation = window.setTimeout(() => this.step(1), this.s.secs * 1000);
    }
    this.onSlide(this.index, slides.length);
  }

  private transition(prev: HTMLElement, next: HTMLElement) {
    const duration = Math.min(TRANSITION_MS, this.s.secs * 400);
    const leave = () => prev.remove();
    if (this.s.transition === "fade" || reduceMotion.matches) {
      next.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration,
        easing: "ease",
      });
      prev.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration,
        easing: "ease",
        fill: "forwards",
      }).onfinish = leave;
    } else {
      const w = this.stage.clientWidth;
      next.animate(
        [{ transform: `translateX(${w}px)` }, { transform: "none" }],
        { duration, easing: EASE_OUT }
      );
      prev.animate(
        [{ transform: "none" }, { transform: `translateX(${-w}px)` }],
        { duration, easing: EASE_OUT, fill: "forwards" }
      ).onfinish = leave;
    }
  }

  /* ---------------- fit ---------------- */

  /**
   * The largest font size at which the Slide fits its padded area: no line
   * taller than the area, and no word wider than it (words are never split,
   * so a long word makes the text smaller). A marquee fits the height only.
   */
  private fit() {
    const el = this.current;
    if (!el) {
      return;
    }
    const text = el.firstElementChild as HTMLElement;
    const w = el.clientWidth;
    const h = el.clientHeight;
    this.marquee?.cancel();
    this.marquee = null;
    if (!w || !h) {
      return;
    }
    const { scroll } = this.s;
    text.style.overflow = "hidden";
    let lo = 1;
    let hi = h;
    while (hi - lo > 0.25) {
      const mid = (lo + hi) / 2;
      text.style.fontSize = `${mid}px`;
      if (
        text.scrollHeight <= h &&
        (scroll || text.scrollWidth <= text.clientWidth)
      ) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    text.style.fontSize = `${lo}px`;
    text.style.overflow = "";
    if (scroll) {
      this.scroll(text, w, lo);
    }
  }

  /** Runs the Slide across once, right to left, then moves on to the next (or the same one again). */
  private scroll(text: HTMLElement, w: number, size: number) {
    const tw = text.scrollWidth;
    const duration = ((w + tw) / (size * SPEED[this.s.speed])) * 1000;
    this.marquee = text.animate(
      [
        { transform: `translateX(${w}px)` },
        { transform: `translateX(${-tw}px)` },
      ],
      { duration, easing: "linear" }
    );
    this.marquee.onfinish = () =>
      this.show(
        this.count > 1 ? (this.index + 1) % this.count : this.index,
        false
      );
  }
}
