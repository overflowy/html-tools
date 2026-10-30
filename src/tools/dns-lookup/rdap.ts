// Whois via RDAP (RFC 7480-7484, 9224): registration data for domains from
// the registry that runs the TLD, and for IP addresses from the regional
// registry, found through IANA's bootstrap files. Classic port-43 WHOIS is
// not reachable from a browser; RDAP is its HTTPS/JSON replacement.
import { asciiFold, inOrder, ipv6Nibbles, isIPv4, LookupError } from "./dns";
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

const httpsFirst = (urls: string[]): string | null => {
  const u = urls.find((x) => x.startsWith("https://")) ?? urls[0];
  if (!u) {
    return null;
  }
  return u.endsWith("/") ? u : `${u}/`;
};

/** The last label of a name, as typed. */
export const tldOf = (name: string): string =>
  name.slice(name.lastIndexOf(".") + 1);

/** The RDAP base URL for a domain's TLD, or null when the registry publishes no RDAP. */
export const dnsService = (
  bootstrap: Bootstrap,
  name: string
): string | null => {
  const tld = tldOf(name).toLowerCase();
  for (const [keys, urls] of bootstrap.services) {
    if (keys.some((k) => k.toLowerCase() === tld)) {
      return httpsFirst(urls);
    }
  }
  return null;
};

const ipToBigInt = (ip: string): { value: bigint; bits: number } | null => {
  if (isIPv4(ip)) {
    // Each part is a byte, so the address is the parts as base-256 digits.
    let value = 0n;
    for (const p of ip.split(".")) {
      value = value * 256n + BigInt(p);
    }
    return { bits: 32, value };
  }
  const nibbles = ipv6Nibbles(ip);
  return nibbles ? { bits: 128, value: BigInt(`0x${nibbles}`) } : null;
};

/** Whether `ip` falls inside `cidr`, same address family only. */
export const ipInCidr = (ip: string, cidr: string): boolean => {
  const [base, lenText] = cidr.split("/");
  const a = ipToBigInt(ip);
  const b = ipToBigInt(base ?? "");
  if (!a || !b || a.bits !== b.bits) {
    return false;
  }
  const len = Number(lenText);
  if (!Number.isInteger(len) || len < 0 || len > a.bits) {
    return false;
  }
  // The addresses agree on the first `len` bits when they do after dropping the rest.
  const scale = 2n ** BigInt(a.bits - len);
  return a.value / scale === b.value / scale;
};

/** The RDAP base URL of the regional registry holding an address (longest matching prefix). */
export const ipService = (bootstrap: Bootstrap, ip: string): string | null => {
  let best: { len: number; url: string | null } | null = null;
  for (const [keys, urls] of bootstrap.services) {
    for (const cidr of keys) {
      const len = Number(cidr.split("/")[1]);
      if (ipInCidr(ip, cidr) && (!best || len > best.len)) {
        best = { len, url: httpsFirst(urls) };
      }
    }
  }
  return best?.url ?? null;
};

// ---- response parsing ----

type Vcard = [string, Record<string, unknown>, string, unknown];

interface Entity {
  handle?: string;
  roles?: string[];
  vcardArray?: ["vcard", Vcard[]];
  publicIds?: { type: string; identifier: string }[];
  entities?: Entity[];
}

const vcardField = (e: Entity, field: string): string => {
  const arr = e.vcardArray?.[1];
  if (!Array.isArray(arr)) {
    return "";
  }
  const hit = arr.find((v) => Array.isArray(v) && v[0] === field);
  if (!hit) {
    return "";
  }
  const [, params, , value] = hit;
  if (typeof value === "string") {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value.filter((x) => typeof x === "string" && x).join(", ");
  }
  if (typeof params?.label === "string") {
    return params.label;
  }
  return "";
};

const entitiesWithRole = (
  list: Entity[] | undefined,
  role: string
): Entity[] => {
  const out: Entity[] = [];
  for (const e of list ?? []) {
    if (e.roles?.includes(role)) {
      out.push(e);
    }
    out.push(...entitiesWithRole(e.entities, role));
  }
  return out;
};

