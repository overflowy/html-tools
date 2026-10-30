// Checking digital signatures: that the signed bytes are the bytes the
// signature was made over (integrity), that the signature was made with the
// key in the signer's certificate (signature), how the signer's certificate
// leads to the certificates that issued it (chain), whether the document
// changed after signing (coverage), and what a timestamp authority says
// about when. WebCrypto does the arithmetic; everything else is read here.
//
// There is no list of trusted authorities to check a chain against: a
// browser keeps its own to itself. So a chain is shown, and each link
// checked, but whether its root is someone to trust is the reader's call.

import type { PDFDocument, PDFObject } from "mupdf";

import {
  TAG,
  child,
  commonName,
  intHex,
  nameOf,
  oidOf,
  parseAsn1,
  sameBytes,
  tagged,
  timeOf,
} from "./asn1";
import type { Asn1 } from "./asn1";
import { parsePdfDate } from "./inspect";
import { dig, itemsOf, textOf } from "./objects";

export type Check = "ok" | "failed" | "unknown";

export interface CertInfo {
  subject: string;
  issuer: string;
  name: string;
  serial: string;
  notBefore: string | null;
  notAfter: string | null;
  selfSigned: boolean;
}

export interface SignatureReport {
  field: string;
  /** 1-based page of the field's widget. */
  page: number;
  /** A signature by a person or system, or a timestamp of the whole document. */
  kind: "signature" | "timestamp";
  signer: string;
  /** When it says it was signed: the timestamp's time if there is one, else the signer's own claim. */
  signedAt: string | null;
  timeSource: "timestamp" | "signer" | "none";
  reason: string;
  location: string;
  contact: string;
  subFilter: string;
  digest: string;
  algorithm: string;
  integrity: Check;
  signature: Check;
  /** Whether the signature covers the whole file, or later revisions came after it. */
  coverage: "whole" | "partial";
  laterBytes: number;
  certificate: CertInfo | null;
  chain: (CertInfo & { verified: Check })[];
  /** The chain ends in a certificate that issued itself (a root). */
  rootIncluded: boolean;
  /** The signer's certificate was in its validity period when signed. */
  validAtSigning: Check;
  timestamp: {
    time: string;
    authority: string;
    integrity: Check;
    signature: Check;
  } | null;
  notes: string[];
}

/* ---------------- algorithms ---------------- */

const HASHES: Record<string, string> = {
  "1.3.14.3.2.26": "SHA-1",
  "2.16.840.1.101.3.4.2.1": "SHA-256",
  "2.16.840.1.101.3.4.2.2": "SHA-384",
  "2.16.840.1.101.3.4.2.3": "SHA-512",
};

const HASH_NAMES: Record<string, string> = {
  ...HASHES,
  "1.2.840.113549.2.5": "MD5",
  "2.16.840.1.101.3.4.2.4": "SHA-224",
};

/** Signature algorithms that name their hash. */
const SIGNED_WITH: Record<string, { key: "rsa" | "ecdsa"; hash: string }> = {
  "1.2.840.10045.4.1": { hash: "SHA-1", key: "ecdsa" },
  "1.2.840.10045.4.3.2": { hash: "SHA-256", key: "ecdsa" },
  "1.2.840.10045.4.3.3": { hash: "SHA-384", key: "ecdsa" },
  "1.2.840.10045.4.3.4": { hash: "SHA-512", key: "ecdsa" },
  "1.2.840.113549.1.1.11": { hash: "SHA-256", key: "rsa" },
  "1.2.840.113549.1.1.12": { hash: "SHA-384", key: "rsa" },
  "1.2.840.113549.1.1.13": { hash: "SHA-512", key: "rsa" },
  "1.2.840.113549.1.1.5": { hash: "SHA-1", key: "rsa" },
};

