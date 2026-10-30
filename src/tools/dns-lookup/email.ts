// Email Check: SPF, DMARC, DKIM, and BIMI as published in DNS, judged against
// the RFCs (7208, 7489, 6376, 8301) and the BIMI drafts. Network access is
// injected so the checks are testable against a map of TXT records.

import { asciiFold, inOrder } from "./dns";

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
export const unquoteTxt = (data: string): string => {
  const s = data.trim();
  if (!s.startsWith('"')) {
    return s;
  }
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] !== '"') {
      i += 1;
      continue;
    }
    i += 1;
    while (i < s.length && s[i] !== '"') {
      if (s[i] === "\\") {
        const dec = s.slice(i + 1, i + 4);
        if (/^\d{3}$/u.test(dec)) {
          out += String.fromCodePoint(Number(dec));
          i += 4;
        } else {
          out += s[i + 1] ?? "";
          i += 2;
        }
      } else {
        out += s[i];
        i += 1;
      }
    }
    i += 1;
  }
  return out;
};

const RANK: Record<Verdict, number> = { fail: 3, none: 0, ok: 1, warn: 2 };

const worst = (findings: Finding[], floor: Verdict = "ok"): Verdict => {
  let verdict = floor;
  for (const f of findings) {
    if (RANK[f.level] > RANK[verdict]) {
      verdict = f.level;
    }
  }
  return verdict;
};

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

// Each report's fields in the order the raw pane shows them, as declared above.
const spfReport = (r: SpfReport): SpfReport =>
  inOrder(r, ["verdict", "record", "records", "lookups", "all", "findings"]);

/** Terms that cost a DNS lookup under RFC 7208 section 4.6.4. */
const LOOKUP_MECHANISMS = new Set(["include", "a", "mx", "ptr", "exists"]);
const MECHANISMS = new Set([
  "all",
  "include",
  "a",
  "mx",
  "ptr",
  "ip4",
  "ip6",
  "exists",
]);
const MODIFIERS = new Set(["redirect", "exp"]);

/** Limit on the total number of records we chase through include/redirect; RFC caps lookups at 10 anyway. */
export const SPF_MAX_FETCHES = 30;

export const spfRecords = (txts: string[]): string[] =>
  txts.filter((t) => /^v=spf1(?:\s|$)/iu.test(asciiFold(t)));

interface Term {
  qualifier: string;
  name: string;
  value: string;
  isModifier: boolean;
  raw: string;
}

const TERM =
  /^(?<qualifier>[+\-~?]?)(?<name>[a-zA-Z0-9_-]+)(?:(?<sep>[:=/])(?<value>.*))?$/u;

const parseTerms = (record: string): Term[] =>
  record
    .trim()
    .split(/\s+/u)
    .slice(1)
    .map((raw) => {
      const groups = TERM.exec(raw)?.groups;
      if (!groups) {
        return {
          isModifier: false,
          name: raw.toLowerCase(),
          qualifier: "",
          raw,
          value: "",
        };
      }
      const { qualifier, name, sep, value } = groups;
      return {
        isModifier: sep === "=",
        name: name.toLowerCase(),
        qualifier: qualifier || "+",
        raw,
        value: value ?? "",
      };
    });

