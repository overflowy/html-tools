// The Terminal: xterm.js with a line editor on top. Program output goes in
// raw; the REPL prompt and a program's input() are lines edited here, with
// history, cursor movement, and tab completion for the REPL, and handed to
// the owner when Enter is pressed. Modes: `off` (no line: a program is
// running, or nothing is booted), `repl` (a prompt), `input` (a program
// waits for a line, on whatever column its own prompt left the cursor).

import type { Terminal as XTerm } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { TerminalApi } from "./engines";

export type TerminalMode = "off" | "repl" | "input";

export interface TerminalHandlers {
  /** A line was entered (without its newline), or null for end of input (Ctrl+D on an empty line). */
  onLine(line: string | null, mode: "repl" | "input"): void;
  /** Ctrl+C. In `repl` the line is cancelled here first; the owner stops a running program. */
  onInterrupt(): void;
  onComplete(source: string): Promise<{ completions: string[]; start: number }>;
  onResize(cols: number, rows: number): void;
}

const RED = "\x1b[38;2;247;193;193m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

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
  private decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  private resizeObserver: ResizeObserver;

  constructor(api: TerminalApi, container: HTMLElement, private handlers: TerminalHandlers) {
    const style = getComputedStyle(document.documentElement);
    const v = (name: string) => style.getPropertyValue(name).trim();
    this.term = new api.Terminal({
      convertEol: true,
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: v("--mono") || "monospace",
      fontSize: 12.5,
      lineHeight: 1.3,
      scrollback: 5000,
      allowProposedApi: true,
      theme: {
        background: v("--bg") || "#1a1a1a",
        foreground: v("--text") || "#f5f4ee",
        cursor: v("--accent") || "#c96442",
        cursorAccent: v("--bg") || "#1a1a1a",
        selectionBackground: "rgba(201, 100, 66, 0.35)",
        black: "#1a1a1a",
        red: "#f28b82",
        green: "#9fbf7f",
        yellow: "#e3c17a",
        blue: "#8ab4f8",
        magenta: "#d7a3e8",
        cyan: "#7fd1d1",
        white: "#f5f4ee",
        brightBlack: "#6b6b66",
        brightRed: "#f7c1c1",
        brightGreen: "#b8d99c",
        brightYellow: "#f0d69a",
        brightBlue: "#aecbfa",
        brightMagenta: "#e8c4f2",
        brightCyan: "#a3e3e3",
        brightWhite: "#ffffff",
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
      if (this.term.element?.offsetParent) this.fit.fit();
    } catch {
      // not laid out yet
    }
  }

  focus() {
    this.term.focus();
  }

  clear() {
    this.term.clear();
  }

  reset() {
    this.term.reset();
    this.decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  }

  dispose() {
    this.resizeObserver.disconnect();
    this.term.dispose();
  }

  /* ---------------- output ---------------- */

  /** A chunk of a program's output, UTF-8 that may end mid-character. */
  output(stream: "stdout" | "stderr", bytes: Uint8Array) {
    const text = this.decoders[stream].decode(bytes, { stream: true });
    if (!text) return;
    this.term.write(stream === "stderr" ? RED + text + RESET : text);
  }

  /** Text from the Tool itself, written as is (use \n). */
  write(text: string) {
    this.term.write(text);
  }

  /** Moves to a fresh row when the cursor is mid-line (an abandoned prompt, unfinished output). */
  newLine() {
    if (this.term.buffer.active.cursorX !== 0) this.term.write("\r\n");
  }

  writeError(text: string) {
    this.term.write(RED + text + RESET);
  }

  writeDim(text: string) {
    this.term.write(DIM + text + RESET);
  }

  /** Flushes any partial character left in the decoders, at the end of a run. */
  flush() {
    for (const s of ["stdout", "stderr"] as const) {
      const rest = this.decoders[s].decode();
      if (rest) this.term.write(s === "stderr" ? RED + rest + RESET : rest);
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
      if ((this.mode as TerminalMode) !== mode) return;
      if (mode === "repl") {
        if (this.term.buffer.active.cursorX !== 0) this.term.write("\r\n");
        this.startCol = 0;
        this.term.write(this.prompt);
      } else {
        this.startCol = this.term.buffer.active.cursorX;
      }
      if (initial) this.insert(initial);
      if (this.queued.length) {
        const next = this.queued.shift()!;
        this.buffer = next;
        this.cursor = next.length;
        this.redraw();
        this.submit();
      } else if (this.tail) {
        const tail = this.tail;
        this.tail = "";
        this.insert(tail);
      }
      while (this.typeahead.length && this.mode !== "off") this.onData(this.typeahead.shift()!);
    });
  }

  /** The last line entered, for a continuation prompt to copy its indentation. */
  get lastLine(): string {
    return this.history[this.history.length - 1] ?? "";
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
    if (this.cursorRow > 0) out += `\x1b[${this.cursorRow}A`;
    out += "\r";
    if (start > 0) out += `\x1b[${start}C`;
    out += "\x1b[J" + this.buffer;
    // A line ending exactly on the right edge leaves the cursor pending on
    // that edge; a space then return forces the wrap so rows are countable.
    if (total > 0 && total % cols === 0) out += " \r";
    const endRow = Math.floor(total / cols);
    const endCol = total % cols;
    const idx = start + this.cursor;
    const row = Math.floor(idx / cols);
    const col = idx % cols;
    if (endRow > row) out += `\x1b[${endRow - row}A`;
    if (col !== endCol || endRow > row) {
      out += "\r";
      if (col > 0) out += `\x1b[${col}C`;
    }
    this.term.write(out);
    this.cursorRow = row;
  }

  private moveCursor(to: number) {
    this.cursor = Math.max(0, Math.min(this.buffer.length, to));
    this.redraw();
  }

  private insert(text: string) {
    this.buffer = this.buffer.slice(0, this.cursor) + text + this.buffer.slice(this.cursor);
    this.cursor += text.length;
    this.redraw();
  }

  private submit() {
    const mode = this.mode;
    if (mode === "off") return;
    const line = this.buffer;
    this.moveCursor(this.buffer.length);
    this.term.write("\r\n");
    this.mode = "off";
    if (mode === "repl" && line.trim()) {
      if (this.history[this.history.length - 1] !== line) this.history.push(line);
      if (this.history.length > 500) this.history.shift();
    }
    this.handlers.onLine(line, mode);
  }

  private onData(data: string) {
    if (this.mode === "off") {
      if (data === "\x03") {
        this.typeahead = [];
        this.handlers.onInterrupt();
      } else if (this.typeahead.length < 200) this.typeahead.push(data);
      return;
    }
    if (data.length > 1 && !data.startsWith("\x1b")) {
      // A paste. Each newline enters a line; whatever follows the last one is left typed.
      const lines = data.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
      this.insert(lines[0]!);
      if (lines.length > 1) {
        this.queued.push(...lines.slice(1, -1));
        this.tail = lines[lines.length - 1]!;
        this.submit();
      }
      return;
    }
    switch (data) {
      case "\r":
        this.submit();
        return;
      case "\x7f":
        if (this.cursor > 0) {
          this.buffer = this.buffer.slice(0, this.cursor - 1) + this.buffer.slice(this.cursor);
          this.cursor--;
          this.redraw();
        }
        return;
      case "\x1b[3~":
        if (this.cursor < this.buffer.length) {
          this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(this.cursor + 1);
          this.redraw();
        }
        return;
      case "\x1b[D":
        this.moveCursor(this.cursor - 1);
        return;
      case "\x1b[C":
        this.moveCursor(this.cursor + 1);
        return;
      case "\x1b[1;5D":
      case "\x1bb":
        this.moveCursor(this.wordLeft());
        return;
      case "\x1b[1;5C":
      case "\x1bf":
        this.moveCursor(this.wordRight());
        return;
      case "\x1b[H":
      case "\x1b[1~":
      case "\x01":
        this.moveCursor(0);
        return;
      case "\x1b[F":
      case "\x1b[4~":
      case "\x05":
        this.moveCursor(this.buffer.length);
        return;
      case "\x1b[A":
        this.historyStep(-1);
        return;
      case "\x1b[B":
        this.historyStep(1);
        return;
      case "\x15":
        this.buffer = this.buffer.slice(this.cursor);
        this.cursor = 0;
        this.redraw();
        return;
      case "\x0b":
        this.buffer = this.buffer.slice(0, this.cursor);
        this.redraw();
        return;
      case "\x17": {
        const from = this.wordLeft();
        this.buffer = this.buffer.slice(0, from) + this.buffer.slice(this.cursor);
        this.cursor = from;
        this.redraw();
        return;
      }
      case "\x0c":
        this.term.clear();
        this.cursorRow = 0;
        this.redraw();
        return;
      case "\x03":
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
        return;
      case "\x04":
        if (this.buffer.length === 0) {
          if (this.mode === "input") {
            this.mode = "off";
            this.term.write("\r\n");
            this.handlers.onLine(null, "input");
          }
        } else if (this.cursor < this.buffer.length) {
          this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(this.cursor + 1);
          this.redraw();
        }
        return;
      case "\t":
        if (this.mode === "repl") void this.complete();
        else this.insert("\t");
        return;
      default:
        if (data.startsWith("\x1b") || (data.length === 1 && data.charCodeAt(0) < 32)) return;
        this.insert(data);
    }
  }

  private wordLeft(): number {
    let i = this.cursor;
    while (i > 0 && /\s/.test(this.buffer[i - 1]!)) i--;
    while (i > 0 && !/[\s.(),[\]{}]/.test(this.buffer[i - 1]!)) i--;
    return i;
  }

  private wordRight(): number {
    let i = this.cursor;
    const n = this.buffer.length;
    while (i < n && /[\s.(),[\]{}]/.test(this.buffer[i]!)) i++;
    while (i < n && !/[\s.(),[\]{}]/.test(this.buffer[i]!)) i++;
    return i;
  }

  private historyStep(delta: number) {
    if (this.mode !== "repl" || this.history.length === 0) return;
    if (this.historyIndex === this.history.length) this.draft = this.buffer;
    const next = Math.max(0, Math.min(this.history.length, this.historyIndex + delta));
    if (next === this.historyIndex) return;
    this.historyIndex = next;
    this.buffer = next === this.history.length ? this.draft : this.history[next]!;
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
    if (this.mode !== "repl") return;
    const { completions, start } = result;
    if (completions.length === 0) return;
    const word = head.slice(start);
    let common = completions[0]!;
    for (const c of completions) {
      let i = 0;
      while (i < common.length && i < c.length && common[i] === c[i]) i++;
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
      completions.slice(0, 200).forEach((c, i) => {
        text += c.padEnd(width);
        if ((i + 1) % perRow === 0) text += "\r\n";
      });
      if (!text.endsWith("\r\n")) text += "\r\n";
      if (completions.length > 200) text += `... ${completions.length - 200} more\r\n`;
      this.term.write(text + this.prompt);
      this.startCol = 0;
      this.cursorRow = 0;
      this.redraw();
    }
  }
}
