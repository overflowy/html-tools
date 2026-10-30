// A signed PDF for tests: a fresh RSA key, a self-signed certificate for
// it, and a CMS detached signature over the file's byte range, all made
// here with WebCrypto and a small DER writer. Imported by tests and the
// smoke test only, never by the Tool.

import * as mupdf from "mupdf";

const enc = new TextEncoder();

const join = (parts: (Uint8Array | number[])[]): Uint8Array<ArrayBuffer> => {
  const arrays = parts.map((p) =>
    p instanceof Uint8Array ? p : new Uint8Array(p)
  );
  let n = 0;
  for (const a of arrays) {
    n += a.length;
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const a of arrays) {
    out.set(a, at);
    at += a.length;
  }
  return out;
};

/* ---------------- DER ---------------- */

const lengthOf = (n: number): number[] => {
  if (n < 128) {
    return [n];
  }
  const digits: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) {
    digits.unshift(v % 256);
  }
  return [128 + digits.length, ...digits];
};

const tlv = (tag: number, ...body: Uint8Array[]) => {
  const content = join(body);
  return join([[tag, ...lengthOf(content.length)], content]);
};

const seq = (...body: Uint8Array[]) => tlv(0x30, ...body);
const set = (...body: Uint8Array[]) => tlv(0x31, ...body);
const ctx = (n: number, ...body: Uint8Array[]) => tlv(0xa0 + n, ...body);
const nul = () => new Uint8Array([5, 0]);
const octet = (b: Uint8Array) => tlv(0x04, b);
const bitString = (b: Uint8Array) => tlv(0x03, new Uint8Array([0]), b);
const utf8 = (s: string) => tlv(0x0c, enc.encode(s));

const integer = (b: number[]) =>
  tlv(0x02, new Uint8Array((b[0] ?? 0) >= 128 ? [0, ...b] : b));

const oid = (dotted: string) => {
  const [a = 0, b = 0, ...rest] = dotted.split(".").map(Number);
  const out = [a * 40 + b];
  for (const v of rest) {
    const digits: number[] = [v % 128];
    for (let x = Math.floor(v / 128); x > 0; x = Math.floor(x / 128)) {
      digits.unshift(128 + (x % 128));
    }
    out.push(...digits);
  }
  return tlv(0x06, new Uint8Array(out));
};

const utcTime = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  const s = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return tlv(0x17, enc.encode(s));
};

const SHA256 = "2.16.840.1.101.3.4.2.1";
const SHA256_RSA = "1.2.840.113549.1.1.11";
const RSA = "1.2.840.113549.1.1.1";
const DATA = "1.2.840.113549.1.7.1";
const SIGNED_DATA = "1.2.840.113549.1.7.2";

/* ---------------- the signature ---------------- */

export interface Signer {
  key: CryptoKeyPair;
  cert: Uint8Array<ArrayBuffer>;
  name: Uint8Array<ArrayBuffer>;
  serial: number[];
}

const RSA_PARAMS = {
  hash: "SHA-256",
  modulusLength: 2048,
  name: "RSASSA-PKCS1-v1_5",
  publicExponent: new Uint8Array([1, 0, 1]),
};

export const makeSigner = async (commonName: string): Promise<Signer> => {
  const key = (await crypto.subtle.generateKey(RSA_PARAMS, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const spki = new Uint8Array(
    await crypto.subtle.exportKey("spki", key.publicKey)
  );
  const name = seq(set(seq(oid("2.5.4.3"), utf8(commonName))));
  const serial = [0x2a, 0x17];
  const now = Date.now();
  const tbs = seq(
    ctx(0, integer([2])),
    integer(serial),
    seq(oid(SHA256_RSA), nul()),
    name,
    seq(
      utcTime(new Date(now - 86_400_000)),
      utcTime(new Date(now + 365 * 86_400_000))
    ),
    name,
    spki
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, tbs)
  );
  const cert = seq(tbs, seq(oid(SHA256_RSA), nul()), bitString(sig));
  return { cert, key, name, serial };
};

/** A CMS SignedData, detached, over `data`, with the usual signed attributes. */
export const cmsSign = async (
  signer: Signer,
  data: Uint8Array<ArrayBuffer>
): Promise<Uint8Array<ArrayBuffer>> => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  const attrs = [
    seq(oid("1.2.840.113549.1.9.3"), set(oid(DATA))),
    seq(oid("1.2.840.113549.1.9.5"), set(utcTime(new Date()))),
    seq(oid("1.2.840.113549.1.9.4"), set(octet(digest))),
  ];
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      signer.key.privateKey,
      set(...attrs)
    )
  );
  const signerInfo = seq(
    integer([1]),
    seq(signer.name, integer(signer.serial)),
    seq(oid(SHA256), nul()),
    ctx(0, ...attrs),
    seq(oid(RSA), nul()),
    octet(signature)
  );
  const signedData = seq(
    integer([1]),
    set(seq(oid(SHA256), nul())),
    seq(oid(DATA)),
    ctx(0, signer.cert),
    set(signerInfo)
  );
  return seq(oid(SIGNED_DATA), ctx(0, signedData));
};