const RSA_KEY = "1.2.840.113549.1.1.1";
const RSA_PSS = "1.2.840.113549.1.1.10";
const EC_KEY = "1.2.840.10045.2.1";
const ED25519 = "1.3.101.112";
const CURVES: Record<string, { name: string; size: number }> = {
  "1.2.840.10045.3.1.7": { name: "P-256", size: 32 },
  "1.3.132.0.34": { name: "P-384", size: 48 },
  "1.3.132.0.35": { name: "P-521", size: 66 },
};

const ALGORITHM_NAMES: Record<string, string> = {
  "1.2.840.10045.2.1": "ECDSA",
  "1.2.840.113549.1.1.1": "RSA",
  "1.2.840.113549.1.1.10": "RSA-PSS",
  "1.3.101.112": "Ed25519",
};

const OID = {
  contentType: "1.2.840.113549.1.9.3",
  messageDigest: "1.2.840.113549.1.9.4",
  signingTime: "1.2.840.113549.1.9.5",
  ski: "2.5.29.14",
  timeStampToken: "1.2.840.113549.1.9.16.2.14",
};

const digestOf = async (
  hash: string,
  data: Uint8Array<ArrayBuffer>
): Promise<Uint8Array<ArrayBuffer>> =>
  new Uint8Array(await crypto.subtle.digest(hash, data));

/** An ECDSA signature as WebCrypto wants it: r and s side by side, each padded to the curve's size. */
const rawEcdsa = (
  der: Uint8Array<ArrayBuffer>,
  size: number
): Uint8Array<ArrayBuffer> => {
  const seq = parseAsn1(der);
  const out = new Uint8Array(size * 2);
  for (const [i, part] of [child(seq, 0), child(seq, 1)].entries()) {
    let b = part.body;
    while (b.length > size && b[0] === 0) {
      b = b.subarray(1);
    }
    out.set(b, (i + 1) * size - b.length);
  }
  return out;
};

/** The hash and salt RSA-PSS parameters name; SHA-1 and 20 when they are left out. */
const pssParams = (alg: Asn1): { hash: string; salt: number } => {
  const [, params] = alg.children;
  let hash = "SHA-1";
  let salt = 20;
  if (params?.tag === TAG.sequence) {
    const h = tagged(params, 0);
    if (h) {
      hash = HASHES[oidOf(child(child(h, 0), 0))] ?? hash;
    }
    const s = tagged(params, 2);
    if (s) {
      salt = 0;
      for (const b of child(s, 0).body) {
        salt = salt * 256 + b;
      }
    }
  }
  return { hash, salt };
};

interface VerifyPlan {
  importAlg: RsaHashedImportParams | EcKeyImportParams | Algorithm;
  verifyAlg: Algorithm | RsaPssParams | EcdsaParams;
  signature: Uint8Array<ArrayBuffer>;
}

/** How WebCrypto is to check a signature by this key and algorithm, or null for one it cannot. */
const planFor = (
  spki: Asn1,
  alg: Asn1,
  hash: string | null,
  signature: Uint8Array<ArrayBuffer>
): VerifyPlan | null => {
  const keyAlg = child(spki, 0);
  const keyOid = oidOf(child(keyAlg, 0));
  const algOid = oidOf(child(alg, 0));
  const h = SIGNED_WITH[algOid]?.hash ?? hash;
  if (algOid === RSA_PSS) {
    const { hash: ph, salt } = pssParams(alg);
    return {
      importAlg: { hash: ph, name: "RSA-PSS" },
      signature,
      verifyAlg: { name: "RSA-PSS", saltLength: salt } as RsaPssParams,
    };
  }
  if (keyOid === RSA_KEY && h) {
    return {
      importAlg: { hash: h, name: "RSASSA-PKCS1-v1_5" },
      signature,
      verifyAlg: { name: "RSASSA-PKCS1-v1_5" },
    };
  }
  const curve = keyOid === EC_KEY ? CURVES[oidOf(child(keyAlg, 1))] : undefined;
  if (curve && h) {
    return {
      importAlg: { name: "ECDSA", namedCurve: curve.name },
      signature: rawEcdsa(signature, curve.size),
      verifyAlg: { hash: h, name: "ECDSA" } as EcdsaParams,
    };
  }
  if (keyOid === ED25519) {
    return {
      importAlg: { name: "Ed25519" },
      signature,
      verifyAlg: { name: "Ed25519" },
    };
  }
  return null;
};

