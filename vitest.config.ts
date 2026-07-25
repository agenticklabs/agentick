import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: {
    jsx: "automatic",
    // v2 JSX is React JSX (compiler-react drives it through react-reconciler).
    // Matches every packages-next tsconfig's `jsxImportSource: "react"`.
    jsxImportSource: "react",
  },
  test: {
    globals: true,
    environment: "node",
    include: [
      "packages-next/*/src/**/*.spec.{ts,tsx}",
      "example/*/src/**/*.spec.{ts,tsx}",
    ],
    benchmark: {
      include: ["packages-next/*/src/**/*.bench.{ts,tsx}"],
      exclude: ["**/node_modules/**", "**/dist/**"],
    },
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: 30000,
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: "v8",
      include: ["packages-next/*/src/**/*.{ts,tsx}"],
      exclude: ["**/*.spec.ts", "**/*.spec.tsx", "**/testing/**"],
      reporter: ["text", "json", "html"],
    },
  },
  resolve: {
    alias: [
      // Strip .js from relative imports so vite resolves .ts source files
      { find: /^(\.{1,2}\/.*)\.js$/, replacement: "$1" },
    ],
  },
});
