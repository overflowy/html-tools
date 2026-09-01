// Pure DNS Lookup logic: name normalization, reverse names, record types, the
// DNS-over-HTTPS JSON wire format shared by Cloudflare and Google, and the two
// Subdomain Sources. Nothing here touches the DOM.

export interface Resolver {
  id: string;
  label: string;
  url: string;
}

export const RESOLVERS: Resolver[] = [
  { id: "cf", label: "Cloudflare 1.1.1.1", url: "https://cloudflare-dns.com/dns-query" },
  { id: "cfsec", label: "Cloudflare 1.1.1.2 (blocks malware)", url: "https://security.cloudflare-dns.com/dns-query" },
  { id: "cffam", label: "Cloudflare 1.1.1.3 (blocks malware, adult content)", url: "https://family.cloudflare-dns.com/dns-query" },
  { id: "google", label: "Google 8.8.8.8", url: "https://dns.google/resolve" },
];

export function resolverById(id: string): Resolver {
  return RESOLVERS.find((r) => r.id === id) ?? RESOLVERS[0]!;
}

/** Record Types offered in the picker, grouped as displayed. ANY is left out: Resolvers refuse it. */
export const TYPE_GROUPS: { label: string; types: string[] }[] = [
  { label: "Common", types: ["A", "AAAA", "CNAME", "MX", "NS", "TXT", "SOA", "CAA", "SRV", "PTR"] },
  { label: "Service binding", types: ["HTTPS", "SVCB"] },
  { label: "DNSSEC", types: ["DNSKEY", "DS", "CDS", "CDNSKEY", "RRSIG", "NSEC", "NSEC3", "NSEC3PARAM"] },
  { label: "Other", types: ["TLSA", "SSHFP", "NAPTR", "DNAME", "HINFO", "LOC", "CERT", "SMIMEA", "OPENPGPKEY", "URI", "SPF"] },
];

/** The Common Types: what All Types queries. */
export const COMMON_TYPES = ["A", "AAAA", "CNAME", "MX", "NS", "TXT", "SOA", "CAA", "SRV", "PTR", "HTTPS", "SVCB", "DNSKEY", "DS"];

const TYPE_NUMBERS: Record<string, number> = {
  A: 1, NS: 2, CNAME: 5, SOA: 6, PTR: 12, HINFO: 13, MX: 15, TXT: 16, AAAA: 28, LOC: 29, SRV: 33, NAPTR: 35,
  CERT: 37, DNAME: 39, OPT: 41, DS: 43, SSHFP: 44, RRSIG: 46, NSEC: 47, DNSKEY: 48, NSEC3: 50, NSEC3PARAM: 51,
  TLSA: 52, SMIMEA: 53, CDS: 59, CDNSKEY: 60, OPENPGPKEY: 61, SVCB: 64, HTTPS: 65, SPF: 99, URI: 256, CAA: 257,
};
const TYPE_NAMES = new Map(Object.entries(TYPE_NUMBERS).map(([name, n]) => [n, name]));

/** Name for a numeric record type, `TYPEn` for ones we do not know (RFC 3597 style). */
export function typeName(n: number): string {
  return TYPE_NAMES.get(n) ?? "TYPE" + n;
}

export function typeNumber(name: string): number | undefined {
  return TYPE_NUMBERS[name.toUpperCase()];
}

/** A Custom type is any mnemonic or a number up to 65535; anything else is rejected before hitting the Resolver. */
export function validCustomType(raw: string): string | null {
  const t = raw.trim().toUpperCase();
  if (/^\d{1,5}$/.test(t)) return Number(t) <= 65535 ? t : null;
  return /^[A-Z][A-Z0-9-]{0,15}$/.test(t) ? t : null;
}

const RCODES: Record<number, string> = {
  0: "NOERROR", 1: "FORMERR", 2: "SERVFAIL", 3: "NXDOMAIN", 4: "NOTIMP", 5: "REFUSED",
  6: "YXDOMAIN", 7: "YXRRSET", 8: "NXRRSET", 9: "NOTAUTH", 10: "NOTZONE", 16: "BADVERS",
};

export function rcodeName(status: number): string {
  return RCODES[status] ?? "RCODE" + status;
}

