// Unit tests for the Email Check logic. Run: bun test
// The DKIM keys in fixtures.json are throwaway keys generated with openssl.
import { describe, expect, test } from "bun:test";
import {
  certValidity, checkBimi, checkDkim, checkDkimSelector, checkDmarc, checkSpf, dkimRecords, dmarcEnforces,
  evaluateDkimKey, evaluateMx, judgeCertificate, judgeLogo, parseTags, rsaBits, unquoteTxt, type Runner, type TxtResolver,
} from "./email";
import fixtures from "./fixtures.json";

const keys = fixtures.dkim_keys;

/** A resolver over a fixed zone; names not listed have no TXT records. */
function zone(records: Record<string, string[]>): TxtResolver & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (name: string) => {
    calls.push(name);
    return records[name] ?? [];
  }) as TxtResolver & { calls: string[] };
  fn.calls = calls;
  return fn;
}

const serial: Runner = async (items, fn) => {
  const out = [];
  for (const i of items) out.push(await fn(i));
  return out;
};

describe("unquoteTxt", () => {
  test("cloudflare quoted chunks are joined", () => {
    expect(unquoteTxt('"k=rsa; p=MIIB" "IjANBg"')).toBe("k=rsa; p=MIIBIjANBg");
  });
  test("google plain text passes through", () => {
    expect(unquoteTxt("v=spf1 -all")).toBe("v=spf1 -all");
  });
  test("escapes", () => {
    expect(unquoteTxt('"say \\"hi\\" \\\\ ok"')).toBe('say "hi" \\ ok');
    expect(unquoteTxt('"a\\032b"')).toBe("a b");
  });
});

describe("SPF", () => {
  test("missing record fails", async () => {
    const r = await checkSpf("example.com", zone({ "example.com": ["google-site-verification=abc"] }));
    expect(r.verdict).toBe("fail");
    expect(r.record).toBeNull();
  });
  test("counts lookups through includes and redirects", async () => {
    const dns = zone({
      "example.com": ["v=spf1 include:_spf.example.net a mx ip4:192.0.2.0/24 -all"],
      "_spf.example.net": ["v=spf1 include:_netblocks.example.net include:_netblocks2.example.net ~all"],
      "_netblocks.example.net": ["v=spf1 ip4:198.51.100.0/24 ~all"],
      "_netblocks2.example.net": ["v=spf1 redirect=_netblocks.example.net"],
    });
    const r = await checkSpf("example.com", dns);
    // include, a, mx, include, include, redirect = 6
    expect(r.lookups).toBe(6);
    expect(r.all).toBe("-all");
    expect(r.verdict).toBe("ok");
    // the redirect target was already visited, so it is not fetched twice
    expect(dns.calls.filter((c) => c === "_netblocks.example.net").length).toBe(1);
  });
  test("more than ten lookups fails", async () => {
    const includes = Array.from({ length: 11 }, (_, i) => "include:i" + i + ".example.net").join(" ");
    const records: Record<string, string[]> = { "example.com": ["v=spf1 " + includes + " -all"] };
    for (let i = 0; i < 11; i++) records["i" + i + ".example.net"] = ["v=spf1 ip4:192.0.2." + i + " -all"];
    const r = await checkSpf("example.com", zone(records));
    expect(r.lookups).toBe(11);
    expect(r.verdict).toBe("fail");
    expect(r.findings.some((f) => f.level === "fail" && f.text.includes("11 DNS lookups"))).toBe(true);
  });
  test("+all fails, ?all and missing all warn, ~all is fine", async () => {
    expect((await checkSpf("a", zone({ a: ["v=spf1 +all"] }))).verdict).toBe("fail");
    expect((await checkSpf("a", zone({ a: ["v=spf1 ip4:192.0.2.1 ?all"] }))).verdict).toBe("warn");
    expect((await checkSpf("a", zone({ a: ["v=spf1 ip4:192.0.2.1"] }))).verdict).toBe("warn");
    expect((await checkSpf("a", zone({ a: ["v=spf1 ip4:192.0.2.1 ~all"] }))).verdict).toBe("ok");
  });
  test("multiple records, dangling include, junk after all, ptr, unknown mechanism", async () => {
    const r = await checkSpf("a", zone({ a: ["v=spf1 include:gone.example ptr -all ip4:1.2.3.4", "v=spf1 -all"] }));
    expect(r.records.length).toBe(2);
    expect(r.verdict).toBe("fail");
    const texts = r.findings.map((f) => f.text);
    expect(texts.some((t) => t.includes("2 SPF records"))).toBe(true);
    expect(texts.some((t) => t.includes("include:gone.example") && t.includes("no SPF record"))).toBe(true);
    expect(texts.some((t) => t.includes("never evaluated"))).toBe(true);
    expect(texts.some((t) => t.includes("deprecated"))).toBe(true);
    const u = await checkSpf("a", zone({ a: ["v=spf1 foo:bar -all"] }));
    expect(u.findings.some((f) => f.text.includes("Unknown mechanism"))).toBe(true);
  });
  test("include cycles terminate and are reported", async () => {
    const r = await checkSpf("a", zone({ a: ["v=spf1 include:b -all"], b: ["v=spf1 include:a -all"] }));
    expect(r.lookups).toBe(2);
    expect(r.findings.some((f) => f.text.includes("loops back"))).toBe(true);
  });
  test("a domain included twice is counted twice but fetched once", async () => {
    const dns = zone({
      a: ["v=spf1 include:shared include:other -all"],
      other: ["v=spf1 include:shared -all"],
      shared: ["v=spf1 a mx -all"],
    });
    const r = await checkSpf("a", dns);
    // include:shared (1 + a + mx) twice, include:other once = 3 + 1 + 3 = 7
    expect(r.lookups).toBe(7);
    expect(dns.calls.filter((c) => c === "shared").length).toBe(1);
  });
});

