// Email Check: SPF, DMARC, and DKIM as published in DNS, judged against the
// RFCs (7208, 7489, 6376, 8301). Network access is injected so the checks are
// testable against a map of TXT records.

export type Verdict = "ok" | "warn" | "fail" | "none";

export interface Finding {
  level: Verdict;
  text: string;
}

/** Fetches every TXT string at a name (already unquoted and joined), [] when there are none or the name does not exist. */
export type TxtResolver = (name: string) => Promise<string[]>;

/**
 * A TXT record's data as the wire format's character-strings. Cloudflare
 * renders them quoted and chunked (`"abc" "def"`), Google unquoted and
 * already joined; either way the value is the concatenation.
 */
export function unquoteTxt(data: string): string {
  const s = data.trim();
  if (!s.startsWith('"')) return s;
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] !== '"') { i++; continue; }
    i++;
    while (i < s.length && s[i] !== '"') {
      if (s[i] === "\\") {
        const dec = s.slice(i + 1, i + 4);
        if (/^\d{3}$/.test(dec)) {
          out += String.fromCharCode(Number(dec));
          i += 4;
        } else {
          out += s[i + 1] ?? "";
          i += 2;
        }
      } else {
        out += s[i];
        i++;
      }
    }
    i++;
  }
  return out;
}

function worst(findings: Finding[], floor: Verdict = "ok"): Verdict {
  const rank: Record<Verdict, number> = { none: 0, ok: 1, warn: 2, fail: 3 };
  return findings.reduce((v, f) => (rank[f.level] > rank[v] ? f.level : v), floor);
}

// ---- SPF ----

export interface SpfReport {
  verdict: Verdict;
  record: string | null;
  /** Every `v=spf1` string found at the name; more than one is itself an error. */
  records: string[];
  /** DNS-querying terms counted across the record and everything it includes or redirects to. */
  lookups: number;
  /** The `all` qualifier in effect, e.g. "-all", or null when the record has none. */
  all: string | null;
  findings: Finding[];
}

/** Terms that cost a DNS lookup under RFC 7208 section 4.6.4. */
const LOOKUP_MECHANISMS = new Set(["include", "a", "mx", "ptr", "exists"]);
const MECHANISMS = new Set(["all", "include", "a", "mx", "ptr", "ip4", "ip6", "exists"]);
const MODIFIERS = new Set(["redirect", "exp"]);

/** Limit on the total number of records we chase through include/redirect; RFC caps lookups at 10 anyway. */
export const SPF_MAX_FETCHES = 30;

export function spfRecords(txts: string[]): string[] {
  return txts.filter((t) => /^v=spf1(\s|$)/i.test(t));
}

interface Term {
  qualifier: string;
  name: string;
  value: string;
  isModifier: boolean;
  raw: string;
}

function parseTerms(record: string): Term[] {
  return record.trim().split(/\s+/).slice(1).map((raw) => {
    const m = raw.match(/^([+\-~?]?)([a-z0-9_-]+)(?:([:=/])(.*))?$/i);
    if (!m) return { qualifier: "", name: raw.toLowerCase(), value: "", isModifier: false, raw };
    const isModifier = m[3] === "=";
    return { qualifier: m[1] || "+", name: m[2]!.toLowerCase(), value: m[4] ?? "", isModifier, raw };
  });
}

