import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  ignorePatterns: [
    ...(ultracite.ignorePatterns ?? []),
    // Verbatim lockfile and API samples the parsers are tested against.
    "src/tools/dependency-audit/fixtures/**",
    // License text is kept exactly as published.
    "**/LICENSE*",
  ],
});
