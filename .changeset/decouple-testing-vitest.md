---
"@agentick/core": minor
---

Sync all packages to 0.7.0.

**Connector system** — New `@agentick/connector` package with platform integration primitives. Initial adapters for iMessage and Telegram.

**CompletionSource redesign** — `@agentick/client` CompletionSource API uses match/resolve pattern.

**MessageSource registry** — Typed message provenance tracking in `@agentick/shared`, used by connectors.

**Gateway fix** — Re-resolve closed sessions after idle eviction.

**Content blocks fix** — Pass all content block types through DefaultPendingMessage.

**Testing utilities** — `createMockClient()` decoupled from vitest. Pass `vi.fn` or `jest.fn` as `fn` parameter for spy-wrapped methods.

**Knobs documentation** — Accordion pattern for conditional context rendering.