/**
 * Whether `signature` over `data` was made with the key in `spki`, by the
 * algorithm `alg` names (or by the key's own algorithm with `hash`, as CMS
 * signer infos often say).
 */
const verifyWith = async (
  spki: Asn1,
  alg: Asn1,
  hash: string | null,
  signature: Uint8Array<ArrayBuffer>,
  data: Uint8Array<ArrayBuffer>
): Promise<Check> => {
  const plan = planFor(spki, alg, hash, signature);
  if (!plan) {
    return "unknown";
  }
  try {
    const key = await crypto.subtle.importKey(
      "spki",
      spki.raw,
      plan.importAlg,
      false,
      ["verify"]
    );
    return (await crypto.subtle.verify(
      plan.verifyAlg,
      key,
      plan.signature,
      data
    ))
      ? "ok"
      : "failed";
  } catch {
    // An algorithm this browser does not have (DSA, or an unusual curve).
    return "unknown";
  }
};

/* ---------------- certificates ---------------- */

interface Cert {
  node: Asn1;
  tbs: Asn1;
  serial: Asn1;
  issuer: Asn1;
  subject: Asn1;
  notBefore: Date | null;
  notAfter: Date | null;
  spki: Asn1;
  alg: Asn1;
  signature: Uint8Array<ArrayBuffer>;
  ski: Uint8Array<ArrayBuffer> | null;
}

/** A BIT STRING's bits, without the octet that says how many are unused. */
const bits = (n: Asn1) => n.body.subarray(1);

const parseCert = (node: Asn1): Cert => {
  const tbs = child(node, 0);
  // A v3 certificate starts with its [0] version; a v1 one has none.
  const at = tbs.children[0]?.tag === 0xa0 ? 1 : 0;
  const validity = child(tbs, at + 3);
  let ski: Uint8Array<ArrayBuffer> | null = null;
  const extensions = tagged(tbs, 3);
  for (const ext of extensions ? child(extensions, 0).children : []) {
    if (oidOf(child(ext, 0)) === OID.ski) {
      // The extension's value wraps an OCTET STRING with the key identifier.
      ski = parseAsn1(child(ext, ext.children.length - 1).body).body;
    }
  }
  return {
    alg: child(node, 1),
    issuer: child(tbs, at + 2),
    node,
    notAfter: timeOf(child(validity, 1)),
    notBefore: timeOf(child(validity, 0)),
    serial: child(tbs, at),
    signature: bits(child(node, 2)),
    ski,
    spki: child(tbs, at + 5),
    subject: child(tbs, at + 4),
    tbs,
  };
};

const certInfo = (c: Cert): CertInfo => ({
  issuer: nameOf(c.issuer),
  name: commonName(c.subject),
  notAfter: c.notAfter?.toISOString() ?? null,
  notBefore: c.notBefore?.toISOString() ?? null,
  selfSigned: sameBytes(c.issuer.raw, c.subject.raw),
  serial: intHex(c.serial),
  subject: nameOf(c.subject),
});

const selfIssued = (c: Cert) => sameBytes(c.issuer.raw, c.subject.raw);

/** The certificate among `certs` that issued `c`, not one already in the chain. */
const issuerOf = (c: Cert, certs: Cert[], used: Set<Cert>): Cert | undefined =>
  certs.find((x) => !used.has(x) && sameBytes(x.subject.raw, c.issuer.raw));

