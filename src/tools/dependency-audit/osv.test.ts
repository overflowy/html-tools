// Unit tests for the OSV side: CVSS scoring, alias merging, fix lookup, the
// batch protocol, and a whole Audit against a fake OSV. Run: bun test
import { describe, expect, test } from "bun:test";

import { runAudit } from "./audit";
import { bandOfScore, cvss3BaseScore } from "./cvss";
import osv from "./fixtures/osv.json";
import { lockfileUrls, parseSource, sourceLabel } from "./github";
import {
  BATCH_LIMIT,
  displayId,
  fixFor,
  mergeAdvisories,
  queryBatch,
  severityOf,
} from "./osv";
import type { JsonFetch, JsonResponse, OsvRecord } from "./osv";
import { reportMarkdown } from "./report";

const fixture = (name: string) =>
  Bun.file(`${import.meta.dir}/fixtures/${name}`).text();
const records = osv.records as unknown as Record<string, OsvRecord>;
const hits = osv.hits as Record<string, string[]>;

/** `value`, failing the test with a message when it is missing. */
const present = <T>(value: T | null | undefined, what: string): T => {
  if (value === null || value === undefined) {
    throw new Error(`Expected ${what} to be present`);
  }
  return value;
};

/** A fake OSV that answers querybatch from the fixture's hit table and /vulns from its records. */
const fakeOsv = (
  opts: { failIds?: string[]; pageAfter?: number } = {}
): JsonFetch & { calls: string[] } => {
  const calls: string[] = [];
  const answer = (url: string, body: unknown): JsonResponse => {
    calls.push(url);
    if (url.endsWith("/querybatch")) {
      const { queries } = body as {
        queries: {
          package: { name: string; ecosystem: string };
          version: string;
          page_token?: string;
        }[];
      };
      const results = queries.map((q) => {
        const all =
          hits[`${q.package.ecosystem}:${q.package.name}@${q.version}`] ?? [];
        // Optional pagination: first page holds `pageAfter` ids and a token, the rest come on the second call.
        if (opts.pageAfter !== undefined && all.length > opts.pageAfter) {
          if (!q.page_token) {
            return {
              next_page_token: "p2",
              vulns: all.slice(0, opts.pageAfter).map((id) => ({ id })),
            };
          }
          return { vulns: all.slice(opts.pageAfter).map((id) => ({ id })) };
        }
        return { vulns: all.map((id) => ({ id })) };
      });
      return { json: { results }, status: 200 };
    }
    const id = decodeURIComponent(present(url.split("/").pop(), "record id"));
    if (opts.failIds?.includes(id)) {
      return { json: { message: "boom" }, status: 500 };
    }
    const rec = records[id];
    return rec
      ? { json: rec, status: 200 }
      : { json: { code: 5, message: "Bug not found." }, status: 404 };
  };
  const fn = ((url: string, body: unknown) =>
    Promise.resolve(answer(url, body))) as unknown as JsonFetch & {
    calls: string[];
  };
  fn.calls = calls;
  return fn;
};

describe("cvss3", () => {
  test("known scores", () => {
    expect(cvss3BaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H")).toBe(
      9.8
    );
    expect(cvss3BaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H")).toBe(
      7.5
    );
    expect(cvss3BaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N")).toBe(
      5.3
    );
    expect(cvss3BaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N")).toBe(
      6.1
    );
    expect(cvss3BaseScore("CVSS:3.0/AV:N/AC:L/PR:H/UI:N/S:U/C:H/I:H/A:H")).toBe(
      7.2
    );
    expect(cvss3BaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N")).toBe(
      0
    );
  });
  test("other vectors are not scored", () => {
    expect(
      cvss3BaseScore(
        "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N"
      )
    ).toBeNull();
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
    const s = severityOf([
      present(records["GHSA-35jh-r3h4-6jhm"], "fixture record"),
    ]);
    expect(s).toMatchObject({ band: "high", score: 7.2, source: "label" });
  });
  test("no label: computed from the best CVSS 3 vector", () => {
    const rec: OsvRecord = {
      id: "X-1",
      severity: [
        {
          score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
          type: "CVSS_V3",
        },
      ],
    };
    expect(severityOf([rec])).toMatchObject({
      band: "critical",
      score: 9.8,
      source: "cvss3",
    });
  });
  test("only a v4 vector: unknown, vector kept for display", () => {
    const rec: OsvRecord = {
      id: "X-2",
      severity: [
        {
          score:
            "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N",
          type: "CVSS_V4",
        },
      ],
    };
    expect(severityOf([rec])).toMatchObject({
      band: "unknown",
      score: null,
      source: "none",
      vector: expect.stringContaining("CVSS:4.0"),
    });
  });
  test("nothing at all", () => {
    expect(severityOf([{ id: "X-3" }])).toMatchObject({
      band: "unknown",
      score: null,
      vector: null,
    });
  });
});

