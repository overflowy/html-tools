// Whois via RDAP (RFC 7480-7484, 9224): registration data for domains from
// the registry that runs the TLD, and for IP addresses from the regional
// registry, found through IANA's bootstrap files. Classic port-43 WHOIS is
// not reachable from a browser; RDAP is its HTTPS/JSON replacement.
import { ipv6Nibbles, isIPv4, LookupError } from "./dns";
import type { Finding, Verdict } from "./email";

/** IANA bootstrap file: each service is [keys, urls]. Keys are TLDs (dns.json) or CIDR prefixes (ipv4/ipv6.json). */
export interface Bootstrap {
  services: [string[], string[]][];
}

export const BOOTSTRAP_URLS = {
  dns: "https://data.iana.org/rdap/dns.json",
  ipv4: "https://data.iana.org/rdap/ipv4.json",
  ipv6: "https://data.iana.org/rdap/ipv6.json",
};

function httpsFirst(urls: string[]): string | null {
  const u = urls.find((x) => x.startsWith("https://")) ?? urls[0];
  return u ? (u.endsWith("/") ? u : u + "/") : null;
}

/** The RDAP base URL for a domain's TLD, or null when the registry publishes no RDAP. */
export function dnsService(bootstrap: Bootstrap, name: string): string | null {
  const tld = name.split(".").pop()!.toLowerCase();
  for (const [keys, urls] of bootstrap.services) {
    if (keys.some((k) => k.toLowerCase() === tld)) return httpsFirst(urls);
  }
  return null;
}

function ipToBigInt(ip: string): { value: bigint; bits: number } | null {
  if (isIPv4(ip)) {
    return { value: ip.split(".").reduce((acc, p) => (acc << 8n) | BigInt(p), 0n), bits: 32 };
  }
  const nibbles = ipv6Nibbles(ip);
  return nibbles ? { value: BigInt("0x" + nibbles), bits: 128 } : null;
}

/** Whether `ip` falls inside `cidr`, same address family only. */
export function ipInCidr(ip: string, cidr: string): boolean {
  const [base, lenText] = cidr.split("/");
  const a = ipToBigInt(ip);
  const b = ipToBigInt(base ?? "");
  if (!a || !b || a.bits !== b.bits) return false;
  const len = Number(lenText);
  if (!Number.isInteger(len) || len < 0 || len > a.bits) return false;
  const shift = BigInt(a.bits - len);
  return a.value >> shift === b.value >> shift;
}

/** The RDAP base URL of the regional registry holding an address (longest matching prefix). */
export function ipService(bootstrap: Bootstrap, ip: string): string | null {
  let best: { len: number; url: string | null } | null = null;
  for (const [keys, urls] of bootstrap.services) {
    for (const cidr of keys) {
      const len = Number(cidr.split("/")[1]);
      if (ipInCidr(ip, cidr) && (!best || len > best.len)) best = { len, url: httpsFirst(urls) };
    }
  }
  return best?.url ?? null;
}

// ---- response parsing ----

type Vcard = [string, Record<string, unknown>, string, unknown];

interface Entity {
  handle?: string;
  roles?: string[];
  vcardArray?: ["vcard", Vcard[]];
  publicIds?: { type: string; identifier: string }[];
  entities?: Entity[];
}

function vcardField(e: Entity, field: string): string {
  const arr = e.vcardArray?.[1];
  if (!Array.isArray(arr)) return "";
  const hit = arr.find((v) => Array.isArray(v) && v[0] === field);
  if (!hit) return "";
  const value = hit[3];
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.filter((x) => typeof x === "string" && x).join(", ");
  if (typeof hit[1]?.label === "string") return hit[1].label;
  return "";
}

function entitiesWithRole(list: Entity[] | undefined, role: string): Entity[] {
  const out: Entity[] = [];
  for (const e of list ?? []) {
    if (e.roles?.includes(role)) out.push(e);
    out.push(...entitiesWithRole(e.entities, role));
  }
  return out;
}

export interface Contact {
  name: string;
  email: string;
  phone: string;
}

function contactOf(e: Entity | undefined): Contact | null {
  if (!e) return null;
  const c = { name: vcardField(e, "fn") || vcardField(e, "org"), email: vcardField(e, "email"), phone: vcardField(e, "tel").replace(/^tel:/, "") };
  return c.name || c.email || c.phone ? c : null;
}

export interface RdapEvent {
  action: string;
  date: string;
}