export interface Contact {
  name: string;
  email: string;
  phone: string;
}

const contactOf = (e: Entity | undefined): Contact | null => {
  if (!e) {
    return null;
  }
  const c = {
    email: vcardField(e, "email"),
    name: vcardField(e, "fn") || vcardField(e, "org"),
    phone: vcardField(e, "tel").replace(/^tel:/u, ""),
  };
  return c.name || c.email || c.phone ? c : null;
};

export interface RdapEvent {
  action: string;
  date: string;
}

const eventsOf = (json: { events?: unknown }): RdapEvent[] => {
  if (!Array.isArray(json.events)) {
    return [];
  }
  return json.events
    .filter(
      (e) =>
        e &&
        typeof e === "object" &&
        typeof (e as { eventAction?: unknown }).eventAction === "string"
    )
    .map((e) => ({
      action: String((e as { eventAction: string }).eventAction),
      date: String((e as { eventDate?: string }).eventDate ?? ""),
    }));
};

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

export const parseDomain = (json: unknown, url: string): DomainInfo => {
  const j = json as Record<string, unknown>;
  if (!j || typeof j !== "object" || j.objectClassName !== "domain") {
    throw new LookupError(
      "The registry returned something that is not an RDAP domain object."
    );
  }
  const entities = Array.isArray(j.entities) ? (j.entities as Entity[]) : [];
  const registrarEntity = entitiesWithRole(entities, "registrar").at(0);
  const registrar = registrarEntity
    ? {
        abuse: contactOf(entitiesWithRole([registrarEntity], "abuse").at(0)),
        ianaId:
          registrarEntity.publicIds?.find((p) =>
            /IANA Registrar ID/iu.test(asciiFold(p.type))
          )?.identifier ??
          registrarEntity.handle ??
          "",
        name: vcardField(registrarEntity, "fn"),
      }
    : null;
  const secure = j.secureDNS as
    | { delegationSigned?: boolean; dsData?: unknown[] }
    | undefined;
  return {
    dnssec:
      typeof secure?.delegationSigned === "boolean"
        ? secure.delegationSigned
        : null,
    dsRecords: Array.isArray(secure?.dsData) ? secure.dsData.length : 0,
    events: eventsOf(j),
    handle: String(j.handle ?? ""),
    name: String(j.ldhName ?? j.unicodeName ?? "").toLowerCase(),
    nameservers: Array.isArray(j.nameservers)
      ? j.nameservers
          .map((n) =>
            String((n as { ldhName?: string }).ldhName ?? "")
              .toLowerCase()
              .replace(/\.$/u, "")
          )
          .filter(Boolean)
      : [],
    registrant: contactOf(
      entitiesWithRole(entities, "registrant").find(
        (e) => !e.roles?.includes("registrar")
      )
    ),
    registrar,
    status: Array.isArray(j.status) ? j.status.map(String) : [],
    url,
  };
};

/**
 * RIRs list several "registrant" entities for a network: the organisation,
 * and (at RIPE) the maintainer objects that guard it. Prefer the organisation.
 */
const pickHolder = (entities: Entity[]): Entity | undefined => {
  const registrants = entitiesWithRole(entities, "registrant");
  const isMaintainer = (e: Entity) =>
    /^MNT-|-MNT$/iu.test(e.handle ?? "") ||
    /^MNT-|-MNT$/iu.test(vcardField(e, "fn"));
  return (
    registrants.find(
      (e) => /^ORG-/iu.test(e.handle ?? "") || vcardField(e, "kind") === "org"
    ) ??
    registrants.find((e) => !isMaintainer(e)) ??
    registrants[0] ??
    entitiesWithRole(entities, "administrative")[0]
  );
};

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