export async function checkSpf(domain: string, resolveTxt: TxtResolver): Promise<SpfReport> {
  const findings: Finding[] = [];
  const records = spfRecords(await resolveTxt(domain));
  if (records.length === 0) {
    findings.push({ level: "fail", text: "No SPF record. Receivers cannot tell which servers may send mail for this domain." });
    return { verdict: "fail", record: null, records, lookups: 0, all: null, findings };
  }
  if (records.length > 1) {
    findings.push({ level: "fail", text: records.length + " SPF records found; RFC 7208 requires exactly one, and receivers treat several as a permanent error." });
  }
  const record = records[0]!;
  const state = { lookups: 0, all: null as string | null };
  // Records fetched so far: a domain included twice is counted twice (each
  // include is a lookup for the receiver) but only fetched once by us.
  const fetched = new Map<string, string[]>();
  const path = new Set<string>();

  async function walk(rec: string, at: string, depth: number): Promise<void> {
    const terms = parseTerms(rec);
    let sawAll = false;
    for (const t of terms) {
      if (sawAll && depth === 0) {
        findings.push({ level: "warn", text: "\"" + t.raw + "\" comes after \"all\" and is never evaluated." });
        continue;
      }
      if (t.isModifier) {
        if (!MODIFIERS.has(t.name)) findings.push({ level: "warn", text: "Unknown modifier \"" + t.raw + "\"." });
        if (t.name === "redirect") {
          state.lookups++;
          await follow(t.value, "redirect=" + t.value, depth);
        }
        continue;
      }
      if (!MECHANISMS.has(t.name)) {
        findings.push({ level: "warn", text: "Unknown mechanism \"" + t.raw + "\" in " + at + "; receivers treat this as a permanent error." });
        continue;
      }
      if (t.name === "all") {
        sawAll = true;
        if (depth === 0) state.all = t.qualifier + "all";
        continue;
      }
      if (LOOKUP_MECHANISMS.has(t.name)) state.lookups++;
      if (t.name === "ptr" && depth === 0) findings.push({ level: "warn", text: "\"ptr\" is deprecated by RFC 7208 and ignored by some receivers." });
      if (t.name === "include") await follow(t.value, "include:" + t.value, depth);
    }
  }

  async function follow(target: string, label: string, depth: number): Promise<void> {
    const name = target.toLowerCase().replace(/\.$/, "");
    if (!name) {
      findings.push({ level: "warn", text: "\"" + label + "\" has no domain." });
      return;
    }
    if (path.has(name)) {
      findings.push({ level: "warn", text: "\"" + label + "\" loops back to a record already being evaluated." });
      return;
    }
    let recs = fetched.get(name);
    if (!recs) {
      if (fetched.size >= SPF_MAX_FETCHES) return;
      recs = spfRecords(await resolveTxt(name));
      fetched.set(name, recs);
      if (recs.length === 0) {
        findings.push({ level: "warn", text: "\"" + label + "\" points at a domain with no SPF record, which receivers treat as a permanent error." });
      }
    }
    if (recs.length === 0) return;
    path.add(name);
    await walk(recs[0]!, name, depth + 1);
    path.delete(name);
  }

  path.add(domain);
  await walk(record, domain, 0);

  const { lookups, all } = state;
  if (all === null) {
    findings.push({ level: "warn", text: "No \"all\" mechanism: senders that match nothing get a neutral result, as if there were no SPF." });
  } else if (all === "+all") {
    findings.push({ level: "fail", text: "\"+all\" authorizes every server on the internet to send as this domain." });
  } else if (all === "?all") {
    findings.push({ level: "warn", text: "\"?all\" is neutral: unlisted senders neither pass nor fail. Prefer \"-all\" or \"~all\"." });
  } else if (all === "~all") {
    findings.push({ level: "ok", text: "\"~all\": unlisted senders soft-fail. With DMARC in place this is as good as \"-all\"." });
  } else {
    findings.push({ level: "ok", text: "\"-all\": unlisted senders fail." });
  }
  if (lookups > 10) {
    findings.push({ level: "fail", text: lookups + " DNS lookups; RFC 7208 allows 10. Receivers return a permanent error, so SPF fails for everyone." });
  } else if (lookups >= 8) {
    findings.push({ level: "warn", text: lookups + " of the 10 allowed DNS lookups used; there is little room for another include." });
  } else {
    findings.push({ level: "ok", text: lookups + " of the 10 allowed DNS lookups used." });
  }
  return { verdict: worst(findings), record, records, lookups, all, findings };
}

// ---- DMARC ----

export interface DmarcReport {
  verdict: Verdict;
  record: string | null;
  records: string[];
  tags: Record<string, string>;
  findings: Finding[];
}

export function dmarcRecords(txts: string[]): string[] {
  return txts.filter((t) => /^v=DMARC1(\s*;|\s|$)/i.test(t));
}