function eventsOf(json: { events?: unknown }): RdapEvent[] {
  if (!Array.isArray(json.events)) return [];
  return json.events
    .filter((e) => e && typeof e === "object" && typeof (e as { eventAction?: unknown }).eventAction === "string")
    .map((e) => ({ action: String((e as { eventAction: string }).eventAction), date: String((e as { eventDate?: string }).eventDate ?? "") }));
}

export interface DomainInfo {
  name: string;
  handle: string;
  status: string[];
  events: RdapEvent[];
  registrar: { name: string; ianaId: string; abuse: Contact | null } | null;
  registrant: Contact | null;
  nameservers: string[];
  /** null when the registry did not say. */
  dnssec: boolean | null;
  dsRecords: number;
  /** The URL the answer came from, for the "view at the registry" link. */
  url: string;
}

export function parseDomain(json: unknown, url: string): DomainInfo {
  const j = json as Record<string, unknown>;
  if (!j || typeof j !== "object" || j.objectClassName !== "domain") throw new LookupError("The registry returned something that is not an RDAP domain object.");
  const entities = Array.isArray(j.entities) ? (j.entities as Entity[]) : [];
  const registrarEntity = entitiesWithRole(entities, "registrar")[0];
  const registrar = registrarEntity
    ? {
        name: vcardField(registrarEntity, "fn"),
        ianaId: registrarEntity.publicIds?.find((p) => /IANA Registrar ID/i.test(p.type))?.identifier ?? registrarEntity.handle ?? "",
        abuse: contactOf(entitiesWithRole([registrarEntity], "abuse")[0]),
      }
    : null;
  const secure = j.secureDNS as { delegationSigned?: boolean; dsData?: unknown[] } | undefined;
  return {
    name: String(j.ldhName ?? j.unicodeName ?? "").toLowerCase(),
    handle: String(j.handle ?? ""),
    status: Array.isArray(j.status) ? j.status.map(String) : [],
    events: eventsOf(j),
    registrar,
    registrant: contactOf(entitiesWithRole(entities, "registrant").find((e) => !e.roles?.includes("registrar"))),
    nameservers: Array.isArray(j.nameservers)
      ? j.nameservers.map((n) => String((n as { ldhName?: string }).ldhName ?? "").toLowerCase().replace(/\.$/, "")).filter(Boolean)
      : [],
    dnssec: typeof secure?.delegationSigned === "boolean" ? secure.delegationSigned : null,
    dsRecords: Array.isArray(secure?.dsData) ? secure.dsData.length : 0,
    url,
  };
}

/**
 * RIRs list several "registrant" entities for a network: the organisation,
 * and (at RIPE) the maintainer objects that guard it. Prefer the organisation.
 */
function pickHolder(entities: Entity[]): Entity | undefined {
  const registrants = entitiesWithRole(entities, "registrant");
  const isMaintainer = (e: Entity) => /^MNT-|-MNT$/i.test(e.handle ?? "") || /^MNT-|-MNT$/i.test(vcardField(e, "fn"));
  return registrants.find((e) => /^ORG-/i.test(e.handle ?? "") || vcardField(e, "kind") === "org")
    ?? registrants.find((e) => !isMaintainer(e))
    ?? registrants[0]
    ?? entitiesWithRole(entities, "administrative")[0];
}

export interface IpInfo {
  handle: string;
  start: string;
  end: string;
  cidrs: string[];
  version: string;
  name: string;
  type: string;
  country: string;
  status: string[];
  events: RdapEvent[];
  holder: Contact | null;
  abuse: Contact | null;
  url: string;
}

export function parseIp(json: unknown, url: string): IpInfo {
  const j = json as Record<string, unknown>;
  if (!j || typeof j !== "object" || j.objectClassName !== "ip network") throw new LookupError("The registry returned something that is not an RDAP IP network object.");
  const entities = Array.isArray(j.entities) ? (j.entities as Entity[]) : [];
  const cidrs = Array.isArray(j.cidr0_cidrs)
    ? (j.cidr0_cidrs as { v4prefix?: string; v6prefix?: string; length?: number }[]).map((c) => (c.v4prefix ?? c.v6prefix ?? "") + "/" + c.length).filter((c) => !c.startsWith("/"))
    : [];
  return {
    handle: String(j.handle ?? ""),
    start: String(j.startAddress ?? ""),
    end: String(j.endAddress ?? ""),
    cidrs,
    version: String(j.ipVersion ?? ""),
    name: String(j.name ?? ""),
    type: String(j.type ?? ""),
    country: String(j.country ?? ""),
    status: Array.isArray(j.status) ? j.status.map(String) : [],
    events: eventsOf(j),
    holder: contactOf(pickHolder(entities)),
    abuse: contactOf(entitiesWithRole(entities, "abuse")[0]),
    url,
  };
}

