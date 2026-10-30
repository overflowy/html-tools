import { expect, test } from "bun:test";

import { zip } from "./zip";

test("a stored zip lists every file under a unique UTF-8 name, and unzip agrees", async () => {
  const enc = new TextEncoder();
  const blob = await zip([
    { bytes: enc.encode("one"), name: "a.pdf" },
    { bytes: enc.encode("two"), name: "a.pdf" },
    { bytes: enc.encode("drei"), name: "über.txt" },
  ]);
  const dir = Bun.env.TMPDIR ?? "/tmp";
  const path = `${dir}/pdf-toolkit-zip-test-${Date.now()}.zip`;
  await Bun.write(path, blob);
  // Python's zipfile reads the UTF-8 name flag; the unzip macOS ships does not.
  const script =
    "import sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); print(z.testzip()); print('|'.join(z.namelist())); print(z.read('über.txt').decode())";
  const run = Bun.spawnSync(["python3", "-I", "-c", script, path]);
  expect(run.exitCode).toBe(0);
  expect(run.stdout.toString().trim().split("\n")).toEqual([
    "None",
    "a.pdf|a (2).pdf|über.txt",
    "drei",
  ]);
});