export const parseIp = (json: unknown, url: string): IpInfo => {
  const j = json as Record<string, unknown>;
  if (!j || typeof j !== "object" || j.objectClassName !== "ip network") {
    throw new LookupError(
      "The registry returned something that is not an RDAP IP network object."
    );
  }
  const entities = Array.isArray(j.entities) ? (j.entities as Entity[]) : [];
  const cidrs = Array.isArray(j.cidr0_cidrs)
    ? (
        j.cidr0_cidrs as {
          v4prefix?: string;
          v6prefix?: string;
          length?: number;
        }[]
      )
        .map((c) => `${c.v4prefix ?? c.v6prefix ?? ""}/${c.length}`)
        .filter((c) => !c.startsWith("/"))
    : [];
  return {
    abuse: contactOf(entitiesWithRole(entities, "abuse").at(0)),
    cidrs,
    country: String(j.country ?? ""),
    end: String(j.endAddress ?? ""),
    events: eventsOf(j),
    handle: String(j.handle ?? ""),
    holder: contactOf(pickHolder(entities)),
    name: String(j.name ?? ""),
    start: String(j.startAddress ?? ""),
    status: Array.isArray(j.status) ? j.status.map(String) : [],
    type: String(j.type ?? ""),
    url,
    version: String(j.ipVersion ?? ""),
  };
};

// ---- judgement ----

/** EPP status values as RDAP spells them (RFC 8056), with what each means for the domain's owner. */
export const STATUS_MEANING: Record<string, string> = {
  active: "No restrictions.",
  "add period": "Registered within the last few days.",
  associated: "Associated with other objects.",
  "auto renew period":
    "Auto-renewed by the registry; the registrar can still reverse it.",
  "client delete prohibited":
    "Registrar lock against deletion. Normal protection.",
  "client hold": "The registrar has suspended the domain: it does not resolve.",
  "client renew prohibited": "The registrar blocks renewal.",
  "client transfer prohibited":
    "Registrar lock against transfers. Normal protection.",
  "client update prohibited":
    "Registrar lock against changes. Normal protection.",
  inactive: "No nameservers delegated: the domain does not resolve.",
  locked: "Locked by the registry.",
  ok: "No restrictions.",
  "pending create": "Registration in progress.",
  "pending delete": "Being deleted; it will become available soon.",
  "pending renew": "Renewal in progress.",
  "pending restore": "Being restored from the redemption period.",
  "pending transfer": "A transfer to another registrar is under way.",
  "pending update": "A change is being processed.",
  "redemption period":
    "Expired and deleted by the registrar; the owner can still restore it for a fee.",
  "renew period": "Renewed within the last few days.",
  "server delete prohibited": "Registry lock against deletion.",
  "server hold":
    "The registry has suspended the domain: it does not resolve. Usually a dispute or compliance issue.",
  "server renew prohibited": "The registry blocks renewal.",
  "server transfer prohibited":
    "Registry lock against transfers (often a paid registry lock).",
  "server update prohibited": "Registry lock against changes.",
  "transfer period": "Transferred within the last few days.",
};

const STATUS_LEVEL: Record<string, Verdict> = {
  "auto renew period": "warn",
  "client hold": "fail",
  inactive: "fail",
  "pending delete": "fail",
  "pending transfer": "warn",
  "redemption period": "fail",
  "server hold": "fail",
};

const eventDate = (events: RdapEvent[], action: string): Date | null => {
  const e = events.find((x) => x.action === action);
  if (!e) {
    return null;
  }
  const d = new Date(e.date);
  return Number.isNaN(d.getTime()) ? null : d;
};

const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

const RANK: Record<Verdict, number> = { fail: 3, none: 0, ok: 1, warn: 2 };

const worstOf = (findings: Finding[]): Verdict => {
  let verdict: Verdict = "none";
  for (const f of findings) {
    if (RANK[f.level] > RANK[verdict]) {
      verdict = f.level;
    }
  }
  return verdict;
};