describe("mergeAdvisories", () => {
  test("records sharing an alias become one Advisory under the GHSA id", () => {
    const map = new Map<string, OsvRecord | null>([
      ["PYSEC-2023-74", present(records["PYSEC-2023-74"], "fixture record")],
      [
        "GHSA-j8r2-6x86-q33q",
        present(records["GHSA-j8r2-6x86-q33q"], "fixture record"),
      ],
      [
        "GHSA-9wx4-h78v-vm56",
        present(records["GHSA-9wx4-h78v-vm56"], "fixture record"),
      ],
    ]);
    const merged = mergeAdvisories(map);
    const a = present(merged.get("PYSEC-2023-74"), "merged advisory");
    expect(a).toBe(present(merged.get("GHSA-j8r2-6x86-q33q"), "alias"));
    expect(a.id).toBe("GHSA-j8r2-6x86-q33q");
    expect(a.ids).toEqual(["GHSA-j8r2-6x86-q33q", "PYSEC-2023-74"]);
    expect(a.aliases).toEqual(["CVE-2023-32681"]);
    expect(a.summary).toBe(
      "Unintended leak of Proxy-Authorization header in requests"
    );
    expect(a.severity.band).toBe("moderate");
    expect(a.records).toHaveLength(2);
    expect(present(merged.get("GHSA-9wx4-h78v-vm56"), "advisory").ids).toEqual([
      "GHSA-9wx4-h78v-vm56",
    ]);
    expect(new Set(merged.values()).size).toBe(2);
  });
  test("a failed fetch leaves a stub that still names the id", () => {
    const merged = mergeAdvisories(new Map([["GHSA-xxxx-xxxx-xxxx", null]]));
    const a = present(merged.get("GHSA-xxxx-xxxx-xxxx"), "stub advisory");
    expect(a.failed).toEqual(["GHSA-xxxx-xxxx-xxxx"]);
    expect(a.severity.band).toBe("unknown");
    expect(a.withdrawn).toBe(false);
  });
  test("withdrawn only when every record is withdrawn", () => {
    const merged = mergeAdvisories(
      new Map<string, OsvRecord | null>([
        [
          "A-1",
          { aliases: ["CVE-1"], id: "A-1", withdrawn: "2024-01-01T00:00:00Z" },
        ],
        ["B-1", { aliases: ["CVE-1"], id: "B-1" }],
        ["C-1", { id: "C-1", withdrawn: "2024-01-01T00:00:00Z" }],
      ])
    );
    expect(present(merged.get("A-1"), "A-1").withdrawn).toBe(false);
    expect(present(merged.get("C-1"), "C-1").withdrawn).toBe(true);
  });
  test("display id preference", () => {
    expect(displayId(["PYSEC-2023-74", "GHSA-j8r2-6x86-q33q"])).toBe(
      "GHSA-j8r2-6x86-q33q"
    );
    expect(displayId(["OSV-2020-1", "PYSEC-2020-1"])).toBe("PYSEC-2020-1");
  });
});

