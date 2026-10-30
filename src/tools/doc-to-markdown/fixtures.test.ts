import { describe, expect, test } from "bun:test";

import { buildDocx, buildPdf, buildZip } from "./fixtures";

// The fixtures are byte-level builders, so pin their exact output: any
// change to object order, offsets, CRCs or little-endian packing shows up
// as a different digest.
const sha256 = (bytes: Uint8Array) =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

const jpeg = {
  bytes: new Uint8Array(Array.from({ length: 300 }, (_, i) => (i * 37) % 256)),
  height: 30,
  width: 40,
};

describe("fixtures", () => {
  test("pdf bytes", () => {
    const pdf = buildPdf([
      { text: ["Hello (world)", "back\\slash", "ünïcode"] },
      { jpeg },
      { jpeg, text: ["a"] },
      {},
    ]);
    expect(sha256(pdf)).toBe(
      "536e2bb49f8e3f5b7715cac8297437fc369f2c5d1f87b8c4cd7a7e8bbacf9c0d"
    );
  });

  test("docx bytes", () => {
    const docx = buildDocx("A <heading> & more", ["one", "two ünï", "three"]);
    expect(sha256(docx)).toBe(
      "5e2f4cc480eb6fe1fc2b74be46234a5aa0d7458df4f9482950564a9c09a802df"
    );
  });

  test("zip bytes", () => {
    const zip = buildZip([
      ["a.txt", "x".repeat(1000)],
      ["b/c.xml", "ÿ中"],
    ]);
    expect(sha256(zip)).toBe(
      "1b6b2c5688837c9028b844dcb657161ec65b345f46964066825764b0b3d1b816"
    );
  });

  test("zip crc32 above 2**31 is stored little-endian", () => {
    // CRC-32 of "123456789" is the standard check value 0xcbf43926.
    const zip = buildZip([["n", "123456789"]]);
    expect([...zip.subarray(14, 18)]).toEqual([0x26, 0x39, 0xf4, 0xcb]);
  });
});