/* ---------------- the PDF ---------------- */

/** Room for the signature, in bytes; written as twice as many hex digits. */
const ROOM = 8192;
const PLACEHOLDER = "1111111111";

const indexOf = (hay: Uint8Array, needle: string, from = 0): number => {
  const n = enc.encode(needle);
  const at = (i: number) => n.every((b, j) => hay[i + j] === b);
  for (let i = from; i <= hay.length - n.length; i += 1) {
    if (at(i)) {
      return i;
    }
  }
  return -1;
};

/** `pdf` with one signature field, signed by `signer` over the whole file. */
export const signPdf = async (
  pdf: Uint8Array,
  signer: Signer
): Promise<Uint8Array<ArrayBuffer>> => {
  const doc: mupdf.PDFDocument | null = mupdf.Document.openDocument(
    pdf,
    "application/pdf"
  ).asPDF();
  if (!doc) {
    throw new Error("not a PDF");
  }
  const page = doc.loadPage(0);
  const v = doc.addObject(doc.newDictionary());
  v.put("Type", doc.newName("Sig"));
  v.put("Filter", doc.newName("Adobe.PPKLite"));
  v.put("SubFilter", doc.newName("adbe.pkcs7.detached"));
  const range = doc.newArray();
  for (const x of [
    0,
    Number(PLACEHOLDER),
    Number(PLACEHOLDER),
    Number(PLACEHOLDER),
  ]) {
    range.push(doc.newInteger(x));
  }
  v.put("ByteRange", range);
  v.put("Contents", doc.newByteString(new Uint8Array(ROOM)));
  v.put("Reason", doc.newString("Approved"));
  const w = doc.addObject(doc.newDictionary());
  w.put("Type", doc.newName("Annot"));
  w.put("Subtype", doc.newName("Widget"));
  w.put("FT", doc.newName("Sig"));
  w.put("T", doc.newString("Signature1"));
  w.put("V", v);
  w.put("F", doc.newInteger(4));
  const rect = doc.newArray();
  for (const x of [0, 0, 0, 0]) {
    rect.push(doc.newInteger(x));
  }
  w.put("Rect", rect);
  w.put("P", page.getObject());
  const annots = doc.newArray();
  annots.push(w);
  page.getObject().put("Annots", annots);
  const form = doc.newDictionary();
  const fields = doc.newArray();
  fields.push(w);
  form.put("Fields", fields);
  form.put("SigFlags", doc.newInteger(3));
  doc.getTrailer().get("Root").put("AcroForm", form);
  const bytes = new Uint8Array(doc.saveToBuffer("").asUint8Array());
  const rangeAt = indexOf(
    bytes,
    `${PLACEHOLDER} ${PLACEHOLDER} ${PLACEHOLDER}`
  );
  const start = indexOf(bytes, "<0000");
  const end = indexOf(bytes, ">", start) + 1;
  if (rangeAt < 0 || start < 0) {
    throw new Error("The placeholders were not found in the saved PDF.");
  }
  const after = bytes.length - end;
  const filled = `${start} ${end} ${after}`.padEnd(
    PLACEHOLDER.length * 3 + 2,
    " "
  );
  bytes.set(enc.encode(filled), rangeAt);
  const signed = join([bytes.subarray(0, start), bytes.subarray(end)]);
  const cms = await cmsSign(signer, signed);
  const hex = [...cms]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .padEnd(end - start - 2, "0");
  bytes.set(enc.encode(hex), start + 1);
  return bytes;
};