describe("fixFor", () => {
  const advisory = (id: string) =>
    present(
      mergeAdvisories(new Map([[id, present(records[id], id)]])).get(id),
      id
    );
  test("the range holding the installed version names the fix", () => {
    expect(
      fixFor(advisory("GHSA-xvch-5gv4-984h"), {
        direct: true,
        ecosystem: "npm",
        groups: [],
        name: "minimist",
        version: "1.2.5",
      })
    ).toEqual({ fixed: "1.2.6", introduced: "1.0.0", unfixed: false });
    expect(
      fixFor(advisory("GHSA-xvch-5gv4-984h"), {
        direct: true,
        ecosystem: "npm",
        groups: [],
        name: "minimist",
        version: "0.2.0",
      })
    ).toEqual({ fixed: "0.2.4", introduced: "0", unfixed: false });
  });
  test("PyPI names match after normalization", () => {
    expect(
      fixFor(advisory("GHSA-9wx4-h78v-vm56"), {
        direct: true,
        ecosystem: "PyPI",
        groups: [],
        name: "Requests",
        version: "2.30.0",
      }).fixed
    ).toBe("2.32.0");
  });
  test("no fixed event means unfixed", () => {
    const rec: OsvRecord = {
      affected: [
        {
          package: { ecosystem: "npm", name: "a" },
          ranges: [{ events: [{ introduced: "0" }], type: "SEMVER" }],
        },
      ],
      id: "X-9",
    };
    const a = present(
      mergeAdvisories(new Map([["X-9", rec]])).get("X-9"),
      "X-9"
    );
    expect(
      fixFor(a, {
        direct: null,
        ecosystem: "npm",
        groups: [],
        name: "a",
        version: "1.0.0",
      })
    ).toEqual({ fixed: null, introduced: "0", unfixed: true });
  });
});

describe("queryBatch", () => {
  const q = (name: string, version: string) => ({
    package: { ecosystem: "npm" as const, name },
    version,
  });
  test("one call per chunk, page tokens followed", async () => {
    const f = fakeOsv({ pageAfter: 1 });
    const ids = await queryBatch(
      [q("lodash", "4.17.20"), q("nothing", "1.0.0"), q("minimist", "1.2.0")],
      f,
      new AbortController().signal
    );
    expect(ids).toEqual([
      ["GHSA-35jh-r3h4-6jhm", "GHSA-29mw-wpgm-hmr9"],
      [],
      ["GHSA-xvch-5gv4-984h", "GHSA-vh95-rmgr-6w4m"],
    ]);
    expect(f.calls).toHaveLength(2);
  });
  test("chunks at the OSV limit", async () => {
    const f = fakeOsv();
    const many = Array.from({ length: BATCH_LIMIT + 1 }, (_, i) =>
      q(`pkg${i}`, "1.0.0")
    );
    const ids = await queryBatch(many, f, new AbortController().signal);
    expect(ids).toHaveLength(BATCH_LIMIT + 1);
    expect(f.calls).toHaveLength(2);
  });
  test("an HTTP failure is explained", async () => {
    const f: JsonFetch = () =>
      Promise.resolve({
        json: { message: "Too many requests" },
        status: 429,
      });
    await expect(
      queryBatch([q("a", "1")], f, new AbortController().signal)
    ).rejects.toThrow("HTTP 429: Too many requests");
  });
});

