// Unit tests for the OSV side: CVSS scoring, alias merging, fix lookup, the
// batch protocol, and a whole Audit against a fake OSV. Run: bun test
import { describe, expect, test } from "bun:test";
import { runAudit } from "./audit";
import { bandOfScore, cvss3BaseScore } from "./cvss";
import { lockfileUrls, parseSource, sourceLabel } from "./github";
import { BATCH_LIMIT, displayId, fixFor, mergeAdvisories, queryBatch, severityOf, type JsonFetch, type OsvRecord } from "./osv";
import { reportMarkdown } from "./report";
import osv from "./fixtures/osv.json";

const fixture = (name: string) => Bun.file(import.meta.dir + "/fixtures/" + name).text();
const records = osv.records as unknown as Record<string, OsvRecord>;
const hits = osv.hits as Record<string, string[]>;

/** A fake OSV that answers querybatch from the fixture's hit table and /vulns from its records. */
function fakeOsv(opts: { failIds?: string[]; pageAfter?: number } = {}): JsonFetch & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string, body: unknown) => {
    calls.push(url);
    if (url.endsWith("/querybatch")) {
      const queries = (body as { queries: { package: { name: string; ecosystem: string }; version: string; page_token?: string }[] }).queries;
      const results = queries.map((q) => {
        const all = hits[q.package.ecosystem + ":" + q.package.name + "@" + q.version] ?? [];
        // Optional pagination: first page holds `pageAfter` ids and a token, the rest come on the second call.
        if (opts.pageAfter !== undefined && all.length > opts.pageAfter) {
          if (!q.page_token) return { vulns: all.slice(0, opts.pageAfter).map((id) => ({ id })), next_page_token: "p2" };
          return { vulns: all.slice(opts.pageAfter).map((id) => ({ id })) };
        }
        return { vulns: all.map((id) => ({ id })) };
      });
      return { status: 200, json: { results } };
    }
    const id = decodeURIComponent(url.split("/").pop()!);
    if (opts.failIds?.includes(id)) return { status: 500, json: { message: "boom" } };
    const rec = records[id];
    return rec ? { status: 200, json: rec } : { status: 404, json: { code: 5, message: "Bug not found." } };
  }) as unknown as JsonFetch & { calls: string[] };
  fn.calls = calls;
  return fn;
}

