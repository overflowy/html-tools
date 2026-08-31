// Unit tests for the QR encoder. Run: bun test
// fixtures.json holds expected module matrices for a battery of inputs
// (spec-determined data: any conforming encoder produces these exact matrices).
import { describe, expect, test } from "bun:test";
import { encode, maxBytes, pickMode, type Ecl } from "./qrcode";
import fixtures from "./fixtures.json";

interface Fixture {
  text: string;
  ecl: string;
  mask: number;
  version: number;
  appliedMask: number;
  matrix: string[];
}

function rowsOf(qr: ReturnType<typeof encode>): string[] {
  const rows: string[] = [];
  for (let y = 0; y < qr.size; y++) {
    let row = "";
    for (let x = 0; x < qr.size; x++) row += qr.matrix[y * qr.size + x] ? "1" : "0";
    rows.push(row);
  }
  return rows;
}

describe("mode selection", () => {
  test("digits are numeric", () => expect(pickMode("0123456789")).toBe("numeric"));
  test("uppercase charset is alphanumeric", () => expect(pickMode("HELLO WORLD $1/2")).toBe("alphanumeric"));
  test("lowercase falls back to byte", () => expect(pickMode("hello")).toBe("byte"));
  test("non-ASCII falls back to byte", () => expect(pickMode("héllo")).toBe("byte"));
});

describe("fixture matrices", () => {
  for (const f of fixtures as Fixture[]) {
    const label = JSON.stringify(f.text.slice(0, 30)) + " " + f.ecl +
      (f.mask >= 0 ? " mask " + f.mask : "");
    test(label, () => {
      const qr = encode(f.text, f.ecl as Ecl, f.mask);
      expect(qr.version).toBe(f.version);
      expect(qr.mask).toBe(f.appliedMask);
      expect(rowsOf(qr)).toEqual(f.matrix);
    });
  }
});

describe("capacity limits", () => {
  test("data too long throws", () => {
    expect(() => encode("x".repeat(3000), "L")).toThrow(RangeError);
    expect(() => encode("x".repeat(1300), "H")).toThrow(RangeError);
  });
  test("maxBytes is the exact byte-mode boundary", () => {
    for (const ecl of ["L", "M", "Q", "H"] as const) {
      const n = maxBytes(ecl);
      expect(encode("x".repeat(n), ecl).version).toBe(40);
      expect(() => encode("x".repeat(n + 1), ecl)).toThrow(RangeError);
    }
  });
});

describe("structural invariants", () => {
  test("size follows version", () => {
    const qr = encode("structural check", "M");
    expect(qr.size).toBe(qr.version * 4 + 17);
    expect(qr.matrix.length).toBe(qr.size * qr.size);
  });
  test("higher error correction never shrinks the version", () => {
    const text = "The quick brown fox jumps over the lazy dog";
    let prev = 0;
    for (const ecl of ["L", "M", "Q", "H"] as const) {
      const v = encode(text, ecl).version;
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});
