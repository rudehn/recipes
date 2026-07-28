// Flat ESLint config. Scoped to catching mistakes the typechecker cannot:
// stale hook dependencies, unhandled promises, accidental `any`. Formatting is
// deliberately not linted - there is no formatter in this project, and adding
// one would rewrite every file to settle questions nobody has asked.

import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Vite's own config is not part of the app's tsconfig project, so the
  // type-aware parser cannot see it.
  { ignores: ["dist", "coverage", "*.tsbuildinfo", "vite.config.ts", "eslint.config.js"] },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      // Type-aware rules: worth the project load, since the bugs worth
      // catching here (a forgotten await, a promise dropped in an onClick)
      // are invisible without type information.
      ...tseslint.configs.recommendedTypeChecked,
    ],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],

      // A rejected promise that nobody awaits becomes an unhandled rejection
      // and the user sees nothing happen. This is the rule that would have
      // caught the pages that swallowed their load errors.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        // An async function is the normal shape of a React event handler; only
        // the non-void cases are real mistakes.
        { checksVoidReturn: { attributes: false } },
      ],

      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],

      // Fires on `useEffect(reload, [reload])` - load-on-mount, which is what
      // a page without a data-fetching library has to do. The rule is aimed at
      // effects that derive state from props; it cannot tell the two apart.
      "react-hooks/set-state-in-effect": "off",
    },
  },
  {
    // Tests reach into mocks and fixtures where precise typing buys nothing:
    // the stand-in backend is deliberately loosely typed so a test can hand
    // back whatever shape it wants to see the UI handle.
    files: ["**/*.test.{ts,tsx}", "src/test/**"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-redundant-type-constituents": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-base-to-string": "off",
      // Mock handlers are async to match the real signature, not because they
      // have anything to await.
      "@typescript-eslint/require-await": "off",
    },
  },
);
