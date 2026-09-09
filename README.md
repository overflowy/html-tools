# html tools

A collection of browser utilities built into one self-contained `index.html`. Open it from disk; nothing you type or drop leaves the browser. Heavy engines (Pyodide, OCR, Monaco) are fetched from a CDN on first use and cached.

## Tools

- **Base64 ⇄ Image**: base64 to image and back
- **Dependency Audit**: check a lockfile (npm, yarn, pnpm, bun, uv) against OSV.dev
- **DNS Lookup**: DNS over HTTPS, subdomains, email auth checks, whois over RDAP
- **Document to Markdown**: Word, Excel, PowerPoint, PDF and more, with OCR for scans
- **Image Metadata**: inspect EXIF and friends, download a stripped copy
- **JSON/JSONC Key Sorter**: sort keys, keep comments
- **LZString Save Decoder**: decode and encode incremental-game saves
- **Markdown Editor**: editor, live preview, math, diagrams
- **Python IDE**: Pyodide, Pyright, Ruff, and a terminal, per-project packages
- **QR Code Generator**: links, WiFi, contacts, and more
- **UUID Generator**: one random v4 UUID
- **Whoami**: your public IPv4, IPv6, country, and user agent

## Develop

```sh
bun install
bun run build       # writes dist/index.html
bun run check       # tsc
bun run lint        # oxlint
bun run test:unit   # bun test
bun run test        # browser smoke test against dist/ (headless Chromium)
```

Adding a tool: create `src/tools/<id>/` with an `index.ts` exporting a `Tool` and a `tool.css` scoped under `.tool-<id>`, then add one line to `src/registry.ts`.

## Acknowledgements

- https://simonwillison.net/2025/Dec/10/html-tools/
- https://github.com/hattray/markdown-editor

## License

MIT
