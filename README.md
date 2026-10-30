# html tools

A collection of browser utilities built into one self-contained `index.html`. Open it from disk; nothing you type or drop leaves the browser. Heavy engines (Pyodide, OCR, Monaco, speech recognition, 7-Zip) are fetched from a CDN on first use and cached.

## Tools

- **Archive Manager**: open, preview, extract, test, and convert 7z, zip, rar, tar, iso, and some fifty more formats; make 7z, zip, and tar archives
- **Base64 ⇄ Image**: base64 to image and back
- **Big Text**: a message as large as the screen allows, with slides, a countdown, and a scrolling marquee
- **Dependency Audit**: check a lockfile (npm, yarn, pnpm, bun, uv) against OSV.dev
- **DNS Lookup**: DNS over HTTPS, subdomains, email auth checks, whois over RDAP
- **Document to Markdown**: Word, Excel, PowerPoint, PDF and more, with OCR for scans
- **Dual N-Back**: the n-back task with position, color, shape, sound, and arithmetic, automatic levels, and a history
- **File Hashes**: MD5, SHA-1, SHA-2, SHA-3, BLAKE3, CRC32, and more, for files or text; check against an expected hash or a checksum file
- **Image Metadata**: inspect EXIF and friends, download a stripped copy
- **JSON/JSONC Key Sorter**: sort keys, keep comments
- **LZString Save Decoder**: decode and encode incremental-game saves
- **Markdown Editor**: editor, live preview, math, diagrams
- **Python IDE**: Pyodide, Pyright, Ruff, and a terminal, per-project packages
- **QR Code Generator**: links, WiFi, contacts, and more
- **Speech to Text**: transcribe a file or the microphone in seven languages, with word timestamps and subtitles
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

## Fonts

Text is set in Mona Sans and code in IBM Plex Mono. The files live in `src/shell/fonts/` and the build inlines them, so the page needs no network for them.

IBM Plex Mono is taken as is from `@fontsource/ibm-plex-mono`. Mona Sans is built from the variable fonts in GitHub's official release (`mona-sans-webfonts-<version>.zip`, under `fonts/webfonts/variable`) by `scripts/build-mona-sans.py`, which pins the optical size, swaps the slashed tabular 0 and footed tabular 1 for the plain digits, and subsets to Latin and Latin Extended. To rebuild:

```sh
uv run --with fonttools --with brotli python scripts/build-mona-sans.py "MonaSansVF[opsz,wght].woff2" src/shell/fonts/mona-sans-latin-wght-normal.woff2
uv run --with fonttools --with brotli python scripts/build-mona-sans.py "MonaSansVF-Italic[opsz,wght].woff2" src/shell/fonts/mona-sans-latin-wght-italic.woff2
```

## Acknowledgements

- https://simonwillison.net/2025/Dec/10/html-tools/
- https://github.com/hattray/markdown-editor

## License

MIT, except the fonts in `src/shell/fonts/`, which are under the SIL Open Font License 1.1 (license files alongside), the sounds in `src/tools/dual-n-back/sounds/`, which are under the GNU GPL v2 (`NOTICE.md` alongside), and the 7-Zip build in `vendor/js7z/`, which is under the GNU LGPL with the unRAR license restriction (`README.md` and the license files alongside).
