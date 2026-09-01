// Unit tests for the DNS Lookup logic. Run: bun test
// fixtures.json holds responses in the exact shapes Cloudflare, Google,
// Cert Spotter, and HackerTarget return, with names under example.com.
import { describe, expect, test } from "bun:test";
import {
  COMMON_TYPES, RESOLVERS, TYPE_GROUPS, formatTtl, ipv6Nibbles, mergeSubdomains, normalizeName, outcomeOf,
  parseCertSpotter, parseHackerTarget, parseResponse, pool, queryUrl, reverseName, subdomainSearchName, typeName,
  typeNumber, validCustomType, wireType,
} from "./dns";
import fixtures from "./fixtures.json";

describe("normalizeName", () => {
  test("trims, lowercases, drops the trailing dot", () => {
    expect(normalizeName("  Example.COM. ")).toBe("example.com");
  });
  test("strips a pasted URL down to its host", () => {
    expect(normalizeName("https://user:pw@Blog.Example.com:8443/path/x?q=1#frag")).toBe("blog.example.com");
    expect(normalizeName("//cdn.example.com/x.js")).toBe("cdn.example.com");
    expect(normalizeName("example.com/")).toBe("example.com");
  });
  test("keeps IPv6 literals and unwraps brackets", () => {
    expect(normalizeName("http://[2001:db8::1]:8080/")).toBe("2001:db8::1");
    expect(normalizeName("2001:DB8::1")).toBe("2001:db8::1");
  });
  test("empty input stays empty", () => {
    expect(normalizeName("   ")).toBe("");
    expect(normalizeName("https://")).toBe("");
  });
});

describe("reverseName", () => {
  test("IPv4", () => expect(reverseName("8.8.4.4")).toBe("4.4.8.8.in-addr.arpa"));
  test("IPv6 with ::", () => {
    expect(reverseName("2001:db8::1")).toBe("1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa");
  });
  test("IPv6 loopback and embedded IPv4", () => {
    expect(ipv6Nibbles("::1")).toBe("0".repeat(31) + "1");
    expect(ipv6Nibbles("::ffff:192.0.2.1")).toBe("0".repeat(20) + "ffffc0000201");
  });
  test("not an address", () => {
    expect(reverseName("example.com")).toBeNull();
    expect(reverseName("1.2.3")).toBeNull();
    expect(reverseName("999.1.1.1")).toBeNull();
    expect(reverseName("2001:db8:::1")).toBeNull();
    expect(reverseName("1:2:3:4:5:6:7:8:9")).toBeNull();
  });
});

describe("record types", () => {
  test("every picker type has a number and round-trips its name", () => {
    for (const g of TYPE_GROUPS) for (const t of g.types) expect(typeName(typeNumber(t)!)).toBe(t);
    expect(typeName(1)).toBe("A");
    expect(typeName(65)).toBe("HTTPS");
    expect(typeName(257)).toBe("CAA");
  });
  test("unknown numbers get the RFC 3597 spelling", () => expect(typeName(4242)).toBe("TYPE4242"));
  test("All Types stays within the picker", () => {
    const offered = new Set(TYPE_GROUPS.flatMap((g) => g.types));
    for (const t of COMMON_TYPES) expect(offered.has(t)).toBe(true);
  });
  test("custom types", () => {
    expect(validCustomType(" https ")).toBe("HTTPS");
    expect(validCustomType("65")).toBe("65");
    expect(validCustomType("65536")).toBeNull();
    expect(validCustomType("A B")).toBeNull();
    expect(validCustomType("")).toBeNull();
  });
});

describe("formatTtl", () => {
  test("two largest units", () => {
    expect(formatTtl(45)).toBe("45s");
    expect(formatTtl(300)).toBe("5m");
    expect(formatTtl(330)).toBe("5m 30s");
    expect(formatTtl(3600)).toBe("1h");
    expect(formatTtl(5400)).toBe("1h 30m");
    expect(formatTtl(86400 + 30)).toBe("1d");
    expect(formatTtl(86400 * 2 + 3600 * 5)).toBe("2d 5h");
    expect(formatTtl(0)).toBe("0s");
  });
});

describe("queryUrl", () => {
  test("cloudflare", () => {
    expect(queryUrl(RESOLVERS[0]!, "example.com", "MX", { cd: false, do: false }))
      .toBe("https://cloudflare-dns.com/dns-query?name=example.com&type=15");
  });
  test("google with flags", () => {
    expect(queryUrl(RESOLVERS[3]!, "example.com", "A", { cd: true, do: true }))
      .toBe("https://dns.google/resolve?name=example.com&type=1&cd=1&do=1");
  });
  test("known types go on the wire as numbers, unknown ones as typed", () => {
    // Google answers LOC, SMIMEA, OPENPGPKEY, and URI only by number.
    expect(wireType("LOC")).toBe("29");
    expect(wireType("OPENPGPKEY")).toBe("61");
    expect(wireType("65")).toBe("65");
    expect(wireType("NOTATYPE")).toBe("NOTATYPE");
    for (const g of TYPE_GROUPS) for (const t of g.types) expect(wireType(t)).toMatch(/^\d+$/);
  });
});

