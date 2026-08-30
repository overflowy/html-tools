// Bundles the app and inlines JS + CSS into a single self-contained index.html.

const result = await Bun.build({
  entrypoints: ["src/shell/main.ts"],
  target: "browser",
  minify: true,
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

await Bun.write("index.html", html);
console.log("index.html written (" + (html.length / 1024).toFixed(1) + " KB)");