/** From the signer's certificate up to the last one found, each checked against the next. */
const buildChain = async (
  leaf: Cert,
  certs: Cert[]
): Promise<{ chain: (CertInfo & { verified: Check })[]; root: boolean }> => {
  const chain: (CertInfo & { verified: Check })[] = [];
  const used = new Set<Cert>([leaf]);
  let current: Cert | undefined = leaf;
  while (current && chain.length < 10) {
    const issuer: Cert | undefined = selfIssued(current)
      ? current
      : issuerOf(current, certs, used);
    const verified = issuer
      ? await verifyWith(
          issuer.spki,
          current.alg,
          null,
          current.signature,
          current.tbs.raw
        )
      : "unknown";
    chain.push({ ...certInfo(current), verified });
    if (!issuer || issuer === current) {
      return { chain, root: issuer === current };
    }
    used.add(issuer);
    current = issuer;
  }
  return { chain, root: false };
};

/* ---------------- CMS ---------------- */

interface SignedDataResult {
  /** The content's digest matches the one the signer signed. */
  integrity: Check;
  signature: Check;
  signer: Cert | null;
  certs: Cert[];
  signingTime: Date | null;
  /** The signature value, which a timestamp's imprint is of. */
  signatureValue: Uint8Array<ArrayBuffer>;
  timestampToken: Asn1 | null;
  /** The encapsulated content, when there is one. */
  content: Uint8Array<ArrayBuffer> | null;
  digest: string;
  algorithm: string;
  notes: string[];
}