/**
 * Reduce whatever was typed to a Name: trim, drop a URL scheme, userinfo,
 * port, path, query, and fragment, drop the trailing dot, lowercase.
 * Returns "" when nothing usable is left.
 */
export function normalizeName(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^\/\//, "");
  s = s.replace(/[/?#].*$/, "");
  const at = s.lastIndexOf("@");
  if (at !== -1) s = s.slice(at + 1);
  if (s.startsWith("[")) {
    // Bracketed IPv6 literal, possibly with a port.
    const close = s.indexOf("]");
    s = close === -1 ? s.slice(1) : s.slice(1, close);
  } else if (/^[^:]+:\d+$/.test(s)) {
    s = s.replace(/:\d+$/, "");
  }
  s = s.replace(/\.+$/, "").toLowerCase();
  return s;
}

export function isIPv4(s: string): boolean {
  const parts = s.split(".");
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/** Expand an IPv6 address to its 32 hex nibbles, or null if it is not one. */
export function ipv6Nibbles(s: string): string | null {
  if (!/^[0-9a-f:.]+$/i.test(s) || !s.includes(":")) return null;
  let addr = s.toLowerCase();
  // Embedded IPv4 tail (::ffff:1.2.3.4) becomes two hextets.
  const v4 = addr.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4) {
    if (!isIPv4(v4[1]!)) return null;
    const b = v4[1]!.split(".").map(Number);
    addr = addr.slice(0, -v4[1]!.length) + ((b[0]! << 8) | b[1]!).toString(16) + ":" + ((b[2]! << 8) | b[3]!).toString(16);
  }
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const groups = halves.length === 2 ? head.concat(Array(8 - head.length - tail.length).fill("0"), tail) : head;
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => g.padStart(4, "0")).join("");
}

/** The `in-addr.arpa` / `ip6.arpa` name for an IP address, or null if the Name is not an address. */
export function reverseName(name: string): string | null {
  if (isIPv4(name)) return name.split(".").toReversed().join(".") + ".in-addr.arpa";
  const nibbles = ipv6Nibbles(name);
  if (nibbles) return nibbles.split("").toReversed().join(".") + ".ip6.arpa";
  return null;
}

/** Human TTL: the two largest units, e.g. "1d 6h", "5m 30s", "45s". */
export function formatTtl(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return String(seconds);
  const s = Math.floor(seconds);
  const units: [string, number][] = [["d", 86400], ["h", 3600], ["m", 60], ["s", 1]];
  for (let i = 0; i < units.length; i++) {
    const [label, size] = units[i]!;
    if (s < size && i < units.length - 1) continue;
    const next = units[i + 1];
    const minor = next ? Math.floor((s % size) / next[1]) : 0;
    return Math.floor(s / size) + label + (minor ? " " + minor + next![0] : "");
  }
  return "0s";
}

export interface DnsRecord {
  name: string;
  type: number;
  TTL: number;
  data: string;
}

export interface DnsResponse {
  Status: number;
  TC: boolean;
  RD: boolean;
  RA: boolean;
  AD: boolean;
  CD: boolean;
  Question: { name: string; type: number }[];
  Answer: DnsRecord[];
  Authority: DnsRecord[];
  Additional: DnsRecord[];
  Comment: string[];
}

function asRecords(v: unknown): DnsRecord[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((r) => r && typeof r === "object")
    .map((r) => ({
      name: String((r as DnsRecord).name ?? ""),
      type: Number((r as DnsRecord).type ?? 0),
      TTL: Number((r as DnsRecord).TTL ?? 0),
      data: String((r as DnsRecord).data ?? ""),
    }));
}

/** Coerce a resolver's JSON body into a DnsResponse. Cloudflare's Comment is an array, Google's a string. */
export function parseResponse(json: unknown): DnsResponse {
  if (!json || typeof json !== "object" || typeof (json as { Status?: unknown }).Status !== "number") {
    throw new Error("The resolver returned something that is not a DNS response.");
  }
  const j = json as Record<string, unknown>;
  const comment = j.Comment;
  return {
    Status: j.Status as number,
    TC: Boolean(j.TC),
    RD: Boolean(j.RD),
    RA: Boolean(j.RA),
    AD: Boolean(j.AD),
    CD: Boolean(j.CD),
    Question: Array.isArray(j.Question) ? asRecords(j.Question).map(({ name, type }) => ({ name, type })) : [],
    Answer: asRecords(j.Answer),
    Authority: asRecords(j.Authority),
    Additional: asRecords(j.Additional),
    Comment: Array.isArray(comment) ? comment.map(String) : typeof comment === "string" && comment ? [comment] : [],
  };
}

export type Outcome = "records" | "empty" | "nxdomain" | "failed";

/** The three outcomes a Response can have, plus resolver-side failure (SERVFAIL, REFUSED, ...). */
export function outcomeOf(r: DnsResponse): Outcome {
  if (r.Status === 3) return "nxdomain";
  if (r.Status !== 0) return "failed";
  return r.Answer.length ? "records" : "empty";
}

export interface QueryOptions {
  cd: boolean;
  do: boolean;
}

/**
 * Both Resolvers take a type by name or number, but Google rejects some
 * mnemonics it does answer by number (LOC, SMIMEA, OPENPGPKEY, URI), so the
 * wire form is the number whenever we know it.
 */
export function wireType(type: string): string {
  const n = typeNumber(type);
  return n === undefined ? type : String(n);
}

export function queryUrl(resolver: Resolver, name: string, type: string, opts: QueryOptions): string {
  const url = new URL(resolver.url);
  url.searchParams.set("name", name);
  url.searchParams.set("type", wireType(type));
  if (opts.cd) url.searchParams.set("cd", "1");
  if (opts.do) url.searchParams.set("do", "1");
  return url.toString();
}

/** Errors thrown by the fetch helpers: a message fit to show as-is. */
export class LookupError extends Error {}

export const REQUEST_TIMEOUT_MS = 10000;

function timeoutSignal(parent: AbortSignal, ms: number): AbortSignal {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException("Timed out after " + ms / 1000 + " s", "TimeoutError")), ms);
  parent.addEventListener("abort", () => { clearTimeout(timer); ctrl.abort(parent.reason); }, { once: true });
  ctrl.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  return ctrl.signal;
}

