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
  </aside>
  <div class="content">
    <header class="tool-header">
      <h1></h1>
      <p class="subtitle"></p>
    </header>
    <div class="hosts"></div>
  </div>
`;

const $filter = document.querySelector(".filter-wrap input") as HTMLInputElement;
const $list = document.querySelector(".tool-list") as HTMLElement;
const $h1 = document.querySelector(".tool-header h1") as HTMLElement;
const $subtitle = document.querySelector(".tool-header .subtitle") as HTMLElement;
const $hosts = document.querySelector(".hosts") as HTMLElement;

const hosts = new Map<string, HTMLElement>();
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
    });
    $list.appendChild(btn);
  });
}

function selectTool(id: string) {
  const tool = tools.find((t) => t.id === id) ?? tools[0]!;
  if (location.hash.slice(1) !== tool.id) {
    history.replaceState(null, "", "#" + tool.id);
  }
  if (current?.id === tool.id) {
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
    tool.mount(host);
  }
  for (const [id, h] of hosts) h.hidden = id !== tool.id;
  renderList();
}

window.addEventListener("hashchange", () => {
  const id = decodeURIComponent(location.hash.slice(1));
  if (id) selectTool(id);
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
    $filter.focus();
    $filter.select();
  } else if (e.key === "/" && !typing) {
    e.preventDefault();
    $filter.focus();
    $filter.select();
  }
});

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
    }
  } else if (e.key === "Escape") {
    $filter.value = "";
    cursor = 0;
    $filter.blur();
    renderList();
  }
});

const requested = decodeURIComponent(location.hash.slice(1)) || localStorage.getItem(LAST_KEY) || "";
selectTool(requested);