describe("DMARC", () => {
  test("missing record fails and notes subdomain inheritance", async () => {
    const r = await checkDmarc("example.com", zone({}));
    expect(r.verdict).toBe("fail");
    expect(r.findings.some((f) => f.text.includes("parent domain"))).toBe(true);
  });
  test("reject with rua is ok", async () => {
    const r = await checkDmarc("example.com", zone({ "_dmarc.example.com": ["v=DMARC1; p=reject; rua=mailto:dmarc@example.com; adkim=s"] }));
    expect(r.verdict).toBe("ok");
    expect(r.tags.p).toBe("reject");
    expect(r.findings.some((f) => f.text.includes("DKIM strict, SPF relaxed"))).toBe(true);
  });
  test("p=none, missing rua, and partial pct warn", async () => {
    expect((await checkDmarc("a", zone({ "_dmarc.a": ["v=DMARC1; p=none; rua=mailto:x@a"] }))).verdict).toBe("warn");
    expect((await checkDmarc("a", zone({ "_dmarc.a": ["v=DMARC1; p=reject"] }))).verdict).toBe("warn");
    const pct = await checkDmarc("a", zone({ "_dmarc.a": ["v=DMARC1; p=reject; pct=50; rua=mailto:x@a"] }));
    expect(pct.findings.some((f) => f.level === "warn" && f.text.includes("50%"))).toBe(true);
  });
  test("missing p, unknown p, and duplicates fail", async () => {
    expect((await checkDmarc("a", zone({ "_dmarc.a": ["v=DMARC1; rua=mailto:x@a"] }))).verdict).toBe("fail");
    expect((await checkDmarc("a", zone({ "_dmarc.a": ["v=DMARC1; p=block"] }))).verdict).toBe("fail");
    expect((await checkDmarc("a", zone({ "_dmarc.a": ["v=DMARC1; p=reject", "v=DMARC1; p=none"] }))).verdict).toBe("fail");
  });
  test("parseTags keeps the first of duplicate keys and tolerates spacing", () => {
    expect(parseTags(" v = DMARC1 ;p=reject; p=none;; sp = none")).toEqual({ v: "DMARC1", p: "reject", sp: "none" });
  });
});

