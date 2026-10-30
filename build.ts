// Bundles the app and inlines JS + CSS into a single self-contained dist/index.html.

import * as symbolFiles from "@react-symbols/icons/files";
import * as symbolFolders from "@react-symbols/icons/folders";
import { createElement } from "react";
import type { FC } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Workers are their own bundles: the main bundle receives each one's source
// as a constant and spawns it from a data: or blob: URL, so the artifact
// stays one file and the workers still run from file://.
const WORKERS = [
  {
    constant: "ARCHIVE_WORKER_SRC",
    entry: "src/tools/archive-manager/worker.ts",
  },
  { constant: "DOC_WORKER_SRC", entry: "src/tools/doc-to-markdown/worker.ts" },
  { constant: "HASH_WORKER_SRC", entry: "src/tools/file-hashes/worker.ts" },
  {
    constant: "PYIDE_PY_WORKER_SRC",
    entry: "src/tools/python-ide/py-worker.ts",
  },
  {
    constant: "PYIDE_RUFF_WORKER_SRC",
    entry: "src/tools/python-ide/ruff-worker.ts",
  },
  { constant: "STT_WORKER_SRC", entry: "src/tools/speech-to-text/worker.ts" },
];

// Python source files are imported as text: the interpreter worker writes
// them into its filesystem at boot.
const loader = { ".py": "text" } as const;

// Icons are Lucide's SVG files, one import per icon so only the ones used
// are bundled. Each becomes the string the app inlines: license comment,
// class, size, and namespace dropped, whitespace collapsed, hidden from
// assistive technology, and drawn with a 1.5px stroke. That is screen
// pixels at every icon size, not units of Lucide's 24-unit grid: theme.css
// makes the strokes non-scaling, so a 12px chevron is drawn as heavily as a
// 16px button icon beside the same text.
const ICON_STROKE = "1.5";
const lucide: Bun.BunPlugin = {
  name: "lucide icons",
  setup(build) {
    build.onLoad(
      { filter: /[\\/]lucide-static[\\/]icons[\\/][^\\/]+\.svg$/u },
      async (args) => {
        const file = await Bun.file(args.path).text();
        const text = file.replace(/<!--[\s\S]*?-->/u, "").trim();
        const root = /^<svg\s(?<attrs>[^>]*)>/u.exec(text);
        if (!root) {
          throw new Error(`${args.path} is not an SVG`);
        }
        const rootAttrs = root.groups?.attrs ?? "";
        const attrs = ` ${rootAttrs}`
          .replaceAll(/\s(?:class|width|height|xmlns)="[^"]*"/gu, "")
          .replace(
            /stroke-width="[^"]*"/u,
            `stroke-width="${ICON_STROKE}" aria-hidden="true"`
          )
          .replaceAll(/\s+/gu, " ")
          .trim();
        const body = text
          .slice(root[0].length)
          .replaceAll(/\s*\n\s*/gu, "")
          .replaceAll(" />", "/>");
        return {
          contents: `export default ${JSON.stringify(`<svg ${attrs}>${body}`)};`,
          loader: "js",
        };
      }
    );
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
    const filter =
      /^@react-symbols\/icons\/(?<set>files|folders)\/(?<name>\w+)$/u;
    build.onResolve({ filter }, (args) => ({
      namespace: "react-symbols",
      path: args.path,
    }));
    build.onLoad({ filter: /.*/u, namespace: "react-symbols" }, (args) => {
      const groups = filter.exec(args.path)?.groups;
      if (!groups) {
        throw new Error(`${args.path} is not a @react-symbols/icons import`);
      }
      const { set, name } = groups;
      const icons: Record<string, FC | undefined> =
        set === "files" ? symbolFiles : symbolFolders;
      const component = icons[name];
      if (!component) {
        throw new Error(
          `@react-symbols/icons has no ${set} icon named ${name}`
        );
      }
      const prefix = `rs-${name.toLowerCase()}-`;
      const svg = renderToStaticMarkup(createElement(component))
        .replace(/ xmlns="[^"]*"/u, "")
        .replace("<svg", '<svg aria-hidden="true"')
        .replaceAll(
          / id="(?<id>[^"]+)"/gu,
          (_, id: string) => ` id="${prefix}${id}"`
        )
        .replaceAll(
          /url\(#(?<id>[^)]+)\)/gu,
          (_, id: string) => `url(#${prefix}${id})`
        )
        .replaceAll(
          /href="#(?<id>[^"]+)"/gu,
          (_, id: string) => `href="#${prefix}${id}"`
        );
      return {
        contents: `export default ${JSON.stringify(svg)};`,
        loader: "js",
      };
    });
  },
};

// Recorded sounds go in as data: URLs, one import per file so only the ones
// used are bundled, and the artifact stays one file.
const audio: Bun.BunPlugin = {
  name: "audio files",
  setup(build) {
    build.onLoad({ filter: /\.mp3$/u }, async (args) => {
      const b64 = Buffer.from(await Bun.file(args.path).arrayBuffer()).toString(
        "base64"
      );
      return {
        contents: `export default ${JSON.stringify(
          `data:audio/mpeg;base64,${b64}`
        )};`,
        loader: "js",
      };
    });
  },
};

const plugins = [lucide, reactSymbols, audio];

const define: Record<string, string> = {};
for (const w of WORKERS) {
  const worker = await Bun.build({
    entrypoints: [w.entry],
    format: "esm",
    loader,
    minify: true,
    plugins,
    target: "browser",
  });
  if (!worker.success) {
    for (const log of worker.logs) {
      console.error(log);
    }
    process.exit(1);
  }
  let src = "";
  for (const output of worker.outputs) {
    src += await output.text();
  }
  define[w.constant] = JSON.stringify(src);
}

const result = await Bun.build({
  define,
  entrypoints: ["src/shell/main.ts"],
  loader,
  minify: true,
  plugins,
  target: "browser",
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

let js = "";
let css = "";
for (const output of result.outputs) {
  const text = await output.text();
  if (output.path.endsWith(".css")) {
    css += text;
  } else {
    js += text;
  }
}

// Fonts: CSS imported from the script bundle keeps each url() as the font's
// path on disk, and each one goes in as a data: URL.
const fonts = new Map<string, string>();
for (const { groups = {} } of css.matchAll(/url\((?<path>[^)]+\.woff2)\)/gu)) {
  const { path } = groups;
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`font not found: ${path}`);
  }
  fonts.set(
    path,
    `data:font/woff2;base64,${Buffer.from(await file.arrayBuffer()).toString(
      "base64"
    )}`
  );
}
css = css.replaceAll(
  /url\((?<path>[^)]+\.woff2)\)/gu,
  (_, path: string) => `url(${fonts.get(path)})`
);

// Replacement callbacks: a string replacement would expand `$&` and friends,
// and a minified bundle is bound to contain one somewhere.
const template = await Bun.file("src/index.html").text();
const html = template
  .replace("<!--STYLE-->", () => `<style>\n${css}</style>`)
  .replace(
    "<!--SCRIPT-->",
    () => `<script>\n${js.replaceAll("</script", "<\\/script")}</script>`
  );

await Bun.write("dist/index.html", html);
console.log(`dist/index.html written (${(html.length / 1024).toFixed(1)} KB)`);
