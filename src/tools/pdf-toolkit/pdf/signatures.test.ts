import { expect, test } from "bun:test";

import { makePdf, openTest } from "../test-env";
import { makeSigner, signPdf } from "./sign-fixture";
import { verifySignatures } from "./signatures";

const signer = await makeSigner("Test Signer");
const signed = await signPdf(makePdf(1), signer);

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
