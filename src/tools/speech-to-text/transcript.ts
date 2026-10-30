// The Transcript and everything made from it: where a Window is cut, how
// Words group into Cues, and the four exports (text, SRT, WebVTT, JSON).
// Pure, so the rules are unit tested without an engine.

/** One word as the engine reports it: times in seconds from the start of the audio. */
export interface Word {
  word: string;
  start: number;
  end: number;
  probability: number;
}

/** A run of Words shown, and exported as a subtitle, together. */
export interface Cue {
  start: number;
  end: number;
  /** Index of the Cue's first Word in the Transcript. */
  first: number;
  words: Word[];
  text: string;
}

export interface Transcript {
  /** Two-letter code of the language the engine transcribed in. */
  language: string;
  /** Seconds of audio the Transcript covers. */
  duration: number;
  words: Word[];
}

export const LANGUAGES = [
  { code: "en", name: "English" },
  { code: "de", name: "German" },
  { code: "fr", name: "French" },
  { code: "es", name: "Spanish" },
  { code: "it", name: "Italian" },
  { code: "nl", name: "Dutch" },
  { code: "pl", name: "Polish" },
] as const;

export function languageName(code: string): string {
  return LANGUAGES.find((l) => l.code === code)?.name ?? code;
}

/* ---------------- windows ---------------- */

/** The longest stretch of audio the engine decodes in one pass. */
export const WINDOW_SECONDS = 30;
/** A Word ending this close to a Window's far edge may have been cut off by it. */
const EDGE = 1;
/** A cut earlier than this into a Window would make too little progress when a later one exists. */
const MIN_ADVANCE = 10;