// ---- judgement ----

/** EPP status values as RDAP spells them (RFC 8056), with what each means for the domain's owner. */
export const STATUS_MEANING: Record<string, string> = {
  "active": "No restrictions.",
  "ok": "No restrictions.",
  "inactive": "No nameservers delegated: the domain does not resolve.",
  "client transfer prohibited": "Registrar lock against transfers. Normal protection.",
  "client delete prohibited": "Registrar lock against deletion. Normal protection.",
  "client update prohibited": "Registrar lock against changes. Normal protection.",
  "client renew prohibited": "The registrar blocks renewal.",
  "client hold": "The registrar has suspended the domain: it does not resolve.",
  "server transfer prohibited": "Registry lock against transfers (often a paid registry lock).",
  "server delete prohibited": "Registry lock against deletion.",
  "server update prohibited": "Registry lock against changes.",
  "server renew prohibited": "The registry blocks renewal.",
  "server hold": "The registry has suspended the domain: it does not resolve. Usually a dispute or compliance issue.",
  "pending create": "Registration in progress.",
  "pending delete": "Being deleted; it will become available soon.",
  "pending renew": "Renewal in progress.",
  "pending restore": "Being restored from the redemption period.",
  "pending transfer": "A transfer to another registrar is under way.",
  "pending update": "A change is being processed.",
  "redemption period": "Expired and deleted by the registrar; the owner can still restore it for a fee.",
  "add period": "Registered within the last few days.",
  "auto renew period": "Auto-renewed by the registry; the registrar can still reverse it.",
  "renew period": "Renewed within the last few days.",
  "transfer period": "Transferred within the last few days.",
  "locked": "Locked by the registry.",
  "associated": "Associated with other objects.",
};

const STATUS_LEVEL: Record<string, Verdict> = {
  "inactive": "fail",
  "client hold": "fail",
  "server hold": "fail",
  "pending delete": "fail",
  "redemption period": "fail",
  "pending transfer": "warn",
  "auto renew period": "warn",
};

function eventDate(events: RdapEvent[], action: string): Date | null {
  const e = events.find((x) => x.action === action);
  if (!e) return null;
  const d = new Date(e.date);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface DomainReport {
  verdict: Verdict;
  info: DomainInfo;
  findings: Finding[];
}

/** Findings for a domain: expiry, status, DNSSEC, and how the registry delegation compares with the zone's own NS set. */
export function judgeDomain(info: DomainInfo, zoneNameservers: string[] | null, now = new Date()): DomainReport {
  const findings: Finding[] = [];
  const day = 86400000;
  const registered = eventDate(info.events, "registration");
  const expires = eventDate(info.events, "expiration");
  const changed = eventDate(info.events, "last changed");
  if (registered) {
    const years = Math.floor((now.getTime() - registered.getTime()) / (365.25 * day));
    findings.push({ level: "none", text: "Registered " + isoDay(registered) + (years > 0 ? " (" + years + " year" + (years === 1 ? "" : "s") + " ago)" : "") + "." });
  }
  if (expires) {
    const days = Math.floor((expires.getTime() - now.getTime()) / day);
    if (days < 0) findings.push({ level: "fail", text: "Expired on " + isoDay(expires) + "." });
    else if (days <= 30) findings.push({ level: "warn", text: "Expires on " + isoDay(expires) + ", in " + days + " day" + (days === 1 ? "" : "s") + "." });
    else findings.push({ level: "ok", text: "Expires on " + isoDay(expires) + ", in " + days + " days." });
  } else {
    findings.push({ level: "none", text: "The registry does not publish an expiry date." });
  }
  if (changed) findings.push({ level: "none", text: "Last changed " + isoDay(changed) + "." });
  for (const s of info.status) {
    const key = s.toLowerCase();
    const level = STATUS_LEVEL[key] ?? "none";
    findings.push({ level, text: s + ": " + (STATUS_MEANING[key] ?? "Registry-specific status.") });
  }
  if (info.dnssec === true) findings.push({ level: "ok", text: "DNSSEC: the delegation is signed" + (info.dsRecords ? " (" + info.dsRecords + " DS record" + (info.dsRecords === 1 ? "" : "s") + " at the registry)" : "") + "." });
  else if (info.dnssec === false) findings.push({ level: "none", text: "DNSSEC: no DS records at the registry; the delegation is unsigned." });
  if (zoneNameservers && info.nameservers.length) {
    const reg = new Set(info.nameservers);
    const zone = new Set(zoneNameservers.map((n) => n.toLowerCase().replace(/\.$/, "")));
    const onlyRegistry = [...reg].filter((n) => !zone.has(n));
    const onlyZone = [...zone].filter((n) => !reg.has(n));
    if (onlyRegistry.length || onlyZone.length) {
      findings.push({
        level: "warn",
        text: "Nameservers at the registry differ from the zone's NS records" +
          (onlyRegistry.length ? "; only at the registry: " + onlyRegistry.join(", ") : "") +
          (onlyZone.length ? "; only in the zone: " + onlyZone.join(", ") : "") + ". Resolvers may use either set.",
      });
    } else {
      findings.push({ level: "ok", text: "Nameservers at the registry match the zone's NS records." });
    }
  }
  return { verdict: worstOf(findings), info, findings };
}

function worstOf(findings: Finding[]): Verdict {
  const rank: Record<Verdict, number> = { none: 0, ok: 1, warn: 2, fail: 3 };
  return findings.reduce<Verdict>((v, f) => (rank[f.level] > rank[v] ? f.level : v), "none");
}

// ---- fetching ----

export interface RdapFetch {
  (url: string): Promise<{ status: number; json: unknown }>;
}

/** GET with the RDAP media type. Status 0 means the browser could not read the response (CORS or network). */
export async function rdapFetch(url: string, signal: AbortSignal): Promise<{ status: number; json: unknown }> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { Accept: "application/rdap+json" }, signal });
  } catch (e) {
    if (signal.aborted) throw e;
    return { status: 0, json: null };
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch { /* not JSON, status tells the story */ }
  return { status: res.status, json };
}

