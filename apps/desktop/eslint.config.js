import js from "@eslint/js";
import tseslint from "typescript-eslint";

const nodeGlobals = {
  process: "readonly",
  console: "readonly",
  Buffer: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  fetch: "readonly",
  document: "readonly",
  window: "readonly",
  module: "writable",
  require: "readonly",
  __dirname: "readonly",
  __filename: "readonly",
};

export default tseslint.config(
  { ignores: ["dist/**", "release/**", "node_modules/**", ".smoke/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: nodeGlobals,
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      eqeqeq: "error",
      "prefer-const": "error",
      "no-console": "off",
    },
  },
);
