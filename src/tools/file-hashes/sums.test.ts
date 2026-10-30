// Unit tests for checksum files: reading the formats tools print, writing
// ones they read back, and matching listed names to files. Run: bun test
//
// The lines are what real tools print for a file `abc.txt` holding "abc":
// shasum (GNU format, text and binary mode, and --tag), OpenSSL 3, and
// BSD md5 (default and -r).
import { describe, expect, test } from "bun:test";

import { ALGORITHMS, algorithmsOfLength, inOrder } from "./algorithms";
import {
  algorithmFromName,
  formatSums,
  isSumsFileName,
  matchListed,
  normalizeDigest,
  parseSums,
} from "./sums";

const SHA256 =
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const SHA3 = "3a985da74fe225b2045c172d6bd390bd855f086e3e9d525b46bfe24511431532";
const MD5 = "900150983cd24fb0d6963f7d28e17f72";
const HELLO =
  "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

describe("parseSums", () => {
  test("GNU lines, text and binary mode, names with spaces", () => {
    const text = `${SHA256}  abc.txt\n${HELLO}  dir name.txt\n${SHA256} *bin.iso\n`;
    expect(parseSums(text, "SHA256SUMS")).toEqual([
      { algorithm: "sha256", digest: SHA256, name: "abc.txt" },
      { algorithm: "sha256", digest: HELLO, name: "dir name.txt" },
      { algorithm: "sha256", digest: SHA256, name: "bin.iso" },
    ]);
  });

  test("BSD tags, as shasum --tag, OpenSSL 3, and md5 print them", () => {
    const text = [
      `SHA256 (abc.txt) = ${SHA256}`,
      `SHA2-256(abc.txt)= ${SHA256}`,
      `SHA3-256(abc.txt)= ${SHA3}`,
      `MD5 (abc.txt) = ${MD5}`,
    ].join("\n");
    expect(parseSums(text, "CHECKSUMS")?.map((l) => l.algorithm)).toEqual([
      "sha256",
      "sha256",
      "sha3-256",
      "md5",
    ]);
  });

  test("md5 -r prints one space", () => {
    expect(parseSums(`${MD5} abc.txt`, "x.md5")).toEqual([
      { algorithm: "md5", digest: MD5, name: "abc.txt" },
    ]);
  });

  test("the list's name decides between Algorithms of one length", () => {
    expect(
      parseSums(`${SHA3}  abc.txt`, "abc.txt.sha3-256")?.[0]?.algorithm
    ).toBe("sha3-256");
    expect(parseSums(`${SHA3}  abc.txt`, "B3SUMS")?.[0]?.algorithm).toBe(
      "blake3"
    );
    // Nothing in the name: the common one of that length.
    expect(parseSums(`${SHA3}  abc.txt`, "list.txt")?.[0]?.algorithm).toBe(
      "sha256"
    );
    // A name that disagrees with the length is overruled by it.
    expect(parseSums(`${MD5}  abc.txt`, "SHA256SUMS")?.[0]?.algorithm).toBe(
      "md5"
    );
  });

  test("comments, blank lines, PGP armor, and unknown tags are skipped", () => {
    const text = [
      "-----BEGIN PGP SIGNED MESSAGE-----",
      "Hash: SHA256",
      "",
      "# release 1.0",
      `${SHA256}  abc.txt`,
      `WHATEVER (abc.txt) = ${SHA256}`,
      "-----BEGIN PGP SIGNATURE-----",
      "iQIzBAEBCAAdFiEE",
    ].join("\n");
    expect(parseSums(text, "SHA256SUMS")).toEqual([
      { algorithm: "sha256", digest: SHA256, name: "abc.txt" },
    ]);
    expect(parseSums("nothing here", "SHA256SUMS")).toBeNull();
  });

  test("SFV: name, then CRC32; semicolons comment", () => {
    expect(parseSums("; made by hand\nabc.txt 352441C2\n", "set.sfv")).toEqual([
      { algorithm: "crc32", digest: "352441c2", name: "abc.txt" },
    ]);
  });

  test("GNU escaping round-trips names with a backslash or newline", () => {
    const files = [
      { digests: new Map([["md5", MD5] as const]), name: "a\\b\nc" },
    ];
    const { text } = formatSums(files, ["md5"]);
    expect(text).toBe(`\\${MD5}  a\\\\b\\nc\n`);
    expect(parseSums(text, "MD5SUMS")?.[0]?.name).toBe("a\\b\nc");
  });
});

