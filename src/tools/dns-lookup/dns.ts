// Pure DNS Lookup logic: name normalization, reverse names, record types, the
// DNS-over-HTTPS JSON wire format shared by Cloudflare and Google, and the two
// Subdomain Sources. Nothing here touches the DOM.

export interface Resolver {
  id: string;
  label: string;
  url: string;
}

export const RESOLVERS: Resolver[] = [
  {
    id: "cf",
    label: "Cloudflare 1.1.1.1",
    url: "https://cloudflare-dns.com/dns-query",
  },
  {
    id: "cfsec",
    label: "Cloudflare 1.1.1.2 (blocks malware)",
    url: "https://security.cloudflare-dns.com/dns-query",
  },
  {
    id: "cffam",
    label: "Cloudflare 1.1.1.3 (blocks malware, adult content)",
    url: "https://family.cloudflare-dns.com/dns-query",
  },
  { id: "google", label: "Google 8.8.8.8", url: "https://dns.google/resolve" },
];

const [DEFAULT_RESOLVER] = RESOLVERS;

export const resolverById = (id: string): Resolver =>
  RESOLVERS.find((r) => r.id === id) ?? DEFAULT_RESOLVER;

/** Record Types offered in the picker, grouped as displayed. ANY is left out: Resolvers refuse it. */
export const TYPE_GROUPS: { label: string; types: string[] }[] = [
  {
    label: "Common",
    types: [
      "A",
      "AAAA",
      "CNAME",
      "MX",
      "NS",
      "TXT",
      "SOA",
      "CAA",
      "SRV",
      "PTR",
    ],
  },
  { label: "Service binding", types: ["HTTPS", "SVCB"] },
  {
    label: "DNSSEC",
    types: [
      "DNSKEY",
      "DS",
      "CDS",
      "CDNSKEY",
      "RRSIG",
      "NSEC",
      "NSEC3",
      "NSEC3PARAM",
    ],
  },
  {
    label: "Other",
    types: [
      "TLSA",
      "SSHFP",
      "NAPTR",
      "DNAME",
      "HINFO",
      "LOC",
      "CERT",
      "SMIMEA",
      "OPENPGPKEY",
      "URI",
      "SPF",
    ],
  },
];

/** The Common Types: what All Types queries. */
export const COMMON_TYPES = [
  "A",
  "AAAA",
  "CNAME",
  "MX",
  "NS",
  "TXT",
  "SOA",
  "CAA",
  "SRV",
  "PTR",
  "HTTPS",
  "SVCB",
  "DNSKEY",
  "DS",
];

/** Record types we know by name, in numeric order. */
const TYPE_TABLE: [string, number][] = [
  ["A", 1],
  ["NS", 2],
  ["CNAME", 5],
  ["SOA", 6],
  ["PTR", 12],
  ["HINFO", 13],
  ["MX", 15],
  ["TXT", 16],
  ["AAAA", 28],
  ["LOC", 29],
  ["SRV", 33],
  ["NAPTR", 35],
  ["CERT", 37],
  ["DNAME", 39],
  ["OPT", 41],
  ["DS", 43],
  ["SSHFP", 44],
  ["RRSIG", 46],
  ["NSEC", 47],
  ["DNSKEY", 48],
  ["NSEC3", 50],
  ["NSEC3PARAM", 51],
  ["TLSA", 52],
  ["SMIMEA", 53],
  ["CDS", 59],
  ["CDNSKEY", 60],
  ["OPENPGPKEY", 61],
  ["SVCB", 64],
  ["HTTPS", 65],
  ["SPF", 99],
  ["URI", 256],
  ["CAA", 257],
];
const TYPE_NUMBERS = new Map(TYPE_TABLE);
const TYPE_NAMES = new Map(TYPE_TABLE.map(([name, n]) => [n, name]));

/** Name for a numeric record type, `TYPEn` for ones we do not know (RFC 3597 style). */
export const typeName = (n: number): string => TYPE_NAMES.get(n) ?? `TYPE${n}`;

export const typeNumber = (name: string): number | undefined =>
  TYPE_NUMBERS.get(name.toUpperCase());