describe("cvss3", () => {
  test("known scores", () => {
    expect(cvss3BaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H")).toBe(9.8);
    expect(cvss3BaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H")).toBe(7.5);
    expect(cvss3BaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N")).toBe(5.3);
    expect(cvss3BaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N")).toBe(6.1);
    expect(cvss3BaseScore("CVSS:3.0/AV:N/AC:L/PR:H/UI:N/S:U/C:H/I:H/A:H")).toBe(7.2);
    expect(cvss3BaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N")).toBe(0);
  });
  test("other vectors are not scored", () => {
    expect(cvss3BaseScore("CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N")).toBeNull();
    expect(cvss3BaseScore("CVSS:3.1/AV:N/AC:L")).toBeNull();
  });
  test("bands", () => {
    expect(bandOfScore(9.8)).toBe("critical");
    expect(bandOfScore(7)).toBe("high");
    expect(bandOfScore(6.9)).toBe("moderate");
    expect(bandOfScore(3.9)).toBe("low");
  });
});

describe("severity", () => {
  test("database label wins, score computed from the vector beside it", () => {
    const s = severityOf([records["GHSA-35jh-r3h4-6jhm"]!]);
    expect(s).toMatchObject({ band: "high", score: 7.2, source: "label" });
  });
  test("no label: computed from the best CVSS 3 vector", () => {
    const rec: OsvRecord = { id: "X-1", severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }] };
    expect(severityOf([rec])).toMatchObject({ band: "critical", score: 9.8, source: "cvss3" });
  });
  test("only a v4 vector: unknown, vector kept for display", () => {
    const rec: OsvRecord = { id: "X-2", severity: [{ type: "CVSS_V4", score: "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N" }] };
    expect(severityOf([rec])).toMatchObject({ band: "unknown", score: null, vector: expect.stringContaining("CVSS:4.0"), source: "none" });
  });
  test("nothing at all", () => {
    expect(severityOf([{ id: "X-3" }])).toMatchObject({ band: "unknown", score: null, vector: null });
  });
});

describe("mergeAdvisories", () => {
  test("records sharing an alias become one Advisory under the GHSA id", () => {
    const map = new Map<string, OsvRecord | null>([
      ["PYSEC-2023-74", records["PYSEC-2023-74"]!],
      ["GHSA-j8r2-6x86-q33q", records["GHSA-j8r2-6x86-q33q"]!],
      ["GHSA-9wx4-h78v-vm56", records["GHSA-9wx4-h78v-vm56"]!],
    ]);
    const merged = mergeAdvisories(map);
    const a = merged.get("PYSEC-2023-74")!;
    expect(a).toBe(merged.get("GHSA-j8r2-6x86-q33q")!);
    expect(a.id).toBe("GHSA-j8r2-6x86-q33q");
    expect(a.ids).toEqual(["GHSA-j8r2-6x86-q33q", "PYSEC-2023-74"]);
    expect(a.aliases).toEqual(["CVE-2023-32681"]);
    expect(a.summary).toBe("Unintended leak of Proxy-Authorization header in requests");
    expect(a.severity.band).toBe("moderate");
    expect(a.records).toHaveLength(2);
    expect(merged.get("GHSA-9wx4-h78v-vm56")!.ids).toEqual(["GHSA-9wx4-h78v-vm56"]);
    expect(new Set(merged.values()).size).toBe(2);
  });
  test("a failed fetch leaves a stub that still names the id", () => {
    const merged = mergeAdvisories(new Map([["GHSA-xxxx-xxxx-xxxx", null]]));
    const a = merged.get("GHSA-xxxx-xxxx-xxxx")!;
    expect(a.failed).toEqual(["GHSA-xxxx-xxxx-xxxx"]);
    expect(a.severity.band).toBe("unknown");
    expect(a.withdrawn).toBe(false);
  });
  test("withdrawn only when every record is withdrawn", () => {
    const merged = mergeAdvisories(new Map<string, OsvRecord | null>([
      ["A-1", { id: "A-1", aliases: ["CVE-1"], withdrawn: "2024-01-01T00:00:00Z" }],
      ["B-1", { id: "B-1", aliases: ["CVE-1"] }],
      ["C-1", { id: "C-1", withdrawn: "2024-01-01T00:00:00Z" }],
    ]));
    expect(merged.get("A-1")!.withdrawn).toBe(false);
    expect(merged.get("C-1")!.withdrawn).toBe(true);
  });
  test("display id preference", () => {
    expect(displayId(["PYSEC-2023-74", "GHSA-j8r2-6x86-q33q"])).toBe("GHSA-j8r2-6x86-q33q");
    expect(displayId(["OSV-2020-1", "PYSEC-2020-1"])).toBe("PYSEC-2020-1");
  });
});

describe("fixFor", () => {
  const advisory = (id: string) => mergeAdvisories(new Map([[id, records[id]!]])).get(id)!;
  test("the range holding the installed version names the fix", () => {
    expect(fixFor(advisory("GHSA-xvch-5gv4-984h"), { name: "minimist", version: "1.2.5", ecosystem: "npm", direct: true, groups: [] }))
      .toEqual({ fixed: "1.2.6", introduced: "1.0.0", unfixed: false });
    expect(fixFor(advisory("GHSA-xvch-5gv4-984h"), { name: "minimist", version: "0.2.0", ecosystem: "npm", direct: true, groups: [] }))
      .toEqual({ fixed: "0.2.4", introduced: "0", unfixed: false });
  });
  test("PyPI names match after normalization", () => {
    expect(fixFor(advisory("GHSA-9wx4-h78v-vm56"), { name: "Requests", version: "2.30.0", ecosystem: "PyPI", direct: true, groups: [] }).fixed).toBe("2.32.0");
  });
  test("no fixed event means unfixed", () => {
    const rec: OsvRecord = { id: "X-9", affected: [{ package: { ecosystem: "npm", name: "a" }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }] }] }] };
    const a = mergeAdvisories(new Map([["X-9", rec]])).get("X-9")!;
    expect(fixFor(a, { name: "a", version: "1.0.0", ecosystem: "npm", direct: null, groups: [] })).toEqual({ fixed: null, introduced: "0", unfixed: true });
  });
});

