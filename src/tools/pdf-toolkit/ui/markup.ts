// The PDF Toolkit's markup, and its elements by name.

import ICON_INFO from "lucide-static/icons/info.svg";

const ACCEPT = ".pdf,application/pdf,image/*,.epub,.cbz,.fb2,.mobi,.xhtml";

export const MARKUP = `
  <div class="toolbar">
    <button type="button" class="open-btn primary">Open</button>
    <button type="button" class="add-btn">Add files</button>
    <span class="sep"></span>
    <span class="undo-slot"></span>
    <button type="button" class="download-btn" disabled>Download PDF</button>
    <span class="status"></span>
  </div>
  <input type="file" class="open-input" multiple hidden accept="${ACCEPT}">
  <input type="file" class="add-input" multiple hidden accept="${ACCEPT}">
  <div class="empty-hint">
    <strong>Drop PDFs, images, or e-books here</strong>, or open them with the buttons above.
    <span>Several files are merged in the order dropped. Nothing leaves the browser. MuPDF (10 MB) and qpdf (1.3 MB) download on first use and stay cached.</span>
  </div>
  <div class="locked">
    <span class="locked-text"></span>
    <input type="password" class="unlock-pw" aria-label="Password" placeholder="Password" autocomplete="off" spellcheck="false">
    <button type="button" class="unlock-btn primary">Open</button>
    <button type="button" class="unlock-skip">Skip</button>
  </div>
  <div class="progress">
    <span class="phase"></span>
    <div class="bar"><div class="fill"></div></div>
    <button type="button" class="cancel-btn">Cancel</button>
  </div>
  <div class="note" role="status">${ICON_INFO}<span class="note-text"></span></div>
  <div class="error-box" role="alert"></div>
  <div class="workspace">
    <section class="viewer" aria-label="Pages">
      <div class="pane-head viewer-head">
        <div class="seg view-seg" role="group" aria-label="View">
          <button type="button" data-view="grid" class="active">Grid</button>
          <button type="button" data-view="pages">Pages</button>
        </div>
        <div class="seg result-seg" role="group" aria-label="Show">
          <button type="button" data-show="workspace">Before</button>
          <button type="button" data-show="result" class="active">After</button>
        </div>
        <span class="zoom-wrap">
          <span class="zoom-out-slot"></span>
          <select class="zoom" aria-label="Zoom">
            <option value="width">Fit width</option>
            <option value="page">Fit page</option>
            <option value="0.5">50%</option>
            <option value="0.75">75%</option>
            <option value="1">100%</option>
            <option value="1.25">125%</option>
            <option value="1.5">150%</option>
            <option value="2">200%</option>
            <option value="3">300%</option>
            <option value="4">400%</option>
          </select>
          <span class="zoom-in-slot"></span>
        </span>
        <span class="page-nav">
          <input type="text" class="page-no" aria-label="Page number" inputmode="numeric" autocomplete="off">
          <span class="page-count"></span>
        </span>
        <span class="spacer"></span>
        <span class="search-wrap">
          <input type="search" class="search" placeholder="Find" aria-label="Find in document" spellcheck="false" autocomplete="off">
          <label class="check" title="Match case"><input type="checkbox" class="search-case">Aa</label>
          <label class="check" title="Whole words"><input type="checkbox" class="search-words">Word</label>
          <span class="search-count"></span>
          <span class="search-nav"></span>
        </span>
      </div>
      <div class="pane-head viewer-tools" hidden></div>
      <div class="viewer-slot"></div>
    </section>
    <aside class="side" aria-label="Operation">
      <div class="pane-head side-head">
        <select class="panel-select" aria-label="Operation"></select>
      </div>
      <div class="panel-body"></div>
      <div class="panel-foot"></div>
    </aside>
  </div>
  <div class="engines">
    <span class="engines-text"></span>
    <button type="button" class="engines-clear" hidden>Clear cached engines</button>
  </div>`;

/** The elements the Toolkit works with, found once. */
export const grab = (root: HTMLElement) => {
  const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => {
    const node = root.querySelector<T>(sel);
    if (!node) {
      throw new Error(`PDF Toolkit markup has no ${sel}`);
    }
    return node;
  };
  return {
    addBtn: $<HTMLButtonElement>(".add-btn"),
    addInput: $<HTMLInputElement>(".add-input"),
    bar: $(".bar"),
    cancelBtn: $<HTMLButtonElement>(".cancel-btn"),
    downloadBtn: $<HTMLButtonElement>(".download-btn"),
    emptyHint: $(".empty-hint"),
    enginesClear: $<HTMLButtonElement>(".engines-clear"),
    enginesText: $(".engines-text"),
    errorBox: $(".error-box"),
    fill: $(".fill"),
    locked: $(".locked"),
    lockedText: $(".locked-text"),
    note: $(".note"),
    noteText: $(".note-text"),
    openBtn: $<HTMLButtonElement>(".open-btn"),
    openInput: $<HTMLInputElement>(".open-input"),
    pageCount: $(".page-count"),
    pageNo: $<HTMLInputElement>(".page-no"),
    panelBody: $(".panel-body"),
    panelFoot: $(".panel-foot"),
    panelSelect: $<HTMLSelectElement>(".panel-select"),
    phase: $(".phase"),
    progress: $(".progress"),
    resultSeg: $(".result-seg"),
    searchCase: $<HTMLInputElement>(".search-case"),
    searchCount: $(".search-count"),
    searchInput: $<HTMLInputElement>(".search"),
    searchNav: $(".search-nav"),
    searchWords: $<HTMLInputElement>(".search-words"),
    skipBtn: $<HTMLButtonElement>(".unlock-skip"),
    status: $(".status"),
    undoSlot: $(".undo-slot"),
    unlockBtn: $<HTMLButtonElement>(".unlock-btn"),
    unlockPw: $<HTMLInputElement>(".unlock-pw"),
    viewerSlot: $(".viewer-slot"),
    viewerTools: $(".viewer-tools"),
    workspace: $(".workspace"),
    zoomIn: $(".zoom-in-slot"),
    zoomOut: $(".zoom-out-slot"),
    zoomSelect: $<HTMLSelectElement>(".zoom"),
  };
};

export type Elements = ReturnType<typeof grab>;
