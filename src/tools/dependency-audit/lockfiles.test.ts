// Unit tests for the Lockfile parsers. Run: bun test
// Fixtures are hand-cut lockfiles in each generation, named so that no
// dependency scanner mistakes them for the repository's own.
import { describe, expect, test } from "bun:test";
import { compareLoose, detectKind, nonRegistryReason, type ParsedLockfile } from "./lockfiles";
import { parseKind, parseLockfile } from "./parse";
import { parseToml } from "./toml";
import { parseYaml } from "./yaml";
import { splitPackageKey } from "./pnpm";
import { nameFromPath } from "./npm";
import { splitDescriptor } from "./yarn";

const fixture = (name: string) => Bun.file(import.meta.dir + "/fixtures/" + name).text();

function pkg(p: ParsedLockfile, name: string, version: string) {
  const found = p.packages.find((x) => x.name === name && x.version === version);
  if (!found) throw new Error(name + "@" + version + " not in " + p.packages.map((x) => x.name + "@" + x.version).join(", "));
  return found;
}

function skipped(p: ParsedLockfile, name: string) {
  const found = p.notChecked.find((x) => x.name === name);
  if (!found) throw new Error(name + " not in notChecked: " + p.notChecked.map((x) => x.name).join(", "));
  return found;
}

describe("detectKind", () => {
  test("by file name", () => {
    expect(detectKind("", "package-lock.json")).toEqual({ kind: "package-lock" });
    expect(detectKind("", "sub/dir/yarn.lock")).toEqual({ kind: "yarn" });
    expect(detectKind("", "pnpm-lock.yaml")).toEqual({ kind: "pnpm" });
    expect(detectKind("", "bun.lock")).toEqual({ kind: "bun" });
    expect(detectKind("", "uv.lock")).toEqual({ kind: "uv" });
    expect(detectKind("", "bun.lockb").kind).toBeNull();
    expect((detectKind("", "package.json") as { refusal: string }).refusal).toContain("version ranges");
  });
  test("by content", async () => {
    expect(detectKind(await fixture("npm-v3.lock.json")).kind).toBe("package-lock");
    expect(detectKind(await fixture("npm-v1.lock.json")).kind).toBe("package-lock");
    expect(detectKind(await fixture("yarn-classic.lock")).kind).toBe("yarn");
    expect(detectKind(await fixture("yarn-berry.lock")).kind).toBe("yarn");
    expect(detectKind(await fixture("pnpm-v9.lock.yaml")).kind).toBe("pnpm");
    expect(detectKind(await fixture("bun-text.lock")).kind).toBe("bun");
    expect(detectKind(await fixture("uv-v1.lock")).kind).toBe("uv");
  });
  test("declaration files are refused by name", () => {
    expect((detectKind('{"name": "x", "dependencies": {"a": "^1"}}') as { refusal: string }).refusal).toContain("package.json");
    expect((detectKind('[project]\nname = "x"\ndependencies = ["a>=1"]') as { refusal: string }).refusal).toContain("pyproject.toml");
    expect((detectKind("requests==2.31.0\nidna>=3\n") as { refusal: string }).refusal).toContain("requirements.txt");
    expect((detectKind("\0\0\0bun") as { refusal: string }).refusal).toContain("bun.lockb");
  });
});

