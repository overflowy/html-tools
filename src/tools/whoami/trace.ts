// A Trace: one request to Cloudflare's trace endpoint over exactly one
// protocol, forced by addressing the endpoint as an IP literal. Cloudflare
// answers with what it saw: the address the request came from, the user
// agent it received, and the country it places that address in.

export type Protocol = "ipv4" | "ipv6";

// Cloudflare's second anycast pair, not the well-known 1.1.1.1: EasyPrivacy
// carries `||1.1.1.1/cdn-cgi/trace`, so every browser with uBlock Origin,
// Brave Shields, or AdGuard at defaults blocks the request to that literal.
export const TRACE_URLS: Record<Protocol, string> = {
  ipv4: "https://1.0.0.1/cdn-cgi/trace",
  ipv6: "https://[2606:4700:4700::1001]/cdn-cgi/trace",
};

export const PROTOCOL_LABEL: Record<Protocol, string> = { ipv4: "IPv4", ipv6: "IPv6" };

/** A black-holed IPv6 route can hang a request for a minute; give up well before that. */
export const TRACE_TIMEOUT_MS = 5000;

export interface TraceInfo {
  ip: string;
  userAgent: string;
  /** ISO 3166 code as Cloudflare returned it; may be "XX" (unknown) or "T1" (Tor). */
  country: string;
}

export type TraceResult =
  | { kind: "found"; info: TraceInfo }
  | { kind: "unreachable"; message: string };

/**
 * The trace body is `key=value` lines. Only the three keys Whoami shows are
 * read; a body missing any of them is not a trace.
 */
export function parseTrace(text: string): TraceInfo | null {
  const fields = new Map<string, string>();
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) fields.set(line.slice(0, eq), line.slice(eq + 1).trim());
  }
  const ip = fields.get("ip");
  const userAgent = fields.get("uag");
  const country = fields.get("loc");
  if (!ip || userAgent === undefined || !country) return null;
  return { ip, userAgent, country };
}

function timeoutSignal(parent: AbortSignal, ms: number): AbortSignal {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException("Timed out after " + ms / 1000 + " s", "TimeoutError")), ms);
  parent.addEventListener("abort", () => { clearTimeout(timer); ctrl.abort(parent.reason); }, { once: true });
  ctrl.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  return ctrl.signal;
}

/**
 * Run one Trace. Never throws except when `signal` aborts: from a browser a
 * missing route and a blocked service look the same, so every failure is
 * reported as "unreachable over this protocol" and the message keeps both
 * possibilities open.
 */
export async function fetchTrace(protocol: Protocol, signal: AbortSignal): Promise<TraceResult> {
  const label = PROTOCOL_LABEL[protocol];
  let res: Response;
  try {
    res = await fetch(TRACE_URLS[protocol], { cache: "no-store", signal: timeoutSignal(signal, TRACE_TIMEOUT_MS) });
  } catch (e) {
    if (signal.aborted) throw e;
    const why = e instanceof DOMException && e.name === "TimeoutError"
      ? e.message
      : "no " + label + " route, or the request is blocked, for instance by a content blocker";
    return { kind: "unreachable", message: "Not reachable over " + label + " (" + why + ")." };
  }
  if (!res.ok) return { kind: "unreachable", message: "Cloudflare answered HTTP " + res.status + " over " + label + "." };
  const info = parseTrace(await res.text());
  if (!info) return { kind: "unreachable", message: "Cloudflare's answer over " + label + " was not a trace." };
  return { kind: "found", info };
}

/** "IT" -> "Italy" where the browser knows the code; null for codes it does not (XX, T1). */
export function countryName(code: string): string | null {
  if (!/^[A-Z]{2}$/.test(code)) return null;
  try {
    const name = new Intl.DisplayNames(["en"], { type: "region" }).of(code);
    return name && name !== code ? name : null;
  } catch {
    return null;
  }
}