/** Byte arrays end to end. */
const join = (parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  let length = 0;
  for (const p of parts) {
    length += p.length;
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** An OCTET STRING's bytes, joining the pieces of a BER constructed one. */
const octets = (n: Asn1): Uint8Array<ArrayBuffer> =>
  n.children.length === 0 ? n.body : join(n.children.map(octets));

const attribute = (attrs: Asn1 | undefined, oid: string): Asn1 | null => {
  for (const a of attrs?.children ?? []) {
    if (oidOf(child(a, 0)) === oid) {
      return child(child(a, 1), 0);
    }
  }
  return null;
};

const findSigner = (sid: Asn1, certs: Cert[]): Cert | null => {
  if (sid.tag === TAG.sequence) {
    const issuer = child(sid, 0);
    const serial = child(sid, 1);
    return (
      certs.find(
        (c) =>
          sameBytes(c.issuer.raw, issuer.raw) &&
          sameBytes(c.serial.body, serial.body)
      ) ?? null
    );
  }
  // [0] SubjectKeyIdentifier.
  return certs.find((c) => c.ski && sameBytes(c.ski, sid.body)) ?? null;
};

/** The parts of a CMS SignedData a check needs. */
const readSignedData = (contentInfo: Asn1) => {
  const sd = child(child(contentInfo, 1), 0);
  const eContent = tagged(child(sd, 2), 0);
  const certSet = sd.children.find((c) => c.tag === 0xa0);
  const si = child(child(sd, sd.children.length - 1), 0);
  const signedAttrs = si.children[3]?.tag === 0xa0 ? si.children[3] : undefined;
  const at = signedAttrs ? 4 : 3;
  const sigAlg = child(si, at);
  const certs = (certSet?.children ?? [])
    .filter((c) => c.tag === TAG.sequence)
    .map(parseCert);
  return {
    certs,
    content: eContent ? octets(child(eContent, 0)) : null,
    digestOid: oidOf(child(child(si, 2), 0)),
    sigAlg,
    signatureValue: child(si, at + 1).body,
    signedAttrs,
    signer: findSigner(child(si, 1), certs),
    unsigned: si.children.find((c) => c.tag === 0xa1),
  };
};

const algorithmName = (sigAlg: Asn1): string => {
  const oid = oidOf(child(sigAlg, 0));
  return ALGORITHM_NAMES[oid] ?? SIGNED_WITH[oid]?.key.toUpperCase() ?? oid;
};

/** Check a CMS SignedData over `detached` content, or over its own when `detached` is null. */
const verifySignedData = async (
  contentInfo: Asn1,
  detached: Uint8Array<ArrayBuffer> | null
): Promise<SignedDataResult> => {
  const d = readSignedData(contentInfo);
  const hash = HASHES[d.digestOid] ?? null;
  const result: SignedDataResult = {
    algorithm: algorithmName(d.sigAlg),
    certs: d.certs,
    content: d.content,
    digest: HASH_NAMES[d.digestOid] ?? d.digestOid,
    integrity: "unknown",
    notes: [],
    signature: "unknown",
    signatureValue: d.signatureValue,
    signer: d.signer,
    signingTime: null,
    timestampToken: attribute(d.unsigned, OID.timeStampToken),
  };
  if (!hash) {
    result.notes.push(
      `The digest algorithm (${result.digest}) is not one this browser can compute.`
    );
    return result;
  }
  const signed = detached ?? d.content ?? new Uint8Array();
  let toVerify = signed;
  if (d.signedAttrs) {
    const md = attribute(d.signedAttrs, OID.messageDigest);
    const digest = await digestOf(hash, signed);
    result.integrity = md && sameBytes(md.body, digest) ? "ok" : "failed";
    const time = attribute(d.signedAttrs, OID.signingTime);
    result.signingTime = time ? timeOf(time) : null;
    // Signed attributes are signed as a SET, not as the [0] they are stored as.
    toVerify = new Uint8Array(d.signedAttrs.raw);
    toVerify[0] = TAG.set;
  }
  if (!d.signer) {
    result.notes.push(
      "The signer's certificate is not in the signature, so the signature itself cannot be checked."
    );
    return result;
  }
  result.signature = await verifyWith(
    d.signer.spki,
    d.sigAlg,
    hash,
    d.signatureValue,
    toVerify
  );
  if (!d.signedAttrs) {
    // Without signed attributes the signature is over the content itself, so verifying it proves the content.
    result.integrity = result.signature;
  }
  if (result.signature === "unknown") {
    result.notes.push(
      `The signature algorithm (${result.algorithm}) is not one this browser can check.`
    );
  }
  return result;
};

interface TstInfo {
  hash: string | null;
  imprint: Uint8Array<ArrayBuffer>;
  time: Date | null;
}

const parseTstInfo = (bytes: Uint8Array<ArrayBuffer>): TstInfo => {
  const tst = parseAsn1(bytes);
  const imprint = child(tst, 2);
  return {
    hash: HASHES[oidOf(child(child(imprint, 0), 0))] ?? null,
    imprint: child(imprint, 1).body,
    time: timeOf(child(tst, 4)),
  };
};

/** A timestamp token: when, by whom, and whether it is a timestamp of `stamped`. */
const checkTimestamp = async (
  token: Asn1,
  stamped: Uint8Array<ArrayBuffer>
) => {
  const r = await verifySignedData(token, null);
  const tst = r.content ? parseTstInfo(r.content) : null;
  let integrity: Check = "unknown";
  if (tst?.hash) {
    const own = await digestOf(tst.hash, stamped);
    integrity =
      sameBytes(own, tst.imprint) && r.integrity === "ok" ? "ok" : "failed";
  }
  return {
    authority: r.signer ? commonName(r.signer.subject) : "",
    integrity,
    signature: r.signature,
    time: tst?.time ?? null,
  };
};

/* ---------------- the document ---------------- */

const LESS_THAN = 0x3c;
const GREATER_THAN = 0x3e;

const isHexDigit = (b: number) =>
  (b >= 0x30 && b <= 0x39) ||
  (b >= 0x41 && b <= 0x46) ||
  (b >= 0x61 && b <= 0x66);

/** The hex string `<…>` that is exactly `file[from, to)`, decoded; null when those bytes are anything else. */
const hexStringAt = (
  file: Uint8Array,
  from: number,
  to: number
): Uint8Array<ArrayBuffer> | null => {
  if (
    to - from < 2 ||
    file[from] !== LESS_THAN ||
    file[to - 1] !== GREATER_THAN
  ) {
    return null;
  }
  const digits = file.subarray(from + 1, to - 1);
  if (digits.length % 2 !== 0 || !digits.every(isHexDigit)) {
    return null;
  }
  const out = new Uint8Array(digits.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(
      String.fromCodePoint(digits[2 * i] ?? 0, digits[2 * i + 1] ?? 0),
      16
    );
  }
  return out;
};

type SignedParts =
  | { status: "malformed" }
  /** The ranges leave out more of the file than the signature's own string. */
  | { status: "gap" }
  | {
      status: "ok";
      /** The bytes signed: everything but the signature. */
      data: Uint8Array<ArrayBuffer>;
      /** The signature, read from the file itself: an encrypted file's reader would decrypt it, though it never was encrypted. */
      contents: Uint8Array<ArrayBuffer>;
      /** Where the signed bytes end; anything after is a later revision. */
      end: number;
    };

/**
 * What a /ByteRange [0 a b c] signs: the file from its start up to the
 * signature's `<hex>` string, and from just after that string on. Anything
 * else left out could be changed without the signature noticing.
 */
const signedParts = (file: Uint8Array, range: number[]): SignedParts => {
  const [start = -1, first = -1, second = -1, length = -1] = range;
  const valid =
    range.length === 4 &&
    range.every((n) => Number.isInteger(n) && n >= 0) &&
    second >= start + first &&
    second + length <= file.length;
  if (!valid) {
    return { status: "malformed" };
  }
  const contents = hexStringAt(file, start + first, second);
  if (start !== 0 || !contents) {
    return { status: "gap" };
  }
  return {
    contents,
    data: join([
      file.subarray(0, first),
      file.subarray(second, second + length),
    ]),
    end: second + length,
    status: "ok",
  };
};

const emptyReport = (field: string, page: number): SignatureReport => ({
  algorithm: "",
  certificate: null,
  chain: [],
  contact: "",
  coverage: "whole",
  digest: "",
  field,
  integrity: "unknown",
  kind: "signature",
  laterBytes: 0,
  location: "",
  notes: [],
  page,
  reason: "",
  rootIncluded: false,
  signature: "unknown",
  signedAt: null,
  signer: "",
  subFilter: "",
  timeSource: "none",
  timestamp: null,
  validAtSigning: "unknown",
});

/** A document timestamp (ETSI.RFC3161): the whole signature is a timestamp token of the covered bytes. */
const fillTimestamp = async (
  r: SignatureReport,
  info: Asn1,
  data: Uint8Array<ArrayBuffer>
) => {
  r.kind = "timestamp";
  const ts = await checkTimestamp(info, data);
  r.integrity = ts.integrity;
  r.signature = ts.signature;
  r.signer = ts.authority || r.signer;
  r.signedAt = ts.time?.toISOString() ?? null;
  r.timeSource = ts.time ? "timestamp" : "none";
};

/** Whether the certificate was within its validity period at `when`. */
const validAt = (cert: Cert | null, when: string | null): Check => {
  if (!when || !cert?.notBefore || !cert.notAfter) {
    return "unknown";
  }
  const t = new Date(when);
  return t >= cert.notBefore && t <= cert.notAfter ? "ok" : "failed";
};

/** A CMS signature: detached over the covered bytes, or (adbe.pkcs7.sha1) over their SHA-1 digest. */
const fillCms = async (
  r: SignatureReport,
  info: Asn1,
  data: Uint8Array<ArrayBuffer>,
  claimed: Date | null
) => {
  const detached = r.subFilter === "adbe.pkcs7.sha1" ? null : data;
  const sd = await verifySignedData(info, detached);
  r.notes.push(...sd.notes);
  r.signature = sd.signature;
  r.integrity = sd.integrity;
  r.digest = sd.digest;
  r.algorithm = sd.algorithm;
  if (detached === null) {
    // The signed content is the document's SHA-1 digest.
    const own = await digestOf("SHA-1", data);
    if (!sd.content || !sameBytes(sd.content, own)) {
      r.integrity = "failed";
    }
  }
  if (sd.signer) {
    r.certificate = certInfo(sd.signer);
    r.signer = commonName(sd.signer.subject) || r.signer;
    const { chain, root } = await buildChain(sd.signer, sd.certs);
    r.chain = chain;
    r.rootIncluded = root;
  }
  const signing = sd.signingTime ?? claimed;
  r.signedAt = signing?.toISOString() ?? null;
  r.timeSource = signing ? "signer" : "none";
  if (sd.timestampToken) {
    const ts = await checkTimestamp(sd.timestampToken, sd.signatureValue);
    r.timestamp = {
      authority: ts.authority,
      integrity: ts.integrity,
      signature: ts.signature,
      time: ts.time?.toISOString() ?? "",
    };
    if (ts.time) {
      r.signedAt = ts.time.toISOString();
      r.timeSource = "timestamp";
    }
  }
  r.validAtSigning = validAt(sd.signer, r.signedAt);
};

const verifyOne = async (
  file: Uint8Array,
  v: PDFObject,
  r: SignatureReport
): Promise<SignatureReport> => {
  r.subFilter = textOf(v.get("SubFilter"));
  r.reason = textOf(v.get("Reason"));
  r.location = textOf(v.get("Location"));
  r.contact = textOf(v.get("ContactInfo"));
  r.signer = textOf(v.get("Name"));
  const range = itemsOf(v.get("ByteRange")).map((n) => n.asNumber());
  const signed = signedParts(file, range);
  if (signed.status === "malformed") {
    r.notes.push("The signature's byte range is malformed.");
    return r;
  }
  if (signed.status === "gap") {
    r.integrity = "failed";
    r.notes.push(
      "The signature's byte range leaves out more than the signature itself, so parts of the file it claims to sign could have been changed."
    );
    return r;
  }
  const { contents, data, end } = signed;
  r.laterBytes = file.length - end;
  r.coverage = r.laterBytes > 0 ? "partial" : "whole";
  if (r.subFilter === "adbe.x509.rsa_sha1") {
    r.notes.push(
      "This is a legacy PKCS #1 signature, which is not checked here."
    );
    r.digest = "SHA-1";
    return r;
  }
  const info = parseAsn1(contents);
  await (r.subFilter === "ETSI.RFC3161"
    ? fillTimestamp(r, info, data)
    : fillCms(r, info, data, parsePdfDate(textOf(v.get("M")))));
  return r;
};

export interface SignaturesResult {
  signatures: SignatureReport[];
  /** Signature fields nobody has signed yet. */
  empty: number;
}

/** Every signed signature field of `doc`, checked against `file`, the exact bytes it was opened from. */
export const verifySignatures = async (
  doc: PDFDocument,
  file: Uint8Array
): Promise<SignaturesResult> => {
  const out: SignatureReport[] = [];
  let empty = 0;
  const n = doc.countPages();
  for (let p = 0; p < n; p += 1) {
    for (const w of doc.loadPage(p).getWidgets()) {
      if (w.getFieldType() !== "signature") {
        continue;
      }
      const obj = w.getObject();
      const field = obj.get("T").isNull() ? (dig(obj, "Parent") ?? obj) : obj;
      const v = dig(field, "V");
      if (!v?.isDictionary()) {
        empty += 1;
        continue;
      }
      const report = emptyReport(w.getName(), p + 1);
      try {
        out.push(await verifyOne(file, v.resolve(), report));
      } catch (error) {
        report.notes.push(
          `The signature could not be read: ${(error as Error).message}`
        );
        out.push(report);
      }
    }
  }
  return { empty, signatures: out };
};
