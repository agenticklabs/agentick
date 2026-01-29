import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "tentickle",
  },
  test: {
    globals: true,
    environment: "node",
    include: [
      "packages/*/src/**/*.spec.{ts,tsx}",
      "packages/adapters/*/src/**/*.spec.{ts,tsx}",
      "example/*/src/**/*.spec.{ts,tsx}",
    ],
    exclude: ["**/node_modules/**", "**/dist/**", "packages/react/**", "packages/angular/**", "packages/nestjs/**"],
    testTimeout: 30000,
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.{ts,tsx}", "packages/adapters/*/src/**/*.{ts,tsx}"],
      exclude: ["**/*.spec.ts", "**/*.spec.tsx", "**/testing/**"],
      reporter: ["text", "json", "html"],
    },
  },
  resolve: {
    alias: {
      "tentickle/jsx-runtime": "./packages/core/src/jsx/jsx-runtime.ts",
      "tentickle/jsx-dev-runtime": "./packages/core/src/jsx/jsx-runtime.ts",
    },
  },
});
