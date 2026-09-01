// Unit tests for the RDAP (whois) logic. Run: bun test
// Fixtures are trimmed real responses from Verisign and ARIN plus cut-down
// IANA bootstrap files.
import { describe, expect, test } from "bun:test";
import {
  dnsService, ianaTldPage, ipInCidr, ipService, judgeDomain, judgeWhoisText, lookupDomain, lookupIp, lookupWhoisText,
  parseDomain, parseIp, parseWhoisText, type Bootstrap, type RdapFetch, type TextFetch,
} from "./rdap";
import fixtures from "./fixtures.json";

const dnsBoot = fixtures.rdap_bootstrap_dns as unknown as Bootstrap;
const v4Boot = fixtures.rdap_bootstrap_ipv4 as unknown as Bootstrap;
const v6Boot = fixtures.rdap_bootstrap_ipv6 as unknown as Bootstrap;

/** A registry that answers 200 for the listed URLs, 404 otherwise, and records what was asked. */
function registry(answers: Record<string, unknown>, failWith?: number): RdapFetch & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    if (failWith !== undefined) return { status: failWith, json: null };
    return url in answers ? { status: 200, json: answers[url] } : { status: 404, json: { errorCode: 404 } };
  }) as RdapFetch & { calls: string[] };
  fn.calls = calls;
  return fn;
}

describe("bootstrap", () => {
  test("TLD to registry, https preferred, trailing slash guaranteed", () => {
    expect(dnsService(dnsBoot, "example.com")).toBe("https://rdap.verisign.com/com/v1/");
    expect(dnsService(dnsBoot, "www.bbc.co.uk")).toBe("https://rdap.nominet.uk/uk/");
    expect(dnsService(dnsBoot, "example.de")).toBeNull();
  });
  test("cidr matching", () => {
    expect(ipInCidr("8.8.8.8", "8.0.0.0/8")).toBe(true);
    expect(ipInCidr("9.0.0.1", "8.0.0.0/8")).toBe(false);
    expect(ipInCidr("8.8.8.8", "8.8.8.0/24")).toBe(true);
    expect(ipInCidr("2001:4860:4860::8888", "2001:4860::/32")).toBe(true);
    expect(ipInCidr("2001:4861::1", "2001:4860::/32")).toBe(false);
    expect(ipInCidr("8.8.8.8", "2001:4860::/32")).toBe(false);
    expect(ipInCidr("8.8.8.8", "not a cidr")).toBe(false);
  });
  test("address to regional registry", () => {
    expect(ipService(v4Boot, "8.8.8.8")).toBe("https://rdap.arin.net/registry/");
    expect(ipService(v4Boot, "193.0.6.139")).toBe("https://rdap.db.ripe.net/");
    expect(ipService(v4Boot, "100.0.0.1")).toBeNull();
    expect(ipService(v6Boot, "2001:4860:4860::8888")).toBe("https://rdap.arin.net/registry/");
  });
  test("iana page for a TLD", () => expect(ianaTldPage("foo.example.de")).toBe("https://www.iana.org/domains/root/db/de.html"));
});

describe("parseDomain", () => {
  const info = parseDomain(fixtures.rdap_domain, "https://rdap.verisign.com/com/v1/domain/example.com");
  test("core fields", () => {
    expect(info.name).toBe("example.com");
    expect(info.status).toEqual(["client delete prohibited", "client transfer prohibited", "client update prohibited"]);
    expect(info.nameservers).toEqual(["elliott.ns.cloudflare.com", "hera.ns.cloudflare.com"]);
    expect(info.dnssec).toBe(true);
    expect(info.dsRecords).toBe(1);
    expect(info.events.find((e) => e.action === "expiration")!.date).toBe("2099-08-13T04:00:00Z");
  });
  test("registrar and its abuse contact", () => {
    expect(info.registrar!.name).toBe("RESERVED-Internet Assigned Numbers Authority");
    expect(info.registrar!.ianaId).toBe("376");
    expect(info.registrar!.abuse).toEqual({ name: "Abuse Desk", email: "abuse@registrar.example", phone: "+1.5550100" });
    expect(info.registrant).toBeNull();
  });
  test("rejects other objects", () => {
    expect(() => parseDomain({ objectClassName: "entity" }, "u")).toThrow();
    expect(() => parseDomain(null, "u")).toThrow();
  });
});