export const checkSpf = async (
  domain: string,
  resolveTxt: TxtResolver
): Promise<SpfReport> => {
  const findings: Finding[] = [];
  const records = spfRecords(await resolveTxt(domain));
  if (records.length === 0) {
    findings.push({
      level: "fail",
      text: "No SPF record. Receivers cannot tell which servers may send mail for this domain.",
    });
    return spfReport({
      all: null,
      findings,
      lookups: 0,
      record: null,
      records,
      verdict: "fail",
    });
  }
  if (records.length > 1) {
    findings.push({
      level: "fail",
      text: `${
        records.length
      } SPF records found; RFC 7208 requires exactly one, and receivers treat several as a permanent error.`,
    });
  }
  const [record] = records;
  const state = { all: null as string | null, lookups: 0 };
  // Records fetched so far: a domain included twice is counted twice (each
  // include is a lookup for the receiver) but only fetched once by us.
  const fetched = new Map<string, string[]>();
  const path = new Set<string>();

  /** The SPF record an include or redirect points at, or null (with a finding) when there is none to walk. */
  const target = async (
    to: string,
    label: string
  ): Promise<{ name: string; rec: string } | null> => {
    const name = to.toLowerCase().replace(/\.$/u, "");
    if (!name) {
      findings.push({ level: "warn", text: `"${label}" has no domain.` });
      return null;
    }
    if (path.has(name)) {
      findings.push({
        level: "warn",
        text: `"${label}" loops back to a record already being evaluated.`,
      });
      return null;
    }
    let recs = fetched.get(name);
    if (!recs) {
      if (fetched.size >= SPF_MAX_FETCHES) {
        return null;
      }
      recs = spfRecords(await resolveTxt(name));
      fetched.set(name, recs);
      if (recs.length === 0) {
        findings.push({
          level: "warn",
          text: `"${
            label
          }" points at a domain with no SPF record, which receivers treat as a permanent error.`,
        });
      }
    }
    return recs.length === 0 ? null : { name, rec: recs[0] };
  };

  const walk = async (
    rec: string,
    at: string,
    depth: number
  ): Promise<void> => {
    const follow = async (to: string, label: string) => {
      const next = await target(to, label);
      if (!next) {
        return;
      }
      path.add(next.name);
      await walk(next.rec, next.name, depth + 1);
      path.delete(next.name);
    };
    const terms = parseTerms(rec);
    let sawAll = false;
    for (const t of terms) {
      if (sawAll && depth === 0) {
        findings.push({
          level: "warn",
          text: `"${t.raw}" comes after "all" and is never evaluated.`,
        });
        continue;
      }
      if (t.isModifier) {
        if (!MODIFIERS.has(t.name)) {
          findings.push({
            level: "warn",
            text: `Unknown modifier "${t.raw}".`,
          });
        }
        if (t.name === "redirect") {
          state.lookups += 1;
          await follow(t.value, `redirect=${t.value}`);
        }
        continue;
      }
      if (!MECHANISMS.has(t.name)) {
        findings.push({
          level: "warn",
          text: `Unknown mechanism "${t.raw}" in ${
            at
          }; receivers treat this as a permanent error.`,
        });
        continue;
      }
      if (t.name === "all") {
        sawAll = true;
        if (depth === 0) {
          state.all = `${t.qualifier}all`;
        }
        continue;
      }
      if (LOOKUP_MECHANISMS.has(t.name)) {
        state.lookups += 1;
      }
      if (t.name === "ptr" && depth === 0) {
        findings.push({
          level: "warn",
          text: '"ptr" is deprecated by RFC 7208 and ignored by some receivers.',
        });
      }
      if (t.name === "include") {
        await follow(t.value, `include:${t.value}`);
      }
    }
  };

  path.add(domain);
  await walk(record, domain, 0);

  const { lookups, all } = state;
  if (all === null) {
    findings.push({
      level: "warn",
      text: 'No "all" mechanism: senders that match nothing get a neutral result, as if there were no SPF.',
    });
  } else if (all === "+all") {
    findings.push({
      level: "fail",
      text: '"+all" authorizes every server on the internet to send as this domain.',
    });
  } else if (all === "?all") {
    findings.push({
      level: "warn",
      text: '"?all" is neutral: unlisted senders neither pass nor fail. Prefer "-all" or "~all".',
    });
  } else if (all === "~all") {
    findings.push({
      level: "ok",
      text: '"~all": unlisted senders soft-fail. With DMARC in place this is as good as "-all".',
    });
  } else {
    findings.push({ level: "ok", text: '"-all": unlisted senders fail.' });
  }
  if (lookups > 10) {
    findings.push({
      level: "fail",
      text: `${
        lookups
      } DNS lookups; RFC 7208 allows 10. Receivers return a permanent error, so SPF fails for everyone.`,
    });
  } else if (lookups >= 8) {
    findings.push({
      level: "warn",
      text: `${
        lookups
      } of the 10 allowed DNS lookups used; there is little room for another include.`,
    });
  } else {
    findings.push({
      level: "ok",
      text: `${lookups} of the 10 allowed DNS lookups used.`,
    });
  }
  return spfReport({
    all,
    findings,
    lookups,
    record,
    records,
    verdict: worst(findings),
  });
};

// ---- DMARC ----

export interface DmarcReport {
  verdict: Verdict;
  record: string | null;
  records: string[];
  tags: Record<string, string>;
  findings: Finding[];
}

const dmarcReport = (r: DmarcReport): DmarcReport =>
  inOrder(r, ["verdict", "record", "records", "tags", "findings"]);

export const dmarcRecords = (txts: string[]): string[] =>
  txts.filter((t) => /^v=DMARC1(?:\s*;|\s|$)/iu.test(t));

export const parseTags = (record: string): Record<string, string> => {
  const tags: Record<string, string> = {};
  for (const part of record.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const k = part.slice(0, eq).trim().toLowerCase();
    if (k && !(k in tags)) {
      tags[k] = part.slice(eq + 1).trim();
    }
  }
  return tags;
};

