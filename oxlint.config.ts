import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";

export default defineConfig({
  env: {
    ...core.env,
    es2022: true,
  },
  extends: [core],
  ignorePatterns: [...(core.ignorePatterns ?? []), "index.html"],
  overrides: [
    {
      files: ["build.ts", "smoke.ts"],
      rules: {
        "no-console": "off",
      },
    },
  ],
  rules: {
    "no-await-in-loop": "off",
    "no-console": ["warn", { allow: ["warn", "error"] }],
    "unicorn/consistent-function-scoping": "off",
    "unicorn/prefer-add-event-listener": "off",
  },
});
