---
"@agentick/mcp": minor
---

MCP server parity slice (v1 `MCPServer` → `McpServerHarness` migration
enablers): `httpMiddlewareTransport` — a mount door for framework-owned
servers (express/Nest) where a raw request-listener attach is shadowed
by the framework's catch-all 404; the host drives
`handler(req, res, parsedBody?)` from its own middleware and
`metadataHandler` serves RFC-9728 discovery at server root, sharing one
request-handling core with `httpTransport`. Per-connection
`instructions` (`string | (ctx) => string | Promise<string>`) projected
into `InitializeResult.instructions` with the authenticated identity on
ctx. Resource-template argument completion (`completions.resources`,
`ref/resource` routing). `wwwAuthenticateMeta` — opt-in tool-result
`_meta["mcp/www_authenticate"]` RFC 6750 step-up challenge builder,
single-sourced with the transport pre-gate's 401 header.
