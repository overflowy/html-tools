# JS7z, single-threaded build

7-Zip 25.01 compiled to WebAssembly by [JS7z](https://github.com/GMH-Code/JS7z), release v2.5.0, variant `[ST+FS+EC]`: single-threaded, with the extra file systems (WORKERFS, which the Archive Manager mounts dropped files with), and with the extra exception catching that reports wrong passwords and corrupt data instead of aborting.

The Archive Manager fetches these two files as an Engine from jsDelivr, pinned to the commit that added them:

- `js7z.js`: the Emscripten glue
- `js7z.wasm`: 7-Zip itself

They are here because nothing else serves them to a browser. The multi-threaded build on npm (`js7z-tools`) needs `SharedArrayBuffer`, which a page opened from `file://` never has, and the single-threaded build is published only as a GitHub release asset, which browsers cannot fetch across origins.

## Provenance

Unpacked unmodified from the release asset `js7z-st-fs-ec.zip` of tag `v2.5.0` (commit `dc0aa142b5f06eb96329535a3687dfbd0039181d`).

| File                 | SHA-256                                                            |
| -------------------- | ------------------------------------------------------------------ |
| `js7z-st-fs-ec.zip`  | `c80dac23a605c6571d5716b9d9b702e800f77df2c83d1e5c50e21a4899c3f413` |
| `js7z.js`            | `f1d6b0abf28cb659e3b9aff46546f1ef267fa44386c5ca7979465cc7e1e289c4` |
| `js7z.wasm`          | `2c29ec3578c8f4bcf816b0efcc10beb452d5376758103eabb633285a7f383a04` |

## License

7-Zip is under the GNU LGPL, with the unRAR license restriction on its RAR code and BSD licenses on a few files: `License.txt`, `unRarLicense.txt`, and `copying.txt` alongside are copied from the JS7z repository's `7z-Src/DOC`. Source code for this build is at the tag above.