describe("parseResponse", () => {
  test("cloudflare answer", () => {
    const r = parseResponse(fixtures.cloudflare_a);
    expect(r.Answer.length).toBe(2);
    expect(r.Answer[0]!.data).toBe("104.20.23.154");
    expect(r.Comment).toEqual([]);
    expect(outcomeOf(r)).toBe("records");
  });
  test("google answer: trailing dots kept, string Comment wrapped", () => {
    const r = parseResponse(fixtures.google_a);
    expect(r.Answer[0]!.name).toBe("example.com.");
    expect(r.Comment).toEqual(["Response from 108.162.195.228."]);
    expect(r.AD).toBe(true);
  });
  test("no records of that type is not NXDOMAIN", () => {
    const r = parseResponse(fixtures.cloudflare_empty);
    expect(outcomeOf(r)).toBe("empty");
    expect(r.Authority.length).toBe(1);
    expect(r.Authority[0]!.type).toBe(6);
  });
  test("NXDOMAIN", () => expect(outcomeOf(parseResponse(fixtures.cloudflare_nxdomain))).toBe("nxdomain"));
  test("NOTIMP carries the EDE comment", () => {
    const r = parseResponse(fixtures.cloudflare_notimp);
    expect(outcomeOf(r)).toBe("failed");
    expect(r.Comment).toEqual(["EDE(21): Not Supported"]);
  });
  test("DNSSEC OK answer includes the RRSIG", () => {
    const r = parseResponse(fixtures.cloudflare_a_dnssec);
    expect(r.Answer.map((a) => typeName(a.type))).toEqual(["A", "A", "RRSIG"]);
  });
  test("garbage is rejected", () => {
    expect(() => parseResponse(null)).toThrow();
    expect(() => parseResponse({ error: "nope" })).toThrow();
    expect(() => parseResponse("<html>")).toThrow();
  });
});

describe("subdomain sources", () => {
  test("cert spotter flattens SANs, keeps only names under the domain", () => {
    const hosts = parseCertSpotter(fixtures.certspotter_page, "example.com").toSorted();
    expect(hosts).toEqual(["docs.example.com", "example.com", "mail.example.com", "staging.example.com", "www.example.com"]);
  });
  test("cert spotter rejects a non-array body", () => {
    expect(() => parseCertSpotter({ message: "rate limited" }, "x")).toThrow();
  });
  test("hackertarget lines", () => {
    const hosts = parseHackerTarget(fixtures.hackertarget_text, "example.com");
    expect(hosts.length).toBe(5);
    expect(hosts[1]).toEqual({ name: "blog.example.com", ip: "192.0.2.10" });
  });
  test("hackertarget: unknown host is an empty result, quota is an error", () => {
    expect(parseHackerTarget(fixtures.hackertarget_invalid, "x")).toEqual([]);
    expect(() => parseHackerTarget(fixtures.hackertarget_quota, "x")).toThrow(/quota/i);
  });
  test("search name drops a leading www.", () => {
    expect(subdomainSearchName("www.example.com")).toBe("example.com");
    expect(subdomainSearchName("wwwx.example.com")).toBe("wwwx.example.com");
  });
  test("merge unions, keeps the IP, lists sources, puts the searched name first", () => {
    const cs = { id: "certspotter", label: "Cert Spotter", fetch: async () => [] };
    const ht = { id: "hackertarget", label: "HackerTarget", fetch: async () => [] };
    const merged = mergeSubdomains("example.com", [
      { source: cs, hosts: parseCertSpotter(fixtures.certspotter_page, "example.com").map((n) => ({ name: n, ip: "" })) },
      { source: ht, hosts: parseHackerTarget(fixtures.hackertarget_text, "example.com") },
    ]);
    expect(merged[0]!.name).toBe("example.com");
    expect(merged.map((m) => m.name).slice(1)).toEqual([
      "api.example.com", "blog.example.com", "cdn.example.com", "docs.example.com",
      "mail.example.com", "staging.example.com", "www.example.com",
    ]);
    const mail = merged.find((m) => m.name === "mail.example.com")!;
    expect(mail.ip).toBe("203.0.113.25");
    expect(mail.sources).toEqual(["Cert Spotter", "HackerTarget"]);
    expect(merged.find((m) => m.name === "docs.example.com")!.sources).toEqual(["Cert Spotter"]);
  });
});

describe("pool", () => {
  test("bounds concurrency and preserves order", async () => {
    let active = 0;
    let peak = 0;
    const out = await pool([5, 1, 4, 2, 3], 2, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, n));
      active--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30]);
    expect(peak).toBe(2);
  });
});
