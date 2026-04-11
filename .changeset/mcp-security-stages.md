---
"@agentick/mcp": patch
---

Phase 5 security hardening: ship production-grade security pipeline stages.

Five new factory functions in `@agentick/mcp` that return plain stage functions (`ConnectionGuard`, `Authenticator`, `Authorizer`, `RateLimiter`, `InputSanitizer`) for drop-in use in `MCPServerOptions.security`:

**`bearerTokenAuth(options)`** — Authorization header extraction with static token maps, async verification (JWT, OAuth introspection), case-insensitive lookup, custom extractors for non-HTTP transports.

**`roleBasedAuthz(options)`** — rule-based RBAC with specificity-ordered matching (`tool_call:name` beats `tool_call:*` beats `*`). Empty `roles: []` = any authenticated user. Missing rule = implicit deny. Override `getRoles` to source roles from scopes, tenants, or other contexts.

**`slidingWindowLimiter(options)`** — in-memory sliding-window rate limiter with configurable `windowMs`, `max`, custom `keyFn`, `onReject` callback, and automatic lazy cleanup of expired buckets. For distributed rate limiting, swap in a Redis-backed limiter with the same signature.

**`allowListGuard(options)`** — connection guard for origins (exact + glob wildcards) and remote addresses (IPv4/IPv6 exact + CIDR ranges). Normalizes IPv4-mapped IPv6 for loopback comparisons. Either/or matching by default, `requireBoth: true` to require both checks.

**`pathTraversalSanitizer(options)`** — tool input sanitizer that detects literal `..`, URL-encoded (`%2e%2e`), double-URL-encoded, backslash-style, and null-byte path traversal. Auto-detects path-like fields by name (`path`, `file`, `filename`, `dir`, `directory`). Optional `allowedRoots` for scoping to specific directories. `mode: "reject"` (default) or `"strip"`.

All stages are pure, test-covered (58 new tests), and documented in the package README with concrete usage examples. Tests exercise happy paths, rejection paths, edge cases, and composition patterns. Total package tests: 158 → 219.

No runtime behavior changes to existing code paths — these are additive factory functions that consumers opt into. The existing safe defaults (`localOnlyGuard`, `rejectAllAuth`, `allowAllAuth`, etc.) remain unchanged.