export function parseTags(record: string): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const part of record.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim().toLowerCase();
    if (k && !(k in tags)) tags[k] = part.slice(eq + 1).trim();
  }
  return tags;
}

export async function checkDmarc(domain: string, resolveTxt: TxtResolver): Promise<DmarcReport> {
  const findings: Finding[] = [];
  const records = dmarcRecords(await resolveTxt("_dmarc." + domain));
  if (records.length === 0) {
    findings.push({ level: "fail", text: "No DMARC record at _dmarc." + domain + ". Without it SPF and DKIM results are not enforced and no reports are sent." });
    findings.push({ level: "none", text: "If this is a subdomain, the parent domain's DMARC policy applies instead." });
    return { verdict: "fail", record: null, records, tags: {}, findings };
  }
  if (records.length > 1) findings.push({ level: "fail", text: records.length + " DMARC records found; receivers ignore all of them." });
  const record = records[0]!;
  const tags = parseTags(record);
  const p = (tags.p ?? "").toLowerCase();
  if (!p) {
    findings.push({ level: "fail", text: "No \"p\" tag: the record is invalid and receivers ignore it." });
  } else if (p === "none") {
    findings.push({ level: "warn", text: "p=none only monitors: mail that fails authentication is still delivered. Move to quarantine or reject once reports look clean." });
  } else if (p === "quarantine") {
    findings.push({ level: "ok", text: "p=quarantine: failing mail goes to spam." });
  } else if (p === "reject") {
    findings.push({ level: "ok", text: "p=reject: failing mail is refused." });
  } else {
    findings.push({ level: "fail", text: "Unknown policy \"" + tags.p + "\"; receivers ignore the record." });
  }
  const sp = (tags.sp ?? "").toLowerCase();
  if (sp && sp !== p) findings.push({ level: sp === "none" ? "warn" : "none", text: "Subdomains use sp=" + sp + "." });
  if (tags.pct !== undefined) {
    const pct = Number(tags.pct);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) findings.push({ level: "warn", text: "pct=" + tags.pct + " is not a percentage." });
    else if (pct < 100) findings.push({ level: "warn", text: "pct=" + pct + ": the policy applies to only " + pct + "% of failing mail." });
  }
  if (!tags.rua) findings.push({ level: "warn", text: "No rua address: nobody receives aggregate reports, so failures go unnoticed." });
  else findings.push({ level: "ok", text: "Aggregate reports go to " + tags.rua.replace(/mailto:/g, "") + "." });
  const adkim = (tags.adkim ?? "r").toLowerCase() === "s" ? "strict" : "relaxed";
  const aspf = (tags.aspf ?? "r").toLowerCase() === "s" ? "strict" : "relaxed";
  findings.push({ level: "none", text: "Alignment: DKIM " + adkim + ", SPF " + aspf + "." });
  return { verdict: worst(findings), record, records, tags, findings };
}

// ---- DKIM ----

export interface DkimKey {
  selector: string;
  /** Every probed selector publishing this exact record; more than one means a wildcard `*._domainkey`. */
  selectors: string[];
  record: string;
  tags: Record<string, string>;
  /** "rsa", "ed25519", or whatever the record claims. */
  keyType: string;
  /** Modulus bits for RSA, 256 for Ed25519, null when the key is absent or unreadable. */
  bits: number | null;
  revoked: boolean;
  findings: Finding[];
  verdict: Verdict;
}

export interface DkimReport {
  verdict: Verdict;
  keys: DkimKey[];
  /** How many selector names were probed. */
  probed: number;
  findings: Finding[];
}

/** Selectors used by common mail providers and their documentation defaults; the user can probe any other. */
export const DKIM_SELECTORS = [
  "default", "google", "selector1", "selector2", "k1", "k2", "k3", "s1", "s2", "s3", "mail", "dkim", "dkim1", "dkim2",
  "smtp", "email", "key1", "key2", "mandrill", "mailjet", "mailo", "mg", "pic", "mx", "zoho", "zmail", "fm1", "fm2", "fm3",
  "protonmail", "protonmail2", "protonmail3", "pm", "mta", "cm", "ctct1", "ctct2", "everlytickey1", "everlytickey2",
  "sig1", "krs", "mxvault", "smtpapi", "api", "s1024", "s2048", "selector", "sel1", "mail1", "mail2", "dkimkey",
];

