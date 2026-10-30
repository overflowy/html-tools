// The Algorithms File Hashes offers, as data: what the picker shows, how
// long each Digest is, and the name each goes by in a checksum file. The
// code that computes them lives in the worker, so the main bundle carries
// none of it.

export type AlgorithmId =
  | "crc32"
  | "crc32c"
  | "crc64"
  | "adler32"
  | "md5"
  | "sha1"
  | "sha224"
  | "sha256"
  | "sha384"
  | "sha512"
  | "sha3-256"
  | "sha3-512"
  | "keccak256"
  | "blake2b"
  | "blake2s"
  | "blake3"
  | "xxh32"
  | "xxh64"
  | "xxh3"
  | "xxh128"
  | "ripemd160"
  | "whirlpool"
  | "sm3";

export interface Algorithm {
  id: AlgorithmId;
  label: string;
  /** Hex digits in a Digest. */
  hex: number;
  /** The tag in a BSD-style checksum line, `SHA256 (name) = ...`. */
  tag: string;
  /** Shown in the picker's first row; the rest are a click further. */
  common: boolean;
  /** What it is for, as the picker's tooltip. */
  note: string;
}

/** In family order, which is the order Digests are listed in; `common` picks the picker's first row. */
export const ALGORITHMS: Algorithm[] = [
  {
    common: true,
    hex: 8,
    id: "crc32",
    label: "CRC32",
    note: "Checksum used by zip, gzip, and PNG. Catches accidents, not tampering.",
    tag: "CRC32",
  },
  {
    common: false,
    hex: 8,
    id: "crc32c",
    label: "CRC32C",
    note: "The Castagnoli CRC used by iSCSI, ext4, and cloud storage (Google Cloud's crc32c).",
    tag: "CRC32C",
  },
  {
    common: false,
    hex: 16,
    id: "crc64",
    label: "CRC64",
    note: "The CRC-64 of xz and 7-Zip (ECMA-182, reflected).",
    tag: "CRC64",
  },
  {
    common: false,
    hex: 8,
    id: "adler32",
    label: "Adler-32",
    note: "The checksum inside zlib streams.",
    tag: "ADLER32",
  },
  {
    common: true,
    hex: 32,
    id: "md5",
    label: "MD5",
    note: "Broken for security, still common for spotting corrupted downloads.",
    tag: "MD5",
  },
  {
    common: true,
    hex: 40,
    id: "sha1",
    label: "SHA-1",
    note: "Broken for security; git and older download pages still use it.",
    tag: "SHA1",
  },
  {
    common: false,
    hex: 56,
    id: "sha224",
    label: "SHA-224",
    note: "SHA-256 cut short.",
    tag: "SHA224",
  },
  {
    common: true,
    hex: 64,
    id: "sha256",
    label: "SHA-256",
    note: "The usual choice for verifying downloads.",
    tag: "SHA256",
  },
  {
    common: false,
    hex: 96,
    id: "sha384",
    label: "SHA-384",
    note: "SHA-512 cut short.",
    tag: "SHA384",
  },
  {
    common: true,
    hex: 128,
    id: "sha512",
    label: "SHA-512",
    note: "SHA-2 with a longer digest; faster than SHA-256 on 64-bit machines.",
    tag: "SHA512",
  },
  {
    common: false,
    hex: 64,
    id: "sha3-256",
    label: "SHA3-256",
    note: "SHA-3, the standard built on Keccak.",
    tag: "SHA3-256",
  },
  {
    common: false,
    hex: 128,
    id: "sha3-512",
    label: "SHA3-512",
    note: "SHA-3 with a longer digest.",
    tag: "SHA3-512",
  },
  {
    common: false,
    hex: 64,
    id: "keccak256",
    label: "Keccak-256",
    note: "Keccak before SHA-3's padding change, as Ethereum uses it.",
    tag: "KECCAK256",
  },
  {
    common: false,
    hex: 128,
    id: "blake2b",
    label: "BLAKE2b",
    note: "BLAKE2b-512, as b2sum prints it.",
    tag: "BLAKE2b",
  },
  {
    common: false,
    hex: 64,
    id: "blake2s",
    label: "BLAKE2s",
    note: "BLAKE2s-256, for 32-bit machines.",
    tag: "BLAKE2s",
  },
  {
    common: true,
    hex: 64,
    id: "blake3",
    label: "BLAKE3",
    note: "Modern and very fast.",
    tag: "BLAKE3",
  },
  {
    common: false,
    hex: 8,
    id: "xxh32",
    label: "XXH32",
    note: "xxHash, 32-bit. Fast, not for security.",
    tag: "XXH32",
  },
  {
    common: false,
    hex: 16,
    id: "xxh64",
    label: "XXH64",
    note: "xxHash, 64-bit. Fast, not for security.",
    tag: "XXH64",
  },
  {
    common: false,
    hex: 16,
    id: "xxh3",
    label: "XXH3",
    note: "xxHash's newest, 64-bit. Fast, not for security.",
    tag: "XXH3",
  },
  {
    common: false,
    hex: 32,
    id: "xxh128",
    label: "XXH128",
    note: "XXH3 with a 128-bit digest. Fast, not for security.",
    tag: "XXH128",
  },
  {
    common: false,
    hex: 40,
    id: "ripemd160",
    label: "RIPEMD-160",
    note: "Used in Bitcoin addresses.",
    tag: "RMD160",
  },
  {
    common: false,
    hex: 128,
    id: "whirlpool",
    label: "Whirlpool",
    note: "A 512-bit hash from the ISO standard.",
    tag: "WHIRLPOOL",
  },
  {
    common: false,
    hex: 64,
    id: "sm3",
    label: "SM3",
    note: "The Chinese national standard hash.",
    tag: "SM3",
  },
];

export const DEFAULT_ALGORITHMS: AlgorithmId[] = ["md5", "sha1", "sha256"];

const BY_ID = new Map(ALGORITHMS.map((a) => [a.id, a]));

export const algorithmById = (id: string): Algorithm | undefined =>
  BY_ID.get(id as AlgorithmId);

/** Every Algorithm whose Digest has `hex` digits: what a pasted Digest could be. */
export const algorithmsOfLength = (hex: number): Algorithm[] =>
  ALGORITHMS.filter((a) => a.hex === hex);

/** Ids in the picker's order, whatever order they were given in. */
export const inOrder = (ids: Iterable<string>): AlgorithmId[] => {
  const want = new Set(ids);
  return ALGORITHMS.filter((a) => want.has(a.id)).map((a) => a.id);
};