/** A Custom type is any mnemonic or a number up to 65535; anything else is rejected before hitting the Resolver. */
export const validCustomType = (raw: string): string | null => {
  const t = raw.trim().toUpperCase();
  if (/^\d{1,5}$/u.test(t)) {
    return Number(t) <= 65_535 ? t : null;
  }
  return /^[A-Z][A-Z0-9-]{0,15}$/u.test(t) ? t : null;
};

const RCODES = new Map<number, string>([
  [0, "NOERROR"],
  [1, "FORMERR"],
  [2, "SERVFAIL"],
  [3, "NXDOMAIN"],
  [4, "NOTIMP"],
  [5, "REFUSED"],
  [6, "YXDOMAIN"],
  [7, "YXRRSET"],
  [8, "NXRRSET"],
  [9, "NOTAUTH"],
  [10, "NOTZONE"],
  [16, "BADVERS"],
]);

export const rcodeName = (status: number): string =>
  RCODES.get(status) ?? `RCODE${status}`;

/**
 * Reduce whatever was typed to a Name: trim, drop a URL scheme, userinfo,
 * port, path, query, and fragment, drop the trailing dot, lowercase.
 * Returns "" when nothing usable is left.
 */
export const normalizeName = (raw: string): string => {
  let s = raw.trim();
  s = s.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//u, "").replace(/^\/\//u, "");
  s = s.replace(/[/?#].*$/u, "");
  const at = s.lastIndexOf("@");
  if (at !== -1) {
    s = s.slice(at + 1);
  }
  if (s.startsWith("[")) {
    // Bracketed IPv6 literal, possibly with a port.
    const close = s.indexOf("]");
    s = close === -1 ? s.slice(1) : s.slice(1, close);
  } else if (/^[^:]+:\d+$/u.test(s)) {
    s = s.replace(/:\d+$/u, "");
  }
  s = s.replace(/\.+$/u, "").toLowerCase();
  return s;
};

export const isIPv4 = (s: string): boolean => {
  const parts = s.split(".");
  return (
    parts.length === 4 &&
    parts.every((p) => /^\d{1,3}$/u.test(p) && Number(p) <= 255)
  );
};

/** Expand an IPv6 address to its 32 hex nibbles, or null if it is not one. */
export const ipv6Nibbles = (s: string): string | null => {
  if (!/^[0-9a-fA-F:.]+$/u.test(s) || !s.includes(":")) {
    return null;
  }
  let addr = s.toLowerCase();
  // Embedded IPv4 tail (::ffff:1.2.3.4) becomes two hextets.
  const v4 = /(?<v4>\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/u.exec(addr)?.groups
    ?.v4;
  if (v4 !== undefined) {
    if (!isIPv4(v4)) {
      return null;
    }
    // Each byte is at most 255, so a pair is high * 256 + low.
    const [b0, b1, b2, b3] = v4.split(".").map(Number);
    addr = `${
      addr.slice(0, -v4.length) + (b0 * 256 + b1).toString(16)
    }:${(b2 * 256 + b3).toString(16)}`;
  }
  const halves = addr.split("::");
  if (halves.length > 2) {
    return null;
  }
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  // The zero groups that :: stands for. More than eight groups around it make
  // the count negative, and repeat() throws a RangeError for that.
  const zeros =
    halves.length === 2 ? [..."0".repeat(8 - head.length - tail.length)] : [];
  const groups = halves.length === 2 ? [...head, ...zeros, ...tail] : head;
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/u.test(g))) {
    return null;
  }
  return groups.map((g) => g.padStart(4, "0")).join("");
};

/** The `in-addr.arpa` / `ip6.arpa` name for an IP address, or null if the Name is not an address. */
export const reverseName = (name: string): string | null => {
  if (isIPv4(name)) {
    return `${name.split(".").toReversed().join(".")}.in-addr.arpa`;
  }
  const nibbles = ipv6Nibbles(name);
  if (nibbles) {
    return `${nibbles.split("").toReversed().join(".")}.ip6.arpa`;
  }
  return null;
};

/** Human TTL: the two largest units, e.g. "1d 6h", "5m 30s", "45s". */
export const formatTtl = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return String(seconds);
  }
  const s = Math.floor(seconds);
  const units: [string, number][] = [
    ["d", 86_400],
    ["h", 3600],
    ["m", 60],
    ["s", 1],
  ];
  for (const [i, [label, size]] of units.entries()) {
    const next = units.at(i + 1);
    if (s < size && next) {
      continue;
    }
    const minor = next ? Math.floor((s % size) / next[1]) : 0;
    return (
      Math.floor(s / size) +
      label +
      (next && minor ? ` ${minor}${next[0]}` : "")
    );
  }
  return "0s";
};