/** What a DMARC record's tags say: the policies, the pct, the reporting address, and the alignment modes. */
const dmarcPolicyFindings = (tags: Record<string, string>): Finding[] => {
  const findings: Finding[] = [];
  const p = (tags.p ?? "").toLowerCase();
  if (!p) {
    findings.push({
      level: "fail",
      text: 'No "p" tag: the record is invalid and receivers ignore it.',
    });
  } else if (p === "none") {
    findings.push({
      level: "warn",
      text: "p=none only monitors: mail that fails authentication is still delivered. Move to quarantine or reject once reports look clean.",
    });
  } else if (p === "quarantine") {
    findings.push({
      level: "ok",
      text: "p=quarantine: failing mail goes to spam.",
    });
  } else if (p === "reject") {
    findings.push({ level: "ok", text: "p=reject: failing mail is refused." });
  } else {
    findings.push({
      level: "fail",
      text: `Unknown policy "${tags.p}"; receivers ignore the record.`,
    });
  }
  const sp = (tags.sp ?? "").toLowerCase();
  if (sp && sp !== p) {
    findings.push({
      level: sp === "none" ? "warn" : "none",
      text: `Subdomains use sp=${sp}.`,
    });
  }
  if (tags.pct !== undefined) {
    const pct = Number(tags.pct);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      findings.push({
        level: "warn",
        text: `pct=${tags.pct} is not a percentage.`,
      });
    } else if (pct < 100) {
      findings.push({
        level: "warn",
        text: `pct=${pct}: the policy applies to only ${pct}% of failing mail.`,
      });
    }
  }
  if (tags.rua) {
    findings.push({
      level: "ok",
      text: `Aggregate reports go to ${tags.rua.replaceAll("mailto:", "")}.`,
    });
  } else {
    findings.push({
      level: "warn",
      text: "No rua address: nobody receives aggregate reports, so failures go unnoticed.",
    });
  }
  const adkim =
    (tags.adkim ?? "r").toLowerCase() === "s" ? "strict" : "relaxed";
  const aspf = (tags.aspf ?? "r").toLowerCase() === "s" ? "strict" : "relaxed";
  findings.push({
    level: "none",
    text: `Alignment: DKIM ${adkim}, SPF ${aspf}.`,
  });
  return findings;
};

export const checkDmarc = async (
  domain: string,
  resolveTxt: TxtResolver
): Promise<DmarcReport> => {
  const findings: Finding[] = [];
  const records = dmarcRecords(await resolveTxt(`_dmarc.${domain}`));
  if (records.length === 0) {
    findings.push(
      {
        level: "fail",
        text: `No DMARC record at _dmarc.${
          domain
        }. Without it SPF and DKIM results are not enforced and no reports are sent.`,
      },
      {
        level: "none",
        text: "If this is a subdomain, the parent domain's DMARC policy applies instead.",
      }
    );
    return dmarcReport({
      findings,
      record: null,
      records,
      tags: {},
      verdict: "fail",
    });
  }
  if (records.length > 1) {
    findings.push({
      level: "fail",
      text: `${records.length} DMARC records found; receivers ignore all of them.`,
    });
  }
  const [record] = records;
  const tags = parseTags(record);
  findings.push(...dmarcPolicyFindings(tags));
  return dmarcReport({
    findings,
    record,
    records,
    tags,
    verdict: worst(findings),
  });
};

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

const dkimKey = (k: DkimKey): DkimKey =>
  inOrder(k, [
    "selector",
    "selectors",
    "record",
    "tags",
    "keyType",
    "bits",
    "revoked",
    "findings",
    "verdict",
  ]);

export interface DkimReport {
  verdict: Verdict;
  keys: DkimKey[];
  /** How many selector names were probed. */
  probed: number;
  findings: Finding[];
}

const dkimReport = (r: DkimReport): DkimReport =>
  inOrder(r, ["verdict", "keys", "probed", "findings"]);

/** Selectors used by common mail providers and their documentation defaults; the user can probe any other. */
export const DKIM_SELECTORS = [
  "default",
  "google",
  "selector1",
  "selector2",
  "k1",
  "k2",
  "k3",
  "s1",
  "s2",
  "s3",
  "mail",
  "dkim",
  "dkim1",
  "dkim2",
  "smtp",
  "email",
  "key1",
  "key2",
  "mandrill",
  "mailjet",
  "mailo",
  "mg",
  "pic",
  "mx",
  "zoho",
  "zmail",
  "fm1",
  "fm2",
  "fm3",
  "protonmail",
  "protonmail2",
  "protonmail3",
  "pm",
  "mta",
  "cm",
  "ctct1",
  "ctct2",
  "everlytickey1",
  "everlytickey2",
  "sig1",
  "krs",
  "mxvault",
  "smtpapi",
  "api",
  "s1024",
  "s2048",
  "selector",
  "sel1",
  "mail1",
  "mail2",
  "dkimkey",
];