describe("parseIp", () => {
  const info = parseIp(fixtures.rdap_ip, "https://rdap.arin.net/registry/ip/8.8.8.8");
  test("network and holder", () => {
    expect(info.handle).toBe("NET-8-8-8-0-2");
    expect(info.cidrs).toEqual(["8.8.8.0/24"]);
    expect(info.start).toBe("8.8.8.0");
    expect(info.end).toBe("8.8.8.255");
    expect(info.name).toBe("GOGL");
    expect(info.type).toBe("DIRECT ALLOCATION");
    expect(info.holder!.name).toBe("Google LLC");
    expect(info.abuse!.email).toBe("network-abuse@google.com");
  });
  test("prefers the organisation over RIPE maintainer objects", () => {
    const ripe = {
      objectClassName: "ip network", handle: "x", startAddress: "2a00::", endAddress: "2a00::ff",
      entities: [
        { roles: ["registrant"], handle: "MNT-EXAMPLE", vcardArray: ["vcard", [["fn", {}, "text", "MNT-EXAMPLE"]]] },
        { roles: ["registrant"], handle: "ORG-EX1-RIPE", vcardArray: ["vcard", [["fn", {}, "text", "Example Org"], ["kind", {}, "text", "org"]]] },
      ],
    };
    expect(parseIp(ripe, "u").holder!.name).toBe("Example Org");
  });
});

describe("judgeDomain", () => {
  const info = parseDomain(fixtures.rdap_domain, "u");
  test("healthy domain", () => {
    const r = judgeDomain(info, ["hera.ns.cloudflare.com.", "ELLIOTT.NS.CLOUDFLARE.COM"], new Date("2026-09-01"));
    expect(r.verdict).toBe("ok");
    const texts = r.findings.map((f) => f.text);
    expect(texts.some((t) => t.startsWith("Registered 1995-08-14 (31 years ago)"))).toBe(true);
    expect(texts.some((t) => t.startsWith("Expires on 2099-08-13, in 26644 days"))).toBe(true);
    expect(texts.some((t) => t.includes("Registrar lock against transfers"))).toBe(true);
    expect(texts.some((t) => t.includes("delegation is signed (1 DS record"))).toBe(true);
    expect(texts.some((t) => t.includes("match the zone's NS records"))).toBe(true);
  });
  test("expiry thresholds", () => {
    expect(judgeDomain(info, null, new Date("2099-08-01")).findings.some((f) => f.level === "warn" && f.text.includes("in 12 days"))).toBe(true);
    expect(judgeDomain(info, null, new Date("2099-09-01")).verdict).toBe("fail");
  });
  test("nameserver mismatch and bad statuses", () => {
    const r = judgeDomain({ ...info, status: ["client hold", "pending transfer"] }, ["ns1.other.example"], new Date("2026-09-01"));
    expect(r.verdict).toBe("fail");
    const mismatch = r.findings.find((f) => f.text.startsWith("Nameservers at the registry differ"))!;
    expect(mismatch.level).toBe("warn");
    expect(mismatch.text).toContain("only at the registry: elliott.ns.cloudflare.com, hera.ns.cloudflare.com");
    expect(mismatch.text).toContain("only in the zone: ns1.other.example");
    expect(r.findings.some((f) => f.level === "fail" && f.text.startsWith("client hold"))).toBe(true);
    expect(r.findings.some((f) => f.level === "warn" && f.text.startsWith("pending transfer"))).toBe(true);
  });
  test("unknown status and missing dates", () => {
    const r = judgeDomain({ ...info, status: ["weird registry thing"], events: [], dnssec: null }, null);
    expect(r.findings.some((f) => f.text.includes("Registry-specific status"))).toBe(true);
    expect(r.findings.some((f) => f.text.includes("does not publish an expiry"))).toBe(true);
    expect(r.findings.some((f) => f.text.includes("DNSSEC"))).toBe(false);
  });
});

