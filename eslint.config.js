import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import oxlint from "eslint-plugin-oxlint";

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "**/*.min.js",
      "**/*.d.ts",
      "website/.vitepress/cache/**",
    ],
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      // TypeScript rules that oxlint doesn't cover yet
      "@typescript-eslint/consistent-type-imports": "warn",
    },
  },
  // oxlint plugin disables rules that oxlint already handles
  ...oxlint.buildFromOxlintConfigFile("./.oxlintrc.json"),
];