const bootstrapCache = new Map<string, Promise<Bootstrap>>();

/** IANA bootstrap files change rarely; fetch each once per page load. */
export function loadBootstrap(url: string, fetcher: RdapFetch): Promise<Bootstrap> {
  let p = bootstrapCache.get(url);
  if (!p) {
    p = fetcher(url).then(({ status, json }) => {
      const b = json as Bootstrap;
      if (status !== 200 || !b || !Array.isArray(b.services)) throw new LookupError("Could not load IANA's RDAP bootstrap file (HTTP " + status + ").");
      return b;
    });
    p.catch(() => bootstrapCache.delete(url));
    bootstrapCache.set(url, p);
  }
  return p;
}

export function explainStatus(status: number, what: string): string {
  if (status === 0) return "The registry's RDAP server did not let the browser read the answer for " + what + " (no CORS headers or unreachable).";
  if (status === 429) return "The registry's RDAP server is rate limiting; try again in a minute.";
  return "The registry's RDAP server answered HTTP " + status + " for " + what + ".";
}

/** IANA's page for a TLD, which names its WHOIS server when there is no RDAP. */
export function ianaTldPage(name: string): string {
  return "https://www.iana.org/domains/root/db/" + name.split(".").pop()!.toLowerCase() + ".html";
}

export type DomainLookup =
  | { kind: "found"; info: DomainInfo; tried: string[] }
  | { kind: "no-rdap"; tld: string }
  | { kind: "not-found"; tried: string[] }
  | { kind: "error"; message: string; unreadable: boolean };

/**
 * Registries answer only for the registered name, so `www.example.co.uk`
 * is retried as `example.co.uk` and so on until something answers or only
 * the TLD is left. That avoids bundling the public suffix list.
 */
export async function lookupDomain(name: string, bootstrap: Bootstrap, fetcher: RdapFetch): Promise<DomainLookup> {
  const base = dnsServiceWithSupplement(bootstrap, name);
  if (!base) return { kind: "no-rdap", tld: name.split(".").pop()! };
  const labels = name.split(".");
  const tried: string[] = [];
  for (let i = 0; i < labels.length - 1 && i < 6; i++) {
    const candidate = labels.slice(i).join(".");
    tried.push(candidate);
    const url = base + "domain/" + candidate;
    const { status, json } = await fetcher(url);
    if (status === 200) return { kind: "found", info: parseDomain(json, url), tried };
    // 404 is "no such domain"; some registries (SWITCH) say 400 for a name with too many labels.
    if (status !== 404 && status !== 400) return { kind: "error", message: explainStatus(status, candidate), unreadable: status === 0 };
  }
  return { kind: "not-found", tried };
}

export type IpLookup =
  | { kind: "found"; info: IpInfo }
  | { kind: "error"; message: string };