describe("package-lock.json", () => {
  test("v3: direct deps by group, nested versions, links and workspaces skipped", async () => {
    const p = parseLockfile(await fixture("npm-v3.lock.json"), "package-lock.json");
    expect(p.label).toBe("package-lock.json v3");
    expect(p.knowsDirect).toBe(true);
    expect(p.packages.map((x) => x.name + "@" + x.version)).toEqual(["lodash@4.17.20", "minimist@1.2.0", "minimist@1.2.5"]);
    expect(pkg(p, "lodash", "4.17.20")).toMatchObject({ direct: true, groups: [] });
    expect(pkg(p, "minimist", "1.2.5")).toMatchObject({ direct: true, groups: ["dev"] });
    expect(pkg(p, "minimist", "1.2.0")).toMatchObject({ direct: false, groups: [] });
    expect(skipped(p, "demo-app").reason).toBe("root");
    expect(skipped(p, "demo-lib").reason).toBe("workspace");
    expect(skipped(p, "left-pad")).toMatchObject({ reason: "git", version: "1.3.0" });
    expect(p.notChecked).toHaveLength(3);
  });
  test("v1: nested tree walked, no direct information", async () => {
    const p = parseLockfile(await fixture("npm-v1.lock.json"), "package-lock.json");
    expect(p.label).toBe("package-lock.json v1");
    expect(p.knowsDirect).toBe(false);
    expect(p.packages.map((x) => x.name + "@" + x.version)).toEqual(["lodash@4.17.20", "minimist@1.2.0", "minimist@1.2.5", "yargs@15.0.0"]);
    expect(pkg(p, "minimist", "1.2.5")).toMatchObject({ direct: null, groups: ["dev"] });
    expect(skipped(p, "left-pad").reason).toBe("git");
  });
  test("unsupported generation is refused by number", () => {
    expect(() => parseKind("package-lock", '{"lockfileVersion": 4, "packages": {}}')).toThrow("lockfileVersion 4 is not supported");
  });
  test("name from path keeps the scope", () => {
    expect(nameFromPath("node_modules/@babel/core")).toBe("@babel/core");
    expect(nameFromPath("node_modules/a/node_modules/@s/b")).toBe("@s/b");
  });
});

describe("yarn.lock", () => {
  test("classic: aliases resolved, git and file entries skipped, nothing direct", async () => {
    const p = parseLockfile(await fixture("yarn-classic.lock"), "yarn.lock");
    expect(p.label).toBe("yarn.lock classic (v1)");
    expect(p.knowsDirect).toBe(false);
    expect(p.packages.map((x) => x.name + "@" + x.version)).toEqual(["@babel/code-frame@7.10.4", "@babel/highlight@7.10.4", "lodash@4.17.20", "minimist@1.2.5"]);
    expect(pkg(p, "lodash", "4.17.20").direct).toBeNull();
    expect(skipped(p, "left-pad").reason).toBe("git");
    expect(skipped(p, "shared-lib").reason).toBe("path");
  });
  test("berry: workspaces name the direct deps, patches map to the registry release", async () => {
    const p = parseLockfile(await fixture("yarn-berry.lock"), "yarn.lock");
    expect(p.label).toBe("yarn.lock berry");
    expect(p.knowsDirect).toBe(true);
    expect(p.knowsGroups).toBe(false);
    expect(p.packages.map((x) => x.name + "@" + x.version)).toEqual(["@babel/code-frame@7.10.4", "@babel/highlight@7.10.4", "lodash@4.17.20", "minimist@1.2.5", "resolve@1.22.8"]);
    expect(pkg(p, "@babel/code-frame", "7.10.4").direct).toBe(true);
    expect(pkg(p, "@babel/highlight", "7.10.4").direct).toBe(false);
    expect(pkg(p, "minimist", "1.2.5").direct).toBe(true);
    expect(skipped(p, "demo-app").reason).toBe("root");
    expect(skipped(p, "demo-lib").reason).toBe("workspace");
    expect(skipped(p, "left-pad")).toMatchObject({ reason: "git", version: "1.3.0" });
  });
  test("descriptor split keeps scopes", () => {
    expect(splitDescriptor("@babel/core@npm:^7")).toEqual({ name: "@babel/core", range: "npm:^7" });
    expect(splitDescriptor("lodash@^4")).toEqual({ name: "lodash", range: "^4" });
  });
  test("a file with neither header is refused", () => {
    expect(() => parseKind("yarn", "lodash@^4:\n  version 1\n")).toThrow("neither");
  });
});

