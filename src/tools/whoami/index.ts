import "./tool.css";
import type { Tool } from "../../shell/types";
import { PROTOCOL_LABEL, countryName, fetchTrace, type Protocol, type TraceInfo, type TraceResult } from "./trace";

const PROTOCOLS: Protocol[] = ["ipv4", "ipv6"];

/** What a card shows: one of these per row on screen and per line in Copy all. */
type Cell =
  | { kind: "pending"; text: string }
  | { kind: "value"; text: string; detail?: string }
  | { kind: "missing"; text: string };

type Row = "ipv4" | "ipv6" | "country" | "ua";
/** On-screen order, also the order of the lines Copy all writes. */
const ROWS: Row[] = ["ipv4", "ipv6", "country", "ua"];
const ROW_LABEL: Record<Row, string> = { ipv4: "IPv4", ipv6: "IPv6", country: "Country", ua: "User agent" };

function countryText(code: string): string {
  const name = countryName(code);
  return name ? code + " · " + name : code;
}

/** The four cells, derived from the two Traces (null while in flight). */
export function cells(results: Record<Protocol, TraceResult | null>): Record<Row, Cell> {
  const address = (p: Protocol): Cell => {
    const r = results[p];
    if (!r) return { kind: "pending", text: "Asking Cloudflare over " + PROTOCOL_LABEL[p] + "…" };
    return r.kind === "found" ? { kind: "value", text: r.info.ip } : { kind: "missing", text: r.message };
  };
  const found: { protocol: Protocol; info: TraceInfo }[] = [];
  for (const p of PROTOCOLS) {
    const r = results[p];
    if (r?.kind === "found") found.push({ protocol: p, info: r.info });
  }
  const settled = PROTOCOLS.every((p) => results[p] !== null);
  const derived = (build: () => Cell): Cell => {
    if (found.length) return build();
    if (settled) return { kind: "missing", text: "Needs a successful trace over IPv4 or IPv6." };
    return { kind: "pending", text: "Waiting for a trace…" };
  };
  return {
    ipv4: address("ipv4"),
    ipv6: address("ipv6"),
    country: derived(() => {
      if (found.every((f) => f.info.country === found[0]!.info.country)) return { kind: "value", text: countryText(found[0]!.info.country) };
      // A tunnel can exit in different countries per protocol; say which is which.
      return {
        kind: "value",
        text: found.map((f) => countryText(f.info.country) + " via " + PROTOCOL_LABEL[f.protocol]).join(", "),
        detail: "The two traces disagree.",
      };
    }),
    ua: derived(() => ({ kind: "value", text: found[0]!.info.userAgent })),
  };
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

const tool: Tool = {
  id: "whoami",
  name: "Whoami",
  subtitle: "Your public IPv4, IPv6, country, and user agent, as servers see them.",
  keywords: ["ip", "ipv4", "ipv6", "my ip", "address", "user agent", "country", "whoami"],
  mount(el) {
    const cardHtml = (row: Row) => `
      <section class="pane" data-row="${row}">
        <div class="pane-head"><span>${ROW_LABEL[row].toLowerCase()}</span><span class="spacer"></span><button class="btn-copy" type="button" disabled>Copy</button></div>
        <div class="value"></div>
      </section>`;
    el.innerHTML = `
      <div class="toolbar">
        <button class="btn-refresh" type="button">Refresh</button>
        <button class="btn-copy-all primary" type="button">Copy all</button>
      </div>
      <div class="cards">${ROWS.map(cardHtml).join("")}</div>`;

    const $btnRefresh = el.querySelector(".btn-refresh") as HTMLButtonElement;
    const $btnCopyAll = el.querySelector(".btn-copy-all") as HTMLButtonElement;

    let results: Record<Protocol, TraceResult | null> = { ipv4: null, ipv6: null };
    let ctrl: AbortController | null = null;

    function flash(btn: HTMLButtonElement) {
      const old = btn.textContent;
      btn.textContent = "Copied";
      setTimeout(() => { btn.textContent = old; }, 1200);
    }

    function render() {
      const c = cells(results);
      for (const row of ROWS) {
        const cell = c[row];
        const $card = el.querySelector('[data-row="' + row + '"]') as HTMLElement;
        const $value = $card.querySelector(".value") as HTMLElement;
        $value.className = "value " + cell.kind;
        $value.innerHTML = esc(cell.text) + (cell.kind === "value" && cell.detail ? '<span class="detail">' + esc(cell.detail) + "</span>" : "");
        ($card.querySelector(".btn-copy") as HTMLButtonElement).disabled = cell.kind !== "value";
      }
      $btnRefresh.disabled = ctrl !== null;
    }

    function report(): string {
      const c = cells(results);
      return ROWS.map((row) => ROW_LABEL[row] + ": " + (c[row].kind === "pending" ? "pending" : c[row].text)).join("\n");
    }

    async function run() {
      ctrl?.abort();
      const mine = new AbortController();
      ctrl = mine;
      results = { ipv4: null, ipv6: null };
      render();
      // Each protocol lands on its own, so a slow IPv6 never holds up IPv4.
      await Promise.all(PROTOCOLS.map(async (p) => {
        let r: TraceResult;
        try {
          r = await fetchTrace(p, mine.signal);
        } catch {
          return; // superseded by a newer Refresh
        }
        if (mine.signal.aborted) return;
        results[p] = r;
        render();
      }));
      if (ctrl === mine) {
        ctrl = null;
        render();
      }
    }

    for (const $card of Array.from(el.querySelectorAll<HTMLElement>(".pane"))) {
      const $btn = $card.querySelector(".btn-copy") as HTMLButtonElement;
      $btn.addEventListener("click", () => {
        const cell = cells(results)[$card.dataset.row as Row];
        if (cell.kind !== "value") return;
        navigator.clipboard.writeText(cell.text).then(() => flash($btn));
      });
    }
    $btnCopyAll.addEventListener("click", () => {
      navigator.clipboard.writeText(report()).then(() => flash($btnCopyAll));
    });
    $btnRefresh.addEventListener("click", () => { void run(); });

    void run();
  },
};

export default tool;
