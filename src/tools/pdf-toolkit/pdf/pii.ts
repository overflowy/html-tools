// Personal data in a document's text: email addresses, phone numbers,
// payment card numbers, US Social Security numbers, and IBANs. Each kind is
// a pattern plus, where one exists, the check its numbers must pass (Luhn
// for cards, mod 97 for IBANs), so a row of digits that merely looks right
// is not reported. Findings are shown masked, context included, so the
// list itself is safe to have on screen.

import type { PDFDocument } from "mupdf";

import { findIn, pageText } from "./text";
import type { Hit } from "./text";

export type PiiKind = "email" | "phone" | "card" | "ssn" | "iban";

export const PII_KINDS: PiiKind[] = ["email", "phone", "card", "ssn", "iban"];

export const PII_NAMES: Record<PiiKind, string> = {
  card: "Payment card",
  email: "Email address",
  iban: "IBAN",
  phone: "Phone number",
  ssn: "US Social Security number",
};

export interface PiiFinding extends Hit {
  kind: PiiKind;
  masked: string;
}

const digitsOf = (s: string) => s.replaceAll(/\D/gu, "");

/** The Luhn checksum every payment card number passes. */
export const luhn = (digits: string): boolean => {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) {
        d -= 9;
      }
    }
    sum += d;
    double = !double;
  }
  return digits.length > 0 && sum % 10 === 0;
};

/** Issuer prefixes and lengths of the card networks in wide use. */
const CARD =
  /^(?:4\d{12}(?:\d{3}){0,2}|5[1-5]\d{14}|2(?:2[2-9]\d|[3-6]\d\d|7[01]\d|720)\d{12}|3[47]\d{13}|3(?:0[0-5]|[68]\d)\d{11,16}|6(?:011|5\d\d|4[4-9]\d)\d{12,15}|35(?:2[89]|[3-8]\d)\d{12,15}|62\d{14,17})$/u;

export const isCardNumber = (s: string): boolean => {
  const d = digitsOf(s);
  return d.length >= 13 && d.length <= 19 && CARD.test(d) && luhn(d);
};

/** IBAN lengths by country, from the SWIFT registry. */
const IBAN_LENGTHS: Record<string, number> = {
  AD: 24,
  AE: 23,
  AL: 28,
  AT: 20,
  AZ: 28,
  BA: 20,
  BE: 16,
  BG: 22,
  BH: 22,
  BI: 27,
  BR: 29,
  BY: 28,
  CH: 21,
  CR: 22,
  CY: 28,
  CZ: 24,
  DE: 22,
  DJ: 27,
  DK: 18,
  DO: 28,
  EE: 20,
  EG: 29,
  ES: 24,
  FI: 18,
  FK: 18,
  FO: 18,
  FR: 27,
  GB: 22,
  GE: 22,
  GI: 23,
  GL: 18,
  GR: 27,
  GT: 28,
  HN: 28,
  HR: 21,
  HU: 28,
  IE: 22,
  IL: 23,
  IQ: 23,
  IS: 26,
  IT: 27,
  JO: 30,
  KW: 30,
  KZ: 20,
  LB: 28,
  LC: 32,
  LI: 21,
  LT: 20,
  LU: 20,
  LV: 21,
  LY: 25,
  MC: 27,
  MD: 24,
  ME: 22,
  MK: 19,
  MN: 20,
  MR: 27,
  MT: 31,
  MU: 30,
  NI: 28,
  NL: 18,
  NO: 15,
  OM: 23,
  PK: 24,
  PL: 28,
  PS: 29,
  PT: 25,
  QA: 29,
  RO: 24,
  RS: 22,
  RU: 33,
  SA: 24,
  SC: 31,
  SD: 18,
  SE: 24,
  SI: 19,
  SK: 24,
  SM: 27,
  SO: 23,
  ST: 25,
  SV: 28,
  TL: 23,
  TN: 24,
  TR: 26,
  UA: 29,
  VA: 22,
  VG: 24,
  XK: 20,
  YE: 30,
};

/** The ISO 13616 check: the rearranged IBAN, letters as numbers, is 1 mod 97. */
export const isIban = (s: string): boolean => {
  const iban = s.replaceAll(/\s/gu, "").toUpperCase();
  const length = IBAN_LENGTHS[iban.slice(0, 2)];
  if (
    length === undefined ||
    iban.length !== length ||
    !/^[A-Z]{2}\d{2}[A-Z\d]+$/u.test(iban)
  ) {
    return false;
  }
  const rearranged = `${iban.slice(4)}${iban.slice(0, 4)}`;
  let rest = 0;
  for (const ch of rearranged) {
    const code = ch.codePointAt(0) ?? 0;
    const value = code >= 65 ? String(code - 55) : ch;
    for (const d of value) {
      rest = (rest * 10 + Number(d)) % 97;
    }
  }
  return rest === 1;
};

