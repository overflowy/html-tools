// Composes the Payload string for each Payload Type from its form fields.

export type WifiAuth = "WPA" | "WEP" | "nopass";

export interface ContactFields {
  first: string;
  last: string;
  phone: string;
  email: string;
  org: string;
  title: string;
  url: string;
}

/** WIFI: syntax special characters that must be backslash-escaped. */
const escapeWifi = (value: string): string =>
  value.replaceAll(/[\\;,":]/gu, "\\$&");

export const wifiPayload = (
  ssid: string,
  password: string,
  auth: WifiAuth,
  hidden: boolean
): string => {
  let out = `WIFI:T:${auth};S:${escapeWifi(ssid)};`;
  if (auth !== "nopass") {
    out += `P:${escapeWifi(password)};`;
  }
  if (hidden) {
    out += "H:true;";
  }
  return `${out};`;
};

/** vCard value escaping: backslash, comma, semicolon, and literal newlines. */
const escapeVcard = (value: string): string =>
  value
    .replaceAll("\\", "\\\\")
    .replaceAll(/[,;]/gu, "\\$&")
    .replaceAll(/\r?\n/gu, "\\n");

export const vcardPayload = (c: ContactFields): string => {
  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `N:${escapeVcard(c.last)};${escapeVcard(c.first)};;;`,
    `FN:${escapeVcard([c.first, c.last].filter(Boolean).join(" "))}`,
  ];
  if (c.org) {
    lines.push(`ORG:${escapeVcard(c.org)}`);
  }
  if (c.title) {
    lines.push(`TITLE:${escapeVcard(c.title)}`);
  }
  if (c.phone) {
    lines.push(`TEL:${escapeVcard(c.phone)}`);
  }
  if (c.email) {
    lines.push(`EMAIL:${escapeVcard(c.email)}`);
  }
  if (c.url) {
    lines.push(`URL:${escapeVcard(c.url)}`);
  }
  lines.push("END:VCARD");
  return lines.join("\r\n");
};

export const emailPayload = (
  to: string,
  subject: string,
  body: string
): string => {
  const params: string[] = [];
  if (subject) {
    params.push(`subject=${encodeURIComponent(subject)}`);
  }
  if (body) {
    params.push(`body=${encodeURIComponent(body)}`);
  }
  return `mailto:${to}${params.length ? `?${params.join("&")}` : ""}`;
};

export const smsPayload = (number: string, message: string): string =>
  `SMSTO:${number.replaceAll(/\s+/gu, "")}${message ? `:${message}` : ""}`;

export const phonePayload = (number: string): string =>
  `tel:${number.replaceAll(/\s+/gu, "")}`;

export const geoPayload = (lat: string, lng: string): string =>
  `geo:${lat.trim()},${lng.trim()}`;
