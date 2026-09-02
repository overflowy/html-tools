// Unit tests for the Trace parser. Run: bun test
import { describe, expect, test } from "bun:test";
import { countryName, parseTrace } from "./trace";

const BODY = [
  "fl=270f128", "h=1.1.1.1", "ip=81.56.207.3", "ts=1788344542.000", "visit_scheme=https",
  "uag=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
  "colo=MXP", "sliver=005-tier1", "http=http/2", "loc=IT", "tls=TLSv1.3", "sni=off", "warp=off", "gateway=off", "rbi=off",
  "kex=X25519MLKEM768", "",
].join("\n");

describe("parseTrace", () => {
  test("reads ip, uag, and loc from key=value lines", () => {
    expect(parseTrace(BODY)).toEqual({
      ip: "81.56.207.3",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
      country: "IT",
    });
  });
  test("keeps '=' inside a value and tolerates CRLF", () => {
    const t = parseTrace("ip=2a01:e11::1\r\nuag=a=b c\r\nloc=DE\r\n");
    expect(t).toEqual({ ip: "2a01:e11::1", userAgent: "a=b c", country: "DE" });
  });
  test("an empty user agent is still a trace", () => {
    expect(parseTrace("ip=1.2.3.4\nuag=\nloc=XX\n")).toEqual({ ip: "1.2.3.4", userAgent: "", country: "XX" });
  });
  test("anything missing ip or loc is not a trace", () => {
    expect(parseTrace("<html>blocked</html>")).toBeNull();
    expect(parseTrace("ip=1.2.3.4\nuag=x\n")).toBeNull();
    expect(parseTrace("uag=x\nloc=IT\n")).toBeNull();
    expect(parseTrace("")).toBeNull();
  });
});

describe("countryName", () => {
  test("names known codes", () => {
    expect(countryName("IT")).toBe("Italy");
    expect(countryName("DE")).toBe("Germany");
  });
  test("has no name for Cloudflare's placeholders", () => {
    expect(countryName("XX")).toBeNull();
    expect(countryName("T1")).toBeNull();
    expect(countryName("")).toBeNull();
  });
});
