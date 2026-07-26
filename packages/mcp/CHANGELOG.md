# @agentick/mcp

## 1.0.0-next.5

### Minor Changes

- MCP server parity slice (v1 `MCPServer` → `McpServerHarness` migration
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

### Patch Changes

- Updated dependencies:
  - @agentick/elicitation@1.0.0-next.5
  - @agentick/prompts@1.0.0-next.5
  - @agentick/pubsub@1.0.0-next.5
  - @agentick/runtime@1.0.0-next.5
  - @agentick/spec@1.0.0-next.5
  - @agentick/tasks@1.0.0-next.5
  - @agentick/tool@1.0.0-next.5
  - @agentick/tool-executor@1.0.0-next.5
  - @agentick/utils@1.0.0-next.5

## 1.0.0-next.4

### Patch Changes

- Updated dependencies:
  - @agentick/elicitation@1.0.0-next.4
  - @agentick/prompts@1.0.0-next.4
  - @agentick/pubsub@1.0.0-next.4
  - @agentick/runtime@1.0.0-next.4
  - @agentick/spec@1.0.0-next.4
  - @agentick/tasks@1.0.0-next.4
  - @agentick/tool@1.0.0-next.4
  - @agentick/tool-executor@1.0.0-next.4
  - @agentick/utils@1.0.0-next.4

## 1.0.0-next.3

### Patch Changes

- Updated dependencies:
  - @agentick/elicitation@1.0.0-next.3
  - @agentick/prompts@1.0.0-next.3
  - @agentick/pubsub@1.0.0-next.3
  - @agentick/runtime@1.0.0-next.3
  - @agentick/spec@1.0.0-next.3
  - @agentick/tasks@1.0.0-next.3
  - @agentick/tool@1.0.0-next.3
  - @agentick/tool-executor@1.0.0-next.3
  - @agentick/utils@1.0.0-next.3

## 1.0.0-next.2

### Patch Changes

- Updated dependencies:
  - @agentick/elicitation@1.0.0-next.2
  - @agentick/prompts@1.0.0-next.2
  - @agentick/pubsub@1.0.0-next.2
  - @agentick/runtime@1.0.0-next.2
  - @agentick/spec@1.0.0-next.2
  - @agentick/tasks@1.0.0-next.2
  - @agentick/tool@1.0.0-next.2
  - @agentick/tool-executor@1.0.0-next.2
  - @agentick/utils@1.0.0-next.2
