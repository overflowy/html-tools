// Reading ASN.1 in DER (and the BER some signing software writes, with
// indefinite lengths): enough for CMS signatures and X.509 certificates.
// Every node keeps the exact bytes it was read from, because a signature
// is checked against bytes as they were written, not as they would be
// written again.

export interface Asn1 {
  /** The identifier octet: class, constructed bit, and tag number (low tag numbers only). */
  tag: number;
  /** The whole element, header included. */
  raw: Uint8Array<ArrayBuffer>;
  /** The contents, without the header. */
  body: Uint8Array<ArrayBuffer>;
  children: Asn1[];
}

export const TAG = {
  bitString: 0x03,
  bmpString: 0x1e,
  boolean: 0x01,
  generalizedTime: 0x18,
  ia5String: 0x16,
  integer: 0x02,
  null: 0x05,
  octetString: 0x04,
  oid: 0x06,
  printableString: 0x13,
  sequence: 0x30,
  set: 0x31,
  t61String: 0x14,
  universalString: 0x1c,
  utcTime: 0x17,
  utf8String: 0x0c,
} as const;

/** Bits of an identifier or length octet, as arithmetic: the lint preset keeps bitwise operators out. */
const lowBits = (b: number, bits: number) => b % 2 ** bits;
const bitSet = (b: number, bit: number) => Math.floor(b / 2 ** bit) % 2 === 1;
/** Past this depth the input is not a certificate anyone made. */
const MAX_DEPTH = 64;

class Reader {
  readonly bytes: Uint8Array<ArrayBuffer>;

  constructor(bytes: Uint8Array<ArrayBuffer>) {
    this.bytes = bytes;
  }

  byte(at: number): number {
    const b = this.bytes[at];
    if (b === undefined) {
      throw new Error("The signature data ends early.");
    }
    return b;
  }

  /** The element at `at`, and where the next one starts. */
  read(at: number, depth: number): { node: Asn1; end: number } {
    if (depth > MAX_DEPTH) {
      throw new Error("The signature data nests too deep.");
    }
    let p = at;
    const tag = this.byte(p);
    p += 1;
    if (lowBits(tag, 5) === 31) {
      // A high tag number: skip its base-128 digits.
      while (bitSet(this.byte(p), 7)) {
        p += 1;
      }
      p += 1;
    }
    const first = this.byte(p);
    p += 1;
    let length = -1;
    if (first < 0x80) {
      length = first;
    } else if (first > 0x80) {
      const n = lowBits(first, 7);
      length = 0;
      for (let i = 0; i < n; i += 1) {
        length = length * 256 + this.byte(p);
        p += 1;
      }
    }
    const constructed = bitSet(tag, 5);
    const children: Asn1[] = [];
    let bodyEnd: number;
    let end: number;
    if (length === -1) {
      // Indefinite length (BER): children until an end-of-contents marker.
      let q = p;
      while (!(this.byte(q) === 0 && this.byte(q + 1) === 0)) {
        const child = this.read(q, depth + 1);
        children.push(child.node);
        q = child.end;
      }
      bodyEnd = q;
      end = q + 2;
    } else {
      bodyEnd = p + length;
      end = bodyEnd;
      if (end > this.bytes.length) {
        throw new Error("The signature data ends early.");
      }
      if (constructed) {
        let q = p;
        while (q < bodyEnd) {
          const child = this.read(q, depth + 1);
          children.push(child.node);
          q = child.end;
        }
      }
    }
    return {
      end,
      node: {
        body: this.bytes.subarray(p, bodyEnd),
        children,
        raw: this.bytes.subarray(at, end),
        tag,
      },
    };
  }
}

/** The first element of `bytes`; anything after it (a signature's zero padding) is ignored. */
export const parseAsn1 = (bytes: Uint8Array<ArrayBuffer>): Asn1 =>
  new Reader(bytes).read(0, 0).node;