describe("DKIM", () => {
  test("rsa key sizes", () => {
    expect(evaluateDkimKey("s", "v=DKIM1; k=rsa; p=" + keys.rsa2048).bits).toBe(2048);
    expect(evaluateDkimKey("s", "v=DKIM1; k=rsa; p=" + keys.rsa2048).verdict).toBe("ok");
    const weak = evaluateDkimKey("s", "k=rsa; p=" + keys.rsa1024);
    expect(weak.bits).toBe(1024);
    expect(weak.verdict).toBe("warn");
  });
  test("ed25519", () => {
    const k = evaluateDkimKey("s", "v=DKIM1; k=ed25519; p=" + keys.ed25519);
    expect(k.bits).toBe(256);
    expect(k.verdict).toBe("ok");
  });
  test("revoked, garbage, testing flag", () => {
    const revoked = evaluateDkimKey("s", "v=DKIM1; k=rsa; p=");
    expect(revoked.revoked).toBe(true);
    expect(revoked.verdict).toBe("warn");
    expect(evaluateDkimKey("s", "v=DKIM1; k=rsa; p=!!!").verdict).toBe("fail");
    expect(evaluateDkimKey("s", "v=DKIM1; k=rsa; p=aGVsbG8=").verdict).toBe("fail");
    const testing = evaluateDkimKey("s", "v=DKIM1; k=rsa; t=y; p=" + keys.rsa2048);
    expect(testing.findings.some((f) => f.text.includes("testing mode"))).toBe(true);
  });
  test("rsaBits rejects non-SPKI bytes", () => {
    expect(rsaBits(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(rsaBits(new Uint8Array(0))).toBeNull();
  });
  test("record detection tolerates missing v= but not a foreign v=", () => {
    expect(dkimRecords(["k=rsa; p=abc", "v=DKIM1; p=abc", "v=spf1 -all", "something=else", "v=DKIM2; p=abc"]).length).toBe(2);
  });
  test("selector probe finds keys and ignores the rest", async () => {
    const dns = zone({
      "google._domainkey.example.com": ["v=DKIM1; k=rsa; p=" + keys.rsa2048],
      "k1._domainkey.example.com": ["v=DKIM1; k=rsa; p="],
      "default._domainkey.example.com": ["some unrelated txt"],
    });
    const r = await checkDkim("example.com", dns, serial, ["default", "google", "k1", "nothing"]);
    expect(r.probed).toBe(4);
    expect(r.keys.map((k) => k.selector)).toEqual(["google", "k1"]);
    expect(r.verdict).toBe("ok");
    expect(r.findings[0]!.text).toContain("1 signing key found: google");
    expect(await checkDkimSelector("example.com", "nothing", dns)).toBeNull();
  });
  test("a wildcard record is shown once", async () => {
    const dns = zone(Object.fromEntries(["a", "b", "c", "d"].map((s) => [s + "._domainkey.x", ["v=DKIM1; p="]])));
    const r = await checkDkim("x", dns, serial, ["a", "b", "c", "d", "e"]);
    expect(r.keys.length).toBe(1);
    expect(r.keys[0]!.selector).toBe("*");
    expect(r.keys[0]!.selectors).toEqual(["a", "b", "c", "d"]);
    expect(r.keys[0]!.findings[0]!.text).toContain("wildcard");
  });
  test("no keys anywhere is none, only revoked keys warns", async () => {
    expect((await checkDkim("a", zone({}), serial, ["x"])).verdict).toBe("none");
    expect((await checkDkim("a", zone({ "x._domainkey.a": ["v=DKIM1; p="] }), serial, ["x"])).verdict).toBe("warn");
  });
});

describe("MX", () => {
  test("sorted by priority", () => {
    const r = evaluateMx(["20 mail2.example.com.", "10 mail.example.com."]);
    expect(r.hosts.map((h) => h.host)).toEqual(["mail.example.com", "mail2.example.com"]);
    expect(r.verdict).toBe("ok");
  });
  test("null MX and no MX", () => {
    expect(evaluateMx(["0 ."]).verdict).toBe("none");
    expect(evaluateMx(["0 ."]).findings[0]!.text).toContain("does not receive mail");
    expect(evaluateMx([]).verdict).toBe("warn");
  });
});

describe("BIMI", () => {
  const enforcing = { v: "DMARC1", p: "reject", rua: "mailto:d@example.com" };
  const assets: Record<string, string> = {
    "https://example.com/brand/logo.svg": fixtures.bimi_logo,
    "https://example.com/brand/vmc.pem": fixtures.bimi_cert,
  };
  const fetcher = async (url: string) => {
    if (url === "https://example.com/missing.svg") return { ok: false, status: 404, body: "" };
    if (url === "https://example.com/blocked.svg") return { ok: false, status: 0, body: "" };
    return { ok: url in assets, status: url in assets ? 200 : 404, body: assets[url] ?? "" };
  };
  const bimiZone = (record: string) => zone({ "default._bimi.example.com": [record] });

  test("no record is n/a, not a failure", async () => {
    const r = await checkBimi("example.com", zone({}), fetcher, enforcing);
    expect(r.verdict).toBe("none");
  });
  test("declined participation", async () => {
    const r = await checkBimi("example.com", bimiZone("v=BIMI1; l=; a="), fetcher, enforcing);
    expect(r.verdict).toBe("none");
    expect(r.findings.some((f) => f.text.includes("declines"))).toBe(true);
  });
  test("full record with reachable logo and certificate is ok", async () => {
    const r = await checkBimi("example.com", bimiZone("v=BIMI1; l=https://example.com/brand/logo.svg; a=https://example.com/brand/vmc.pem"), fetcher, enforcing);
    expect(r.verdict).toBe("ok");
    expect(r.logoUrl).toBe("https://example.com/brand/logo.svg");
    expect(r.logo!.state).toBe("ok");
    expect(r.certificate!.state).toBe("ok");
    expect(r.certificate!.findings[0]!.text).toContain("Valid until 2126-08-08");
  });
  test("DMARC gate", () => {
    expect(dmarcEnforces({ p: "none" }).ok).toBe(false);
    expect(dmarcEnforces({ p: "quarantine", pct: "50" }).ok).toBe(false);
    expect(dmarcEnforces({ p: "reject", sp: "none" }).ok).toBe(false);
    expect(dmarcEnforces({ p: "reject", sp: "quarantine", pct: "100" }).ok).toBe(true);
    expect(dmarcEnforces({}).ok).toBe(false);
  });
  test("unenforced DMARC fails the check even with good assets", async () => {
    const r = await checkBimi("example.com", bimiZone("v=BIMI1; l=https://example.com/brand/logo.svg"), fetcher, { p: "none" });
    expect(r.verdict).toBe("fail");
    expect(r.findings.some((f) => f.level === "warn" && f.text.includes("No a= certificate"))).toBe(true);
  });
  test("http logo, missing logo, unreachable logo", async () => {
    expect((await checkBimi("example.com", bimiZone("v=BIMI1; l=http://example.com/logo.svg"), fetcher, enforcing)).findings.some((f) => f.text.includes("must be https"))).toBe(true);
    const missing = await checkBimi("example.com", bimiZone("v=BIMI1; l=https://example.com/missing.svg"), fetcher, enforcing);
    expect(missing.logo!.state).toBe("fail");
    expect(missing.logo!.findings[0]!.text).toContain("HTTP 404");
    const blocked = await checkBimi("example.com", bimiZone("v=BIMI1; l=https://example.com/blocked.svg"), fetcher, enforcing);
    expect(blocked.logo!.state).toBe("unreachable");
    expect(blocked.verdict).toBe("warn");
  });
  test("logo profile checks", () => {
    const ok = judgeLogo("u", fixtures.bimi_logo);
    expect(ok.state).toBe("ok");
    const bad = judgeLogo("u", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32"><script>alert(1)</script><image href="https://x/y.png"/></svg>');
    expect(bad.state).toBe("fail");
    const texts = bad.findings.map((f) => f.text).join("\n");
    expect(texts).toContain("baseProfile");
    expect(texts).toContain("<title>");
    expect(texts).toContain("<script>");
    expect(texts).toContain("<image>");
    expect(texts).toContain("external resource");
    expect(texts).toContain("not square");
    expect(judgeLogo("u", "<html></html>").state).toBe("fail");
  });
  test("certificate validity parses UTCTime and GeneralizedTime and judges dates", () => {
    const v = certValidity(fixtures.bimi_cert)!;
    expect(v.notBefore.toISOString().slice(0, 10)).toBe("2026-09-01");
    expect(v.notAfter.toISOString().slice(0, 10)).toBe("2126-08-08");
    expect(judgeCertificate("u", fixtures.bimi_cert, new Date("2126-07-20")).findings[0]!.level).toBe("warn");
    expect(judgeCertificate("u", fixtures.bimi_cert, new Date("2127-01-01")).state).toBe("fail");
    expect(judgeCertificate("u", fixtures.bimi_cert, new Date("2020-01-01")).findings[0]!.text).toContain("not valid until");
    expect(judgeCertificate("u", "not a cert").state).toBe("fail");
    expect(certValidity("-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----")).toBeNull();
  });
});