describe("lookupDomain", () => {
  const registered = "https://rdap.verisign.com/com/v1/domain/example.com";
  test("walks up from a subdomain to the registered name", async () => {
    const reg = registry({ [registered]: fixtures.rdap_domain });
    const r = await lookupDomain("deep.www.example.com", dnsBoot, reg);
    expect(r.kind).toBe("found");
    if (r.kind === "found") {
      expect(r.info.name).toBe("example.com");
      expect(r.tried).toEqual(["deep.www.example.com", "www.example.com", "example.com"]);
    }
    expect(reg.calls.length).toBe(3);
  });
  test("treats a 400 like a 404 while walking up", async () => {
    const reg = (async (url: string) => (url.endsWith("/domain/example.com") ? { status: 200, json: fixtures.rdap_domain } : { status: 400, json: null })) as RdapFetch;
    const r = await lookupDomain("www.example.com", dnsBoot, reg);
    expect(r.kind).toBe("found");
  });
  test("supplement covers TLDs IANA omits", async () => {
    const reg = registry({ "https://rdap.nic.ch/domain/wikipedia.ch": fixtures.rdap_domain });
    const r = await lookupDomain("wikipedia.ch", dnsBoot, reg);
    expect(r.kind).toBe("found");
    expect(reg.calls[0]).toBe("https://rdap.nic.ch/domain/wikipedia.ch");
  });
  test("stops before the bare TLD", async () => {
    const reg = registry({});
    const r = await lookupDomain("nope.example.com", dnsBoot, reg);
    expect(r.kind).toBe("not-found");
    expect(reg.calls.at(-1)).toBe("https://rdap.verisign.com/com/v1/domain/example.com");
  });
  test("no RDAP for the TLD", async () => {
    const r = await lookupDomain("heise.de", dnsBoot, registry({}));
    expect(r).toEqual({ kind: "no-rdap", tld: "de" });
  });
  test("server trouble is reported, not retried up the tree", async () => {
    const reg = registry({}, 429);
    const r = await lookupDomain("a.b.example.com", dnsBoot, reg);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.message).toContain("rate limiting");
    expect(reg.calls.length).toBe(1);
    const blocked = await lookupDomain("example.com", dnsBoot, registry({}, 0));
    if (blocked.kind === "error") expect(blocked.message).toContain("did not let the browser");
  });
});

describe("whois text fallback", () => {
  test("parses the proxy's fields and judges them", async () => {
    const fetcher: TextFetch = async () => ({ status: 200, text: JSON.stringify(fixtures.whois_text) });
    const w = await lookupWhoisText("google.it", fetcher);
    expect(w.registrar).toBe("MarkMonitor International Limited");
    expect(w.created).toBe("1999-12-10");
    expect(w.expires).toBe("2099-04-21");
    expect(w.available).toBe(false);
    expect(w.text.startsWith("Domain:")).toBe(true);
    const r = judgeWhoisText(w, new Date("2026-09-01"));
    expect(r.verdict).toBe("ok");
    expect(r.findings.some((f) => f.text.startsWith("Expires on 2099-04-21"))).toBe(true);
    expect(r.findings.some((f) => f.text.includes("whois.vu"))).toBe(true);
  });
  test("unregistered and failures", async () => {
    const free = parseWhoisText({ domain: "x.de", available: "yes", statuses: ["free"], whois: "Status: free" });
    expect(judgeWhoisText(free).findings[0]!.text).toBe("Not registered.");
    await expect(lookupWhoisText("x.de", async () => ({ status: 0, text: "" }))).rejects.toThrow(/could not be reached/);
    await expect(lookupWhoisText("x.de", async () => ({ status: 200, text: "<html>" }))).rejects.toThrow(/JSON/);
    expect(() => parseWhoisText({ domain: "x" })).toThrow();
  });
});

describe("lookupIp", () => {
  test("asks the right RIR", async () => {
    const reg = registry({ "https://rdap.arin.net/registry/ip/8.8.8.8": fixtures.rdap_ip });
    const r = await lookupIp("8.8.8.8", v4Boot, reg);
    expect(r.kind).toBe("found");
    if (r.kind === "found") expect(r.info.holder!.name).toBe("Google LLC");
  });
  test("unclaimed space", async () => {
    const r = await lookupIp("100.64.0.1", v4Boot, registry({}));
    expect(r.kind).toBe("error");
  });
});