async function fetchOrExplain(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: timeoutSignal(signal, REQUEST_TIMEOUT_MS) });
  } catch (e) {
    if (signal.aborted) throw e;
    if (e instanceof DOMException && e.name === "TimeoutError") throw new LookupError(e.message);
    throw new LookupError("Could not reach " + new URL(url).host + ". " + (e as Error).message);
  }
}

export interface LookupResult {
  response: DnsResponse;
  ms: number;
}

/** One Lookup. Rejects with LookupError on transport or HTTP failure; rethrows the abort reason if `signal` fires. */
export async function lookup(resolver: Resolver, name: string, type: string, opts: QueryOptions, signal: AbortSignal): Promise<LookupResult> {
  const started = performance.now();
  const resp = await fetchOrExplain(queryUrl(resolver, name, type, opts), { headers: { Accept: "application/dns-json" } }, signal);
  if (!resp.ok) {
    // Cloudflare explains 4xx as {"error": "..."}; Google sends an HTML page.
    let detail = "";
    try {
      const j = await resp.json();
      if (j && typeof j.error === "string") detail = j.error;
    } catch { /* not JSON */ }
    throw new LookupError("HTTP " + resp.status + (detail ? ": " + detail : "") + " from " + resolver.label);
  }
  let json: unknown;
  try {
    json = await resp.json();
  } catch {
    throw new LookupError("The resolver did not return JSON.");
  }
  return { response: parseResponse(json), ms: Math.round(performance.now() - started) };
}

export interface SubdomainHit {
  name: string;
  /** Address reported by HackerTarget, when it has one. */
  ip: string;
  sources: string[];
}

export interface SubdomainSource {
  id: string;
  label: string;
  fetch(name: string, signal: AbortSignal): Promise<{ name: string; ip: string }[]>;
}

/** Keep only `name` itself and hostnames beneath it; certificates list unrelated SANs too. */
export function underName(host: string, name: string): boolean {
  return host === name || host.endsWith("." + name);
}

function cleanHost(h: string): string {
  return h.trim().toLowerCase().replace(/\.$/, "");
}

