// The Terminal: xterm.js with a line editor on top. Program output goes in
// raw; the REPL prompt and a program's input() are lines edited here, with
// history, cursor movement, and tab completion for the REPL, and handed to
// the owner when Enter is pressed. Modes: `off` (no line: a program is
// running, or nothing is booted), `repl` (a prompt), `input` (a program
// waits for a line, on whatever column its own prompt left the cursor).

import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal as XTerm } from "@xterm/xterm";

import type { TerminalApi } from "./engines";

export type TerminalMode = "off" | "repl" | "input";

export interface TerminalHandlers {
  /** A line was entered (without its newline), or null for end of input (Ctrl+D on an empty line). */
  onLine: (line: string | null, mode: "repl" | "input") => void;
  /** Ctrl+C. In `repl` the line is cancelled here first; the owner stops a running program. */
  onInterrupt: () => void;
  onComplete: (
    source: string
  ) => Promise<{ completions: string[]; start: number }>;
  onResize: (cols: number, rows: number) => void;
}

const RED = "\u001B[38;2;247;193;193m";
const DIM = "\u001B[2m";
const RESET = "\u001B[0m";

export class IdeTerminal {
  readonly term: XTerm;
  private fit: FitAddon;
  mode: TerminalMode = "off";
  private prompt = "";
  private startCol = 0;
  private buffer = "";
  private cursor = 0;
  private cursorRow = 0;
  private history: string[] = [];
  private historyIndex = 0;
  private draft = "";
  /** Pasted lines still to be entered, and the unfinished text after the paste's last newline. */
  private queued: string[] = [];
  private tail = "";
  /** Keys pressed while no line was being read, kept for the next one, as a terminal's typeahead. */
  private typeahead: string[] = [];
  private decoders = { stderr: new TextDecoder(), stdout: new TextDecoder() };
  private resizeObserver: ResizeObserver;
  private handlers: TerminalHandlers;
  /** What each editing key does; any other key types itself, control keys excepted. */
  private readonly bindings = this.keyBindings();

  constructor(
    api: TerminalApi,
    container: HTMLElement,
    handlers: TerminalHandlers
  ) {
    this.handlers = handlers;
    const style = getComputedStyle(document.documentElement);
    const v = (name: string) => style.getPropertyValue(name).trim();
    this.term = new api.Terminal({
      allowProposedApi: true,
      convertEol: true,
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: v("--mono") || "monospace",
      fontSize: 12.5,
      lineHeight: 1.3,
      scrollback: 5000,
      theme: {
        background: v("--bg") || "#1a1a1a",
        black: "#1a1a1a",
        blue: "#8ab4f8",
        brightBlack: "#6b6b66",
        brightBlue: "#aecbfa",
        brightCyan: "#a3e3e3",
        brightGreen: "#b8d99c",
        brightMagenta: "#e8c4f2",
        brightRed: "#f7c1c1",
        brightWhite: "#ffffff",
        brightYellow: "#f0d69a",
        cursor: v("--accent") || "#c96442",
        cursorAccent: v("--bg") || "#1a1a1a",
        cyan: "#7fd1d1",
        foreground: v("--text") || "#f5f4ee",
        green: "#9fbf7f",
        magenta: "#d7a3e8",
        red: "#f28b82",
        selectionBackground: "rgba(201, 100, 66, 0.35)",
        white: "#f5f4ee",
        yellow: "#e3c17a",
      },
    });
    this.fit = new api.FitAddon();
    this.term.loadAddon(this.fit);
    this.term.open(container);
    this.term.onData((data) => this.onData(data));
    this.term.onResize(({ cols, rows }) => this.handlers.onResize(cols, rows));
    this.resizeObserver = new ResizeObserver(() => this.layout());
    this.resizeObserver.observe(container);
    this.layout();
  }

  layout() {
    try {
      if (this.term.element?.offsetParent) {
        this.fit.fit();
      }
    } catch {
      // not laid out yet
    }
  }

  focus() {
    this.term.focus();
  }

  /** Empties the scrollback; the line being edited, if any, stays as the top row. */
  clearScreen() {
    this.term.clear();
    this.cursorRow = 0;
    if (this.mode !== "off") {
      this.redraw();
    }
  }

  reset() {
    this.term.reset();
    this.decoders = { stderr: new TextDecoder(), stdout: new TextDecoder() };
  }

  dispose() {
    this.resizeObserver.disconnect();
    this.term.dispose();
  }

  /* ---------------- output ---------------- */

