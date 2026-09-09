// Bundles the app and inlines JS + CSS into a single self-contained dist/index.html.

import { createElement, type FC } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as symbolFiles from "@react-symbols/icons/files";
import * as symbolFolders from "@react-symbols/icons/folders";

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

// Icons are Lucide's SVG files, one import per icon so only the ones used
// are bundled. Each becomes the string the app inlines: license comment,
// class, size, and namespace dropped, whitespace collapsed, hidden from
// assistive technology, and drawn at the stroke the Collection's 16px icons
// have always had (1.5px, which on Lucide's 24-unit grid is 2.25).
const ICON_STROKE = "2.25";
const lucide: Bun.BunPlugin = {
  name: "lucide icons",
  setup(build) {
    build.onLoad({ filter: /[\\/]lucide-static[\\/]icons[\\/][^\\/]+\.svg$/ }, async (args) => {
      const text = (await Bun.file(args.path).text()).replace(/<!--[\s\S]*?-->/, "").trim();
      const root = /^<svg\s([^>]*)>/.exec(text);
      if (!root) throw new Error(args.path + " is not an SVG");
      const attrs = (" " + root[1]!)
        .replace(/\s(class|width|height|xmlns)="[^"]*"/g, "")
        .replace(/stroke-width="[^"]*"/, `stroke-width="${ICON_STROKE}" aria-hidden="true"`)
        .replaceAll(/\s+/g, " ")
        .trim();
      const body = text.slice(root[0].length).replaceAll(/\s*\n\s*/g, "").replaceAll(" />", "/>");
      return { contents: "export default " + JSON.stringify(`<svg ${attrs}>${body}`) + ";", loader: "js" };
    });
  },
};

// The Tree's file and folder icons are Symbols (Miguel Solorio's VS Code
// icon theme), which @react-symbols/icons ships as React components. An
// import of "@react-symbols/icons/files/<Name>" (or folders/<Name>) renders
// that one component to its markup here, at build time, so React stays out
// of the bundle and only the icons imported go in. Ids inside an icon (masks,
// clips) are prefixed with its name: two different icons on one page must
// not capture each other's.
const reactSymbols: Bun.BunPlugin = {
  name: "react-symbols icons",
  setup(build) {
    const filter = /^@react-symbols\/icons\/(files|folders)\/(\w+)$/;
    build.onResolve({ filter }, (args) => ({ path: args.path, namespace: "react-symbols" }));
    build.onLoad({ filter: /.*/, namespace: "react-symbols" }, (args) => {
      const [, set, name] = filter.exec(args.path)!;
      const icons: Record<string, FC | undefined> = set === "files" ? symbolFiles : symbolFolders;
      const component = icons[name!];
      if (!component) throw new Error(`@react-symbols/icons has no ${set} icon named ${name}`);
      const prefix = `rs-${name!.toLowerCase()}-`;
      const svg = renderToStaticMarkup(createElement(component))
        .replace(/ xmlns="[^"]*"/, "")
        .replace("<svg", '<svg aria-hidden="true"')
        .replaceAll(/ id="([^"]+)"/g, (_, id: string) => ` id="${prefix}${id}"`)
        .replaceAll(/url\(#([^)]+)\)/g, (_, id: string) => `url(#${prefix}${id})`)
        .replaceAll(/href="#([^"]+)"/g, (_, id: string) => `href="#${prefix}${id}"`);
      return { contents: "export default " + JSON.stringify(svg) + ";", loader: "js" };
    });
  },
};

const plugins = [lucide, reactSymbols];

const define: Record<string, string> = {};
for (const w of WORKERS) {
  const worker = await Bun.build({
    entrypoints: [w.entry],
    target: "browser",
    format: "esm",
    minify: true,
    loader,
    plugins,
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
  plugins,
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
