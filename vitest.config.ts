import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: {
    jsx: "automatic",
    // Note: v2 tests use @jsxImportSource react pragma to override
    jsxImportSource: "agentick",
  },
  test: {
    globals: true,
    environment: "node",
    include: [
      "packages/*/src/**/*.spec.{ts,tsx}",
      "packages/core/v2/src/**/*.spec.{ts,tsx}",
      "packages/adapters/*/src/**/*.spec.{ts,tsx}",
      "example/*/src/**/*.spec.{ts,tsx}",
    ],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "packages/react/**",
      "packages/tui/**",
      "packages/angular/**",
      "packages/nestjs/**",
    ],
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
      "agentick/jsx-runtime": "./packages/core/src/jsx/jsx-runtime.ts",
      "agentick/jsx-dev-runtime": "./packages/core/src/jsx/jsx-runtime.ts",
    },
  },
});