const base64Bytes = (b64: string): Uint8Array | null => {
  try {
    const clean = b64.replaceAll(/\s+/gu, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(clean)) {
      return null;
    }
    const bin = atob(clean);
    // atob gives one character per byte, each below 256.
    return Uint8Array.from(bin, (c) => c.codePointAt(0) ?? 0);
  } catch {
    return null;
  }
};

/** Reads one DER TLV at `pos`: returns [tag, contents start, contents length]. */
const der = (
  bytes: Uint8Array,
  pos: number
): [number, number, number] | null => {
  if (pos + 2 > bytes.length) {
    return null;
  }
  const tag = bytes[pos];
  let len = bytes[pos + 1];
  let start = pos + 2;
  // Long form: the length byte's high bit is set and its low seven bits count the big-endian length bytes after it.
  if (len >= 0x80) {
    const n = len - 0x80;
    if (n === 0 || n > 4 || start + n > bytes.length) {
      return null;
    }
    len = 0;
    for (let i = 0; i < n; i += 1) {
      len = len * 256 + bytes[start + i];
    }
    // Four bytes at 0x80000000 and up read as a negative 32-bit number.
    if (len >= 2 ** 31) {
      len -= 2 ** 32;
    }
    start += n;
  }
  if (start + len > bytes.length) {
    return null;
  }
  return [tag, start, len];
};

/**
 * RSA modulus size from a SubjectPublicKeyInfo (what DKIM's `p=` holds):
 * SEQUENCE { SEQUENCE { OID, NULL }, BIT STRING { SEQUENCE { INTEGER modulus, INTEGER exponent } } }.
 */
export const rsaBits = (spki: Uint8Array): number | null => {
  const outer = der(spki, 0);
  if (!outer || outer[0] !== 0x30) {
    return null;
  }
  const alg = der(spki, outer[1]);
  if (!alg || alg[0] !== 0x30) {
    return null;
  }
  const bitString = der(spki, alg[1] + alg[2]);
  if (!bitString || bitString[0] !== 0x03) {
    return null;
  }
  // First BIT STRING byte is the unused-bits count.
  const rsa = der(spki, bitString[1] + 1);
  if (!rsa || rsa[0] !== 0x30) {
    return null;
  }
  const modulus = der(spki, rsa[1]);
  if (!modulus || modulus[0] !== 0x02) {
    return null;
  }
  let [, start, len] = modulus;
  while (len > 0 && spki[start] === 0) {
    start += 1;
    len -= 1;
  }
  if (len === 0) {
    return null;
  }
  return (len - 1) * 8 + (32 - Math.clz32(spki[start]));
};

// A key record must have p=; v=DKIM1 is optional but, when present, must come first.
export const dkimRecords = (txts: string[]): string[] =>
  txts.filter((t) => {
    const tags = parseTags(t);
    return (
      "p" in tags &&
      (!("v" in tags) || /^v=DKIM1\s*(?:;|$)/iu.test(asciiFold(t)))
    );
  });

export const evaluateDkimKey = (selector: string, record: string): DkimKey => {
  const findings: Finding[] = [];
  const tags = parseTags(record);
  const keyType = (tags.k ?? "rsa").toLowerCase();
  const p = (tags.p ?? "").replaceAll(/\s+/gu, "");
  const revoked = p === "";
  let bits: number | null = null;
  if (revoked) {
    findings.push({
      level: "warn",
      text: "Empty p=: this key is revoked. Signatures using it fail.",
    });
  } else {
    const bytes = base64Bytes(p);
    if (!bytes) {
      findings.push({ level: "fail", text: "p= is not valid base64." });
    } else if (keyType === "ed25519") {
      bits = bytes.length * 8;
      if (bytes.length === 32) {
        findings.push({ level: "ok", text: "Ed25519 key." });
      } else {
        findings.push({
          level: "fail",
          text: `Ed25519 keys are 32 bytes; this one is ${bytes.length}.`,
        });
      }
    } else if (keyType === "rsa") {
      bits = rsaBits(bytes);
      if (bits === null) {
        findings.push({
          level: "fail",
          text: "p= does not decode as an RSA public key.",
        });
      } else if (bits < 1024) {
        findings.push({
          level: "fail",
          text: `${
            bits
          }-bit RSA key; receivers reject keys under 1024 bits (RFC 8301).`,
        });
      } else if (bits < 2048) {
        findings.push({
          level: "warn",
          text: `${
            bits
          }-bit RSA key; 2048 bits is the recommended minimum (RFC 8301).`,
        });
      } else {
        findings.push({ level: "ok", text: `${bits}-bit RSA key.` });
      }
    } else {
      findings.push({
        level: "warn",
        text: `Unknown key type k=${keyType}.`,
      });
    }
  }
  const flags = new Set(
    (tags.t ?? "").split(":").map((f) => f.trim().toLowerCase())
  );
  if (flags.has("y")) {
    findings.push({
      level: "warn",
      text: "t=y: testing mode, receivers are asked not to treat failures as significant.",
    });
  }
  if (flags.has("s")) {
    findings.push({
      level: "none",
      text: "t=s: the signing domain must match the From domain exactly (no subdomains).",
    });
  }
  if (tags.h) {
    findings.push({
      level: "none",
      text: `Hash algorithms restricted to ${tags.h}.`,
    });
  }
  return dkimKey({
    bits,
    findings,
    keyType,
    record,
    revoked,
    selector,
    selectors: [selector],
    tags,
    verdict: worst(findings),
  });
};