describe("queryBatch", () => {
  const q = (name: string, version: string) => ({ package: { name, ecosystem: "npm" as const }, version });
  test("one call per chunk, page tokens followed", async () => {
    const f = fakeOsv({ pageAfter: 1 });
    const ids = await queryBatch([q("lodash", "4.17.20"), q("nothing", "1.0.0"), q("minimist", "1.2.0")], f, new AbortController().signal);
    expect(ids).toEqual([["GHSA-35jh-r3h4-6jhm", "GHSA-29mw-wpgm-hmr9"], [], ["GHSA-xvch-5gv4-984h", "GHSA-vh95-rmgr-6w4m"]]);
    expect(f.calls).toHaveLength(2);
  });
  test("chunks at the OSV limit", async () => {
    const f = fakeOsv();
    const many = Array.from({ length: BATCH_LIMIT + 1 }, (_, i) => q("pkg" + i, "1.0.0"));
    const ids = await queryBatch(many, f, new AbortController().signal);
    expect(ids).toHaveLength(BATCH_LIMIT + 1);
    expect(f.calls).toHaveLength(2);
  });
  test("an HTTP failure is explained", async () => {
    const f: JsonFetch = async () => ({ status: 429, json: { message: "Too many requests" } });
    await expect(queryBatch([q("a", "1")], f, new AbortController().signal)).rejects.toThrow("HTTP 429: Too many requests");
  });
});

describe("runAudit", () => {
  const signal = () => new AbortController().signal;
  test("two lockfiles, one query per distinct package, aliases merged, fixes named", async () => {
    const f = fakeOsv();
    const messages: string[] = [];
    const r = await runAudit([
      { name: "package-lock.json", text: await fixture("npm-v3.lock.json") },
      { name: "uv.lock", text: await fixture("uv-v1.lock") },
    ], f, signal(), (m) => messages.push(m));
    expect(r.lockfiles).toHaveLength(2);
    expect(r.queried).toBe(8);
    expect(f.calls.filter((u) => u.endsWith("/querybatch"))).toHaveLength(1);
    // Seven distinct records across the hits, each fetched exactly once.
    expect(f.calls.filter((u) => u.includes("/vulns/"))).toHaveLength(7);
    // Worst first: band from the database label, then the computed score within a band.
    expect(r.advisories.map((a) => a.id + " " + a.severity.band + " " + a.severity.score)).toEqual([
      "GHSA-xvch-5gv4-984h critical 9.8", "GHSA-35jh-r3h4-6jhm high 7.2", "GHSA-vh95-rmgr-6w4m moderate 7.3",
      "GHSA-j8r2-6x86-q33q moderate 5.9", "GHSA-9wx4-h78v-vm56 moderate 5.6", "GHSA-29mw-wpgm-hmr9 moderate 5.3",
    ]);
    const npm = r.lockfiles[0]!;
    const lodash = npm.packages.find((p) => p.pkg.name === "lodash")!;
    expect(lodash.hits.map((h) => h.advisory.id + " -> " + h.fix.fixed)).toEqual(["GHSA-35jh-r3h4-6jhm -> 4.17.21", "GHSA-29mw-wpgm-hmr9 -> 4.17.21"]);
    const old = npm.packages.find((p) => p.pkg.name === "minimist" && p.pkg.version === "1.2.0")!;
    expect(old.hits.map((h) => h.advisory.severity.band)).toEqual(["critical", "moderate"]);
    const py = r.lockfiles[1]!;
    const requests = py.packages.find((p) => p.pkg.name === "requests")!;
    expect(requests.hits.map((h) => h.advisory.id)).toEqual(["GHSA-j8r2-6x86-q33q", "GHSA-9wx4-h78v-vm56"]);
    expect(requests.hits[0]!.advisory.ids).toContain("PYSEC-2023-74");
    expect(py.packages.find((p) => p.pkg.name === "idna")!.hits).toEqual([]);
    expect(r.failedRecords).toEqual([]);
    expect(messages[0]).toBe("Asking OSV.dev about 8 packages…");
    expect(messages.at(-1)).toBe("Fetching 7 advisories… 7/7");
  });
  test("a record that fails to fetch is reported, not fatal", async () => {
    const f = fakeOsv({ failIds: ["GHSA-29mw-wpgm-hmr9"] });
    const r = await runAudit([{ name: "package-lock.json", text: await fixture("npm-v3.lock.json") }], f, signal(), () => {});
    expect(r.failedRecords).toEqual(["GHSA-29mw-wpgm-hmr9"]);
    const lodash = r.lockfiles[0]!.packages.find((p) => p.pkg.name === "lodash")!;
    const stub = lodash.hits.find((h) => h.advisory.id === "GHSA-29mw-wpgm-hmr9")!;
    expect(stub.advisory.failed).toEqual(["GHSA-29mw-wpgm-hmr9"]);
    expect(stub.advisory.severity.band).toBe("unknown");
  });
  test("an unreadable file beside a readable one is reported in place", async () => {
    const f = fakeOsv();
    const r = await runAudit([
      { name: "package.json", text: '{"dependencies": {"lodash": "^4"}}' },
      { name: "", text: await fixture("yarn-classic.lock") },
    ], f, signal(), () => {});
    expect(r.lockfiles[0]!.error).toContain("package.json");
    expect(r.lockfiles[1]!.name).toBe("pasted");
    expect(r.lockfiles[1]!.parsed!.kind).toBe("yarn");
  });
  test("nothing readable fails the Audit with the reason", async () => {
    await expect(runAudit([{ name: "", text: "hello" }], fakeOsv(), signal(), () => {})).rejects.toThrow("Not a lockfile");
  });
  test("a lockfile with no registry packages needs no network", async () => {
    const f = fakeOsv();
    const r = await runAudit([{ name: "package-lock.json", text: '{"lockfileVersion": 3, "packages": {"": {"name": "x"}}}' }], f, signal(), () => {});
    expect(r.queried).toBe(0);
    expect(f.calls).toEqual([]);
  });
});

