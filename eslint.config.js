// @ts-check
import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "**/dist/**", "**/build/**", "**/coverage/**", "**/.aspire/**", "**/*.d.ts", "**/vendor/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser },
    },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none", ignoreRestSiblings: true }],
      // Handles that closures read are declared before they are assigned (`let timer; const done = () => clearTimeout(timer)`).
      "prefer-const": ["error", { ignoreReadBeforeAssign: true }],
      // `declare global { namespace Express { ... } }` is how Express request types are augmented.
      "@typescript-eslint/no-namespace": ["error", { allowDeclarations: true }],
      // Tool lists are typed `Tool<any>[]`, as the stock SDK's own `SessionConfig.tools` is; `tsc --strict` still checks the rest.
      "@typescript-eslint/no-explicit-any": "off",
      // Sanitizers deliberately match control characters (file names, terminal output, header values).
      "no-control-regex": "off",
    },
  },
  {
    files: ["**/*.tsx"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
  {
    files: ["**/*.cjs"],
    languageOptions: { sourceType: "commonjs" },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
);
