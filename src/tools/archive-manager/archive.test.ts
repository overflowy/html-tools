// Unit tests for reading 7-Zip's output and building its command lines.
// Run: bun test
//
// fixtures.json is real output of the vendored JS7z build: a 7z with
// encrypted files, a zip with junk after its end, a tar.gz, a 7z with
// encrypted names opened without the password, a file that is no archive,
// and tests that pass, lack the password, hit a truncated stream, and hit
// a CRC error.
import { describe, expect, test } from "bun:test";

import {
  IN,
  OUT,
  baseName,
  createSteps,
  extractArgs,
  firstVolume,
  levelFor,
  listArgs,
  looksLikeArchive,
  readOutcome,
  readTotals,
  testArgs,
} from "./commands";
import type { CreateOptions, Format } from "./commands";
import fixtures from "./fixtures.json";
import { parseListing, parseTime } from "./listing";
import type { Entry } from "./listing";
import { buildTree, descendants, findNode, segments, sortNodes } from "./tree";

const T = new Date(2024, 0, 15, 10, 30, 0).getTime();

describe("parseListing", () => {
  test("reads a 7z: properties, files, folders, encryption", () => {
    const { info, entries } = parseListing(fixtures.list7z.stdout);
    expect(info.type).toBe("7z");
    expect(info.solid).toBe(true);
    expect(info.method).toContain("7zAES");
    expect(info.physicalSize).toBeGreaterThan(0);
    expect(info.warnings).toEqual([]);
    const byPath = new Map(entries.map((e) => [e.path, e]));
    expect([...byPath.keys()].toSorted()).toEqual([
      "docs",
      "docs/a b.md",
      "docs/empty",
      "docs/ünï.txt",
      "readme.txt",
    ]);
    expect(byPath.get("docs")?.dir).toBe(true);
    expect(byPath.get("docs/empty")?.dir).toBe(true);
    const readme = byPath.get("readme.txt");
    expect(readme?.dir).toBe(false);
    expect(readme?.size).toBe(300);
    expect(readme?.encrypted).toBe(true);
    expect(readme?.mtime).toBe(T);
    expect(readme?.crc).toMatch(/^[0-9A-F]{8}$/u);
  });

  test("a warning printed mid-properties is a warning, and the properties after it still count", () => {
    const { info, entries } = parseListing(fixtures.listZipJunk.stdout);
    expect(info.type).toBe("zip");
    expect(info.warnings).toEqual(["There are data after the end of archive"]);
    expect(info.physicalSize).toBe(
      Number(info.props.find(([k]) => k === "Physical Size")?.[1])
    );
    expect(info.props.some(([k]) => k === "Tail Size")).toBe(true);
    expect(info.solid).toBeNull();
    // Folders by `Folder = +`, not only by attributes.
    expect(
      entries
        .filter((e) => e.dir)
        .map((e) => e.path)
        .toSorted()
    ).toEqual(["docs", "docs/empty"]);
  });

  test("a tar.gz lists the one tar inside", () => {
    const { info, entries } = parseListing(fixtures.listTgz.stdout);
    expect(info.type).toBe("gzip");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe("x.tar");
    expect(entries[0]?.dir).toBe(false);
  });

  test("an archive that did not open lists nothing", () => {
    expect(parseListing(fixtures.listHeadersNoPw.stdout).entries).toEqual([]);
    expect(parseListing(fixtures.listNotArchive.stdout).entries).toEqual([]);
  });

  test("times: fraction optional, local time, garbage is null", () => {
    expect(parseTime("2024-01-15 10:30:00")).toBe(T);
    expect(parseTime("2024-01-15 10:30:00.2650000")).toBe(T + 265);
    expect(parseTime("")).toBeNull();
    expect(parseTime("yesterday")).toBeNull();
  });
});