export const checkDkimSelector = async (
  domain: string,
  selector: string,
  resolveTxt: TxtResolver
): Promise<DkimKey | null> => {
  const recs = dkimRecords(
    await resolveTxt(`${selector}._domainkey.${domain}`)
  );
  if (recs.length === 0) {
    return null;
  }
  const key = evaluateDkimKey(selector, recs[0]);
  if (recs.length > 1) {
    key.findings.unshift({
      level: "fail",
      text: `${
        recs.length
      } key records at this selector; receivers cannot choose between them.`,
    });
  }
  return key;
};

/** Identical records at several selectors come from one wildcard `*._domainkey` record; show it once. */
export const collapseWildcard = (keys: DkimKey[]): DkimKey[] => {
  const byRecord = new Map<string, DkimKey>();
  for (const k of keys) {
    const seen = byRecord.get(k.record);
    if (seen) {
      seen.selectors.push(k.selector);
    } else {
      byRecord.set(k.record, k);
    }
  }
  for (const k of byRecord.values()) {
    if (k.selectors.length < 3) {
      continue;
    }
    k.selector = "*";
    k.findings.unshift({
      level: "none",
      text: `The same record answers at ${
        k.selectors.length
      } probed selectors: a wildcard *._domainkey record.`,
    });
  }
  return [...byRecord.values()];
};

/** Runs `fn` over the selectors with at most `limit` in flight. Injected rather than imported so the caller controls concurrency. */
export type Runner = <T, R>(
  items: T[],
  fn: (item: T) => Promise<R>
) => Promise<R[]>;

export const checkDkim = async (
  domain: string,
  resolveTxt: TxtResolver,
  run: Runner,
  selectors = DKIM_SELECTORS
): Promise<DkimReport> => {
  const results = await run(selectors, (sel) =>
    checkDkimSelector(domain, sel, resolveTxt)
  );
  const keys = collapseWildcard(
    results.filter((k): k is DkimKey => k !== null)
  );
  const findings: Finding[] = [];
  if (keys.length === 0) {
    findings.push({
      level: "none",
      text: `No keys at ${
        selectors.length
      } common selectors. DKIM may still be set up under a selector this check does not guess; look one up below.`,
    });
    return dkimReport({
      findings,
      keys,
      probed: selectors.length,
      verdict: "none",
    });
  }
  const live = keys.filter((k) => !k.revoked);
  if (live.length === 0) {
    findings.push({ level: "warn", text: "Every key found is revoked." });
  } else {
    findings.push({
      level: worst(live.flatMap((k) => k.findings)),
      text: `${live.length} signing key${
        live.length === 1 ? "" : "s"
      } found: ${live.map((k) => k.selector).join(", ")}.`,
    });
  }
  return dkimReport({
    findings,
    keys,
    probed: selectors.length,
    verdict: worst(findings, "ok"),
  });
};

// ---- MX ----

export interface MxReport {
  verdict: Verdict;
  hosts: { priority: number; host: string }[];
  findings: Finding[];
}

const mxReport = (r: MxReport): MxReport =>
  inOrder(r, ["verdict", "hosts", "findings"]);

const MX_DATA = /^(?<priority>\d+)\s+(?<host>\S+)$/u;

export const parseMx = (data: string[]): { priority: number; host: string }[] =>
  data
    .map((d) => MX_DATA.exec(d.trim())?.groups)
    .filter((g) => g !== undefined)
    .map((g) =>
      inOrder(
        { host: g.host.replace(/\.$/u, ""), priority: Number(g.priority) },
        ["priority", "host"]
      )
    )
    .toSorted((a, b) => a.priority - b.priority || (a.host < b.host ? -1 : 1));

export const evaluateMx = (data: string[]): MxReport => {
  const hosts = parseMx(data);
  const findings: Finding[] = [];
  if (hosts.length === 0) {
    findings.push({
      level: "warn",
      text: "No MX records: mail is delivered to the domain's A/AAAA address, if any.",
    });
  } else if (hosts.length === 1 && hosts[0].host === "") {
    findings.push({
      level: "none",
      text: 'Null MX ("0 ."): this domain declares that it does not receive mail (RFC 7505).',
    });
  } else {
    findings.push({
      level: "ok",
      text: `${hosts.length} mail exchanger${hosts.length === 1 ? "" : "s"}.`,
    });
  }
  return mxReport({ findings, hosts, verdict: worst(findings, "none") });
};

