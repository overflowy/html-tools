import "./theme.css";
import "./shell.css";
import { tools } from "../registry";
import type { Tool } from "./types";

const LAST_KEY = "html-tools:last";

document.body.innerHTML = `
  <aside class="sidebar">
    <div class="app-name">
      <svg class="logo" viewBox="0 0 64 64" aria-hidden="true"><text x="32" y="45" font-family="ui-monospace,Menlo,monospace" font-size="32" font-weight="700" text-anchor="middle" fill="#c96442">{/}</text></svg>
      html tools
    </div>
    <div class="filter-wrap">
      <input type="search" placeholder="Filter tools" aria-label="Filter tools">
      <kbd>&#8984;K</kbd>
    </div>
    <nav class="tool-list"></nav>
    <footer class="sidebar-footer">
      <p>All tools run in the browser.</p>
      <a href="https://github.com/overflowy/html-tools" target="_blank" rel="noreferrer">Source</a>
    </footer>
  </aside>
  <div class="content">
    <header class="tool-header">
      <button class="menu-btn" type="button" aria-label="Open tool list" aria-expanded="false">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      </button>
      <div class="tool-title">
        <h1></h1>
        <p class="subtitle"></p>
      </div>
    </header>
    <div class="hosts"></div>
  </div>
  <div class="drawer-backdrop"></div>
`;

const $filter = document.querySelector(".filter-wrap input") as HTMLInputElement;
const $list = document.querySelector(".tool-list") as HTMLElement;
const $h1 = document.querySelector(".tool-header h1") as HTMLElement;
const $subtitle = document.querySelector(".tool-header .subtitle") as HTMLElement;
const $hosts = document.querySelector(".hosts") as HTMLElement;
const $sidebar = document.querySelector(".sidebar") as HTMLElement;
const $content = document.querySelector(".content") as HTMLElement;
const $menuBtn = document.querySelector(".menu-btn") as HTMLButtonElement;
const $backdrop = document.querySelector(".drawer-backdrop") as HTMLElement;

// Narrow Layout: below 768px the Sidebar becomes the Drawer. Keep this query
// in sync with the media queries in shell.css and theme.css.
const narrow = window.matchMedia("(max-width: 767px)");
let drawerOpen = false;

function setDrawer(open: boolean) {
  if (open === drawerOpen) return;
  if (open && !narrow.matches) return;
  drawerOpen = open;
  document.body.classList.toggle("drawer-open", open);
  $menuBtn.setAttribute("aria-expanded", String(open));
  // Full modal treatment: the Main Pane is inert while the Drawer is open,
  // which both traps focus in the Drawer and hides the background from
  // screen readers.
  $content.inert = open;
  if (open) {
    $sidebar.setAttribute("role", "dialog");
    $sidebar.setAttribute("aria-modal", "true");
    $sidebar.setAttribute("aria-label", "Tool list");
    const target = $list.querySelector("button.selected") ?? $list.querySelector("button");
    (target as HTMLElement | null)?.focus();
  } else {
    $sidebar.removeAttribute("role");
    $sidebar.removeAttribute("aria-modal");
    $sidebar.removeAttribute("aria-label");
    const active = document.activeElement;
    if ($sidebar.contains(active) || active === document.body) $menuBtn.focus();
  }
}

const hosts = new Map<string, HTMLElement>();
const payloads = new Map<string, string>();
const restorers = new Map<string, (payload: string) => void>();
let current: Tool | null = null;
let visible: Tool[] = tools.slice();
let cursor = 0;

function matches(tool: Tool, query: string): boolean {
  const hay = [tool.name, tool.id, ...tool.keywords].join(" ").toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((word) => hay.includes(word));
}

function renderList() {
  const query = $filter.value.trim();
  visible = tools.filter((t) => matches(t, query));
  cursor = Math.min(cursor, Math.max(0, visible.length - 1));
  $list.replaceChildren();
  if (visible.length === 0) {
    const empty = document.createElement("div");
    empty.className = "no-match";
    empty.textContent = "No matching tools";
    $list.appendChild(empty);
    return;
  }
  visible.forEach((tool, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = tool.name;
    if (current && tool.id === current.id) btn.classList.add("selected");
    if (document.activeElement === $filter && i === cursor) btn.classList.add("cursor");
    btn.addEventListener("click", () => {
      location.hash = tool.id;
      // Re-selecting the current tool fires no hashchange, so the Drawer
      // closes here rather than in the hashchange handler.
      setDrawer(false);
    });
    $list.appendChild(btn);
  });
}

