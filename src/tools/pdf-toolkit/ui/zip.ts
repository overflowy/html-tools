// A zip of several files, for downloading them in one go: split parts,
// extracted images, attachments. Stored, not compressed (PDFs and images are
// compressed already), with UTF-8 names, as a Blob of the parts so no one
// big copy is made. The checksum is hash-wasm's CRC-32.

import { crc32 } from "hash-wasm";

const u16 = (v: DataView, at: number, n: number) => v.setUint16(at, n, true);
const u32 = (v: DataView, at: number, n: number) => v.setUint32(at, n, true);

/** A date in MS-DOS form: what zip keeps, to the even second, local time. */
const dosTime = (d: Date): [time: number, date: number] => [
  d.getHours() * 2048 + d.getMinutes() * 32 + Math.floor(d.getSeconds() / 2),
  (Math.max(1980, d.getFullYear()) - 1980) * 512 +
    (d.getMonth() + 1) * 32 +
    d.getDate(),
];

export interface ZipEntry {
  name: string;
  bytes: Uint8Array<ArrayBuffer>;
}

/** Names made unique, as a file manager would: "a.pdf", "a (2).pdf". */
const uniqueNames = (entries: ZipEntry[]): string[] => {
  const seen = new Set<string>();
  return entries.map(({ name }) => {
    let candidate = name;
    const dot = name.lastIndexOf(".");
    for (let n = 2; seen.has(candidate.toLowerCase()); n += 1) {
      candidate =
        dot > 0
          ? `${name.slice(0, dot)} (${n})${name.slice(dot)}`
          : `${name} (${n})`;
    }
    seen.add(candidate.toLowerCase());
    return candidate;
  });
};

const UTF8_NAMES = 0x08_00;

export const zip = async (
  entries: ZipEntry[],
  when = new Date()
): Promise<Blob> => {
  const [time, date] = dosTime(when);
  const enc = new TextEncoder();
  const parts: BlobPart[] = [];
  const central: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  for (const [i, name] of uniqueNames(entries).entries()) {
    const bytes: Uint8Array<ArrayBuffer> =
      entries[i]?.bytes ?? new Uint8Array();
    const nameBytes = enc.encode(name);
    const crc = Number.parseInt(await crc32(bytes), 16);
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    u32(lv, 0, 0x04_03_4b_50);
    u16(lv, 4, 20);
    u16(lv, 6, UTF8_NAMES);
    u16(lv, 8, 0);
    u16(lv, 10, time);
    u16(lv, 12, date);
    u32(lv, 14, crc);
    u32(lv, 18, bytes.length);
    u32(lv, 22, bytes.length);
    u16(lv, 26, nameBytes.length);
    local.set(nameBytes, 30);
    parts.push(local, bytes);
    const dir = new Uint8Array(46 + nameBytes.length);
    const dv = new DataView(dir.buffer);
    u32(dv, 0, 0x02_01_4b_50);
    u16(dv, 4, 20);
    u16(dv, 6, 20);
    u16(dv, 8, UTF8_NAMES);
    u16(dv, 10, 0);
    u16(dv, 12, time);
    u16(dv, 14, date);
    u32(dv, 16, crc);
    u32(dv, 20, bytes.length);
    u32(dv, 24, bytes.length);
    u16(dv, 28, nameBytes.length);
    u32(dv, 42, offset);
    dir.set(nameBytes, 46);
    central.push(dir);
    offset += local.length + bytes.length;
  }
  let size = 0;
  for (const c of central) {
    size += c.length;
  }
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  u32(ev, 0, 0x06_05_4b_50);
  u16(ev, 8, central.length);
  u16(ev, 10, central.length);
  u32(ev, 12, size);
  u32(ev, 16, offset);
  return new Blob([...parts, ...central, end], { type: "application/zip" });
};