// ---- BIMI ----

/** Fetches a URL from the browser. `ok: false` with status 0 means it could not be reached at all (CORS, network). */
export type AssetFetcher = (
  url: string
) => Promise<{ ok: boolean; status: number; body: string }>;

export interface AssetReport {
  url: string;
  /** "ok", "fail", or "unreachable" when the server did not let the browser read it. */
  state: "ok" | "fail" | "unreachable";
  findings: Finding[];
}

const assetReport = (r: AssetReport): AssetReport =>
  inOrder(r, ["url", "state", "findings"]);

export interface BimiReport {
  verdict: Verdict;
  record: string | null;
  records: string[];
  tags: Record<string, string>;
  /** The logo URL when the record has one; what the tool can display. */
  logoUrl: string | null;
  logo: AssetReport | null;
  certificate: AssetReport | null;
  findings: Finding[];
}

const bimiReport = (r: BimiReport): BimiReport =>
  inOrder(r, [
    "verdict",
    "record",
    "records",
    "tags",
    "logoUrl",
    "logo",
    "certificate",
    "findings",
  ]);

export const bimiRecords = (txts: string[]): string[] =>
  txts.filter((t) => /^v=BIMI1(?:\s*;|\s|$)/iu.test(t));

/** Whether a DMARC record meets BIMI's enforcement requirement: quarantine or reject, for the whole domain, all of the time. */
export const dmarcEnforces = (
  tags: Record<string, string>
): {
  ok: boolean;
  why: string;
} => {
  const p = (tags.p ?? "").toLowerCase();
  const sp = (tags.sp ?? "").toLowerCase();
  if (p !== "quarantine" && p !== "reject") {
    return {
      ok: false,
      why: `DMARC policy is p=${
        p || "missing"
      }; BIMI needs quarantine or reject.`,
    };
  }
  if (tags.pct !== undefined && Number(tags.pct) !== 100) {
    return {
      ok: false,
      why: `DMARC pct=${tags.pct}; BIMI needs the policy applied to all mail.`,
    };
  }
  if (sp && sp !== "quarantine" && sp !== "reject") {
    return {
      ok: false,
      why: `DMARC sp=${
        sp
      } leaves subdomains unenforced; BIMI needs quarantine or reject there too.`,
    };
  }
  return {
    ok: true,
    why: `DMARC enforces p=${p}${sp ? `, sp=${sp}` : ""}.`,
  };
};

const SVG_FORBIDDEN = [
  "script",
  "a",
  "image",
  "foreignObject",
  "animate",
  "animateMotion",
  "animateTransform",
  "set",
  "audio",
  "video",
];

