// Bundles the app and inlines JS + CSS into a single self-contained dist/index.html.

// The Document to Markdown worker is its own bundle: the main bundle receives
// its source as the DOC_WORKER_SRC constant and spawns it from a blob: URL, so
// the artifact stays one file and the worker still runs from file://.
const worker = await Bun.build({
  entrypoints: ["src/tools/doc-to-markdown/worker.ts"],
  target: "browser",
  format: "esm",
  minify: true,
});

if (!worker.success) {
  for (const log of worker.logs) console.error(log);
  process.exit(1);
}

let workerJs = "";
for (const output of worker.outputs) workerJs += await output.text();

const result = await Bun.build({
  entrypoints: ["src/shell/main.ts"],
  target: "browser",
  minify: true,
  define: { DOC_WORKER_SRC: JSON.stringify(workerJs) },
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

const template = await Bun.file("src/index.html").text();
const html = template
  .replace("<!--STYLE-->", "<style>\n" + css + "</style>")
  .replace("<!--SCRIPT-->", "<script>\n" + js.replaceAll("</script", "<\\/script") + "</script>");

await Bun.write("dist/index.html", html);
console.log("dist/index.html written (" + (html.length / 1024).toFixed(1) + " KB)");