describe("pnpm-lock.yaml", () => {
  test("v9: importers give direct deps and groups, peer suffixes stripped", async () => {
    const p = parseLockfile(await fixture("pnpm-v9.lock.yaml"), "pnpm-lock.yaml");
    expect(p.label).toBe("pnpm-lock.yaml v9.0");
    expect(p.packages.map((x) => x.name + "@" + x.version)).toEqual([
      "@babel/highlight@7.10.4", "lodash@4.17.20", "minimist@1.2.0", "minimist@1.2.5", "react@18.2.0", "react-dom@18.2.0", "scheduler@0.23.0",
    ]);
    expect(pkg(p, "lodash", "4.17.20")).toMatchObject({ direct: true, groups: [] });
    expect(pkg(p, "minimist", "1.2.5")).toMatchObject({ direct: true, groups: ["dev"] });
    expect(pkg(p, "minimist", "1.2.0")).toMatchObject({ direct: true, groups: [] });
    expect(pkg(p, "react-dom", "18.2.0").direct).toBe(true);
    expect(pkg(p, "react", "18.2.0").direct).toBe(false);
    expect(skipped(p, "left-pad")).toMatchObject({ reason: "git", version: "1.3.0" });
    expect(skipped(p, "demo-lib").reason).toBe("workspace");
    expect(p.notChecked).toHaveLength(2);
  });
  test("v6: top-level sections form the single importer, dev flags read", async () => {
    const p = parseLockfile(await fixture("pnpm-v6.lock.yaml"), "pnpm-lock.yaml");
    expect(p.label).toBe("pnpm-lock.yaml v6.0");
    expect(p.packages.map((x) => x.name + "@" + x.version)).toEqual(["lodash@4.17.20", "minimist@1.2.5", "scheduler@0.23.0"]);
    expect(pkg(p, "minimist", "1.2.5")).toMatchObject({ direct: true, groups: ["dev"] });
    expect(pkg(p, "scheduler", "0.23.0")).toMatchObject({ direct: false, groups: [] });
  });
  test("v5 is refused", () => {
    expect(() => parseKind("pnpm", "lockfileVersion: 5.4\npackages:\n  /lodash/4.17.20:\n    dev: false\n")).toThrow("lockfileVersion 5.4 is not supported");
  });
  test("package key split", () => {
    expect(splitPackageKey("/@babel/core@7.0.0(supports-color@5.5.0)")).toEqual({ name: "@babel/core", version: "7.0.0" });
    expect(splitPackageKey("lodash@4.17.20")).toEqual({ name: "lodash", version: "4.17.20" });
  });
});

describe("bun.lock", () => {
  test("workspaces name direct deps, nested keys are transitive", async () => {
    const p = parseLockfile(await fixture("bun-text.lock"), "bun.lock");
    expect(p.label).toBe("bun.lock v1");
    expect(p.packages.map((x) => x.name + "@" + x.version)).toEqual(["lodash@4.17.20", "minimist@1.2.0", "minimist@1.2.5"]);
    expect(pkg(p, "lodash", "4.17.20")).toMatchObject({ direct: true, groups: [] });
    expect(pkg(p, "minimist", "1.2.5")).toMatchObject({ direct: true, groups: ["dev"] });
    expect(pkg(p, "minimist", "1.2.0")).toMatchObject({ direct: false, groups: [] });
    expect(skipped(p, "demo-app").reason).toBe("root");
    expect(skipped(p, "demo-lib").reason).toBe("workspace");
    expect(skipped(p, "left-pad").reason).toBe("git");
    expect(p.notChecked).toHaveLength(3);
  });
  test("v2 reads the same shape; v3 is refused by number", async () => {
    const v1 = await fixture("bun-text.lock");
    const v2 = parseKind("bun", v1.replace('"lockfileVersion": 1', '"lockfileVersion": 2'));
    expect(v2.label).toBe("bun.lock v2");
    expect(v2.packages.map((x) => x.name + "@" + x.version)).toEqual(["lodash@4.17.20", "minimist@1.2.0", "minimist@1.2.5"]);
    expect(() => parseKind("bun", v1.replace('"lockfileVersion": 1', '"lockfileVersion": 3'))).toThrow("lockfileVersion 3 is not supported; 0, 1, and 2 are");
  });
});

