---
"@agentick/core": minor
"@agentick/shared": minor
"@agentick/client": minor
"@agentick/gateway": patch
"@agentick/tui": minor
"@agentick/sandbox": patch
"@agentick/connector": minor
"@agentick/connector-imessage": minor
"@agentick/connector-telegram": minor
---

**Connector system** — New `@agentick/connector` package with platform integration primitives. Initial adapters for iMessage and Telegram.

**CompletionSource redesign** — `@agentick/client` CompletionSource API now uses match/resolve pattern for cleaner composition.

**MessageSource registry** — Typed message provenance tracking in `@agentick/shared`, used by connectors.

**Gateway fix** — Re-resolve closed sessions after idle eviction instead of returning stale references.

**Content blocks fix** — Pass all content block types through DefaultPendingMessage in core.

**Testing utilities** — `createMockClient()` no longer imports vitest. Pass `vi.fn` or `jest.fn` as the `fn` parameter for spy-wrapped methods. Fixes TypeDoc build failure.
