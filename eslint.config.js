import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

/**
 * One lint config for the whole workspace.
 *
 * The rule set is deliberately the small, uncontroversial core: `js.configs.recommended`
 * plus typescript-eslint's `recommended` (not `recommended-type-checked`, which needs
 * a program per file and a matching TypeScript version in every package), plus the
 * two react-hooks rules that catch real bugs. Adding lint to a tree this size is
 * only honest if every file passes, so anything that needs a refactor is off with a
 * reason below instead of being left on and ignored.
 *
 * Rules turned off, and why:
 *
 * - `@typescript-eslint/no-explicit-any` — the provider adapters and computer
 *   adapters parse third-party JSON, and the api handlers talk to untyped SSE
 *   payloads; the real fix is `unknown` plus validators in the routes, which is a
 *   product change, not a lint change.
 * - `@typescript-eslint/no-empty-object-type` — React prop types in `packages/ui`
 *   legitimately extend `{}`-shaped bases.
 * - `@typescript-eslint/no-require-imports` — `apps/desktop/scripts/*.mjs` and the
 *   electron-builder config are CommonJS by contract.
 * - `no-console` — the api, worker and desktop main process log to stdout on
 *   purpose; there is no logger package to redirect to yet.
 * - `no-control-regex` — used to strip terminal escapes from captured output.
 * - the React Compiler rule set that ships in eslint-plugin-react-hooks 7
 *   (`purity`, `immutability`, `refs`, `set-state-in-effect`, …) is not enabled: it
 *   is a large refactor across `packages/ui`, `apps/web` and `apps/mobile` and does
 *   not belong in a CI change.
 *
 * Ignored, and why: build output, generated Expo artifacts, the vendored avatar
 * gallery data (`packages/avatars/src/gallery`, third-party JSON re-emitted as TS),
 * and Drizzle's generated migration snapshots.
 */
export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/dist/**",
      "**/release/**",
      "**/.expo/**",
      "**/android/**",
      "**/.turbo/**",
      "**/coverage/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "packages/avatars/src/gallery/**",
      "packages/db/drizzle/**",
      "**/*.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Only the two rules that catch real bugs. See the note above about the rest
    // of this plugin's rule set.
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
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
      },
    },
    linterOptions: {
      // A `// eslint-disable-next-line` for a rule that no longer reports anything
      // is dead weight that misleads the next reader; treat it as an error, the
      // same way ESLint's own recommended practice does.
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-require-imports": "off",
      "no-console": "off",
      "no-control-regex": "off",
      eqeqeq: "error",
      "prefer-const": "error",
      "no-var": "error",
      "no-unused-private-class-members": "error",
    },
  },
);