export async function lookupIp(ip: string, bootstrap: Bootstrap, fetcher: RdapFetch): Promise<IpLookup> {
  const base = ipService(bootstrap, ip);
  if (!base) return { kind: "error", message: "No regional registry claims " + ip + " in IANA's bootstrap file." };
  const url = base + "ip/" + ip;
  const { status, json } = await fetcher(url);
  if (status !== 200) return { kind: "error", message: explainStatus(status, ip) };
  return { kind: "found", info: parseIp(json, url) };
}

// ---- supplements and fallback ----

/**
 * Registries that run RDAP but are missing from IANA's bootstrap file, checked
 * for CORS by hand. DENIC (.de) also runs one, without CORS, so it is not here.
 */
export const RDAP_SUPPLEMENT: Record<string, string> = {
  ch: "https://rdap.nic.ch/",
  li: "https://rdap.nic.ch/",
  pl: "https://rdap.dns.pl/",
  us: "https://rdap.nic.us/",
  io: "https://rdap.identitydigital.services/rdap/",
};

/** IANA's bootstrap first, then the supplement. */
export function dnsServiceWithSupplement(bootstrap: Bootstrap, name: string): string | null {
  return dnsService(bootstrap, name) ?? RDAP_SUPPLEMENT[name.split(".").pop()!.toLowerCase()] ?? null;
}

export interface TextFetch {
  (url: string): Promise<{ status: number; text: string }>;
}

export const WHOIS_FALLBACK_URL = "https://api.whois.vu/?q=";

export interface WhoisText {
  domain: string;
  available: boolean | null;
  registrar: string;
  statuses: string[];
  /** ISO dates, when the proxy managed to parse them out of the text. */
  created: string | null;
  updated: string | null;
  expires: string | null;
  text: string;
}

function epochToIso(v: unknown): string | null {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString().slice(0, 10) : null;
}

/** The whois.vu proxy's JSON: a few fields it parsed, and the registry's WHOIS output verbatim. */
export function parseWhoisText(json: unknown): WhoisText {
  const j = json as Record<string, unknown>;
  if (!j || typeof j !== "object" || typeof j.whois !== "string") throw new LookupError("The WHOIS proxy returned something unexpected.");
  return {
    domain: String(j.domain ?? j.ip ?? ""),
    available: j.available === "yes" ? true : j.available === "no" ? false : null,
    registrar: typeof j.registrar === "string" ? j.registrar : "",
    statuses: Array.isArray(j.statuses) ? j.statuses.map(String).filter(Boolean) : [],
    created: epochToIso(j.created),
    updated: epochToIso(j.updated),
    expires: epochToIso(j.expires),
    text: j.whois.replace(/\r\n/g, "\n").trim(),
  };
}

export function judgeWhoisText(w: WhoisText, now = new Date()): { verdict: Verdict; findings: Finding[] } {
  const findings: Finding[] = [];
  if (w.available === true) {
    findings.push({ level: "none", text: "Not registered." });
    return { verdict: "none", findings };
  }
  if (w.created) findings.push({ level: "none", text: "Registered " + w.created + "." });
  if (w.expires) {
    const days = Math.floor((new Date(w.expires).getTime() - now.getTime()) / 86400000);
    if (days < 0) findings.push({ level: "fail", text: "Expired on " + w.expires + "." });
    else if (days <= 30) findings.push({ level: "warn", text: "Expires on " + w.expires + ", in " + days + " day" + (days === 1 ? "" : "s") + "." });
    else findings.push({ level: "ok", text: "Expires on " + w.expires + ", in " + days + " days." });
  }
  if (w.updated) findings.push({ level: "none", text: "Last changed " + w.updated + "." });
  for (const s of w.statuses) {
    const key = s.toLowerCase();
    findings.push({ level: STATUS_LEVEL[key] ?? "none", text: s + (STATUS_MEANING[key] ? ": " + STATUS_MEANING[key] : "") });
  }
  findings.push({ level: "none", text: "Raw WHOIS via whois.vu, a third-party proxy; the registry's own output is shown below." });
  return { verdict: worstOf(findings), findings };
}

export async function lookupWhoisText(name: string, fetcher: TextFetch): Promise<WhoisText> {
  const { status, text } = await fetcher(WHOIS_FALLBACK_URL + encodeURIComponent(name));
  if (status === 0) throw new LookupError("The WHOIS proxy (whois.vu) could not be reached from the browser.");
  if (status !== 200) throw new LookupError("The WHOIS proxy (whois.vu) answered HTTP " + status + ".");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new LookupError("The WHOIS proxy (whois.vu) did not return JSON.");
  }
  return parseWhoisText(json);
}