  /** A chunk of a program's output, UTF-8 that may end mid-character. */
  output(stream: "stdout" | "stderr", bytes: Uint8Array) {
    const text = this.decoders[stream].decode(bytes, { stream: true });
    if (!text) {
      return;
    }
    this.term.write(stream === "stderr" ? RED + text + RESET : text);
  }

  /** Text from the Tool itself, written as is (use \n). */
  write(text: string) {
    this.term.write(text);
  }

  /** Moves to a fresh row when the cursor is mid-line (an abandoned prompt, unfinished output). */
  newLine() {
    if (this.term.buffer.active.cursorX !== 0) {
      this.term.write("\r\n");
    }
  }

  writeError(text: string) {
    this.term.write(RED + text + RESET);
  }

  writeDim(text: string) {
    this.term.write(DIM + text + RESET);
  }

  /** Everything on screen and in the scrollback, trailing blank lines dropped. */
  text(): string {
    const buffer = this.term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i += 1) {
      lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
    }
    while (lines.length && lines.at(-1) === "") {
      lines.pop();
    }
    return lines.join("\n");
  }

  /**
   * Whether there is anything to copy: a line of text other than the REPL's
   * own empty prompt. Reads from the top and stops at the first, so it costs
   * next to nothing however long the scrollback.
   */
  hasOutput(): boolean {
    const buffer = this.term.buffer.active;
    const promptRow =
      this.mode === "repl" && !this.buffer ? buffer.baseY + buffer.cursorY : -1;
    for (let i = 0; i < buffer.length; i += 1) {
      if (
        i !== promptRow &&
        buffer.getLine(i)?.translateToString(true).trim()
      ) {
        return true;
      }
    }
    return false;
  }

  /** Flushes any partial character left in the decoders, at the end of a run. */
  flush() {
    for (const s of ["stdout", "stderr"] as const) {
      const rest = this.decoders[s].decode();
      if (rest) {
        this.term.write(s === "stderr" ? RED + rest + RESET : rest);
      }
      this.decoders[s] = new TextDecoder();
    }
  }

  /* ---------------- line editing ---------------- */

  /**
   * Starts editing a line. `repl` shows `prompt` on a fresh row; `input`
   * continues on whatever column the program's own prompt left the cursor.
   * `initial` is text already on the line (a continuation's indentation).
   */
  readLine(mode: "repl" | "input", prompt = "", initial = "") {
    this.mode = mode;
    this.prompt = mode === "repl" ? prompt : "";
    this.buffer = "";
    this.cursor = 0;
    this.cursorRow = 0;
    this.historyIndex = this.history.length;
    this.draft = "";
    // xterm parses writes asynchronously: the cursor is only where the
    // program's output left it once everything written so far is in.
    this.term.write("", () => {
      if ((this.mode as TerminalMode) !== mode) {
        return;
      }
      if (mode === "repl") {
        if (this.term.buffer.active.cursorX !== 0) {
          this.term.write("\r\n");
        }
        this.startCol = 0;
        this.term.write(this.prompt);
      } else {
        this.startCol = this.term.buffer.active.cursorX;
      }
      if (initial) {
        this.insert(initial);
      }
      const next = this.queued.shift();
      if (next !== undefined) {
        this.buffer = next;
        this.cursor = next.length;
        this.redraw();
        this.submit();
      } else if (this.tail) {
        const { tail } = this;
        this.tail = "";
        this.insert(tail);
      }
      for (
        let key = this.nextTypeahead();
        key !== undefined;
        key = this.nextTypeahead()
      ) {
        this.onData(key);
      }
    });
  }

  /** The next key typed ahead, while a line is being read. */
  private nextTypeahead(): string | undefined {
    return this.mode === "off" ? undefined : this.typeahead.shift();
  }

  /** The last line entered, for a continuation prompt to copy its indentation. */
  get lastLine(): string {
    return this.history.at(-1) ?? "";
  }

  /** Stops editing: the line in progress is abandoned. */
  stopLine() {
    this.mode = "off";
    this.queued = [];
    this.tail = "";
    this.typeahead = [];
  }

  private lineStart(): number {
    return this.startCol + this.prompt.length;
  }

  private redraw() {
    const cols = Math.max(1, this.term.cols);
    const start = this.lineStart();
    const total = start + this.buffer.length;
    let out = "";
    if (this.cursorRow > 0) {
      out += `\u001B[${this.cursorRow}A`;
    }
    out += "\r";
    if (start > 0) {
      out += `\u001B[${start}C`;
    }
    out += `\u001B[J${this.buffer}`;
    // A line ending exactly on the right edge leaves the cursor pending on
    // that edge; a space then return forces the wrap so rows are countable.
    if (total > 0 && total % cols === 0) {
      out += " \r";
    }
    const endRow = Math.floor(total / cols);
    const endCol = total % cols;
    const idx = start + this.cursor;
    const row = Math.floor(idx / cols);
    const col = idx % cols;
    if (endRow > row) {
      out += `\u001B[${endRow - row}A`;
    }
    if (col !== endCol || endRow > row) {
      out += "\r";
      if (col > 0) {
        out += `\u001B[${col}C`;
      }
    }
    this.term.write(out);
    this.cursorRow = row;
  }

  private moveCursor(to: number) {
    this.cursor = Math.max(0, Math.min(this.buffer.length, to));
    this.redraw();
  }

  private insert(text: string) {
    this.buffer =
      this.buffer.slice(0, this.cursor) + text + this.buffer.slice(this.cursor);
    this.cursor += text.length;
    this.redraw();
  }

  private submit() {
    const { mode } = this;
    if (mode === "off") {
      return;
    }
    const line = this.buffer;
    this.moveCursor(this.buffer.length);
    this.term.write("\r\n");
    this.mode = "off";
    if (mode === "repl" && line.trim()) {
      if (this.history.at(-1) !== line) {
        this.history.push(line);
      }
      if (this.history.length > 500) {
        this.history.shift();
      }
    }
    this.handlers.onLine(line, mode);
  }

  private onData(data: string) {
    if (this.mode === "off") {
      this.whileOff(data);
      return;
    }
    if (data.length > 1 && !data.startsWith("\u001B")) {
      this.paste(data);
      return;
    }
    const action = this.bindings.get(data);
    if (action) {
      action();
      return;
    }
    if (data.startsWith("\u001B") || (data.length === 1 && data < " ")) {
      return;
    }
    this.insert(data);
  }

  /** A key while no line is being read: Ctrl+C interrupts, anything else is typeahead. */
  private whileOff(data: string) {
    if (data === "\u0003") {
      this.typeahead = [];
      this.handlers.onInterrupt();
    } else if (this.typeahead.length < 200) {
      this.typeahead.push(data);
    }
  }

  /** A paste. Each newline enters a line; whatever follows the last one is left typed. */
  private paste(data: string) {
    const [first = "", ...rest] = data
      .replaceAll("\r\n", "\n")
      .replaceAll("\r", "\n")
      .split("\n");
    this.insert(first);
    const tail = rest.pop();
    if (tail !== undefined) {
      this.queued.push(...rest);
      this.tail = tail;
      this.submit();
    }
  }

  private keyBindings(): Map<string, () => void> {
    const toStart = () => this.moveCursor(0);
    const toEnd = () => this.moveCursor(this.buffer.length);
    const wordBack = () => this.moveCursor(this.wordLeft());
    const wordForward = () => this.moveCursor(this.wordRight());
    return new Map<string, () => void>([
      ["\r", () => this.submit()],
      ["\u007F", () => this.deleteBack()],
      ["\u001B[3~", () => this.deleteForward()],
      ["\u001B[D", () => this.moveCursor(this.cursor - 1)],
      ["\u001B[C", () => this.moveCursor(this.cursor + 1)],
      ["\u001B[1;5D", wordBack],
      ["\u001Bb", wordBack],
      ["\u001B[1;5C", wordForward],
      ["\u001Bf", wordForward],
      ["\u001B[H", toStart],
      ["\u001B[1~", toStart],
      ["\u0001", toStart],
      ["\u001B[F", toEnd],
      ["\u001B[4~", toEnd],
      ["\u0005", toEnd],
      ["\u001B[A", () => this.historyStep(-1)],
      ["\u001B[B", () => this.historyStep(1)],
      ["\u0015", () => this.killToStart()],
      ["\u000B", () => this.killToEnd()],
      ["\u0017", () => this.killWordBack()],
      ["\u000C", () => this.clearScreen()],
      ["\u0003", () => this.interrupt()],
      ["\u0004", () => this.endOfInput()],
      ["\t", () => this.tab()],
    ]);
  }

  private deleteBack() {
    if (this.cursor > 0) {
      this.buffer =
        this.buffer.slice(0, this.cursor - 1) + this.buffer.slice(this.cursor);
      this.cursor -= 1;
      this.redraw();
    }
  }

  private deleteForward() {
    if (this.cursor < this.buffer.length) {
      this.buffer =
        this.buffer.slice(0, this.cursor) + this.buffer.slice(this.cursor + 1);
      this.redraw();
    }
  }

  private killToStart() {
    this.buffer = this.buffer.slice(this.cursor);
    this.cursor = 0;
    this.redraw();
  }

  private killToEnd() {
    this.buffer = this.buffer.slice(0, this.cursor);
    this.redraw();
  }

  private killWordBack() {
    const from = this.wordLeft();
    this.buffer = this.buffer.slice(0, from) + this.buffer.slice(this.cursor);
    this.cursor = from;
    this.redraw();
  }

  /** Ctrl+C: the REPL's line is cancelled here; a program's input() is the owner's to stop. */
  private interrupt() {
    if (this.mode === "repl") {
      this.moveCursor(this.buffer.length);
      this.term.write("^C\r\n");
      this.buffer = "";
      this.cursor = 0;
      this.queued = [];
      this.tail = "";
      this.mode = "off";
      this.handlers.onLine(null, "repl");
    } else {
      this.handlers.onInterrupt();
    }
  }

  /** Ctrl+D: end of input on an empty line of input(), else delete forward. */
  private endOfInput() {
    if (this.buffer.length === 0) {
      if (this.mode === "input") {
        this.mode = "off";
        this.term.write("\r\n");
        this.handlers.onLine(null, "input");
      }
    } else {
      this.deleteForward();
    }
  }

  private tab() {
    if (this.mode === "repl") {
      void this.complete();
    } else {
      this.insert("\t");
    }
  }

  private wordLeft(): number {
    let i = this.cursor;
    while (i > 0 && /\s/u.test(this.buffer.charAt(i - 1))) {
      i -= 1;
    }
    while (i > 0 && !/[\s.(),[\]{}]/u.test(this.buffer.charAt(i - 1))) {
      i -= 1;
    }
    return i;
  }

  private wordRight(): number {
    let i = this.cursor;
    const n = this.buffer.length;
    while (i < n && /[\s.(),[\]{}]/u.test(this.buffer.charAt(i))) {
      i += 1;
    }
    while (i < n && !/[\s.(),[\]{}]/u.test(this.buffer.charAt(i))) {
      i += 1;
    }
    return i;
  }

  private historyStep(delta: number) {
    if (this.mode !== "repl" || this.history.length === 0) {
      return;
    }
    if (this.historyIndex === this.history.length) {
      this.draft = this.buffer;
    }
    const next = Math.max(
      0,
      Math.min(this.history.length, this.historyIndex + delta)
    );
    if (next === this.historyIndex) {
      return;
    }
    this.historyIndex = next;
    // One step past the last entry is the line being typed before.
    this.buffer = this.history[next] ?? this.draft;
    this.cursor = this.buffer.length;
    this.redraw();
  }

  private async complete() {
    const head = this.buffer.slice(0, this.cursor);
    if (!head.trim()) {
      this.insert("    ");
      return;
    }
    let result: { completions: string[]; start: number };
    try {
      result = await this.handlers.onComplete(head);
    } catch {
      return;
    }
    if (this.mode !== "repl") {
      return;
    }
    const { completions, start } = result;
    const [first] = completions;
    if (first === undefined) {
      return;
    }
    const word = head.slice(start);
    let common = first;
    for (const c of completions) {
      let i = 0;
      while (i < common.length && i < c.length && common[i] === c[i]) {
        i += 1;
      }
      common = common.slice(0, i);
    }
    if (common.length > word.length) {
      this.insert(common.slice(word.length));
      return;
    }
    if (completions.length > 1) {
      // Nothing more to add: list the candidates under the line, then redraw it.
      this.moveCursor(this.buffer.length);
      const cols = Math.max(1, this.term.cols);
      const width = Math.max(...completions.map((c) => c.length)) + 2;
      const perRow = Math.max(1, Math.floor(cols / width));
      let text = "\r\n";
      for (const [i, c] of completions.slice(0, 200).entries()) {
        text += c.padEnd(width);
        if ((i + 1) % perRow === 0) {
          text += "\r\n";
        }
      }
      if (!text.endsWith("\r\n")) {
        text += "\r\n";
      }
      if (completions.length > 200) {
        text += `... ${completions.length - 200} more\r\n`;
      }
      this.term.write(text + this.prompt);
      this.startCol = 0;
      this.cursorRow = 0;
      this.redraw();
    }
  }
}