function base64Bytes(b64: string): Uint8Array | null {
  try {
    const clean = b64.replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) return null;
    const bin = atob(clean);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Reads one DER TLV at `pos`: returns [tag, contents start, contents length]. */
function der(bytes: Uint8Array, pos: number): [number, number, number] | null {
  if (pos + 2 > bytes.length) return null;
  const tag = bytes[pos]!;
  let len = bytes[pos + 1]!;
  let start = pos + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4 || start + n > bytes.length) return null;
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | bytes[start + i]!;
    start += n;
  }
  if (start + len > bytes.length) return null;
  return [tag, start, len];
}

/**
 * RSA modulus size from a SubjectPublicKeyInfo (what DKIM's `p=` holds):
 * SEQUENCE { SEQUENCE { OID, NULL }, BIT STRING { SEQUENCE { INTEGER modulus, INTEGER exponent } } }.
 */
export function rsaBits(spki: Uint8Array): number | null {
  const outer = der(spki, 0);
  if (!outer || outer[0] !== 0x30) return null;
  const alg = der(spki, outer[1]);
  if (!alg || alg[0] !== 0x30) return null;
  const bitString = der(spki, alg[1] + alg[2]);
  if (!bitString || bitString[0] !== 0x03) return null;
  // First BIT STRING byte is the unused-bits count.
  const rsa = der(spki, bitString[1] + 1);
  if (!rsa || rsa[0] !== 0x30) return null;
  const modulus = der(spki, rsa[1]);
  if (!modulus || modulus[0] !== 0x02) return null;
  let start = modulus[1];
  let len = modulus[2];
  while (len > 0 && spki[start] === 0) { start++; len--; }
  if (len === 0) return null;
  return (len - 1) * 8 + (32 - Math.clz32(spki[start]!));
}

export function dkimRecords(txts: string[]): string[] {
  // A key record must have p=; v=DKIM1 is optional but, when present, must come first.
  return txts.filter((t) => {
    const tags = parseTags(t);
    return "p" in tags && (!("v" in tags) || /^v=DKIM1\s*(;|$)/i.test(t));
  });
}

export function evaluateDkimKey(selector: string, record: string): DkimKey {
  const findings: Finding[] = [];
  const tags = parseTags(record);
  const keyType = (tags.k ?? "rsa").toLowerCase();
  const p = (tags.p ?? "").replace(/\s+/g, "");
  const revoked = p === "";
  let bits: number | null = null;
  if (revoked) {
    findings.push({ level: "warn", text: "Empty p=: this key is revoked. Signatures using it fail." });
  } else {
    const bytes = base64Bytes(p);
    if (!bytes) {
      findings.push({ level: "fail", text: "p= is not valid base64." });
    } else if (keyType === "ed25519") {
      bits = bytes.length * 8;
      if (bytes.length === 32) findings.push({ level: "ok", text: "Ed25519 key." });
      else findings.push({ level: "fail", text: "Ed25519 keys are 32 bytes; this one is " + bytes.length + "." });
    } else if (keyType === "rsa") {
      bits = rsaBits(bytes);
      if (bits === null) findings.push({ level: "fail", text: "p= does not decode as an RSA public key." });
      else if (bits < 1024) findings.push({ level: "fail", text: bits + "-bit RSA key; receivers reject keys under 1024 bits (RFC 8301)." });
      else if (bits < 2048) findings.push({ level: "warn", text: bits + "-bit RSA key; 2048 bits is the recommended minimum (RFC 8301)." });
      else findings.push({ level: "ok", text: bits + "-bit RSA key." });
    } else {
      findings.push({ level: "warn", text: "Unknown key type k=" + keyType + "." });
    }
  }
  const flags = new Set((tags.t ?? "").split(":").map((f) => f.trim().toLowerCase()));
  if (flags.has("y")) findings.push({ level: "warn", text: "t=y: testing mode, receivers are asked not to treat failures as significant." });
  if (flags.has("s")) findings.push({ level: "none", text: "t=s: the signing domain must match the From domain exactly (no subdomains)." });
  if (tags.h) findings.push({ level: "none", text: "Hash algorithms restricted to " + tags.h + "." });
  return { selector, selectors: [selector], record, tags, keyType, bits, revoked, findings, verdict: worst(findings) };
}