/** Cert Spotter issuance objects (one page) to the hostnames under `name`. */
export function parseCertSpotter(json: unknown, name: string): string[] {
  if (!Array.isArray(json)) throw new LookupError("Cert Spotter returned an unexpected response.");
  const out = new Set<string>();
  for (const issuance of json) {
    const names = (issuance as { dns_names?: unknown }).dns_names;
    if (!Array.isArray(names)) continue;
    for (const n of names) {
      const host = cleanHost(String(n));
      if (underName(host, name)) out.add(host);
    }
  }
  return [...out];
}

/** HackerTarget's `host,ip` lines. Errors come back as 200 with a one-line message. */
export function parseHackerTarget(text: string, name: string): { name: string; ip: string }[] {
  const body = text.trim();
  if (!body) return [];
  if (/^(error|api count)/i.test(body)) {
    if (/invalid host|no records/i.test(body)) return [];
    throw new LookupError("HackerTarget: " + body);
  }
  const out: { name: string; ip: string }[] = [];
  for (const line of body.split("\n")) {
    const comma = line.indexOf(",");
    const host = cleanHost(comma === -1 ? line : line.slice(0, comma));
    if (!host || !underName(host, name)) continue;
    out.push({ name: host, ip: comma === -1 ? "" : line.slice(comma + 1).trim() });
  }
  return out;
}

/** Longest Cert Spotter walk we make per search: pages are 100 issuances and unauthenticated use is rate limited. */
export const CERTSPOTTER_MAX_PAGES = 10;

// crt.name and crt.sh would be the obvious sources but neither sends CORS
// headers, so they cannot be called from the browser.
export const SUBDOMAIN_SOURCES: SubdomainSource[] = [
  {
    id: "certspotter",
    label: "Cert Spotter",
    async fetch(name, signal) {
      const found = new Set<string>();
      let after = "";
      for (let page = 0; page < CERTSPOTTER_MAX_PAGES; page++) {
        const url = new URL("https://api.certspotter.com/v1/issuances");
        url.searchParams.set("domain", name);
        url.searchParams.set("include_subdomains", "true");
        url.searchParams.set("expand", "dns_names");
        if (after) url.searchParams.set("after", after);
        const resp = await fetchOrExplain(url.toString(), {}, signal);
        if (resp.status === 429) throw new LookupError("Cert Spotter rate limit reached; try again later.");
        if (!resp.ok) throw new LookupError("Cert Spotter answered HTTP " + resp.status + ".");
        const json = await resp.json();
        for (const h of parseCertSpotter(json, name)) found.add(h);
        const last = Array.isArray(json) && json.length ? json[json.length - 1] : null;
        if (!last || typeof last.id !== "string") break;
        after = last.id;
      }
      return [...found].map((n) => ({ name: n, ip: "" }));
    },
  },
  {
    id: "hackertarget",
    label: "HackerTarget",
    async fetch(name, signal) {
      const url = "https://api.hackertarget.com/hostsearch/?q=" + encodeURIComponent(name);
      const resp = await fetchOrExplain(url, {}, signal);
      if (!resp.ok) throw new LookupError("HackerTarget answered HTTP " + resp.status + ".");
      return parseHackerTarget(await resp.text(), name);
    },
  },
];

/** What Subdomain Search asks the sources about: the Name with a leading `www.` removed. */
export function subdomainSearchName(name: string): string {
  return name.replace(/^www\./, "");
}

/** Union per-source results into one sorted list, the searched Name first. */
export function mergeSubdomains(name: string, perSource: { source: SubdomainSource; hosts: { name: string; ip: string }[] }[]): SubdomainHit[] {
  const byName = new Map<string, SubdomainHit>();
  for (const { source, hosts } of perSource) {
    for (const h of hosts) {
      const hit = byName.get(h.name) ?? { name: h.name, ip: "", sources: [] };
      if (h.ip && !hit.ip) hit.ip = h.ip;
      if (!hit.sources.includes(source.label)) hit.sources.push(source.label);
      byName.set(h.name, hit);
    }
  }
  return [...byName.values()].toSorted((a, b) => {
    if (a.name === name) return -1;
    if (b.name === name) return 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