export interface DnsRecord {
  name: string;
  type: number;
  TTL: number;
  data: string;
}

/**
 * A copy of `value` with the keys in `order` first, in that order, then any
 * others. JSON.stringify writes keys in the order they were added, so this is
 * how the raw pane keeps showing an object's fields in their meaningful order
 * while the code spells its keys sorted.
 */
export const inOrder = <T extends object>(
  value: T,
  order: readonly (keyof T)[]
): T => {
  const out: Partial<T> = {};
  for (const key of order) {
    if (key in value) {
      out[key] = value[key];
    }
  }
  return Object.assign(out, value);
};

/**
 * `text` ready for a case-insensitive `iu` test that should mean ASCII case
 * only. Under the u flag, i also folds ſ (U+017F) into s and the Kelvin sign
 * (U+212A) into k, and counts them as word characters for \b. Swapping those
 * two for U+FFFD, which every pattern here treats as they would be treated
 * without u, keeps the test exactly as it was.
 */
export const asciiFold = (text: string): string =>
  text.replaceAll(/[\u017F\u212A]/gu, "\uFFFD");

/** A record's fields in the order the Resolvers send them. */
const RECORD_FIELDS: readonly (keyof DnsRecord)[] = [
  "name",
  "type",
  "TTL",
  "data",
];

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

/** A Response's fields in the order the Resolvers send them. */
const RESPONSE_FIELDS: readonly (keyof DnsResponse)[] = [
  "Status",
  "TC",
  "RD",
  "RA",
  "AD",
  "CD",
  "Question",
  "Answer",
  "Authority",
  "Additional",
  "Comment",
];

const asRecords = (v: unknown): DnsRecord[] => {
  if (!Array.isArray(v)) {
    return [];
  }
  return v
    .filter((r) => r && typeof r === "object")
    .map((r) =>
      inOrder(
        {
          TTL: Number((r as DnsRecord).TTL ?? 0),
          data: String((r as DnsRecord).data ?? ""),
          name: String((r as DnsRecord).name ?? ""),
          type: Number((r as DnsRecord).type ?? 0),
        },
        RECORD_FIELDS
      )
    );
};

/** Cloudflare's Comment is an array, Google's a string. */
const commentsOf = (comment: unknown): string[] => {
  if (Array.isArray(comment)) {
    return comment.map(String);
  }
  return typeof comment === "string" && comment ? [comment] : [];
};

/** Coerce a resolver's JSON body into a DnsResponse. Cloudflare's Comment is an array, Google's a string. */
export const parseResponse = (json: unknown): DnsResponse => {
  if (
    !json ||
    typeof json !== "object" ||
    typeof (json as { Status?: unknown }).Status !== "number"
  ) {
    throw new Error(
      "The resolver returned something that is not a DNS response."
    );
  }
  const j = json as Record<string, unknown>;
  return inOrder(
    {
      AD: Boolean(j.AD),
      Additional: asRecords(j.Additional),
      Answer: asRecords(j.Answer),
      Authority: asRecords(j.Authority),
      CD: Boolean(j.CD),
      Comment: commentsOf(j.Comment),
      Question: Array.isArray(j.Question)
        ? asRecords(j.Question).map(({ name, type }) => ({ name, type }))
        : [],
      RA: Boolean(j.RA),
      RD: Boolean(j.RD),
      Status: j.Status as number,
      TC: Boolean(j.TC),
    },
    RESPONSE_FIELDS
  );
};

export type Outcome = "records" | "empty" | "nxdomain" | "failed";

/** The three outcomes a Response can have, plus resolver-side failure (SERVFAIL, REFUSED, ...). */
export const outcomeOf = (r: DnsResponse): Outcome => {
  if (r.Status === 3) {
    return "nxdomain";
  }
  if (r.Status !== 0) {
    return "failed";
  }
  return r.Answer.length ? "records" : "empty";
};

export interface QueryOptions {
  cd: boolean;
  do: boolean;
}

/**
 * Both Resolvers take a type by name or number, but Google rejects some
 * mnemonics it does answer by number (LOC, SMIMEA, OPENPGPKEY, URI), so the
 * wire form is the number whenever we know it.
 */