export async function checkDkimSelector(domain: string, selector: string, resolveTxt: TxtResolver): Promise<DkimKey | null> {
  const recs = dkimRecords(await resolveTxt(selector + "._domainkey." + domain));
  if (recs.length === 0) return null;
  const key = evaluateDkimKey(selector, recs[0]!);
  if (recs.length > 1) key.findings.unshift({ level: "fail", text: recs.length + " key records at this selector; receivers cannot choose between them." });
  return key;
}

/** Identical records at several selectors come from one wildcard `*._domainkey` record; show it once. */
export function collapseWildcard(keys: DkimKey[]): DkimKey[] {
  const byRecord = new Map<string, DkimKey>();
  for (const k of keys) {
    const seen = byRecord.get(k.record);
    if (seen) seen.selectors.push(k.selector);
    else byRecord.set(k.record, k);
  }
  for (const k of byRecord.values()) {
    if (k.selectors.length < 3) continue;
    k.selector = "*";
    k.findings.unshift({ level: "none", text: "The same record answers at " + k.selectors.length + " probed selectors: a wildcard *._domainkey record." });
  }
  return [...byRecord.values()];
}

/** Runs `fn` over the selectors with at most `limit` in flight. Injected rather than imported so the caller controls concurrency. */
export type Runner = <T, R>(items: T[], fn: (item: T) => Promise<R>) => Promise<R[]>;

export async function checkDkim(domain: string, resolveTxt: TxtResolver, run: Runner, selectors = DKIM_SELECTORS): Promise<DkimReport> {
  const results = await run(selectors, (sel) => checkDkimSelector(domain, sel, resolveTxt));
  const keys = collapseWildcard(results.filter((k): k is DkimKey => k !== null));
  const findings: Finding[] = [];
  if (keys.length === 0) {
    findings.push({ level: "none", text: "No keys at " + selectors.length + " common selectors. DKIM may still be set up under a selector this check does not guess; look one up below." });
    return { verdict: "none", keys, probed: selectors.length, findings };
  }
  const live = keys.filter((k) => !k.revoked);
  if (live.length === 0) findings.push({ level: "warn", text: "Every key found is revoked." });
  else findings.push({ level: worst(live.flatMap((k) => k.findings)), text: live.length + " signing key" + (live.length === 1 ? "" : "s") + " found: " + live.map((k) => k.selector).join(", ") + "." });
  return { verdict: worst(findings, "ok"), keys, probed: selectors.length, findings };
}

// ---- MX ----

export interface MxReport {
  verdict: Verdict;
  hosts: { priority: number; host: string }[];
  findings: Finding[];
}

export function parseMx(data: string[]): { priority: number; host: string }[] {
  return data
    .map((d) => d.trim().match(/^(\d+)\s+(\S+)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ priority: Number(m[1]), host: m[2]!.replace(/\.$/, "") }))
    .toSorted((a, b) => a.priority - b.priority || (a.host < b.host ? -1 : 1));
}

export function evaluateMx(data: string[]): MxReport {
  const hosts = parseMx(data);
  const findings: Finding[] = [];
  if (hosts.length === 0) {
    findings.push({ level: "warn", text: "No MX records: mail is delivered to the domain's A/AAAA address, if any." });
  } else if (hosts.length === 1 && hosts[0]!.host === "") {
    findings.push({ level: "none", text: "Null MX (\"0 .\"): this domain declares that it does not receive mail (RFC 7505)." });
  } else {
    findings.push({ level: "ok", text: hosts.length + " mail exchanger" + (hosts.length === 1 ? "" : "s") + "." });
  }
  return { verdict: worst(findings, "none"), hosts, findings };
}