describe("readOutcome", () => {
  const read = (f: { code: number; stdout: string[]; stderr: string[] }) =>
    readOutcome(f.code, f.stdout, f.stderr);

  test("encrypted names without the password", () => {
    const o = read(fixtures.listHeadersNoPw);
    expect(o.ok).toBe(false);
    expect(o.wrongPassword).toBe(true);
    // The path under IN is the user's file name.
    expect(o.errors[0]).toBe(
      "h.7z : Cannot open encrypted archive. Wrong password?"
    );
  });

  test("not an archive", () => {
    const o = read(fixtures.listNotArchive);
    expect(o.ok).toBe(false);
    expect(o.notArchive).toBe(true);
    expect(o.wrongPassword).toBe(false);
  });

  test("encrypted files tested without the password", () => {
    const o = read(fixtures.testNoPw);
    expect(o.wrongPassword).toBe(true);
    expect(o.errors).toHaveLength(3);
  });

  test("a truncated stream", () => {
    const o = read(fixtures.testTruncated);
    expect(o.ok).toBe(false);
    expect(o.truncated).toBe(true);
    expect(o.errors).toEqual(["Unexpected end of data : x.tar"]);
  });

  test("a CRC error names the file", () => {
    const o = read(fixtures.testCrc);
    expect(o.ok).toBe(false);
    expect(o.wrongPassword).toBe(false);
    expect(o.errors).toEqual(["CRC Failed : readme.txt"]);
  });

  test("a clean test, and its totals", () => {
    const o = read(fixtures.testOk);
    expect(o).toEqual({
      errors: [],
      notArchive: false,
      ok: true,
      truncated: false,
      warnings: [],
      wrongPassword: false,
    });
    expect(readTotals(fixtures.testOk.stdout)).toEqual({
      files: 3,
      folders: 2,
      size: 305,
    });
  });

  test("a failure with no message still says something", () => {
    expect(readOutcome(8, [], []).errors).toEqual(["7-Zip ran out of memory."]);
    expect(readOutcome(42, [], []).errors).toEqual([
      "7-Zip exited with code 42.",
    ]);
  });

  test("a heading's lines are errors until a blank line", () => {
    const o = readOutcome(
      2,
      [],
      ["", "ERROR:", "Unsupported archive type", ""]
    );
    expect(o.errors).toEqual(["Unsupported archive type"]);
    expect(o.notArchive).toBe(true);
  });
});

const entry = (path: string, dir = false, size = 1, mtime = T): Entry => ({
  crc: "",
  dir,
  encrypted: false,
  method: "",
  modified: "",
  mtime,
  packed: null,
  path,
  size,
});

describe("buildTree", () => {
  test("makes implied folders real and totals them", () => {
    const root = buildTree([
      entry("a/b/c.txt", false, 10),
      entry("a/d.txt", false, 5, T + 1000),
      entry("e.txt", false, 1),
    ]);
    expect([...root.children.keys()].toSorted()).toEqual(["a", "e.txt"]);
    const a = findNode(root, "a");
    expect(a?.dir).toBe(true);
    expect(a?.entry).toBeUndefined();
    expect(a?.size).toBe(15);
    expect(a?.files).toBe(2);
    expect(a?.mtime).toBe(T + 1000);
    expect(findNode(root, "a/b")?.files).toBe(1);
    expect(root.files).toBe(3);
    expect(root.size).toBe(16);
    expect(findNode(root, "nope")).toBeNull();
  });

  test("a folder's own entry is kept, whichever comes first", () => {
    const root = buildTree([entry("a/x", false), entry("a", true, 0, T - 5)]);
    const a = findNode(root, "a");
    expect(a?.entry?.path).toBe("a");
    expect(a?.mtime).toBe(T - 5);
  });

  test("backslashes, dots, and doubled slashes are noise; .. stays visible", () => {
    expect(segments("a\\b//./c")).toEqual(["a", "b", "c"]);
    expect(segments("/../etc/passwd")).toEqual(["..", "etc", "passwd"]);
    const root = buildTree([entry("./x\\y.txt")]);
    expect(findNode(root, "x/y.txt")?.dir).toBe(false);
  });

  test("a folder named like a file wins over it", () => {
    const root = buildTree([entry("a"), entry("a/b")]);
    expect(findNode(root, "a")?.dir).toBe(true);
    expect(descendants(root).map((n) => n.path)).toEqual(["a", "a/b"]);
  });

  test("sorting puts folders first and compares numbers as numbers", () => {
    const root = buildTree([
      entry("file10.txt", false, 1),
      entry("file2.txt", false, 3),
      entry("dir/x", false, 1),
    ]);
    const names = (key: "name" | "size", desc: boolean) =>
      sortNodes([...root.children.values()], key, desc).map((n) => n.name);
    expect(names("name", false)).toEqual(["dir", "file2.txt", "file10.txt"]);
    expect(names("size", true)).toEqual(["dir", "file2.txt", "file10.txt"]);
  });
});

const options = (o: Partial<CreateOptions>): CreateOptions => ({
  encryptNames: true,
  format: "7z",
  level: 5,
  password: "",
  zipEncryption: "aes",
  ...o,
});

