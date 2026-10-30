// What an Operation's panel can do: the Tool hands every panel one of these.
// A panel works on the Current Document (the Page List as one PDF), shows a
// Result in the Viewer, applies it (the Result becomes the Workspace), and
// draws on pages through the Viewer's overlay.

import type { OpName, OpOptions, OpReport } from "../ops";
import type { OutFile } from "../pdf/doc";
import type { Point } from "../pdf/geometry";
import type { PageSize, RunResult } from "../worker";
import type { PdfWorker } from "../worker-client";
import type { Field, Values } from "./form";
import type { DrawTool, Gesture, Mark } from "./viewer";

/** One page of the Page List: a page of a Source, turned. */
export interface PageEntry {
  key: string;
  /** The Source's key (not the worker's id, which changes when the worker restarts). */
  src: string;
  index: number;
  rotate: number;
}

export interface SourceInfo {
  key: string;
  name: string;
  pages: PageSize[];
}

/** The Current Document: what every Operation runs on. */
export interface Current {
  id: string;
  pages: PageSize[];
  size: number;
}

export type Ran<K extends OpName> = Omit<RunResult, "report"> & {
  report: OpReport<K>;
};

export interface Api {
  /** Where the panel puts its controls, and its buttons. */
  body: HTMLElement;
  foot: HTMLElement;
  worker: () => Promise<PdfWorker>;
  current: () => Promise<Current>;
  /** Pages in the Page List. */
  pageCount: () => number;
  /** Display sizes of the Page List's pages, turned. */
  sizes: () => PageSize[];
  /** The name outputs are named after: the first file's, without extension. */
  name: () => string;
  /**
   * Run an Operation on the Current Document. `quiet` runs show their
   * progress in the panel, not the Tool's progress bar, and do not cancel
   * other work. Resolves to null when it failed (the error is shown),
   * was cancelled, or was superseded by a newer run of the same panel.
   */
  run: <K extends OpName>(
    op: K,
    options: OpOptions<K>,
    what: string,
    opts?: { quiet?: boolean }
  ) => Promise<Ran<K> | null>;
  /** Show a Result in the Viewer (null to go back to the Workspace). */
  showResult: (r: RunResult | null) => void;
  /** Make a Result the Workspace, as one undoable step: one this panel's run made of the Page List as it is. */
  apply: (r: RunResult, label: string) => void;
  download: (blob: Blob, name: string) => void;
  /** One file as it is, several as a zip named `zipName`. */
  downloadFiles: (files: OutFile[], zipName: string) => Promise<void>;
  note: (text: string) => void;
  error: (text: string) => void;
  clearMessages: () => void;
  /** Long work outside the worker (OCR): shows the shared progress, and Cancel stops it; no text ends it. */
  progress: (text: string, fraction: number | null) => void;
  setTool: (tool: DrawTool | null, onGesture?: (g: Gesture) => void) => void;
  /** Put the panel's tools in a row above the pages (null to take them away); they go when the panel closes. */
  toolbar: (row: HTMLElement | null) => void;
  /** Let the user type on a page from `at`: resolves with what they typed, "" for nothing. */
  write: (
    page: number,
    at: Point,
    style: { color: string; size: number; opacity: number }
  ) => Promise<string>;
  /** Let the user write a note whose icon is at `at`, starting from `text`: resolves with what it says. */
  writeNote: (
    page: number,
    at: Point,
    style: { color: string; text: string }
  ) => Promise<string>;
  setMarks: (fn: ((page: number) => Mark[]) | null) => void;
  /**
   * Take files dropped on a page in the Pages view (null to stop): `take`
   * answers whether it took them; if not, they open as any drop does.
   */
  onDrop: (
    take: ((page: number, at: Point, files: File[]) => boolean) | null
  ) => void;
  redrawMarks: (page?: number) => void;
  view: (mode: "grid" | "pages") => void;
  goTo: (page: number, y?: number) => void;
  currentPage: () => number;
  pages: () => PageEntry[];
  setPages: (pages: PageEntry[], label: string) => void;
  /** Keys of the selected pages, in Page List order. */
  selection: () => string[];
  select: (keys: string[]) => void;
  sources: () => SourceInfo[];
  /** A blank page's Source of this size, made once per size. */
  blank: (w: number, h: number) => Promise<string>;
  /** The panel's values changed: the Deep Link follows. */
  persist: () => void;
  /** Switch to another panel, handing it values (the Redact panel takes marks this way). */
  open: (panel: string, handoff?: unknown) => void;
  newKey: () => string;
  /** Open more files into the Workspace, as the Add files button does. */
  addFiles: (files: File[]) => void;
  /** Run `hook` whenever the Page List changes, until the panel closes. */
  onPagesChanged: (hook: () => void) => void;
  /** Run `hook` when the user presses Cancel; returns the way to stop listening. */
  onCancel: (hook: () => void) => () => void;
  /** Put `view` where the pages are shown (Compare's view), or the pages back with null. */
  takeOver: (view: HTMLElement | null) => void;
}

export interface PanelInstance {
  destroy?: () => void;
  /** The Page List changed under the panel. */
  docChanged?: () => void;
  selectionChanged?: () => void;
}

export interface PanelDef {
  id: string;
  name: string;
  group: string;
  summary: string;
  /** Fields whose values the Deep Link carries, with their defaults. */
  fields?: Field[];
  defaults?: Values;
  mount: (api: Api, values: Values, handoff?: unknown) => PanelInstance;
}