describe("runAudit", () => {
  const signal = () => new AbortController().signal;
  test("two lockfiles, one query per distinct package, aliases merged, fixes named", async () => {
    const f = fakeOsv();
    const messages: string[] = [];
    const r = await runAudit(
      [
        { name: "package-lock.json", text: await fixture("npm-v3.lock.json") },
        { name: "uv.lock", text: await fixture("uv-v1.lock") },
      ],
      f,
      signal(),
      (m) => messages.push(m)
    );
    expect(r.lockfiles).toHaveLength(2);
    expect(r.queried).toBe(8);
    expect(f.calls.filter((u) => u.endsWith("/querybatch"))).toHaveLength(1);
    // Seven distinct records across the hits, each fetched exactly once.
    expect(f.calls.filter((u) => u.includes("/vulns/"))).toHaveLength(7);
    // Worst first: band from the database label, then the computed score within a band.
    expect(
      r.advisories.map((a) => `${a.id} ${a.severity.band} ${a.severity.score}`)
    ).toEqual([
      "GHSA-xvch-5gv4-984h critical 9.8",
      "GHSA-35jh-r3h4-6jhm high 7.2",
      "GHSA-vh95-rmgr-6w4m moderate 7.3",
      "GHSA-j8r2-6x86-q33q moderate 5.9",
      "GHSA-9wx4-h78v-vm56 moderate 5.6",
      "GHSA-29mw-wpgm-hmr9 moderate 5.3",
    ]);
    const npm = present(r.lockfiles[0], "npm report");
    const lodash = present(
      npm.packages.find((p) => p.pkg.name === "lodash"),
      "lodash"
    );
    expect(
      lodash.hits.map((h) => `${h.advisory.id} -> ${h.fix.fixed}`)
    ).toEqual([
      "GHSA-35jh-r3h4-6jhm -> 4.17.21",
      "GHSA-29mw-wpgm-hmr9 -> 4.17.21",
    ]);
    const old = present(
      npm.packages.find(
        (p) => p.pkg.name === "minimist" && p.pkg.version === "1.2.0"
      ),
      "minimist 1.2.0"
    );
    expect(old.hits.map((h) => h.advisory.severity.band)).toEqual([
      "critical",
      "moderate",
    ]);
    const py = present(r.lockfiles[1], "uv report");
    const requests = present(
      py.packages.find((p) => p.pkg.name === "requests"),
      "requests"
    );
    expect(requests.hits.map((h) => h.advisory.id)).toEqual([
      "GHSA-j8r2-6x86-q33q",
      "GHSA-9wx4-h78v-vm56",
    ]);
    expect(present(requests.hits[0], "worst hit").advisory.ids).toContain(
      "PYSEC-2023-74"
    );
    expect(
      present(
        py.packages.find((p) => p.pkg.name === "idna"),
        "idna"
      ).hits
    ).toEqual([]);
    expect(r.failedRecords).toEqual([]);
    expect(messages[0]).toBe("Asking OSV.dev about 8 packages…");
    expect(messages.at(-1)).toBe("Fetching 7 advisories… 7/7");
  });
  test("a record that fails to fetch is reported, not fatal", async () => {
    const f = fakeOsv({ failIds: ["GHSA-29mw-wpgm-hmr9"] });
    const r = await runAudit(
      [{ name: "package-lock.json", text: await fixture("npm-v3.lock.json") }],
      f,
      signal(),
      () => {}
    );
    expect(r.failedRecords).toEqual(["GHSA-29mw-wpgm-hmr9"]);
    const lodash = present(
      present(r.lockfiles[0], "report").packages.find(
        (p) => p.pkg.name === "lodash"
      ),
      "lodash"
    );
    const stub = present(
      lodash.hits.find((h) => h.advisory.id === "GHSA-29mw-wpgm-hmr9"),
      "stub hit"
    );
    expect(stub.advisory.failed).toEqual(["GHSA-29mw-wpgm-hmr9"]);
    expect(stub.advisory.severity.band).toBe("unknown");
  });
  test("an unreadable file beside a readable one is reported in place", async () => {
    const f = fakeOsv();
    const r = await runAudit(
      [
        { name: "package.json", text: '{"dependencies": {"lodash": "^4"}}' },
        { name: "", text: await fixture("yarn-classic.lock") },
      ],
      f,
      signal(),
      () => {}
    );
    const [unreadable, pasted] = r.lockfiles;
    expect(present(unreadable, "first report").error).toContain("package.json");
    expect(present(pasted, "second report").name).toBe("pasted");
    expect(present(pasted?.parsed, "parsed yarn.lock").kind).toBe("yarn");
  });
  test("nothing readable fails the Audit with the reason", async () => {
    await expect(
      runAudit([{ name: "", text: "hello" }], fakeOsv(), signal(), () => {})
    ).rejects.toThrow("Not a lockfile");
  });
  test("a lockfile with no registry packages needs no network", async () => {
    const f = fakeOsv();
    const r = await runAudit(
      [
        {
          name: "package-lock.json",
          text: '{"lockfileVersion": 3, "packages": {"": {"name": "x"}}}',
        },
      ],
      f,
      signal(),
      () => {}
    );
    expect(r.queried).toBe(0);
    expect(f.calls).toEqual([]);
  });
});