const SENTENCE_END = /[.!?…]["'»”’)\]]*$/;

export function endsSentence(w: Word): boolean {
  return SENTENCE_END.test(w.word);
}

/**
 * Which Words of a Window to keep, and how far into it the next Window
 * starts, the way the engine cuts long audio itself: at the last sentence end
 * that leaves the Window's edge alone, so no sentence is split between two
 * passes. Without one, at the last Word clear of the edge. Words past the
 * cut are dropped; the next Window decodes them again with their context.
 * `seconds` is the Window's length, and `last` says it reaches the end of
 * the audio, where everything is kept.
 */
export function cutWindow(
  words: Word[],
  seconds: number,
  last: boolean
): { keep: Word[]; advance: number } {
  if (last) {
    return { keep: words, advance: seconds };
  }
  if (words.length === 0) {
    return { keep: [], advance: seconds };
  }
  let safe = 0;
  while (safe < words.length && words[safe]!.end <= seconds - EDGE) {
    safe += 1;
  }
  if (safe === 0) {
    // Speech only at the very edge: start the next Window just before it.
    return {
      keep: [],
      advance: Math.max(1, Math.min(seconds - EDGE, words[0]!.start - 0.1)),
    };
  }
  let k = -1;
  for (let i = safe - 1; i >= 0; i -= 1) {
    if (words[i]!.end < MIN_ADVANCE) {
      break;
    }
    if (endsSentence(words[i]!)) {
      k = i;
      break;
    }
  }
  if (k < 0) {
    k = safe - 1;
  }
  const next = words[k + 1];
  // Halfway into the gap after the kept Word, so neither Word's edge is clipped.
  const advance = next
    ? (words[k]!.end + next.start) / 2
    : Math.min(words[k]!.end + 0.5, seconds - EDGE);
  return { keep: words.slice(0, k + 1), advance: Math.max(1, advance) };
}

/* ---------------- cues ---------------- */

/** A Cue is cut before a Word that would push it past any of these. */
const CUE_MAX_SECONDS = 7;
const CUE_MAX_CHARS = 84;
/** Silence this long between two Words starts a new Cue. */
const CUE_GAP = 1.5;
/** Silence this long after a sentence starts a new paragraph in the text export. */
const PARAGRAPH_GAP = 2;

const CLAUSE_END = /[,;:–—]["'»”’)\]]*$/;

const textOf = (ws: Word[]) => ws.map((w) => w.word).join(" ");

/**
 * Words grouped into Cues: one per sentence, cut shorter where a sentence
 * runs past two subtitle lines or seven seconds, or pauses for long enough.
 * A sentence too long for one Cue is cut after its last comma (or semicolon,
 * colon, dash) where it has one, so no Cue ends mid-clause with a stray word
 * carried into the next.
 */
export function toCues(words: Word[]): Cue[] {
  const cues: Cue[] = [];
  let cur: Word[] = [];
  let first = 0;
  const emit = (ws: Word[], at: number) => {
    cues.push({
      start: ws[0]!.start,
      end: ws.at(-1)!.end,
      first: at,
      words: ws,
      text: textOf(ws),
    });
  };
  const flush = () => {
    if (cur.length) {
      emit(cur, first);
    }
    cur = [];
  };
  const overflows = (w: Word) =>
    textOf(cur).length + 1 + w.word.length > CUE_MAX_CHARS ||
    w.end - cur[0]!.start > CUE_MAX_SECONDS;
  words.forEach((w, i) => {
    if (cur.length && w.start - cur.at(-1)!.end > CUE_GAP) {
      flush();
    } else if (cur.length && overflows(w)) {
      // The last clause end, leaving at least two Words before it and one after.
      let cut = cur.length - 2;
      while (cut >= 1 && !CLAUSE_END.test(cur[cut]!.word)) {
        cut -= 1;
      }
      if (cut >= 1) {
        emit(cur.slice(0, cut + 1), first);
        first += cut + 1;
        cur = cur.slice(cut + 1);
      }
      if (overflows(w)) {
        flush();
      }
    }
    if (!cur.length) {
      first = i;
    }
    cur.push(w);
    if (endsSentence(w)) {
      flush();
    }
  });
  flush();
  return cues;
}

/* ---------------- time ---------------- */

/** `m:ss`, or `h:mm:ss` from an hour on: how the Tool shows a time. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** `hh:mm:ss,mmm` (SRT) or `hh:mm:ss.mmm` (WebVTT). */
export function timestamp(seconds: number, sep: "," | "."): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms % 1000, 3)}`;
}

/* ---------------- exports ---------------- */

const LINE_CHARS = 42;

/** A Cue's text on one subtitle line, or two split at the space nearest the middle. */
export function subtitleLines(text: string): string {
  if (text.length <= LINE_CHARS) {
    return text;
  }
  const mid = text.length / 2;
  let best = -1;
  for (let i = text.indexOf(" "); i >= 0; i = text.indexOf(" ", i + 1)) {
    if (best < 0 || Math.abs(i - mid) < Math.abs(best - mid)) {
      best = i;
    }
  }
  return best < 0 ? text : `${text.slice(0, best)}\n${text.slice(best + 1)}`;
}

export function toSrt(cues: Cue[]): string {
  return cues
    .map(
      (c, i) =>
        `${i + 1}\n${timestamp(c.start, ",")} --> ${timestamp(c.end, ",")}\n${subtitleLines(c.text)}\n`
    )
    .join("\n");
}

export function toVtt(cues: Cue[]): string {
  return `WEBVTT\n\n${cues
    .map(
      (c) =>
        `${timestamp(c.start, ".")} --> ${timestamp(c.end, ".")}\n${subtitleLines(c.text)}\n`
    )
    .join("\n")}`;
}

/** What was said, as prose: Words joined by spaces, a new paragraph after a sentence followed by a long pause. */
export function toText(words: Word[]): string {
  let out = "";
  words.forEach((w, i) => {
    const prev = words[i - 1];
    if (prev) {
      out +=
        endsSentence(prev) && w.start - prev.end >= PARAGRAPH_GAP
          ? "\n\n"
          : " ";
    }
    out += w.word;
  });
  return out ? `${out}\n` : "";
}

export function toJson(t: Transcript): string {
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return `${JSON.stringify(
    {
      language: t.language,
      duration: round(t.duration),
      text: t.words.map((w) => w.word).join(" "),
      words: t.words.map((w) => ({
        word: w.word,
        start: round(w.start),
        end: round(w.end),
        probability: round(w.probability),
      })),
    },
    null,
    2
  )}\n`;
}

/** The Keywords field as the engine wants them: one per line, blanks dropped. */
export function keywordLines(field: string): string {
  return field
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean)
    .join("\n");
}