/** Judges a fetched logo against the SVG Tiny Portable/Secure profile, as far as text inspection allows. */
export const judgeLogo = (url: string, body: string): AssetReport => {
  const findings: Finding[] = [];
  // Tag and attribute names are matched regardless of ASCII case.
  const markup = asciiFold(body);
  const svgTag = /<svg\b[^>]*>/iu.exec(markup);
  if (!svgTag) {
    findings.push({ level: "fail", text: "The logo is not an SVG document." });
    return assetReport({ findings, state: "fail", url });
  }
  const [attrs] = svgTag;
  if (!/baseProfile\s*=\s*["']tiny-ps["']/iu.test(attrs)) {
    findings.push({
      level: "fail",
      text: 'Missing baseProfile="tiny-ps"; mail clients require the SVG Tiny Portable/Secure profile.',
    });
  }
  if (!/version\s*=\s*["']1\.2["']/iu.test(attrs)) {
    findings.push({
      level: "warn",
      text: 'The profile expects version="1.2" on the svg element.',
    });
  }
  if (!/<title\b[^>]*>[^<]+<\/title>/iu.test(markup)) {
    findings.push({
      level: "fail",
      text: "Missing <title>; the profile requires one.",
    });
  }
  for (const el of SVG_FORBIDDEN) {
    if (new RegExp(`<${el}\\b`, "iu").test(markup)) {
      findings.push({
        level: "fail",
        text: `Contains <${el}>, which the profile forbids.`,
      });
    }
  }
  if (/\b(?:xlink:)?href\s*=\s*["'](?!#)/iu.test(markup)) {
    findings.push({
      level: "fail",
      text: "References an external resource; the profile forbids anything outside the file.",
    });
  }
  if (/\bon[a-z]+\s*=/iu.test(attrs) || /<[^>]+\bon[a-z]+\s*=/iu.test(markup)) {
    findings.push({
      level: "fail",
      text: "Contains event handler attributes.",
    });
  }
  const viewBox =
    /viewBox\s*=\s*["']\s*[\d.-]+[\s,]+[\d.-]+[\s,]+(?<width>[\d.]+)[\s,]+(?<height>[\d.]+)\s*["']/iu.exec(
      attrs
    )?.groups;
  if (
    viewBox &&
    Math.abs(Number(viewBox.width) - Number(viewBox.height)) >
      0.01 * Math.max(Number(viewBox.width), Number(viewBox.height))
  ) {
    findings.push({
      level: "warn",
      text: `The viewBox is not square (${viewBox.width}×${
        viewBox.height
      }); clients expect a square logo.`,
    });
  }
  const bytes = new TextEncoder().encode(body).length;
  if (bytes > 32 * 1024) {
    findings.push({
      level: "warn",
      text: `The file is ${Math.round(
        bytes / 1024
      )} KB; 32 KB is the recommended maximum.`,
    });
  }
  if (!findings.some((f) => f.level === "fail")) {
    findings.unshift({
      level: "ok",
      text: `SVG Tiny Portable/Secure checks pass (${bytes} bytes).`,
    });
  }
  return assetReport({
    findings,
    state: findings.some((f) => f.level === "fail") ? "fail" : "ok",
    url,
  });
};

const UTC_TIME =
  /^(?<year>\d{2})(?<month>\d{2})(?<day>\d{2})(?<hour>\d{2})(?<minute>\d{2})(?<second>\d{2})Z$/u;
const GENERALIZED_TIME =
  /^(?<year>\d{4})(?<month>\d{2})(?<day>\d{2})(?<hour>\d{2})(?<minute>\d{2})(?<second>\d{2})(?:\.\d+)?Z$/u;

const derTime = (bytes: Uint8Array, pos: number): Date | null => {
  const t = der(bytes, pos);
  if (!t || (t[0] !== 0x17 && t[0] !== 0x18)) {
    return null;
  }
  const text = String.fromCodePoint(...bytes.subarray(t[1], t[1] + t[2]));
  // UTCTime YYMMDDHHMMSSZ (RFC 5280: years 50-99 are 19xx), GeneralizedTime YYYYMMDDHHMMSSZ.
  const m = (t[0] === 0x17 ? UTC_TIME : GENERALIZED_TIME).exec(text)?.groups;
  if (!m) {
    return null;
  }
  const year =
    t[0] === 0x17
      ? (Number(m.year) >= 50 ? 1900 : 2000) + Number(m.year)
      : Number(m.year);
  return new Date(
    Date.UTC(
      year,
      Number(m.month) - 1,
      Number(m.day),
      Number(m.hour),
      Number(m.minute),
      Number(m.second)
    )
  );
};

/** notBefore/notAfter of the first certificate in a PEM or DER blob, or null if it does not parse. */
export const certValidity = (
  pem: string
): { notBefore: Date; notAfter: Date } | null => {
  const b64 =
    /-----BEGIN CERTIFICATE-----(?<body>[\s\S]*?)-----END CERTIFICATE-----/u.exec(
      pem
    )?.groups?.body ?? pem;
  const bytes = base64Bytes(b64);
  if (!bytes) {
    return null;
  }
  const cert = der(bytes, 0);
  if (!cert || cert[0] !== 0x30) {
    return null;
  }
  const tbs = der(bytes, cert[1]);
  if (!tbs || tbs[0] !== 0x30) {
    return null;
  }
  let [, pos] = tbs;
  // tbsCertificate: [0] version (optional), serial, signature algorithm, issuer, validity, ...
  const first = der(bytes, pos);
  if (!first) {
    return null;
  }
  if (first[0] === 0xa0) {
    pos = first[1] + first[2];
  }
  for (let i = 0; i < 3; i += 1) {
    const item = der(bytes, pos);
    if (!item) {
      return null;
    }
    pos = item[1] + item[2];
  }
  const validity = der(bytes, pos);
  if (!validity || validity[0] !== 0x30) {
    return null;
  }
  const notBefore = derTime(bytes, validity[1]);
  if (!notBefore) {
    return null;
  }
  // Read again for its length: derTime above has already found it.
  const nb = der(bytes, validity[1]);
  const notAfter = nb && derTime(bytes, nb[1] + nb[2]);
  if (!notAfter) {
    return null;
  }
  return { notAfter, notBefore };
};

export const judgeCertificate = (
  url: string,
  body: string,
  now = new Date()
): AssetReport => {
  const findings: Finding[] = [];
  if (!body.includes("-----BEGIN CERTIFICATE-----")) {
    findings.push({ level: "fail", text: "Not a PEM certificate file." });
    return assetReport({ findings, state: "fail", url });
  }
  const validity = certValidity(body);
  if (!validity) {
    findings.push({ level: "fail", text: "The certificate does not parse." });
    return assetReport({ findings, state: "fail", url });
  }
  const day = 86_400_000;
  const daysLeft = Math.floor(
    (validity.notAfter.getTime() - now.getTime()) / day
  );
  const until = validity.notAfter.toISOString().slice(0, 10);
  if (validity.notBefore.getTime() > now.getTime()) {
    findings.push({
      level: "fail",
      text: `The certificate is not valid until ${validity.notBefore
        .toISOString()
        .slice(0, 10)}.`,
    });
  } else if (daysLeft < 0) {
    findings.push({
      level: "fail",
      text: `The certificate expired on ${until}.`,
    });
  } else if (daysLeft <= 30) {
    findings.push({
      level: "warn",
      text: `The certificate expires on ${until} (${daysLeft} days).`,
    });
  } else {
    findings.push({ level: "ok", text: `Valid until ${until}.` });
  }
  findings.push({
    level: "none",
    text: "Whether it is a Verified or Common Mark Certificate from an authorized CA is not checked here.",
  });
  return assetReport({
    findings,
    state: findings.some((f) => f.level === "fail") ? "fail" : "ok",
    url,
  });
};

const httpsUrl = (value: string): boolean => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

const fetchAsset = async (
  url: string,
  fetcher: AssetFetcher,
  what: string,
  judge: (url: string, body: string) => AssetReport
): Promise<AssetReport> => {
  let res: { ok: boolean; status: number; body: string };
  try {
    res = await fetcher(url);
  } catch {
    res = { body: "", ok: false, status: 0 };
  }
  if (res.status === 0) {
    return assetReport({
      findings: [
        {
          level: "none",
          text: `The ${
            what
          } could not be fetched from the browser (the server does not allow cross-origin reads); open it by hand to inspect it.`,
        },
      ],
      state: "unreachable",
      url,
    });
  }
  if (!res.ok) {
    return assetReport({
      findings: [
        {
          level: "fail",
          text: `The ${what} URL answered HTTP ${res.status}.`,
        },
      ],
      state: "fail",
      url,
    });
  }
  return judge(url, res.body);
};

export const checkBimi = async (
  domain: string,
  resolveTxt: TxtResolver,
  fetcher: AssetFetcher,
  dmarcTags: Record<string, string>,
  now = new Date()
): Promise<BimiReport> => {
  const findings: Finding[] = [];
  const records = bimiRecords(await resolveTxt(`default._bimi.${domain}`));
  const none = bimiReport({
    certificate: null,
    findings,
    logo: null,
    logoUrl: null,
    record: null,
    records,
    tags: {},
    verdict: "none",
  });
  if (records.length === 0) {
    findings.push({
      level: "none",
      text: `No BIMI record at default._bimi.${
        domain
      }. Optional: only needed to show a brand logo beside messages.`,
    });
    return none;
  }
  if (records.length > 1) {
    findings.push({
      level: "fail",
      text: `${records.length} BIMI records found; receivers ignore all of them.`,
    });
  }
  const [record] = records;
  const tags = parseTags(record);
  const l = tags.l ?? "";
  const a = tags.a ?? "";
  if (!l && !a) {
    findings.push({
      level: "none",
      text: "Empty l= and a=: the domain declines to participate in BIMI.",
    });
    return { ...none, record, tags };
  }
  const gate = dmarcEnforces(dmarcTags);
  findings.push({ level: gate.ok ? "ok" : "fail", text: gate.why });
  let logo: AssetReport | null = null;
  let certificate: AssetReport | null = null;
  if (!l) {
    findings.push({ level: "fail", text: "No l= logo URL." });
  } else if (httpsUrl(l)) {
    logo = await fetchAsset(l, fetcher, "logo", judgeLogo);
  } else {
    findings.push({ level: "fail", text: "The logo URL must be https." });
  }
  if (!a) {
    findings.push({
      level: "warn",
      text: "No a= certificate: Gmail and Apple Mail show logos only with a Verified or Common Mark Certificate.",
    });
  } else if (httpsUrl(a)) {
    certificate = await fetchAsset(a, fetcher, "certificate", (u, b) =>
      judgeCertificate(u, b, now)
    );
  } else {
    findings.push({
      level: "fail",
      text: "The certificate URL must be https.",
    });
  }
  const all = [
    ...findings,
    ...(logo?.findings ?? []),
    ...(certificate?.findings ?? []),
  ];
  return bimiReport({
    certificate,
    findings,
    logo,
    logoUrl: l && httpsUrl(l) ? l : null,
    record,
    records,
    tags,
    verdict: worst(all),
  });
};