export const wireType = (type: string): string => {
  const n = typeNumber(type);
  return n === undefined ? type : String(n);
};

export const queryUrl = (
  resolver: Resolver,
  name: string,
  type: string,
  opts: QueryOptions
): string => {
  const url = new URL(resolver.url);
  url.searchParams.set("name", name);
  url.searchParams.set("type", wireType(type));
  if (opts.cd) {
    url.searchParams.set("cd", "1");
  }
  if (opts.do) {
    url.searchParams.set("do", "1");
  }
  return url.toString();
};

/** Errors thrown by the fetch helpers: a message fit to show as-is. */
export class LookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LookupError";
  }
}

export const REQUEST_TIMEOUT_MS = 10_000;

const timeoutSignal = (parent: AbortSignal, ms: number): AbortSignal => {
  const ctrl = new AbortController();
  const timer = setTimeout(
    () =>
      ctrl.abort(
        new DOMException(`Timed out after ${ms / 1000} s`, "TimeoutError")
      ),
    ms
  );
  parent.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);
      ctrl.abort(parent.reason);
    },
    { once: true }
  );
  ctrl.signal.addEventListener("abort", () => clearTimeout(timer), {
    once: true,
  });
  return ctrl.signal;
};

const fetchOrExplain = async (
  url: string,
  init: RequestInit,
  signal: AbortSignal
): Promise<Response> => {
  try {
    return await fetch(url, {
      ...init,
      signal: timeoutSignal(signal, REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new LookupError(error.message);
    }
    throw new LookupError(
      `Could not reach ${new URL(url).host}. ${(error as Error).message}`
    );
  }
};

export interface LookupResult {
  response: DnsResponse;
  ms: number;
}

/** One Lookup. Rejects with LookupError on transport or HTTP failure; rethrows the abort reason if `signal` fires. */
export const lookup = async (
  resolver: Resolver,
  name: string,
  type: string,
  opts: QueryOptions,
  signal: AbortSignal
): Promise<LookupResult> => {
  const started = performance.now();
  const resp = await fetchOrExplain(
    queryUrl(resolver, name, type, opts),
    { headers: { Accept: "application/dns-json" } },
    signal
  );
  if (!resp.ok) {
    // Cloudflare explains 4xx as {"error": "..."}; Google sends an HTML page.
    let detail = "";
    try {
      const j = await resp.json();
      if (j && typeof j.error === "string") {
        detail = j.error;
      }
    } catch {
      /* not JSON */
    }
    throw new LookupError(
      `HTTP ${resp.status}${detail ? `: ${detail}` : ""} from ${resolver.label}`
    );
  }
  let json: unknown;
  try {
    json = await resp.json();
  } catch {
    throw new LookupError("The resolver did not return JSON.");
  }
  const response = parseResponse(json);
  return { ms: Math.round(performance.now() - started), response };
};

export interface SubdomainHit {
  name: string;
  /** Address reported by HackerTarget, when it has one. */
  ip: string;
  sources: string[];
}

export interface SubdomainSource {
  id: string;
  label: string;
  fetch: (
    name: string,
    signal: AbortSignal
  ) => Promise<{ name: string; ip: string }[]>;
}

/** Keep only `name` itself and hostnames beneath it; certificates list unrelated SANs too. */
export const underName = (host: string, name: string): boolean =>
  host === name || host.endsWith(`.${name}`);

const cleanHost = (h: string): string =>
  h.trim().toLowerCase().replace(/\.$/u, "");

/** A host a Subdomain Source found, with the fields in the order the raw pane shows them. */
const foundHost = (name: string, ip: string): { name: string; ip: string } =>
  inOrder({ ip, name }, ["name", "ip"]);

/** Cert Spotter issuance objects (one page) to the hostnames under `name`. */
export const parseCertSpotter = (json: unknown, name: string): string[] => {
  if (!Array.isArray(json)) {
    throw new LookupError("Cert Spotter returned an unexpected response.");
  }
  const out = new Set<string>();
  for (const issuance of json) {
    const names = (issuance as { dns_names?: unknown }).dns_names;
    if (!Array.isArray(names)) {
      continue;
    }
    for (const n of names) {
      const host = cleanHost(String(n));
      if (underName(host, name)) {
        out.add(host);
      }
    }
  }
  return [...out];
};

/** HackerTarget's `host,ip` lines. Errors come back as 200 with a one-line message. */
export const parseHackerTarget = (
  text: string,
  name: string
): { name: string; ip: string }[] => {
  const body = text.trim();
  if (!body) {
    return [];
  }
  if (/^(?:error|api count)/iu.test(body)) {
    if (/invalid host|no records/iu.test(asciiFold(body))) {
      return [];
    }
    throw new LookupError(`HackerTarget: ${body}`);
  }
  const out: { name: string; ip: string }[] = [];
  for (const line of body.split("\n")) {
    const comma = line.indexOf(",");
    const host = cleanHost(comma === -1 ? line : line.slice(0, comma));
    if (!host || !underName(host, name)) {
      continue;
    }
    out.push(foundHost(host, comma === -1 ? "" : line.slice(comma + 1).trim()));
  }
  return out;
};

/** Longest Cert Spotter walk we make per search: pages are 100 issuances and unauthenticated use is rate limited. */
export const CERTSPOTTER_MAX_PAGES = 10;

const fetchCertSpotter: SubdomainSource["fetch"] = async (name, signal) => {
  const found = new Set<string>();
  let after = "";
  for (let page = 0; page < CERTSPOTTER_MAX_PAGES; page += 1) {
    const url = new URL("https://api.certspotter.com/v1/issuances");
    url.searchParams.set("domain", name);
    url.searchParams.set("include_subdomains", "true");
    url.searchParams.set("expand", "dns_names");
    if (after) {
      url.searchParams.set("after", after);
    }
    const resp = await fetchOrExplain(url.toString(), {}, signal);
    if (resp.status === 429) {
      throw new LookupError(
        "Cert Spotter rate limit reached; try again later."
      );
    }
    if (!resp.ok) {
      throw new LookupError(`Cert Spotter answered HTTP ${resp.status}.`);
    }
    const json = await resp.json();
    for (const h of parseCertSpotter(json, name)) {
      found.add(h);
    }
    const last = Array.isArray(json) && json.length ? json.at(-1) : null;
    if (!last || typeof last.id !== "string") {
      break;
    }
    after = last.id;
  }
  return [...found].map((n) => foundHost(n, ""));
};

const fetchHackerTarget: SubdomainSource["fetch"] = async (name, signal) => {
  const url = `https://api.hackertarget.com/hostsearch/?q=${encodeURIComponent(
    name
  )}`;
  const resp = await fetchOrExplain(url, {}, signal);
  if (!resp.ok) {
    throw new LookupError(`HackerTarget answered HTTP ${resp.status}.`);
  }
  return parseHackerTarget(await resp.text(), name);
};

// crt.name and crt.sh would be the obvious sources but neither sends CORS
// headers, so they cannot be called from the browser.
export const SUBDOMAIN_SOURCES: SubdomainSource[] = [
  { fetch: fetchCertSpotter, id: "certspotter", label: "Cert Spotter" },
  { fetch: fetchHackerTarget, id: "hackertarget", label: "HackerTarget" },
];

/** What Subdomain Search asks the sources about: the Name with a leading `www.` removed. */
export const subdomainSearchName = (name: string): string =>
  name.replace(/^www\./u, "");

/** Union per-source results into one sorted list, the searched Name first. */
export const mergeSubdomains = (
  name: string,
  perSource: {
    source: SubdomainSource;
    hosts: { name: string; ip: string }[];
  }[]
): SubdomainHit[] => {
  const byName = new Map<string, SubdomainHit>();
  for (const { source, hosts } of perSource) {
    for (const h of hosts) {
      const hit = byName.get(h.name) ?? { ip: "", name: h.name, sources: [] };
      if (h.ip && !hit.ip) {
        hit.ip = h.ip;
      }
      if (!hit.sources.includes(source.label)) {
        hit.sources.push(source.label);
      }
      byName.set(h.name, hit);
    }
  }
  return [...byName.values()].toSorted((a, b) => {
    if (a.name === name) {
      return -1;
    }
    if (b.name === name) {
      return 1;
    }
    if (a.name < b.name) {
      return -1;
    }
    return a.name > b.name ? 1 : 0;
  });
};

/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
export const pool = async <T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> => {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
  return results;
};