describe("report", () => {
  test("markdown names lockfiles, packages, fixes, and what was not checked", async () => {
    const r = await runAudit([{ name: "package-lock.json", text: await fixture("npm-v3.lock.json") }], fakeOsv(), new AbortController().signal, () => {});
    const md = reportMarkdown(r, "acme/demo");
    expect(md).toContain("# Dependency audit of acme/demo");
    expect(md).toContain("4 advisories across 3 packages, out of 3 packages in 1 lockfile.");
    expect(md).toContain("## package-lock.json (package-lock.json v3, npm)");
    expect(md).toContain("### minimist@1.2.0 · transitive · critical 9.8");
    expect(md).toContain("- [GHSA-xvch-5gv4-984h](https://osv.dev/vulnerability/GHSA-xvch-5gv4-984h) (CVE-2021-44906) · critical 9.8: Prototype Pollution in minimist Fixed in 1.2.6.");
    expect(md).toContain("Not checked: demo-app@1.0.0 (the project itself), left-pad@1.3.0 (git dependency), demo-lib@0.1.0 (workspace member).");
  });
});

describe("github source", () => {
  test("shorthand forms", () => {
    expect(parseSource("acme/demo")).toEqual({ kind: "repo", owner: "acme", repo: "demo", ref: "HEAD", dir: "" });
    expect(parseSource("acme/demo@v1.2")).toEqual({ kind: "repo", owner: "acme", repo: "demo", ref: "v1.2", dir: "" });
    expect(parseSource("acme/demo/packages/web@release/2024")).toEqual({ kind: "repo", owner: "acme", repo: "demo", ref: "release/2024", dir: "packages/web" });
    expect(parseSource("acme/demo.git")).toMatchObject({ repo: "demo" });
    expect(parseSource("acme")).toBeNull();
    expect(parseSource("")).toBeNull();
  });
  test("github urls", () => {
    expect(parseSource("https://github.com/acme/demo")).toEqual({ kind: "repo", owner: "acme", repo: "demo", ref: "HEAD", dir: "" });
    expect(parseSource("https://github.com/acme/demo/tree/main/apps/web")).toEqual({ kind: "repo", owner: "acme", repo: "demo", ref: "main", dir: "apps/web" });
    expect(parseSource("https://github.com/acme/demo/blob/main/apps/web/uv.lock")).toEqual({ kind: "file", url: "https://raw.githubusercontent.com/acme/demo/main/apps/web/uv.lock", filename: "uv.lock" });
    expect(parseSource("https://raw.githubusercontent.com/acme/demo/main/yarn.lock")).toMatchObject({ kind: "file", filename: "yarn.lock" });
    expect(parseSource("https://example.com/x/pnpm-lock.yaml")).toEqual({ kind: "file", url: "https://example.com/x/pnpm-lock.yaml", filename: "pnpm-lock.yaml" });
  });
  test("urls tried and label", () => {
    const src = parseSource("acme/demo/apps/web@main")!;
    expect(src.kind).toBe("repo");
    expect(lockfileUrls(src as Extract<typeof src, { kind: "repo" }>).map((l) => l.url)).toEqual([
      "https://raw.githubusercontent.com/acme/demo/main/apps/web/package-lock.json",
      "https://raw.githubusercontent.com/acme/demo/main/apps/web/yarn.lock",
      "https://raw.githubusercontent.com/acme/demo/main/apps/web/pnpm-lock.yaml",
      "https://raw.githubusercontent.com/acme/demo/main/apps/web/bun.lock",
      "https://raw.githubusercontent.com/acme/demo/main/apps/web/uv.lock",
    ]);
    expect(sourceLabel(src)).toBe("acme/demo/apps/web@main");
    expect(sourceLabel(parseSource("acme/demo")!)).toBe("acme/demo");
  });
});