/**
 * A plausible phone number: 10 to 15 digits (9 with a country code),
 * written the way people write phone numbers.
 */
export const isPhone = (s: string): boolean => {
  const d = digitsOf(s);
  const international = s.trim().startsWith("+");
  if (d.length < (international ? 9 : 10) || d.length > 15) {
    return false;
  }
  const groups = s.split(/[\s.-]+/u).length;
  // A bare run of digits is as likely an order number; a phone number is written in groups or with a country code.
  return international || s.includes("(") || groups >= 3;
};

interface Detector {
  re: RegExp;
  valid?: (s: string) => boolean;
  mask: (s: string) => string;
}

const keepLast = (s: string, n: number) => {
  const d = digitsOf(s);
  return d.slice(-n);
};

const DETECTORS: Record<PiiKind, Detector> = {
  card: {
    mask: (s) => `•••• ${keepLast(s, 4)}`,
    re: /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/gu,
    valid: isCardNumber,
  },
  email: {
    mask: (s) => {
      const at = s.indexOf("@");
      return `${s.slice(0, 1)}•••${s.slice(at)}`;
    },
    re: /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu,
  },
  iban: {
    mask: (s) => {
      const t = s.replaceAll(/\s/gu, "");
      return `${t.slice(0, 4)} •••• ${t.slice(-4)}`;
    },
    re: /\b[A-Z]{2}\d{2}(?: ?[A-Z\d]{4}){2,7}(?: ?[A-Z\d]{1,3})?\b/gu,
    valid: isIban,
  },
  phone: {
    mask: (s) => `•••${keepLast(s, 2)}`,
    re: /(?<![\w+])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{1,4}\)[\s.-]?)?\d{2,4}(?:[\s.-]\d{2,5}){1,4}(?!\w)/gu,
    valid: isPhone,
  },
  ssn: {
    mask: (s) => `•••-••-${keepLast(s, 4)}`,
    re: /(?<!\d)(?!000|666|9\d\d)\d{3}(?<sep>[- ])(?!00)\d{2}\k<sep>(?!0000)\d{4}(?!\d)/gu,
  },
};

/** When two findings overlap, the more specific one stands. */
const PRIORITY: PiiKind[] = ["card", "iban", "ssn", "email", "phone"];

const overlaps = (a: PiiFinding, b: PiiFinding) =>
  a.page === b.page &&
  a.quads.some((q) =>
    b.quads.some(
      (r) => q[0] < r[2] && r[0] < q[2] && q[1] < r[5] && r[1] < q[5]
    )
  );

/** Every raw value in `text` replaced by its masked form, longest first so none is half masked. */
const maskAll = (
  text: string,
  found: { raw: string; masked: string }[]
): string => {
  let out = text;
  for (const f of found.toSorted((x, y) => y.raw.length - x.raw.length)) {
    out = out.replaceAll(f.raw, f.masked);
  }
  return out;
};

export const scanPii = (doc: PDFDocument, kinds: PiiKind[]): PiiFinding[] => {
  const findings: PiiFinding[] = [];
  const ordered = PRIORITY.filter((k) => kinds.includes(k));
  const n = doc.countPages();
  for (let i = 0; i < n; i += 1) {
    const pt = pageText(doc.loadPage(i));
    const onPage: (PiiFinding & { raw: string })[] = [];
    for (const kind of ordered) {
      const d = DETECTORS[kind];
      for (const hit of findIn(pt, d.re, i)) {
        if (d.valid && !d.valid(hit.text)) {
          continue;
        }
        const masked = d.mask(hit.text);
        const f = { ...hit, kind, masked, raw: hit.text, text: masked };
        if (!onPage.some((g) => overlaps(f, g))) {
          onPage.push(f);
        }
      }
    }
    // A context may show a neighbouring finding too: every one is masked in every context.
    for (const { raw: _raw, ...f } of onPage) {
      findings.push({ ...f, context: maskAll(f.context, onPage) });
    }
  }
  return findings.toSorted(
    (a, b) => a.page - b.page || (a.quads[0]?.[1] ?? 0) - (b.quads[0]?.[1] ?? 0)
  );
};
