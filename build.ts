// Bundles the app and inlines JS + CSS into a single self-contained dist/index.html.

// Workers are their own bundles: the main bundle receives each one's source
// as a constant and spawns it from a data: or blob: URL, so the artifact
// stays one file and the workers still run from file://.
const WORKERS = [
  { entry: "src/tools/doc-to-markdown/worker.ts", constant: "DOC_WORKER_SRC" },
  { entry: "src/tools/python-ide/py-worker.ts", constant: "PYIDE_PY_WORKER_SRC" },
  { entry: "src/tools/python-ide/ruff-worker.ts", constant: "PYIDE_RUFF_WORKER_SRC" },
];

// Python source files are imported as text: the interpreter worker writes
// them into its filesystem at boot.
const loader = { ".py": "text" } as const;

const define: Record<string, string> = {};
for (const w of WORKERS) {
  const worker = await Bun.build({
    entrypoints: [w.entry],
    target: "browser",
    format: "esm",
    minify: true,
    loader,
  });
  if (!worker.success) {
    for (const log of worker.logs) console.error(log);
    process.exit(1);
  }
  let src = "";
  for (const output of worker.outputs) src += await output.text();
  define[w.constant] = JSON.stringify(src);
}

const result = await Bun.build({
  entrypoints: ["src/shell/main.ts"],
  target: "browser",
  minify: true,
  loader,
  define,
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

let js = "";
let css = "";
for (const output of result.outputs) {
  const text = await output.text();
  if (output.path.endsWith(".css")) css += text;
  else js += text;
}

// Replacement callbacks: a string replacement would expand `$&` and friends,
// and a minified bundle is bound to contain one somewhere.
const template = await Bun.file("src/index.html").text();
const html = template
  .replace("<!--STYLE-->", () => "<style>\n" + css + "</style>")
  .replace("<!--SCRIPT-->", () => "<script>\n" + js.replaceAll("</script", "<\\/script") + "</script>");

await Bun.write("dist/index.html", html);
console.log("dist/index.html written (" + (html.length / 1024).toFixed(1) + " KB)");