/** Age at the registry, the expiry date and how near it is, and the last change. */
const dateFindings = (info: DomainInfo, now: Date): Finding[] => {
  const findings: Finding[] = [];
  const day = 86_400_000;
  const registered = eventDate(info.events, "registration");
  const expires = eventDate(info.events, "expiration");
  const changed = eventDate(info.events, "last changed");
  if (registered) {
    const years = Math.floor(
      (now.getTime() - registered.getTime()) / (365.25 * day)
    );
    findings.push({
      level: "none",
      text: `Registered ${isoDay(registered)}${
        years > 0 ? ` (${years} year${years === 1 ? "" : "s"} ago)` : ""
      }.`,
    });
  }
  if (expires) {
    const days = Math.floor((expires.getTime() - now.getTime()) / day);
    if (days < 0) {
      findings.push({
        level: "fail",
        text: `Expired on ${isoDay(expires)}.`,
      });
    } else if (days <= 30) {
      findings.push({
        level: "warn",
        text: `Expires on ${isoDay(expires)}, in ${days} day${
          days === 1 ? "" : "s"
        }.`,
      });
    } else {
      findings.push({
        level: "ok",
        text: `Expires on ${isoDay(expires)}, in ${days} days.`,
      });
    }
  } else {
    findings.push({
      level: "none",
      text: "The registry does not publish an expiry date.",
    });
  }
  if (changed) {
    findings.push({
      level: "none",
      text: `Last changed ${isoDay(changed)}.`,
    });
  }
  return findings;
};

export interface DomainReport {
  verdict: Verdict;
  info: DomainInfo;
  findings: Finding[];
}

/** Findings for a domain: expiry, status, DNSSEC, and how the registry delegation compares with the zone's own NS set. */
export const judgeDomain = (
  info: DomainInfo,
  zoneNameservers: string[] | null,
  now = new Date()
): DomainReport => {
  const findings = dateFindings(info, now);
  for (const s of info.status) {
    const key = s.toLowerCase();
    const level = STATUS_LEVEL[key] ?? "none";
    findings.push({
      level,
      text: `${s}: ${STATUS_MEANING[key] ?? "Registry-specific status."}`,
    });
  }
  if (info.dnssec === true) {
    findings.push({
      level: "ok",
      text: `DNSSEC: the delegation is signed${
        info.dsRecords
          ? ` (${info.dsRecords} DS record${
              info.dsRecords === 1 ? "" : "s"
            } at the registry)`
          : ""
      }.`,
    });
  } else if (info.dnssec === false) {
    findings.push({
      level: "none",
      text: "DNSSEC: no DS records at the registry; the delegation is unsigned.",
    });
  }
  if (zoneNameservers && info.nameservers.length) {
    const reg = new Set(info.nameservers);
    const zone = new Set(
      zoneNameservers.map((n) => n.toLowerCase().replace(/\.$/u, ""))
    );
    const onlyRegistry = [...reg].filter((n) => !zone.has(n));
    const onlyZone = [...zone].filter((n) => !reg.has(n));
    if (onlyRegistry.length || onlyZone.length) {
      findings.push({
        level: "warn",
        text: `Nameservers at the registry differ from the zone's NS records${
          onlyRegistry.length
            ? `; only at the registry: ${onlyRegistry.join(", ")}`
            : ""
        }${
          onlyZone.length ? `; only in the zone: ${onlyZone.join(", ")}` : ""
        }. Resolvers may use either set.`,
      });
    } else {
      findings.push({
        level: "ok",
        text: "Nameservers at the registry match the zone's NS records.",
      });
    }
  }
  return { findings, info, verdict: worstOf(findings) };
};

// ---- fetching ----

export type RdapFetch = (
  url: string
) => Promise<{ status: number; json: unknown }>;

/** GET with the RDAP media type. Status 0 means the browser could not read the response (CORS or network). */
export const rdapFetch = async (
  url: string,
  signal: AbortSignal
): Promise<{ status: number; json: unknown }> => {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Accept: "application/rdap+json" },
      signal,
    });
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    return { json: null, status: 0 };
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    /* not JSON, status tells the story */
  }
  return { json, status: res.status };
};

