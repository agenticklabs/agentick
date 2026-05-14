---
"@agentick/core": patch
---

Section duplicate warning — switch from `Logger.warn` to dev-only `console.warn`.

The previous release introduced a `Logger.warn` for duplicate `<Section id>` collisions. That produced a structured pino log line per occurrence, which is too noisy for an authoring-mistake / render-bug warning that should behave like React's `react/jsx-key` warning.

Now uses plain `console.warn`, gated on `"production" !== process.env.NODE_ENV` (the same yoda-style guard React uses in `react-reconciler.development.js`). Bundler dead-code elimination can strip the warning from production builds; in dev/test it surfaces directly without polluting structured logs.
