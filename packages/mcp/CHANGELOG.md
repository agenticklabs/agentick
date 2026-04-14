# @agentick/mcp

## 0.14.32

### Patch Changes

- ba21889: support mcp server instructions
  - @agentick/kernel@0.14.32
  - @agentick/shared@0.14.32

## 0.14.31

### Patch Changes

- @agentick/kernel@0.14.31
- @agentick/shared@0.14.31

## 0.14.30

### Patch Changes

- 3ad42aa: Phase 5 security hardening: ship production-grade security pipeline stages.

  Five new factory functions in `@agentick/mcp` that return plain stage functions (`ConnectionGuard`, `Authenticator`, `Authorizer`, `RateLimiter`, `InputSanitizer`) for drop-in use in `MCPServerOptions.security`:

  **`bearerTokenAuth(options)`** — Authorization header extraction with static token maps, async verification (JWT, OAuth introspection), case-insensitive lookup, custom extractors for non-HTTP transports.

  **`roleBasedAuthz(options)`** — rule-based RBAC with specificity-ordered matching (`tool_call:name` beats `tool_call:*` beats `*`). Empty `roles: []` = any authenticated user. Missing rule = implicit deny. Override `getRoles` to source roles from scopes, tenants, or other contexts.

  **`slidingWindowLimiter(options)`** — in-memory sliding-window rate limiter with configurable `windowMs`, `max`, custom `keyFn`, `onReject` callback, and automatic lazy cleanup of expired buckets. For distributed rate limiting, swap in a Redis-backed limiter with the same signature.

  **`allowListGuard(options)`** — connection guard for origins (exact + glob wildcards) and remote addresses (IPv4/IPv6 exact + CIDR ranges). Normalizes IPv4-mapped IPv6 for loopback comparisons. Either/or matching by default, `requireBoth: true` to require both checks.

  **`pathTraversalSanitizer(options)`** — tool input sanitizer that detects literal `..`, URL-encoded (`%2e%2e`), double-URL-encoded, backslash-style, and null-byte path traversal. Auto-detects path-like fields by name (`path`, `file`, `filename`, `dir`, `directory`). Optional `allowedRoots` for scoping to specific directories. `mode: "reject"` (default) or `"strip"`.

  All stages are pure, test-covered (58 new tests), and documented in the package README with concrete usage examples. Tests exercise happy paths, rejection paths, edge cases, and composition patterns. Total package tests: 158 → 219.

  No runtime behavior changes to existing code paths — these are additive factory functions that consumers opt into. The existing safe defaults (`localOnlyGuard`, `rejectAllAuth`, `allowAllAuth`, etc.) remain unchanged.

  - @agentick/kernel@0.14.30
  - @agentick/shared@0.14.30

## 0.14.29

### Patch Changes

- d8b1984: Introduce standalone `@agentick/mcp` package and migrate core + gateway to use it.

  **New package: `@agentick/mcp`**

  A standalone MCP (Model Context Protocol) server and client library that depends only on `@agentick/kernel` and `@agentick/shared`. Drop it into any project — no core, no gateway, no framework coupling.

  - `MCPServer` — per-session SDK `Server` pool, shared registry, dynamic tool/resource/prompt registration with notification fan-out (`tools/list_changed`, `resources/list_changed`), structured error sanitization, request-level security pipeline
  - `MCPClient` — multi-server connection pool, tool/resource/prompt caching, automatic cache invalidation on notifications, progress callbacks, sampling and roots support, logging, completions, cancellation
  - Security pipeline — `ConnectionGuard → contextProvider → Authenticator → Authorizer → RateLimiter → InputSanitizer`, fully pluggable with safe defaults
  - MCP Apps (local variant) — `createMCPApp` wraps ext-apps `AppBridge` + `PostMessageTransport`, enforces tool visibility from `_meta.ui.visibility`, exposes `buildAllowAttribute` / `getToolAppUri` / `isToolVisibilityModelOnly` helpers
  - 158 tests covering server, client, security, protocol, transport integration, and HTTP lifecycle

  **Core migration (`@agentick/core`)**

  `packages/core/src/mcp/client.ts` is now a thin adapter over `@agentick/mcp`'s `MCPClient`. Existing core consumers see the same public API (`MCPClient`, `MCPService`, `MCPTool`, `MCPResourceComponent`) with unchanged behavior. Net `-564` lines in `packages/core/src/mcp/`.

  **Gateway migration (`@agentick/gateway`)**

  `mcpServerPlugin` now delegates entirely to `@agentick/mcp`'s `MCPServer`. The plugin is auth-agnostic (gateway middleware handles auth, MCP server trusts), supports tool catalog discovery, standalone tools, static resources, resource templates, per-session filtering, and OAuth metadata proxying. Public plugin config types (`MCPStaticResource`, `MCPResourceTemplate`, `MCPStandaloneTool`, `MCPServerPluginConfig`, `ToolEntry`) are unchanged. Net `-471` lines in `packages/gateway/src/plugins/mcp-server.ts`.

  **SDK version bump**

  `@modelcontextprotocol/sdk` bumped `^1.26.0 → ^1.29.0` in `@agentick/core` and `@agentick/gateway`. Required by `@modelcontextprotocol/ext-apps@1.5.0`, which `@agentick/mcp` uses for the MCP Apps bridge.

  **Deferred**

  - `createMCPAppRelay` — server-side AppBridge variant for bridging an iframe over a remote chat channel. Required for cloud-agent + browser-UI topology. Blocked on agentick's bidirectional channel architecture resolving (see `docs/channels-current-state.md`). The local `createMCPApp` variant ships today and covers in-process and desktop-local use cases.
  - `MCPAuthProvider` — pluggable OAuth 2.1 / DCR / token refresh. Phase 5 work item; not architecturally blocked.
  - @agentick/kernel@0.14.29
  - @agentick/shared@0.14.29