describe("uv.lock", () => {
  test("project metadata gives direct deps, extras and dev groups", async () => {
    const p = parseLockfile(await fixture("uv-v1.lock"), "uv.lock");
    expect(p.ecosystem).toBe("PyPI");
    expect(p.packages.map((x) => x.name + "@" + x.version)).toEqual(["certifi@2024.2.2", "idna@3.6", "pysocks@1.7.1", "pytest@8.1.1", "requests@2.30.0"]);
    expect(pkg(p, "requests", "2.30.0")).toMatchObject({ direct: true, groups: [] });
    expect(pkg(p, "pysocks", "1.7.1")).toMatchObject({ direct: true, groups: ["socks"] });
    expect(pkg(p, "pytest", "8.1.1")).toMatchObject({ direct: true, groups: ["dev"] });
    expect(pkg(p, "idna", "3.6")).toMatchObject({ direct: true, groups: [] });
    expect(pkg(p, "certifi", "2024.2.2").direct).toBe(false);
    expect(skipped(p, "demo-app").reason).toBe("root");
    expect(skipped(p, "demo-lib").reason).toBe("workspace");
    expect(skipped(p, "my-fork").reason).toBe("git");
  });
  test("other versions are refused", () => {
    expect(() => parseKind("uv", 'version = 2\n[[package]]\nname = "a"\nversion = "1"\n')).toThrow("uv.lock version 2 is not supported");
  });
});

describe("helpers", () => {
  test("non-registry specs", () => {
    expect(nonRegistryReason("^4.17.0")).toBeNull();
    expect(nonRegistryReason("https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz")).toBeNull();
    expect(nonRegistryReason("github:stevemao/left-pad")).toBe("git");
    expect(nonRegistryReason("stevemao/left-pad")).toBe("git");
    expect(nonRegistryReason("git+https://github.com/a/b.git")).toBe("git");
    expect(nonRegistryReason("file:../x")).toBe("path");
    expect(nonRegistryReason("workspace:*")).toBe("workspace");
    expect(nonRegistryReason("https://example.com/pkg.tgz")).toBe("url");
  });
  test("loose version order", () => {
    expect(compareLoose("1.2.10", "1.2.9")).toBe(1);
    expect(compareLoose("4.17.21", "4.17.21")).toBe(0);
    expect(compareLoose("1.0.0-beta.1", "1.0.0")).toBe(-1);
    expect(compareLoose("2024.2.2", "2023.11.17")).toBe(1);
    expect(compareLoose("0", "0.2.4")).toBe(-1);
  });
});

describe("toml subset", () => {
  test("tables, arrays of tables, inline tables, strings", () => {
    const doc = parseToml('a = 1\nb = "x" # comment\n[[p]]\nname = "one"\n[p.meta]\nk = [ { n = "z" }, ]\n[[p]]\nname = "two"\nflag = true\n');
    expect(doc.a).toBe(1);
    expect(doc.b).toBe("x");
    expect(doc.p).toEqual([{ name: "one", meta: { k: [{ n: "z" }] } }, { name: "two", flag: true }]);
  });
  test("escapes and literal strings", () => {
    expect(parseToml('s = "a\\"b\\n"\nl = \'C:\\path\'\n')).toEqual({ s: 'a"b\n', l: "C:\\path" });
  });
  test("rejects garbage with a line number", () => {
    expect(() => parseToml("a = \n")).toThrow("line 1");
  });
});

describe("yaml subset", () => {
  test("block mappings, sequences, flow collections, quoting", () => {
    const doc = parseYaml("a: '1.10'\nb:\n  c: true\n  d: [x, 'y', \"z\"]\ne:\n  - one\n  - k: v\n    w: 2\nf: {g: h, i: 'j: k'}\n'q: k': 5\n# comment\n") as Record<string, unknown>;
    expect(doc.a).toBe("1.10");
    expect(doc.b).toEqual({ c: true, d: ["x", "y", "z"] });
    expect(doc.e).toEqual(["one", { k: "v", w: "2" }]);
    expect(doc.f).toEqual({ g: "h", i: "j: k" });
    expect(doc["q: k"]).toBe("5");
  });
  test("plain keys with colons inside, empty values", () => {
    const doc = parseYaml("packages:\n  left-pad@https://codeload.github.com/x/y/tar.gz/abc:\n    version: 1.3.0\n  empty:\n") as Record<string, Record<string, unknown>>;
    expect(doc.packages!["left-pad@https://codeload.github.com/x/y/tar.gz/abc"]).toEqual({ version: "1.3.0" });
    expect(doc.packages!.empty).toBeNull();
  });
  test("block scalars are refused", () => {
    expect(() => parseYaml("a: |\n  text\n")).toThrow("Block scalars");
  });
});
