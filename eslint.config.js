import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/dist-web/**", "**/.expo/**", "**/node_modules/**", "**/coverage/**"] },
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
    files: ["examples/**/src/client.mjs", "examples/**/src/send.mjs", "examples/**/src/session.mjs", "examples/react/src/**/*.{js,jsx}", "examples/expo/src/**/*.js", "examples/expo/index.js"],
    languageOptions: { globals: globals.browser, parserOptions: { ecmaFeatures: { jsx: true } } },
  },
  {
    // Expo inlines process.env.EXPO_PUBLIC_* values when it bundles the app.
    files: ["examples/expo/src/**/*.js"],
    languageOptions: { globals: { process: "readonly" } },
  },
  {
    files: ["examples/**/src/sw.mjs"],
    languageOptions: { globals: globals.serviceworker },
  },
);