describe("formatSums", () => {
  const files = [
    {
      digests: new Map([
        ["sha256", SHA256],
        ["md5", MD5],
      ] as const),
      name: "abc.txt",
    },
  ];

  test("one Algorithm: GNU format, named after it", () => {
    expect(formatSums(files, ["sha256"])).toEqual({
      fileName: "SHA256SUMS",
      text: `${SHA256}  abc.txt\n`,
    });
  });

  test("several: BSD tags, which read back as written", () => {
    const out = formatSums(files, ["md5", "sha256"]);
    expect(out.fileName).toBe("CHECKSUMS");
    expect(out.text).toBe(
      `MD5 (abc.txt) = ${MD5}\nSHA256 (abc.txt) = ${SHA256}\n`
    );
    expect(parseSums(out.text, out.fileName)).toEqual([
      { algorithm: "md5", digest: MD5, name: "abc.txt" },
      { algorithm: "sha256", digest: SHA256, name: "abc.txt" },
    ]);
  });

  test("every Algorithm's tag reads back as that Algorithm", () => {
    for (const a of ALGORITHMS) {
      const digest = "0".repeat(a.hex);
      const out = formatSums(
        [{ digests: new Map([[a.id, digest]]), name: "f" }],
        [a.id, "md5"]
      );
      expect(parseSums(out.text, out.fileName)?.[0]).toEqual({
        algorithm: a.id,
        digest,
        name: "f",
      });
    }
  });

  test("nothing hashed yet, nothing written", () => {
    expect(
      formatSums([{ digests: new Map(), name: "x" }], ["sha256"]).text
    ).toBe("");
  });
});

describe("names and digests", () => {
  test("what is taken as a checksum list", () => {
    for (const n of [
      "SHA256SUMS",
      "sha256sums.txt",
      "ubuntu.iso.sha256",
      "MD5SUMS",
      "x.md5",
      "B3SUMS",
      "CHECKSUMS",
      "checksums.txt",
      "release.sfv",
    ]) {
      expect(isSumsFileName(n)).toBe(true);
    }
    for (const n of ["notes.txt", "photo.jpg", "summary.pdf", "sha.txt"]) {
      expect(isSumsFileName(n)).toBe(false);
    }
    expect(algorithmFromName("ubuntu-24.04.iso.sha512")).toBe("sha512");
    expect(algorithmFromName("SHA1SUMS")).toBe("sha1");
    expect(algorithmFromName("checksums.txt")).toBeNull();
  });

  test("a pasted Digest is made comparable", () => {
    expect(normalizeDigest(`  ${SHA256.toUpperCase()} `)).toBe(SHA256);
    expect(normalizeDigest("0x900150983CD24FB0D6963F7D28E17F72")).toBe(MD5);
    expect(
      normalizeDigest("90:01:50:98:3c:d2:4f:b0:d6:96:3f:7d:28:e1:7f:72")
    ).toBe(MD5);
    expect(normalizeDigest("9001 5098 3cd2 4fb0 d696 3f7d 28e1 7f72")).toBe(
      MD5
    );
    expect(normalizeDigest(`${SHA256}  ubuntu.iso`)).toBe(SHA256);
    expect(normalizeDigest("not a hash")).toBeNull();
    expect(normalizeDigest("   ")).toBeNull();
  });

  test("a listed name finds its file by path, or by a file name only one file has", () => {
    const files = [
      { path: "dist/app.tar.gz" },
      { path: "a/x.txt" },
      { path: "b/x.txt" },
    ];
    expect(matchListed("./dist/app.tar.gz", files)).toBe(files[0]);
    expect(matchListed("app.tar.gz", files)).toBe(files[0]);
    expect(matchListed("a/x.txt", files)).toBe(files[1]);
    // Two files are called x.txt: which one is meant cannot be told.
    expect(matchListed("x.txt", files)).toBeNull();
    expect(matchListed("missing.bin", files)).toBeNull();
  });

  test("Algorithms by Digest length, and in the picker's order", () => {
    expect(algorithmsOfLength(40).map((a) => a.id)).toEqual([
      "sha1",
      "ripemd160",
    ]);
    expect(inOrder(["sha256", "nope", "md5"])).toEqual(["md5", "sha256"]);
  });
});