/** Deep Link format: `#<tool-id>` or `#<tool-id>/<payload>`. */
function parseHash(): { id: string; payload: string } {
  const raw = location.hash.slice(1);
  const slash = raw.indexOf("/");
  if (slash === -1) return { id: decodeURIComponent(raw), payload: "" };
  return { id: decodeURIComponent(raw.slice(0, slash)), payload: raw.slice(slash + 1) };
}

function writeHash(toolId: string) {
  const payload = payloads.get(toolId);
  const hash = "#" + toolId + (payload ? "/" + payload : "");
  if (location.hash !== hash) history.replaceState(null, "", hash);
}

function selectTool(id: string, payload = "") {
  const tool = tools.find((t) => t.id === id) ?? tools[0]!;
  // A hash without a payload (sidebar click, hand-typed URL) keeps the
  // tool's last-known State rather than wiping it. A payload meant for an
  // unknown tool id is dropped, not applied to the fallback tool.
  const changed = tool.id === id && payload !== "" && payload !== payloads.get(tool.id);
  if (changed) payloads.set(tool.id, payload);
  writeHash(tool.id);
  if (current?.id === tool.id) {
    if (changed) restorers.get(tool.id)?.(payload);
    renderList();
    return;
  }
  current = tool;
  localStorage.setItem(LAST_KEY, tool.id);
  document.title = tool.name + " · html tools";
  $h1.textContent = tool.name;
  $subtitle.textContent = tool.subtitle;

  let host = hosts.get(tool.id);
  if (!host) {
    host = document.createElement("section");
    host.className = "tool-host tool-" + tool.id;
    $hosts.appendChild(host);
    hosts.set(tool.id, host);
    tool.mount(host, {
      setState(p) {
        if (p) payloads.set(tool.id, p);
        else payloads.delete(tool.id);
        if (current?.id === tool.id) writeHash(tool.id);
      },
      onRestore(fn) {
        restorers.set(tool.id, fn);
      },
    });
    const stored = payloads.get(tool.id);
    if (stored) restorers.get(tool.id)?.(stored);
  } else if (changed) {
    restorers.get(tool.id)?.(payload);
  }
  for (const [hostId, h] of hosts) h.hidden = hostId !== tool.id;
  renderList();
}

window.addEventListener("hashchange", () => {
  const { id, payload } = parseHash();
  if (id) selectTool(id, payload);
});

window.addEventListener("keydown", (e) => {
  const t = e.target as HTMLElement;
  const typing =
    t instanceof HTMLInputElement ||
    t instanceof HTMLTextAreaElement ||
    t instanceof HTMLSelectElement ||
    t.isContentEditable;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    setDrawer(true);
    $filter.focus();
    $filter.select();
  } else if (e.key === "/" && !typing) {
    e.preventDefault();
    setDrawer(true);
    $filter.focus();
    $filter.select();
  } else if (e.key === "Escape") {
    setDrawer(false);
  }
});

$menuBtn.addEventListener("click", () => setDrawer(!drawerOpen));
$backdrop.addEventListener("click", () => setDrawer(false));
narrow.addEventListener("change", () => setDrawer(false));

$filter.addEventListener("input", () => {
  cursor = 0;
  renderList();
});
$filter.addEventListener("focus", renderList);
$filter.addEventListener("blur", renderList);
$filter.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    cursor = Math.min(cursor + 1, visible.length - 1);
    renderList();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    cursor = Math.max(cursor - 1, 0);
    renderList();
  } else if (e.key === "Enter") {
    const tool = visible[cursor];
    if (tool) {
      location.hash = tool.id;
      $filter.value = "";
      cursor = 0;
      $filter.blur();
      renderList();
      setDrawer(false);
    }
  } else if (e.key === "Escape") {
    // Escape layers innermost-first: clear the Filter now, leave the Drawer
    // open; the next press reaches the window handler and closes it.
    e.stopPropagation();
    $filter.value = "";
    cursor = 0;
    $filter.blur();
    renderList();
  }
});

const initial = parseHash();
selectTool(initial.id || localStorage.getItem(LAST_KEY) || "", initial.payload);
