import { expect, test } from "bun:test";

import { makePdf, openTest, testEnv } from "../test-env";
import { openPdf } from "./doc";
import { protect } from "./security";
import { cmsSign, makeSigner, signPdf } from "./sign-fixture";
import { verifySignatures } from "./signatures";

const BYTE_RANGE = /\/ByteRange\s*\[(?<inner>[^\]]*)\]/u;
const SPACES = /\s+/u;

const signer = await makeSigner("Test Signer");
const signed = await signPdf(makePdf(1), signer);

/**
 * `signed` signed again over what `range` (given where the signature's
 * `<hex>` string starts and ends) covers: a forger leaving bytes unsigned.
 */
const forge = async (
  file: Uint8Array,
  range: (from: number, end: number) => number[]
): Promise<Uint8Array<ArrayBuffer>> => {
  const out = new Uint8Array(file);
  const text = new TextDecoder("latin1").decode(out);
  const m = BYTE_RANGE.exec(text);
  const inner = m?.groups?.inner ?? "";
  // [0 from end after]: the signature's string is file[from, end).
  const [, from = 0, end = 0] = inner.trim().split(SPACES).map(Number);
  const forged = range(from, end);
  const at = (m?.index ?? 0) + (m?.[0].indexOf("[") ?? 0) + 1;
  out.set(
    new TextEncoder().encode(forged.join(" ").padEnd(inner.length, " ")),
    at
  );
  const [s0 = 0, l0 = 0, s1 = 0, l1 = 0] = forged;
  const data = new Uint8Array(l0 + l1);
  data.set(out.subarray(s0, s0 + l0));
  data.set(out.subarray(s1, s1 + l1), l0);
  const hex = [...(await cmsSign(signer, data))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .padEnd(end - from - 2, "0");
  out.set(new TextEncoder().encode(hex), from + 1);
  return out;
};

test("a fresh signature checks out: integrity, signature, chain to itself, whole file", async () => {
  const { signatures, empty } = await verifySignatures(
    openTest(signed),
    signed
  );
  expect(empty).toBe(0);
  const [s] = signatures;
  expect(s?.signer).toBe("Test Signer");
  expect(s?.integrity).toBe("ok");
  expect(s?.signature).toBe("ok");
  expect(s?.coverage).toBe("whole");
  expect(s?.digest).toBe("SHA-256");
  expect(s?.algorithm).toBe("RSA");
  expect(s?.reason).toBe("Approved");
  expect(s?.rootIncluded).toBe(true);
  expect(s?.chain.map((c) => [c.name, c.verified])).toEqual([
    ["Test Signer", "ok"],
  ]);
  expect(s?.validAtSigning).toBe("ok");
  expect(s?.timeSource).toBe("signer");
});

test("a changed byte inside the signed range fails integrity", async () => {
  const tampered = new Uint8Array(signed);
  const at = new TextDecoder("latin1").decode(tampered).indexOf("Approved");
  expect(at).toBeGreaterThan(0);
  tampered[at] = "X".codePointAt(0) ?? 0;
  const result = await verifySignatures(openTest(tampered), tampered);
  const [s] = result.signatures;
  expect(s?.integrity).toBe("failed");
});

test("bytes appended after signing leave the signature intact but partial", async () => {
  const update = new TextEncoder().encode("\n% a later revision\n");
  const longer = new Uint8Array(signed.length + update.length);
  longer.set(signed);
  longer.set(update, signed.length);
  const result = await verifySignatures(openTest(longer), longer);
  const [s] = result.signatures;
  expect(s?.integrity).toBe("ok");
  expect(s?.coverage).toBe("partial");
  expect(s?.laterBytes).toBe(update.length);
});

test("a byte range that does not start the file fails, though its digest matches", async () => {
  const forged = await forge(signed, (from, end) => [
    10,
    from - 10,
    end,
    signed.length - end,
  ]);
  const { signatures } = await verifySignatures(openTest(forged), forged);
  const [s] = signatures;
  expect(s?.integrity).toBe("failed");
  expect(s?.notes.join(" ")).toContain("leaves out more than the signature");
});

test("a byte range that leaves out more than the signature fails, though its digest matches", async () => {
  const forged = await forge(signed, (from, end) => [
    0,
    from - 20,
    end,
    signed.length - end,
  ]);
  const { signatures } = await verifySignatures(openTest(forged), forged);
  const [s] = signatures;
  expect(s?.integrity).toBe("failed");
});

test("an encrypted file's signature checks out against the encrypted bytes", async () => {
  const env = await testEnv();
  const locked = protect(env, makePdf(1), {
    accessibility: true,
    annotate: true,
    assemble: true,
    bits: 256,
    copy: true,
    forms: true,
    modify: true,
    ownerPassword: "",
    print: "full",
    userPassword: "secret",
  });
  const file = await signPdf(locked, signer, "secret");
  const { signatures } = await verifySignatures(
    openPdf(env, file, "secret"),
    file
  );
  const [s] = signatures;
  expect(s?.reason).toBe("Approved");
  expect(s?.integrity).toBe("ok");
  expect(s?.signature).toBe("ok");
  expect(s?.coverage).toBe("whole");
});
