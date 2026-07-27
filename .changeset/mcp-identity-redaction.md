---
"@agentick/mcp": minor
"@agentick/runtime": minor
---

SECURITY: the MCP identity stamp no longer carries the caller's
credential. `toIngressIdentity` spread the WHOLE authenticated user
record onto `IngressIdentity.user`, which rides `EventScope` on every
crossing — and `call-tool` / `initialize` are the persisted journal
classes — so an authenticator that hangs a bearer token off the record
(the common shape: tool handlers need it) wrote a live credential into
the durable journal on every tool call, contradicting the function's own
"never the credential itself" contract and the ADR 92 redaction law.

The stamp is now STRUCTURALLY safe: the default projection copies only
the four fields `McpAuthenticatedUser` declares (`id`, `displayName`,
`roles`, `scopes`) and cannot read a key it does not name — adopter-bag
fields, where credentials and PII live, are never copied. The new
`identityProjection` option on the MCP server config is the adopter's
redaction/sanitization seam: what it returns becomes `identity.user`
verbatim, while `principal` and `scopes` stay framework-derived.

The credential keeps a legitimate home. `@agentick/runtime` gains
`BoundaryFacetsRef` / `withBoundaryFacets` — an in-fiber channel that
`deriveContext` folds into a derived context as extras and that
`inheritScope` never reads, so it cannot reach an event scope, the bus,
or the journal. The MCP crossing publishes its `mcp` facet there, so
`ctx.mcp.user` (credential included) now reaches every handler seam:
tool handlers, the three per-connection filters, completion handlers,
`PromptDeclaration.render`, and resource resolvers. Verified by a
combined assertion driving all five crossings — the facet is read, and
neither the serialized bus nor the serialized journal contains the
credential.
