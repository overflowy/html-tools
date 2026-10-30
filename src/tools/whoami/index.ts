import "./tool.css";
import type { Tool } from "../../shell/types";
import { PROTOCOL_LABEL, countryName, fetchTrace } from "./trace";
import type { Protocol, TraceInfo, TraceResult } from "./trace";

const PROTOCOLS: Protocol[] = ["ipv4", "ipv6"];

/** What a card shows: one of these per row on screen and per line in Copy all. */
type Cell =
  | { kind: "pending"; text: string }
  | { kind: "value"; text: string; detail?: string }
  | { kind: "missing"; text: string };

type Row = "ipv4" | "ipv6" | "country" | "ua";
/** On-screen order, also the order of the lines Copy all writes. */
const ROWS: Row[] = ["ipv4", "ipv6", "country", "ua"];
const ROW_LABEL: Record<Row, string> = {
  country: "Country",
  ipv4: "IPv4",
  ipv6: "IPv6",
  ua: "User agent",
};

const countryText = (code: string): string => {
  const name = countryName(code);
  return name ? `${code} · ${name}` : code;
};

/** The four cells, derived from the two Traces (null while in flight). */
export const cells = (
  results: Record<Protocol, TraceResult | null>
): Record<Row, Cell> => {
  const address = (p: Protocol): Cell => {
    const r = results[p];
    if (!r) {
      return {
        kind: "pending",
        text: `Asking Cloudflare over ${PROTOCOL_LABEL[p]}…`,
      };
    }
    return r.kind === "found"
      ? { kind: "value", text: r.info.ip }
      : { kind: "missing", text: r.message };
  };
  const found: { protocol: Protocol; info: TraceInfo }[] = [];
  for (const p of PROTOCOLS) {
    const r = results[p];
    if (r?.kind === "found") {
      found.push({ info: r.info, protocol: p });
    }
  }
  const settled = PROTOCOLS.every((p) => results[p] !== null);
  const [first] = found;
  const derived = (build: (one: (typeof found)[number]) => Cell): Cell => {
    if (first) {
      return build(first);
    }
    if (settled) {
      return {
        kind: "missing",
        text: "Needs a successful trace over IPv4 or IPv6.",
      };
    }
    return { kind: "pending", text: "Waiting for a trace…" };
  };
  return {
    country: derived((one) => {
      if (found.every((f) => f.info.country === one.info.country)) {
        return { kind: "value", text: countryText(one.info.country) };
      }
      // A tunnel can exit in different countries per protocol; say which is which.
      return {
        detail: "The two traces disagree.",
        kind: "value",
        text: found
          .map(
            (f) =>
              `${countryText(f.info.country)} via ${PROTOCOL_LABEL[f.protocol]}`
          )
          .join(", "),
      };
    }),
    ipv4: address("ipv4"),
    ipv6: address("ipv6"),
    ua: derived((one) => ({ kind: "value", text: one.info.userAgent })),
  };
};

const ESCAPES: Record<string, string> = {
  '"': "&quot;",
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
};

const esc = (s: string): string =>
  s.replaceAll(/[&<>"]/gu, (c) => ESCAPES[c] ?? c);

const tool: Tool = {
  id: "whoami",
  keywords: [
    "ip",
    "ipv4",
    "ipv6",
    "my ip",
    "address",
    "user agent",
    "country",
    "whoami",
  ],
  mount(el) {
    const cardHtml = (row: Row) => `
      <section class="pane" data-row="${row}">
        <div class="pane-head"><span>${ROW_LABEL[row]}</span><span class="spacer"></span><button class="btn-copy" type="button" disabled>Copy</button></div>
        <div class="value"></div>
      </section>`;
    el.innerHTML = `
      <div class="toolbar">
        <button class="btn-copy-all primary" type="button" disabled>Copy all</button>
        <button class="btn-refresh" type="button">Refresh</button>
      </div>
      <div class="cards">${ROWS.map(cardHtml).join("")}</div>`;

    const $btnRefresh = el.querySelector(".btn-refresh") as HTMLButtonElement;
    const $btnCopyAll = el.querySelector(".btn-copy-all") as HTMLButtonElement;

    let results: Record<Protocol, TraceResult | null> = {
      ipv4: null,
      ipv6: null,
    };
    let ctrl: AbortController | null = null;

    const flash = (btn: HTMLButtonElement) => {
      const old = btn.textContent;
      btn.textContent = "Copied";
      setTimeout(() => {
        btn.textContent = old;
      }, 1200);
    };

    const render = () => {
      const c = cells(results);
      for (const row of ROWS) {
        const cell = c[row];
        const $card = el.querySelector(`[data-row="${row}"]`) as HTMLElement;
        const $value = $card.querySelector(".value") as HTMLElement;
        $value.className = `value ${cell.kind}`;
        $value.innerHTML =
          esc(cell.text) +
          (cell.kind === "value" && cell.detail
            ? `<span class="detail">${esc(cell.detail)}</span>`
            : "");
        ($card.querySelector(".btn-copy") as HTMLButtonElement).disabled =
          cell.kind !== "value";
      }
      $btnCopyAll.disabled = !ROWS.some((row) => c[row].kind === "value");
      $btnRefresh.disabled = ctrl !== null;
    };

    const report = (): string => {
      const c = cells(results);
      return ROWS.map(
        (row) =>
          `${ROW_LABEL[row]}: ${
            c[row].kind === "pending" ? "pending" : c[row].text
          }`
      ).join("\n");
    };

    const run = async () => {
      ctrl?.abort();
      const mine = new AbortController();
      ctrl = mine;
      results = { ipv4: null, ipv6: null };
      render();
      // Each protocol lands on its own, so a slow IPv6 never holds up IPv4.
      await Promise.all(
        PROTOCOLS.map(async (p) => {
          let r: TraceResult;
          try {
            r = await fetchTrace(p, mine.signal);
          } catch {
            // Superseded by a newer Refresh.
            return;
          }
          if (mine.signal.aborted) {
            return;
          }
          results[p] = r;
          render();
        })
      );
      if (ctrl === mine) {
        ctrl = null;
        render();
      }
    };

    const wireCopy = ($card: HTMLElement) => {
      const $btn = $card.querySelector(".btn-copy") as HTMLButtonElement;
      $btn.addEventListener("click", async () => {
        const cell = cells(results)[$card.dataset.row as Row];
        if (cell.kind !== "value") {
          return;
        }
        await navigator.clipboard.writeText(cell.text);
        flash($btn);
      });
    };
    for (const $card of el.querySelectorAll<HTMLElement>(".pane")) {
      wireCopy($card);
    }
    $btnCopyAll.addEventListener("click", async () => {
      await navigator.clipboard.writeText(report());
      flash($btnCopyAll);
    });
    $btnRefresh.addEventListener("click", () => {
      void run();
    });

    void run();
  },
  name: "Whoami",
  subtitle:
    "Your public IPv4, IPv6, country, and user agent, as servers see them.",
};

export default tool;