describe("command lines", () => {
  test("every command ends its switches before any name and never prompts", () => {
    expect(listArgs("/in/-a.7z", "")).toEqual([
      "l",
      "-slt",
      "-p",
      "--",
      "/in/-a.7z",
    ]);
    expect(testArgs("/in/a.7z", "pw")).toEqual(["t", "-ppw", "--", "/in/a.7z"]);
    expect(extractArgs("/in/a.zip", "", ["a*b", "-x"])).toEqual([
      "x",
      "-y",
      "-p",
      `-o${OUT}`,
      "-spd",
      "--",
      "/in/a.zip",
      "a*b",
      "-x",
    ]);
  });

  test("7z with a password hides names unless told not to", () => {
    const [step] = createSteps("x.7z", ["a", "b"], options({ password: "pw" }));
    expect(step?.cwd).toBe(IN);
    expect(step?.args).toEqual([
      "a",
      "-t7z",
      "-mx5",
      "-ppw",
      "-mhe=on",
      "-y",
      "-spd",
      "--",
      `${OUT}/x.7z`,
      "a",
      "b",
    ]);
    const [plain] = createSteps(
      "x.7z",
      ["a"],
      options({ encryptNames: false, password: "pw" })
    );
    expect(plain?.args).not.toContain("-mhe=on");
  });

  test("zip: UTF-8 names, AES or ZipCrypto", () => {
    const [aes] = createSteps(
      "x.zip",
      ["a"],
      options({ format: "zip", level: 9, password: "pw" })
    );
    expect(aes?.args).toEqual([
      "a",
      "-tzip",
      "-mx9",
      "-mcu=on",
      "-ppw",
      "-mem=AES256",
      "-y",
      "-spd",
      "--",
      `${OUT}/x.zip`,
      "a",
    ]);
    const [legacy] = createSteps(
      "x.zip",
      ["a"],
      options({ format: "zip", password: "pw", zipEncryption: "zipcrypto" })
    );
    expect(legacy?.args).toContain("-mem=ZipCrypto");
    const [none] = createSteps("x.zip", ["a"], options({ format: "zip" }));
    expect(
      none?.args.some((a) => a.startsWith("-p") || a.startsWith("-mem"))
    ).toBe(false);
  });

  test("tar ignores level and password", () => {
    const steps = createSteps(
      "x.tar",
      ["a"],
      options({ format: "tar", level: 9, password: "pw" })
    );
    expect(steps).toEqual([
      {
        args: ["a", "-ttar", "-y", "-spd", "--", `${OUT}/x.tar`, "a"],
        cwd: IN,
      },
    ]);
  });

  test("a compressed tarball is a tar, then the tar compressed", () => {
    const steps = createSteps(
      "x.tar.xz",
      ["a", "b"],
      options({ format: "tar.xz", level: 0 })
    );
    expect(steps).toEqual([
      {
        args: ["a", "-ttar", "-y", "-spd", "--", `${OUT}/x.tar`, "a", "b"],
        cwd: IN,
      },
      // Store is not an xz level: the nearest one is used.
      {
        args: [
          "a",
          "-txz",
          "-mx1",
          "-y",
          "-spd",
          "--",
          `${OUT}/x.tar.xz`,
          "x.tar",
        ],
        cwd: IN,
      },
    ]);
  });

  test("a single-file format compresses the one file", () => {
    expect(
      createSteps("n.txt.gz", ["n.txt"], options({ format: "gz", level: 9 }))
    ).toEqual([
      {
        args: [
          "a",
          "-tgzip",
          "-mx9",
          "-y",
          "-spd",
          "--",
          `${OUT}/n.txt.gz`,
          "n.txt",
        ],
        cwd: IN,
      },
    ]);
  });

  test("levels snap to what a format offers", () => {
    const xz = { levels: [1, 3, 5, 7, 9] } as Format;
    expect(levelFor(xz, 0)).toBe(1);
    expect(levelFor(xz, 9)).toBe(9);
    expect(levelFor({ levels: [] } as unknown as Format, 5)).toBeNull();
  });
});

describe("names", () => {
  test("what is opened when dropped alone", () => {
    for (const n of [
      "a.zip",
      "A.7Z",
      "x.tar.gz",
      "x.tgz",
      "d.iso",
      "s.7z.001",
      "r.part1.rar",
      "z.z01",
    ]) {
      expect(looksLikeArchive(n)).toBe(true);
    }
    for (const n of [
      "report.docx",
      "book.epub",
      "photo.jpg",
      "notes",
      ".zip",
    ]) {
      expect(looksLikeArchive(n)).toBe(false);
    }
  });

  test("the volume a split archive is opened by", () => {
    expect(firstVolume(["a.7z.002", "a.7z.001", "a.7z.003"])).toBe("a.7z.001");
    expect(firstVolume(["a.part2.rar", "a.part1.rar"])).toBe("a.part1.rar");
    expect(firstVolume(["a.part02.rar", "a.part01.rar"])).toBe("a.part01.rar");
    expect(firstVolume(["a.r00", "a.rar", "a.r01"])).toBe("a.rar");
    expect(firstVolume(["a.z01", "a.zip"])).toBe("a.zip");
    expect(firstVolume(["a.zip"])).toBeNull();
    expect(firstVolume(["a.zip", "b.zip"])).toBeNull();
    expect(firstVolume(["a.7z.001", "b.7z.002"])).toBeNull();
    // The first volume itself must be there.
    expect(firstVolume(["a.7z.002", "a.7z.003"])).toBeNull();
  });

  test("base names drop the whole archive extension", () => {
    expect(baseName("photos.zip")).toBe("photos");
    expect(baseName("src.tar.gz")).toBe("src");
    expect(baseName("big.7z.001")).toBe("big");
    expect(baseName("r.part1.rar")).toBe("r");
    expect(baseName("noext")).toBe("noext");
  });
});
