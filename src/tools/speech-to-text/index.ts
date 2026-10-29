import "./tool.css";
import ICON_INFO from "lucide-static/icons/info.svg";
import ICON_MIC from "lucide-static/icons/mic.svg";
import ICON_STOP from "lucide-static/icons/square.svg";
import type { Tool } from "../../shell/types";
import { Microphone, decodeFile, encodeWav } from "./audio";
import { ENGINES, cacheAvailable, cachedFamilies, clearCached, getEngine, listCached, type Progress } from "./engines";
import { ENGINE_RATE } from "./resample";
import { LANGUAGES, clock, keywordLines, languageName, toCues, toJson, toSrt, toText, toVtt, type Cue, type Word } from "./transcript";
import { CANCELLED, SpeechWorker } from "./worker-client";

const LANG_KEY = "html-tools:speech-to-text:language";
const KEYWORDS_KEY = "html-tools:speech-to-text:keywords";
/** Words the engine is less sure of than this are marked. */
const UNSURE = 0.5;
const NO_SPEECH = "No speech was heard. Silence and steady noise give no words.";

function formatBytes(n: number) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

function baseName(name: string) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name || "transcript";
}

function download(text: string, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type: type + ";charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function flash(btn: HTMLButtonElement, label: string) {
  const prev = btn.textContent;
  btn.textContent = label;
  setTimeout(() => (btn.textContent = prev), 1200);
}

