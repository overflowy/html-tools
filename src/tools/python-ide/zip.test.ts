import { expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";

import { readZip, writeZip } from "./zip";

const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

/** Bytes whose values wander over the whole range, the same on every run. */
const sample = (length: number, seed: number) =>
  Uint8Array.from({ length }, (_, i) => (i * 131 + seed * 17 + (i % 7)) % 256);

test("a written entry carries the standard CRC-32 of its bytes", async () => {
  const datas = [
    new TextEncoder().encode("123456789"),
    new Uint8Array(0),
    Uint8Array.from({ length: 256 }, (_, i) => i),
    sample(10_000, 3),
    sample(1, 250),
  ];
  for (const data of datas) {
    const zip = await bytesOf(writeZip([{ data, path: "f" }], 0));
    const view = new DataView(zip.buffer);
    expect(view.getUint32(14, true)).toBe(Bun.hash.crc32(data));
  }
  const check = await bytesOf(
    writeZip([{ data: datas[0] ?? new Uint8Array(0), path: "f" }], 0)
  );
  expect(new DataView(check.buffer).getUint32(14, true)).toBe(0xcb_f4_39_26);
});

test("the entry's DOS time and date are packed from local time", async () => {
  const cases: [Date, number, number][] = [
    // 13:45:58 -> 13 << 11 | 45 << 5 | 29; 2024-03-15 -> 44 << 9 | 3 << 5 | 15
    [new Date(2024, 2, 15, 13, 45, 58), 28_093, 22_639],
    [new Date(2000, 0, 1, 0, 0, 0), 0, 10_273],
    [new Date(2107, 11, 31, 23, 59, 59), 49_021, 65_439],
    // Before the DOS epoch the year is clamped to 1980.
    [new Date(1975, 5, 9, 7, 8, 9), 14_596, 201],
  ];
  for (const [when, time, date] of cases) {
    const zip = await bytesOf(
      writeZip([{ data: new Uint8Array(1), path: "f" }], when.getTime())
    );
    const view = new DataView(zip.buffer);
    expect([view.getUint16(10, true), view.getUint16(12, true)]).toEqual([
      time,
      date,
    ]);
  }
});

test("what is written reads back, names in UTF-8", async () => {
  const entries = [
    { data: sample(5000, 1), path: "main.py" },
    { data: new Uint8Array(0), path: "pkg/empty.txt" },
    { data: sample(3, 9), path: "données/ü.py" },
  ];
  const zip = await bytesOf(writeZip(entries));
  const back = await readZip(zip.buffer);
  expect(back.map((e) => e.path)).toEqual(entries.map((e) => e.path));
  for (const [i, e] of back.entries()) {
    expect(e.data).toEqual(entries[i]?.data ?? new Uint8Array(0));
  }
});

test("a name without the UTF-8 flag is read as Latin-1", async () => {
  const zip = await bytesOf(
    writeZip([{ data: new Uint8Array([1]), path: "x" }])
  );
  // Clear the flag in the central directory (after the 30-byte local
  // header, the name and the data) and put a byte UTF-8 rejects in the name.
  const central = 30 + 1 + 1;
  const view = new DataView(zip.buffer);
  view.setUint16(central + 8, 0, true);
  zip[central + 46] = 0xe9;
  const [entry] = await readZip(zip.buffer);
  expect(entry?.path).toBe("é");
});

test("a deflated entry is inflated", async () => {
  const data = new TextEncoder().encode("print('hello')\n".repeat(200));
  const deflated = new Uint8Array(deflateRawSync(data));
  const zip = await bytesOf(writeZip([{ data: deflated, path: "a.py" }]));
  const view = new DataView(zip.buffer);
  const central = 30 + 4 + deflated.length;
  // Method 8 in both headers, and the uncompressed size in the directory.
  view.setUint16(8, 8, true);
  view.setUint16(central + 10, 8, true);
  view.setUint32(central + 24, data.length, true);
  const [entry] = await readZip(zip.buffer);
  expect(entry?.data).toEqual(data);
});

test("anything else is refused", async () => {
  await expect(readZip(new Uint8Array(100).buffer)).rejects.toThrow(
    "Not a zip file."
  );
  const zip = await bytesOf(
    writeZip([{ data: new Uint8Array([1, 2]), path: "x" }])
  );
  const central = 30 + 1 + 2;
  new DataView(zip.buffer).setUint16(central + 10, 12, true);
  await expect(readZip(zip.buffer)).rejects.toThrow(
    "Unsupported compression (method 12) for x."
  );
});