/** Child `i`, which must exist. */
export const child = (n: Asn1, i: number): Asn1 => {
  const c = n.children[i];
  if (!c) {
    throw new Error("The signature data is missing a part.");
  }
  return c;
};

/** The children with a context tag [n] (0xa0 + n constructed, 0x80 + n primitive). */
export const tagged = (n: Asn1, number: number): Asn1 | undefined =>
  n.children.find((c) => c.tag === 0x80 + number || c.tag === 0xa0 + number);

export const oidOf = (n: Asn1): string => {
  const b = n.body;
  const first = b[0] ?? 0;
  const parts = [Math.floor(first / 40), first % 40];
  let value = 0;
  for (let i = 1; i < b.length; i += 1) {
    const byte = b[i] ?? 0;
    value = value * 128 + lowBits(byte, 7);
    if (!bitSet(byte, 7)) {
      parts.push(value);
      value = 0;
    }
  }
  return parts.join(".");
};

/** An integer as hex, its sign octet dropped: how serial numbers are shown. */
export const intHex = (n: Asn1): string => {
  let b = n.body;
  while (b.length > 1 && b[0] === 0) {
    b = b.subarray(1);
  }
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join(":");
};

export const timeOf = (n: Asn1): Date | null => {
  const s = new TextDecoder("latin1").decode(n.body);
  const m =
    /^(?<y>\d{2}|\d{4})(?<mo>\d{2})(?<d>\d{2})(?<h>\d{2})(?<mi>\d{2})(?<s>\d{2})?(?:\.\d+)?Z$/u.exec(
      s
    )?.groups;
  if (!m) {
    return null;
  }
  let year = Number(m.y);
  if (n.tag === TAG.utcTime) {
    // UTCTime's two digits: 50 and on are the 1900s.
    year += year >= 50 ? 1900 : 2000;
  }
  const d = new Date(
    Date.UTC(
      year,
      Number(m.mo) - 1,
      Number(m.d),
      Number(m.h),
      Number(m.mi),
      Number(m.s ?? 0)
    )
  );
  return Number.isNaN(d.getTime()) ? null : d;
};

export const stringOf = (n: Asn1): string => {
  if (n.tag === TAG.bmpString) {
    let out = "";
    for (let i = 0; i + 1 < n.body.length; i += 2) {
      out += String.fromCodePoint(
        (n.body[i] ?? 0) * 256 + (n.body[i + 1] ?? 0)
      );
    }
    return out;
  }
  if (n.tag === TAG.utf8String) {
    return new TextDecoder().decode(n.body);
  }
  return new TextDecoder("latin1").decode(n.body);
};

const NAME_KEYS: Record<string, string> = {
  "0.9.2342.19200300.100.1.25": "DC",
  "1.2.840.113549.1.9.1": "E",
  "2.5.4.10": "O",
  "2.5.4.11": "OU",
  "2.5.4.3": "CN",
  "2.5.4.5": "SERIALNUMBER",
  "2.5.4.6": "C",
  "2.5.4.7": "L",
  "2.5.4.8": "ST",
  "2.5.4.97": "organizationIdentifier",
};

/** A distinguished name, most specific part first: "CN=Jane Doe, O=Example, C=GB". */
export const nameOf = (n: Asn1): string => {
  const parts: string[] = [];
  for (const rdn of n.children) {
    for (const atv of rdn.children) {
      const key = oidOf(child(atv, 0));
      parts.push(`${NAME_KEYS[key] ?? key}=${stringOf(child(atv, 1))}`);
    }
  }
  return parts.toReversed().join(", ");
};

/** The common name in a distinguished name, or the whole name when it has none. */
export const commonName = (n: Asn1): string => {
  for (const rdn of n.children) {
    for (const atv of rdn.children) {
      if (oidOf(child(atv, 0)) === "2.5.4.3") {
        return stringOf(child(atv, 1));
      }
    }
  }
  return nameOf(n);
};

export const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);