const bootstrapCache = new Map<string, Promise<Bootstrap>>();

/** IANA bootstrap files change rarely; fetch each once per page load. */
export const loadBootstrap = (
  url: string,
  fetcher: RdapFetch
): Promise<Bootstrap> => {
  let p = bootstrapCache.get(url);
  if (!p) {
    p = fetcher(url).then(({ status, json }) => {
      const b = json as Bootstrap;
      if (status !== 200 || !b || !Array.isArray(b.services)) {
        throw new LookupError(
          `Could not load IANA's RDAP bootstrap file (HTTP ${status}).`
        );
      }
      return b;
    });
    p.catch(() => bootstrapCache.delete(url));
    bootstrapCache.set(url, p);
  }
  return p;
};

export const explainStatus = (status: number, what: string): string => {
  if (status === 0) {
    return `The registry's RDAP server did not let the browser read the answer for ${
      what
    } (no CORS headers or unreachable).`;
  }
  if (status === 429) {
    return "The registry's RDAP server is rate limiting; try again in a minute.";
  }
  return `The registry's RDAP server answered HTTP ${status} for ${what}.`;
};

/** IANA's page for a TLD, which names its WHOIS server when there is no RDAP. */
export const ianaTldPage = (name: string): string =>
  `https://www.iana.org/domains/root/db/${tldOf(name).toLowerCase()}.html`;

/**
 * Registries that run RDAP but are missing from IANA's bootstrap file, checked
 * for CORS by hand. DENIC (.de) also runs one, without CORS, so it is not here.
 */
export const RDAP_SUPPLEMENT: Record<string, string> = {
  ch: "https://rdap.nic.ch/",
  io: "https://rdap.identitydigital.services/rdap/",
  li: "https://rdap.nic.ch/",
  pl: "https://rdap.dns.pl/",
  us: "https://rdap.nic.us/",
};

/** IANA's bootstrap first, then the supplement. */
export const dnsServiceWithSupplement = (
  bootstrap: Bootstrap,
  name: string
): string | null =>
  dnsService(bootstrap, name) ??
  RDAP_SUPPLEMENT[tldOf(name).toLowerCase()] ??
  null;

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
export const lookupDomain = async (
  name: string,
  bootstrap: Bootstrap,
  fetcher: RdapFetch
): Promise<DomainLookup> => {
  const base = dnsServiceWithSupplement(bootstrap, name);
  if (!base) {
    return { kind: "no-rdap", tld: tldOf(name) };
  }
  const labels = name.split(".");
  const tried: string[] = [];
  for (let i = 0; i < labels.length - 1 && i < 6; i += 1) {
    const candidate = labels.slice(i).join(".");
    tried.push(candidate);
    const url = `${base}domain/${candidate}`;
    const { status, json } = await fetcher(url);
    if (status === 200) {
      return { info: parseDomain(json, url), kind: "found", tried };
    }
    // 404 is "no such domain"; some registries (SWITCH) say 400 for a name with too many labels.
    if (status !== 404 && status !== 400) {
      return {
        kind: "error",
        message: explainStatus(status, candidate),
        unreadable: status === 0,
      };
    }
  }
  return { kind: "not-found", tried };
};

export type IpLookup =
  | { kind: "found"; info: IpInfo }
  | { kind: "error"; message: string };

export const lookupIp = async (
  ip: string,
  bootstrap: Bootstrap,
  fetcher: RdapFetch
): Promise<IpLookup> => {
  const base = ipService(bootstrap, ip);
  if (!base) {
    return {
      kind: "error",
      message: `No regional registry claims ${ip} in IANA's bootstrap file.`,
    };
  }
  const url = `${base}ip/${ip}`;
  const { status, json } = await fetcher(url);
  if (status !== 200) {
    return { kind: "error", message: explainStatus(status, ip) };
  }
  return { info: parseIp(json, url), kind: "found" };
};

// ---- WHOIS fallback ----

