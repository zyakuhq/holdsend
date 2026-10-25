import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: { process: "readonly", console: "readonly", URL: "readonly" },
    },
  },
  {
    files: ["examples/**/src/server.mjs", "examples/**/src/app.mjs", "examples/**/test/**/*.mjs"],
    languageOptions: { globals: globals.node },
  },
  {
    // page.evaluate() callbacks run in the browser.
    files: ["examples/**/test/**/*.mjs"],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ["examples/**/src/client.mjs", "examples/**/src/send.mjs", "examples/**/src/session.mjs"],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ["examples/**/src/sw.mjs"],
    languageOptions: { globals: globals.serviceworker },
  },
);
