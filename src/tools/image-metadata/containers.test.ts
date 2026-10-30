// Unit tests for the container walks and Strips. Run: bun test
// fixtures.json holds small synthetic images in every container (built byte by
// byte: rich EXIF in both byte orders, XMP, IPTC, ICC, comments, text chunks,
// every iloc layout, malformed files) with what the parser made of them: the
// inspection, the stripped bytes, and an inspection of the stripped copy.
import { describe, expect, test } from "bun:test";

import { inspect, sniff, strip } from "./containers";
import fixtures from "./fixtures.json";

/** The JSON form the fixtures store: byte arrays as base64. */
const normalize = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value, (_key, v) =>
      v instanceof Uint8Array
        ? { base64: Buffer.from(v).toString("base64") }
        : v
    )
  );

const attempt = (fn: () => unknown) => {
  try {
    return { ok: fn() };
  } catch (error) {
    return { error: (error as Error).message };
  }
};

const fromBase64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

describe("fixture files", () => {
  for (const f of fixtures) {
    const bytes = fromBase64(f.input);

    test(`${f.name}: inspection`, () => {
      expect<unknown>(attempt(() => normalize(inspect(bytes)))).toEqual(
        f.inspect
      );
    });

    test(`${f.name}: strip`, () => {
      const stripped = attempt(() => strip(bytes));
      if ("error" in stripped) {
        expect<unknown>(stripped).toEqual(f.strip);
        return;
      }
      const result = stripped.ok as ReturnType<typeof strip>;
      expect<unknown>({
        ok: {
          keptOrientation: result.keptOrientation,
          out: Buffer.from(result.out).toString("base64"),
        },
      }).toEqual(f.strip);
      expect<unknown>(attempt(() => normalize(inspect(result.out)))).toEqual(
        f.reinspect ?? {}
      );
    });
  }
});

describe("sniff", () => {
  test("too short or unknown is null", () => {
    expect(sniff(new Uint8Array(4))).toBeNull();
    expect(sniff(new Uint8Array(32))).toBeNull();
  });
});