export type TextFetch = (
  url: string
) => Promise<{ status: number; text: string }>;

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

/** The whois.vu proxy's fields, in the order the raw pane shows them, as declared above. */
const whoisText = (w: WhoisText): WhoisText =>
  inOrder(w, [
    "domain",
    "available",
    "registrar",
    "statuses",
    "created",
    "updated",
    "expires",
    "text",
  ]);

/** The proxy's "yes" / "no", or null when it said neither. */
const availability = (v: unknown): boolean | null => {
  if (v === "yes") {
    return true;
  }
  return v === "no" ? false : null;
};

const epochToIso = (v: unknown): string | null => {
  let n = Number.NaN;
  if (typeof v === "number") {
    n = v;
  } else if (typeof v === "string" && /^\d+$/u.test(v)) {
    n = Number(v);
  }
  return Number.isFinite(n) && n > 0
    ? new Date(n * 1000).toISOString().slice(0, 10)
    : null;
};

/** The whois.vu proxy's JSON: a few fields it parsed, and the registry's WHOIS output verbatim. */
export const parseWhoisText = (json: unknown): WhoisText => {
  const j = json as Record<string, unknown>;
  if (!j || typeof j !== "object" || typeof j.whois !== "string") {
    throw new LookupError("The WHOIS proxy returned something unexpected.");
  }
  return whoisText({
    available: availability(j.available),
    created: epochToIso(j.created),
    domain: String(j.domain ?? j.ip ?? ""),
    expires: epochToIso(j.expires),
    registrar: typeof j.registrar === "string" ? j.registrar : "",
    statuses: Array.isArray(j.statuses)
      ? j.statuses.map(String).filter(Boolean)
      : [],
    text: j.whois.replaceAll("\r\n", "\n").trim(),
    updated: epochToIso(j.updated),
  });
};

export const judgeWhoisText = (
  w: WhoisText,
  now = new Date()
): { verdict: Verdict; findings: Finding[] } => {
  const findings: Finding[] = [];
  if (w.available === true) {
    findings.push({ level: "none", text: "Not registered." });
    return { findings, verdict: "none" };
  }
  if (w.created) {
    findings.push({ level: "none", text: `Registered ${w.created}.` });
  }
  if (w.expires) {
    const days = Math.floor(
      (new Date(w.expires).getTime() - now.getTime()) / 86_400_000
    );
    if (days < 0) {
      findings.push({ level: "fail", text: `Expired on ${w.expires}.` });
    } else if (days <= 30) {
      findings.push({
        level: "warn",
        text: `Expires on ${w.expires}, in ${days} day${
          days === 1 ? "" : "s"
        }.`,
      });
    } else {
      findings.push({
        level: "ok",
        text: `Expires on ${w.expires}, in ${days} days.`,
      });
    }
  }
  if (w.updated) {
    findings.push({ level: "none", text: `Last changed ${w.updated}.` });
  }
  for (const s of w.statuses) {
    const key = s.toLowerCase();
    findings.push({
      level: STATUS_LEVEL[key] ?? "none",
      text: s + (STATUS_MEANING[key] ? `: ${STATUS_MEANING[key]}` : ""),
    });
  }
  findings.push({
    level: "none",
    text: "Raw WHOIS via whois.vu, a third-party proxy; the registry's own output is shown below.",
  });
  return { findings, verdict: worstOf(findings) };
};

export const lookupWhoisText = async (
  name: string,
  fetcher: TextFetch
): Promise<WhoisText> => {
  const { status, text } = await fetcher(
    WHOIS_FALLBACK_URL + encodeURIComponent(name)
  );
  if (status === 0) {
    throw new LookupError(
      "The WHOIS proxy (whois.vu) could not be reached from the browser."
    );
  }
  if (status !== 200) {
    throw new LookupError(
      `The WHOIS proxy (whois.vu) answered HTTP ${status}.`
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new LookupError("The WHOIS proxy (whois.vu) did not return JSON.");
  }
  return parseWhoisText(json);
};