describe("report", () => {
  test("markdown names lockfiles, packages, fixes, and what was not checked", async () => {
    const r = await runAudit(
      [{ name: "package-lock.json", text: await fixture("npm-v3.lock.json") }],
      fakeOsv(),
      new AbortController().signal,
      () => {}
    );
    const md = reportMarkdown(r, "acme/demo");
    expect(md).toContain("# Dependency audit of acme/demo");
    expect(md).toContain(
      "4 advisories across 3 packages, out of 3 packages in 1 lockfile."
    );
    expect(md).toContain("## package-lock.json (package-lock.json v3, npm)");
    expect(md).toContain("### minimist@1.2.0 · transitive · critical 9.8");
    expect(md).toContain(
      "- [GHSA-xvch-5gv4-984h](https://osv.dev/vulnerability/GHSA-xvch-5gv4-984h) (CVE-2021-44906) · critical 9.8: Prototype Pollution in minimist Fixed in 1.2.6."
    );
    expect(md).toContain(
      "Not checked: demo-app@1.0.0 (the project itself), left-pad@1.3.0 (git dependency), demo-lib@0.1.0 (workspace member)."
    );
  });
});

describe("github source", () => {
  test("shorthand forms", () => {
    expect(parseSource("acme/demo")).toEqual({
      dir: "",
      kind: "repo",
      owner: "acme",
      ref: "HEAD",
      repo: "demo",
    });
    expect(parseSource("acme/demo@v1.2")).toEqual({
      dir: "",
      kind: "repo",
      owner: "acme",
      ref: "v1.2",
      repo: "demo",
    });
    expect(parseSource("acme/demo/packages/web@release/2024")).toEqual({
      dir: "packages/web",
      kind: "repo",
      owner: "acme",
      ref: "release/2024",
      repo: "demo",
    });
    expect(parseSource("acme/demo.git")).toMatchObject({ repo: "demo" });
    expect(parseSource("acme")).toBeNull();
    expect(parseSource("")).toBeNull();
  });
  test("github urls", () => {
    expect(parseSource("https://github.com/acme/demo")).toEqual({
      dir: "",
      kind: "repo",
      owner: "acme",
      ref: "HEAD",
      repo: "demo",
    });
    expect(
      parseSource("https://github.com/acme/demo/tree/main/apps/web")
    ).toEqual({
      dir: "apps/web",
      kind: "repo",
      owner: "acme",
      ref: "main",
      repo: "demo",
    });
    expect(
      parseSource("https://github.com/acme/demo/blob/main/apps/web/uv.lock")
    ).toEqual({
      filename: "uv.lock",
      kind: "file",
      url: "https://raw.githubusercontent.com/acme/demo/main/apps/web/uv.lock",
    });
    expect(
      parseSource("https://raw.githubusercontent.com/acme/demo/main/yarn.lock")
    ).toMatchObject({ filename: "yarn.lock", kind: "file" });
    expect(parseSource("https://example.com/x/pnpm-lock.yaml")).toEqual({
      filename: "pnpm-lock.yaml",
      kind: "file",
      url: "https://example.com/x/pnpm-lock.yaml",
    });
  });
  test("urls tried and label", () => {
    const src = present(parseSource("acme/demo/apps/web@main"), "source");
    expect(src.kind).toBe("repo");
    expect(
      lockfileUrls(src as Extract<typeof src, { kind: "repo" }>).map(
        (l) => l.url
      )
    ).toEqual([
      "https://raw.githubusercontent.com/acme/demo/main/apps/web/package-lock.json",
      "https://raw.githubusercontent.com/acme/demo/main/apps/web/yarn.lock",
      "https://raw.githubusercontent.com/acme/demo/main/apps/web/pnpm-lock.yaml",
      "https://raw.githubusercontent.com/acme/demo/main/apps/web/bun.lock",
      "https://raw.githubusercontent.com/acme/demo/main/apps/web/uv.lock",
    ]);
    expect(sourceLabel(src)).toBe("acme/demo/apps/web@main");
    expect(sourceLabel(present(parseSource("acme/demo"), "source"))).toBe(
      "acme/demo"
    );
  });
});