function concat(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function knownLanguage(code: string | null): string {
  return LANGUAGES.some((l) => l.code === code) ? code! : "";
}

function message(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

/** What is being transcribed: a file, or a finished Recording. Kept so a changed option can transcribe it again. */
interface Source {
  name: string;
  pcm: Float32Array;
  /** Object URL the player plays. */
  url: string;
  recording: boolean;
}

interface Phase {
  text: string;
  fraction: number | null;
}

const tool: Tool = {
  id: "speech-to-text",
  name: "Speech to Text",
  subtitle: "Transcribe an audio file or the microphone, with word timestamps and subtitles, in seven languages.",
  keywords: ["transcribe", "transcription", "asr", "speech recognition", "dictation", "subtitles", "captions", "srt", "vtt", "audio", "voice", "microphone", "record", "whistle"],
  mount(el, ctx) {
    el.innerHTML = `
      <div class="toolbar">
        <button type="button" class="choose-btn">Choose file</button>
        <button type="button" class="record-btn"></button>
        <select class="lang-select" aria-label="Language" title="The language spoken; detected unless you pick one">
          <option value="">Detect language</option>
          ${LANGUAGES.map((l) => `<option value="${l.code}">${l.name}</option>`).join("")}
        </select>
        <input type="text" class="keywords" placeholder="Keywords, comma-separated" aria-label="Keywords" spellcheck="false" autocomplete="off"
          title="Names, places and jargon the speaker uses, separated by commas: recognition favours them">
        <button type="button" class="clear-btn">Clear</button>
        <span class="status"></span>
      </div>
      <input type="file" class="file-input" accept="audio/*,video/*" hidden>
      <div class="empty-hint">
        <strong>Drop an audio or video file anywhere here</strong>, choose a file, or record from the microphone.
        <span>Nothing you drop or say leaves the browser. The engine and its model (18 MB) download on first use and stay cached.</span>
      </div>
      <div class="progress">
        <span class="phase"></span>
        <div class="level" aria-hidden="true"><div class="level-fill"></div></div>
        <div class="bar"><div class="fill"></div></div>
        <button type="button" class="cancel-btn">Cancel</button>
      </div>
      <div class="note" role="status">${ICON_INFO}<span class="note-text"></span></div>
      <div class="result">
        <div class="pane-head">
          Transcript
          <span class="meta"></span>
          <span class="spacer"></span>
          <button type="button" class="copy-btn" title="Copy the transcript as text">Copy</button>
          <button type="button" class="dl" data-format="txt" title="Download the transcript as text">.txt</button>
          <button type="button" class="dl" data-format="srt" title="Download subtitles (SubRip)">.srt</button>
          <button type="button" class="dl" data-format="vtt" title="Download subtitles (WebVTT)">.vtt</button>
          <button type="button" class="dl" data-format="json" title="Download every word with its times and probability">.json</button>
        </div>
        <audio class="player" controls preload="metadata"></audio>
        <div class="cues"></div>
      </div>
      <div class="error-box"></div>
      <div class="engines">
        <span class="engines-text"></span>
        <button type="button" class="engines-clear" hidden>Clear cached engines</button>
      </div>`;

    const $ = <T extends HTMLElement = HTMLElement>(sel: string) => el.querySelector(sel) as T;
    const fileInput = $<HTMLInputElement>(".file-input");
    const recordBtn = $<HTMLButtonElement>(".record-btn");
    const langSelect = $<HTMLSelectElement>(".lang-select");
    const keywordsInput = $<HTMLInputElement>(".keywords");
    const status = $(".status");
    const emptyHint = $(".empty-hint");
    const progress = $(".progress");
    const phase = $(".phase");
    const level = $(".level");
    const bar = $(".bar");
    const fill = $(".fill");
    const cancelBtn = $<HTMLButtonElement>(".cancel-btn");
    const note = $(".note");
    const noteText = $(".note-text");
    const result = $(".result");
    const meta = $(".meta");
    const player = $<HTMLAudioElement>(".player");
    const cuesEl = $(".cues");
    const errorBox = $(".error-box");
    const enginesText = $(".engines-text");
    const enginesClear = $<HTMLButtonElement>(".engines-clear");

    let language = knownLanguage(localStorage.getItem(LANG_KEY));
    let keywords = localStorage.getItem(KEYWORDS_KEY) ?? "";

    let worker: SpeechWorker | null = null;
    /** Whether the worker is doing something for the current run, so stopping the run must stop it. */
    let working = false;
    let source: Source | null = null;
    let words: Word[] = [];
    let cues: Cue[] = [];
    /** The language the engine reported for the Transcript on screen. */
    let heard = "";
    /** The unconfirmed tail of a Recording, shown after the committed Words. */
    let pending = "";
    /** Seconds of the Source transcribed so far, for the note a cancel leaves. */
    let reached = 0;
    let mode: "idle" | "busy" | "recording" = "idle";
    /** Which run owns the screen; a superseded one must not touch it. */
    let runId = 0;
    /** Set while recording: ends the Recording and transcribes what is left. */
    let stopRecording: (() => void) | null = null;
    /** Set while the microphone is open: closes it. */
    let releaseMic: (() => void) | null = null;
    /** The highlighted Word while the player plays, and its index. */
    let lit: HTMLElement | null = null;
    let litAt = -1;
    let frame = 0;

    /* ---- options and the Deep Link ---- */

    /** State layout: the language code (`auto` when detected), then `.` and the URI-encoded Keywords if any. Defaults leave the Deep Link empty. */
    function publishState() {
      localStorage.setItem(LANG_KEY, language);
      localStorage.setItem(KEYWORDS_KEY, keywords);
      langSelect.value = language;
      keywordsInput.value = keywords;
      ctx.setState(keywords ? (language || "auto") + "." + encodeURIComponent(keywords) : language);
    }

    ctx.onRestore((payload) => {
      const dot = payload.indexOf(".");
      language = knownLanguage(dot < 0 ? payload : payload.slice(0, dot));
      try {
        keywords = dot < 0 ? "" : decodeURIComponent(payload.slice(dot + 1)).trim();
      } catch {
        keywords = "";
      }
      publishState();
    });
    // Only the controls: publishing here would replace a Deep Link the Shell is about to restore.
    langSelect.value = language;
    keywordsInput.value = keywords;

    // A changed option applies to what is on screen at once: a file or a
    // finished Recording is transcribed again, a Recording in progress uses
    // it from its next pass.
    langSelect.addEventListener("change", () => {
      language = langSelect.value;
      publishState();
      if (source && mode !== "recording") void transcribe();
    });
    keywordsInput.addEventListener("change", () => {
      const next = keywordsInput.value.trim();
      if (next === keywords) return;
      keywords = next;
      publishState();
      if (source && mode !== "recording") void transcribe();
    });

    /* ---- engines footer ---- */

    async function renderEngines() {
      if (!(await cacheAvailable())) {
        enginesText.textContent = "Engines cannot be kept here (no IndexedDB); they download on every visit.";
        enginesClear.hidden = true;
        return;
      }
      const rows = await listCached();
      if (rows.length === 0) {
        enginesText.textContent = "No engines cached";
        enginesClear.hidden = true;
        return;
      }
      enginesText.textContent = "Engines cached: " + formatBytes(rows.reduce((n, r) => n + r.bytes, 0));
      // The breakdown is a hover away, not in the way.
      enginesText.title = cachedFamilies(rows).map((f) => f.label + " " + formatBytes(f.bytes)).join("\n");
      enginesClear.hidden = false;
    }
    enginesClear.addEventListener("click", async () => {
      if (mode !== "idle") return;
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

    function setPhase(p: Phase) {
      phase.textContent = p.text;
      if (p.fraction === null) {
        bar.classList.add("busy");
        fill.style.width = "";
      } else {
        bar.classList.remove("busy");
        fill.style.width = Math.round(Math.max(0, Math.min(1, p.fraction)) * 100) + "%";
      }
    }

    function showNote(text: string) {
      noteText.textContent = text;
      note.classList.add("on");
    }

    function showError(msg: string) {
      errorBox.textContent = msg;
      errorBox.classList.add("on");
    }

    function setMode(next: typeof mode) {
      mode = next;
      const rec = next === "recording";
      el.classList.toggle("recording", rec);
      recordBtn.classList.toggle("primary", rec);
      recordBtn.innerHTML = (rec ? ICON_STOP : ICON_MIC) + (rec ? "Stop" : "Record");
      recordBtn.title = rec ? "Stop recording" : "Transcribe from the microphone as you speak";
      progress.classList.toggle("on", next !== "idle");
      cancelBtn.hidden = rec;
      level.style.setProperty("--level", "0");
      if (next === "idle") void renderEngines();
    }
    setMode("idle");

    /** Drop the Transcript and any message; the Source and its player stay. */
    function clearTranscript() {
      words = [];
      cues = [];
      heard = "";
      pending = "";
      reached = 0;
      lit = null;
      litAt = -1;
      cuesEl.replaceChildren();
      meta.textContent = "";
      errorBox.classList.remove("on");
      note.classList.remove("on");
    }

    function setSource(next: Source | null) {
      if (source) URL.revokeObjectURL(source.url);
      source = next;
      player.pause();
      if (next) player.src = next.url;
      else player.removeAttribute("src");
      result.classList.toggle("playable", !!next);
      status.textContent = next?.name ?? "";
    }

    /** Back to the empty state, as on first visit. */
    function emptyScreen() {
      setSource(null);
      clearTranscript();
      result.classList.remove("on");
      emptyHint.style.display = "block";
    }

    function cueElement(c: Cue): HTMLElement {
      const row = document.createElement("div");
      row.className = "cue";
      const t = document.createElement("button");
      t.type = "button";
      t.className = "t";
      t.textContent = clock(c.start);
      t.dataset.i = String(c.first);
      t.title = "Play from here";
      const p = document.createElement("p");
      c.words.forEach((w, j) => {
        if (j) p.append(" ");
        const s = document.createElement("span");
        s.className = w.probability < UNSURE ? "w unsure" : "w";
        s.dataset.i = String(c.first + j);
        s.textContent = w.word;
        if (w.probability < UNSURE) s.title = "Uncertain (" + Math.round(w.probability * 100) + "%)";
        p.append(s);
      });
      row.append(t, p);
      return row;
    }

    /**
     * Add Words to the Transcript and redraw from the last Cue on: Cues are
     * grouped left to right, so new Words can only change the last one.
     */
    function addWords(more: Word[]) {
      const follow = cuesEl.scrollHeight - cuesEl.scrollTop - cuesEl.clientHeight < 40;
      words = words.concat(more);
      const from = Math.max(0, cues.length - 1);
      cues = toCues(words);
      while (cuesEl.children.length > from) cuesEl.lastElementChild!.remove();
      const frag = document.createDocumentFragment();
      for (const c of cues.slice(from)) frag.append(cueElement(c));
      if (pending) {
        const tail = document.createElement("p");
        tail.className = "pending";
        tail.textContent = pending;
        frag.append(tail);
      }
      cuesEl.append(frag);
      result.classList.add("on");
      // Keep the newest words in view while they arrive, unless the reader has scrolled away.
      if (follow) cuesEl.scrollTop = cuesEl.scrollHeight;
    }

    function setMeta(extra = "") {
      const lang = heard ? languageName(heard) + (language ? "" : " (detected)") : "";
      const dur = source ? clock(source.pcm.length / ENGINE_RATE) : "";
      const count = words.length === 1 ? "1 word" : words.length + " words";
      meta.textContent = [lang, dur, count, extra].filter(Boolean).join(" · ");
    }

    /* ---- the engine ---- */

    /** The worker with the engine loaded, downloading what the cache lacks first. */
    async function engine(onPhase: (p: Phase) => void): Promise<SpeechWorker> {
      worker ??= new SpeechWorker();
      const w = worker;
      const assets = [ENGINES.needleJs, ENGINES.needleWasm, ENGINES.whistle];
      const seen = new Map<string, Progress>();
      const report = (p: Progress) => {
        seen.set(p.asset.id, p);
        const fetching = [...seen.values()].filter((x) => !x.fromCache);
        if (!fetching.length) return;
        const loaded = fetching.reduce((n, x) => n + x.loaded, 0);
        const total = fetching.reduce((n, x) => n + x.total, 0);
        onPhase({ text: `Downloading the engine (${formatBytes(loaded)} of ${formatBytes(total)})`, fraction: total ? loaded / total : null });
      };
      const [glue, wasm, model] = await Promise.all(assets.map((a) => getEngine(a, report)));
      onPhase({ text: "Starting the engine", fraction: null });
      try {
        await w.load(new TextDecoder().decode(glue), wasm!, model!);
      } catch (e) {
        // A worker that failed to load is no use to the next run either.
        if (worker === w) worker = null;
        w.terminate();
        throw e;
      }
      return w;
    }

    /** End whatever runs: the microphone, and the worker if it is busy for the run. A loaded, idle worker is kept. */
    function stopWork() {
      runId++;
      releaseMic?.();
      releaseMic = null;
      stopRecording = null;
      if (working && worker) {
        worker.terminate();
        worker = null;
      }
      working = false;
    }

    /** A worker that failed mid-run may be in any state; the next run starts from a fresh one. */
    function dropWorker() {
      worker?.terminate();
      worker = null;
      working = false;
    }

    /* ---- files ---- */

    /** Transcribe the Source, one Window at a time, showing the Words as they come. */
    async function transcribe() {
      if (!source) return;
      stopWork();
      const id = runId;
      const src = source;
      clearTranscript();
      result.classList.add("on");
      setMode("busy");
      setPhase({ text: "Loading the engine", fraction: null });
      const total = src.pcm.length / ENGINE_RATE;
      working = true;
      try {
        const w = await engine((p) => id === runId && setPhase(p));
        if (id !== runId) return;
        setPhase({ text: `Transcribing (0:00 of ${clock(total)})`, fraction: 0 });
        const res = await w.transcribe(src.pcm, language, keywordLines(keywords), (more, lang, at) => {
          if (id !== runId) return;
          reached = at;
          heard = lang;
          addWords(more);
          setMeta();
          setPhase({ text: `Transcribing (${clock(at)} of ${clock(total)})`, fraction: at / total });
        });
        if (id !== runId) return;
        heard = res.language;
        const speed = total / (res.ms / 1000);
        setMeta(speed >= 1 ? Math.round(speed) + "× real time" : "");
        if (!words.length) showNote(NO_SPEECH);
      } catch (e) {
        if (id !== runId) return;
        showError(message(e));
        dropWorker();
      } finally {
        if (id === runId) {
          working = false;
          setMode("idle");
        }
      }
    }

    async function openFile(file: File) {
      if (mode === "recording") {
        showNote("Stop the recording before opening a file.");
        return;
      }
      stopWork();
      const id = runId;
      setSource(null);
      clearTranscript();
      result.classList.remove("on");
      emptyHint.style.display = "none";
      status.textContent = file.name;
      setMode("busy");
      setPhase({ text: "Decoding audio", fraction: null });
      try {
        const pcm = await decodeFile(await file.arrayBuffer());
        if (id !== runId) return;
        setSource({ name: file.name, pcm, url: URL.createObjectURL(file), recording: false });
        await transcribe();
      } catch (e) {
        if (id !== runId) return;
        showError(message(e));
        setMode("idle");
      }
    }

    /* ---- recording ---- */

    async function record() {
      stopWork();
      const id = runId;
      setSource(null);
      clearTranscript();
      result.classList.remove("on");
      emptyHint.style.display = "none";
      // The phase line says it is recording; the status names the Source once there is one.
      status.textContent = "";
      setMode("recording");
      setPhase({ text: "Starting the microphone", fraction: null });
      working = true;

      const mic = new Microphone();
      const all: Float32Array[] = [];
      let recorded = 0;
      let queue: Float32Array[] = [];
      let queued = 0;
      let ready: SpeechWorker | null = null;
      /** The feeds in flight, in order; the Recording is finished after the last. */
      let chain: Promise<void> = Promise.resolve();
      let feeding = false;
      const owns = () => id === runId;

      const clockTimer = setInterval(() => tick(), 250);
      releaseMic = () => {
        mic.stop();
        clearInterval(clockTimer);
      };

      const fail = (e: unknown, fromWorker: boolean) => {
        if (!owns()) return;
        const hadWords = words.length > 0;
        // Ends the run; the worker only goes if it was the one that failed.
        if (!fromWorker) working = false;
        stopWork();
        if (fromWorker) dropWorker();
        setMode("idle");
        if (!hadWords && !all.length) emptyScreen();
        else if (all.length) {
          const pcm = concat(all);
          setSource({ name: "Microphone recording", pcm, url: URL.createObjectURL(encodeWav(pcm)), recording: true });
        }
        const msg = message(e);
        if (msg !== CANCELLED) showError(msg);
      };

      const take = (res: { words: Word[]; pending: string; language: string }) => {
        if (!owns()) return;
        pending = res.pending;
        if (res.language) heard = res.language;
        addWords(res.words);
        setMeta();
      };

      // A pass re-reads the audio buffered so far, so feeds are not stacked up:
      // while one runs, new audio waits and goes with the next.
      const pump = (force = false) => {
        if (!ready || feeding || !queued || (!force && queued < ENGINE_RATE)) return;
        const pcm = concat(queue);
        queue = [];
        queued = 0;
        feeding = true;
        const w = ready;
        chain = chain.then(() => w.feed(pcm, language, keywordLines(keywords))).then(take).finally(() => {
          feeding = false;
          if (owns() && mode === "recording") pump();
        });
        chain.catch((e) => fail(e, true));
      };

      function tick() {
        if (!owns() || mode !== "recording") return;
        const at = clock(recorded / ENGINE_RATE);
        if (ready) setPhase({ text: "Recording " + at, fraction: null });
      }

      const enginePromise = engine((p) => {
        if (owns() && mode === "recording") setPhase({ text: "Recording " + clock(recorded / ENGINE_RATE) + "; " + p.text[0]!.toLowerCase() + p.text.slice(1), fraction: p.fraction });
      });
      enginePromise.then((w) => {
        if (!owns()) return;
        ready = w;
        tick();
        pump();
      }, (e) => fail(e, true));

      stopRecording = () => {
        if (!owns()) return;
        stopRecording = null;
        releaseMic?.();
        releaseMic = null;
        setMode("busy");
        setPhase({ text: "Finishing", fraction: null });
        const pcm = concat(all);
        setSource({ name: "Microphone recording", pcm, url: URL.createObjectURL(encodeWav(pcm)), recording: true });
        void (async () => {
          try {
            const w = ready ?? (await enginePromise);
            if (!owns()) return;
            ready = w;
            await chain;
            pump(true);
            await chain;
            if (!owns()) return;
            const res = await w.finish();
            if (!owns()) return;
            pending = "";
            if (res.language) heard = res.language;
            addWords(res.words);
            result.classList.add("on");
            setMeta();
            if (!words.length) showNote(NO_SPEECH);
            working = false;
            setMode("idle");
          } catch (e) {
            fail(e, true);
          }
        })();
      };

      try {
        await mic.start((pcm, peak) => {
          if (!owns() || mode !== "recording") return;
          all.push(pcm);
          recorded += pcm.length;
          queue.push(pcm);
          queued += pcm.length;
          level.style.setProperty("--level", String(Math.min(1, Math.sqrt(peak))));
          pump();
        });
        if (owns()) setPhase({ text: ready ? "Recording 0:00" : "Recording 0:00; loading the engine", fraction: null });
      } catch (e) {
        mic.stop();
        fail(e, false);
      }
    }

    recordBtn.addEventListener("click", () => {
      if (mode === "recording") stopRecording?.();
      else void record();
    });

    cancelBtn.addEventListener("click", () => {
      if (mode !== "busy") return;
      const at = reached;
      const hadSource = !!source;
      stopWork();
      setMode("idle");
      if (!hadSource) return emptyScreen();
      // What was transcribed stays, and the Source with it: changing an option transcribes it again.
      if (source!.recording) showNote("Stopped before the recording was fully transcribed; the words so far are kept.");
      else showNote(`Stopped at ${clock(at)} of ${clock(source!.pcm.length / ENGINE_RATE)}; the words up to there are kept.`);
      result.classList.add("on");
      setMeta();
    });

    $(".clear-btn").addEventListener("click", () => {
      stopWork();
      setMode("idle");
      emptyScreen();
    });

    /* ---- player ---- */

    function seek(i: number) {
      const w = words[i];
      if (!w || !source || mode === "recording") return;
      player.currentTime = w.start;
      // Refused when another Source replaces this one first, or when the browser blocks playback: nothing to report.
      player.play().catch(() => {});
    }

    cuesEl.addEventListener("click", (e) => {
      // A click that ends a drag across the text is a selection, not a request to play.
      if (document.getSelection()?.toString()) return;
      const hit = (e.target as HTMLElement).closest<HTMLElement>(".t, .w");
      if (hit?.dataset.i) seek(Number(hit.dataset.i));
    });

    // The word being played is highlighted. Every frame while playing, since
    // timeupdate fires only about four times a second.
    function highlight() {
      const t = player.currentTime;
      // The last Word starting at or before t, if t is still within it or just after.
      let lo = 0;
      let hi = words.length - 1;
      let at = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (words[mid]!.start <= t) {
          at = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      if (at >= 0 && t > words[at]!.end + 0.3) at = -1;
      if (at !== litAt) {
        lit?.classList.remove("now");
        lit = at >= 0 ? cuesEl.querySelector<HTMLElement>(`.w[data-i="${at}"]`) : null;
        lit?.classList.add("now");
        litAt = at;
        if (lit && !player.paused) lit.scrollIntoView({ block: "nearest" });
      }
      if (!player.paused) frame = requestAnimationFrame(highlight);
    }
    player.addEventListener("play", () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(highlight);
    });
    player.addEventListener("seeked", highlight);

    /* ---- output ---- */

    function outputName(ext: string) {
      if (source && !source.recording) return baseName(source.name) + "." + ext;
      const d = new Date();
      const p = (n: number) => String(n).padStart(2, "0");
      return `recording-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.${ext}`;
    }

    const copyBtn = $<HTMLButtonElement>(".copy-btn");
    copyBtn.addEventListener("click", async () => {
      if (!words.length) return;
      const text = toText(words);
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // file:// is not a secure context everywhere; the old way still works there.
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
      flash(copyBtn, "Copied");
    });

    for (const btn of el.querySelectorAll<HTMLButtonElement>(".dl")) {
      btn.addEventListener("click", () => {
        if (!words.length) return;
        const format = btn.dataset.format!;
        if (format === "txt") download(toText(words), outputName("txt"), "text/plain");
        else if (format === "srt") download(toSrt(cues), outputName("srt"), "application/x-subrip");
        else if (format === "vtt") download(toVtt(cues), outputName("vtt"), "text/vtt");
        else download(toJson({ language: heard, duration: source ? source.pcm.length / ENGINE_RATE : 0, words }), outputName("json"), "application/json");
      });
    }

    /* ---- input ---- */

    $(".choose-btn").addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      if (file) void openFile(file);
      fileInput.value = "";
    });

    // Drop a file anywhere on the tool
    let dragDepth = 0;
    el.addEventListener("dragenter", (e) => {
      e.preventDefault();
      dragDepth++;
      el.classList.add("dragging");
    });
    el.addEventListener("dragover", (e) => e.preventDefault());
    el.addEventListener("dragleave", () => {
      if (--dragDepth <= 0) {
        dragDepth = 0;
        el.classList.remove("dragging");
      }
    });
    el.addEventListener("drop", (e) => {
      e.preventDefault();
      dragDepth = 0;
      el.classList.remove("dragging");
      const files = e.dataTransfer?.files;
      const file = files?.[0];
      if (!file) return;
      const others = (files?.length ?? 1) - 1;
      void openFile(file).then(() => {
        if (others && source?.name === file.name && mode === "idle") showNote("One file at a time: transcribed " + file.name + ", the other " + others + " ignored.");
      });
    });
  },
};

export default tool;
