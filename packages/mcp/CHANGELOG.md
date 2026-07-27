# @agentick/mcp

## 1.0.0-next.15

### Patch Changes

- Updated dependencies:
  - @agentick/elicitation@1.0.0-next.15
  - @agentick/prompts@1.0.0-next.15
  - @agentick/pubsub@1.0.0-next.15
  - @agentick/runtime@1.0.0-next.15
  - @agentick/spec@1.0.0-next.15
  - @agentick/tasks@1.0.0-next.15
  - @agentick/tool@1.0.0-next.15
  - @agentick/tool-executor@1.0.0-next.15
  - @agentick/utils@1.0.0-next.15

## 1.0.0-next.14

### Patch Changes

- Updated dependencies:
  - @agentick/elicitation@1.0.0-next.14
  - @agentick/prompts@1.0.0-next.14
  - @agentick/pubsub@1.0.0-next.14
  - @agentick/runtime@1.0.0-next.14
  - @agentick/spec@1.0.0-next.14
  - @agentick/tasks@1.0.0-next.14
  - @agentick/tool@1.0.0-next.14
  - @agentick/tool-executor@1.0.0-next.14
  - @agentick/utils@1.0.0-next.14

## 1.0.0-next.13

### Patch Changes

- Updated dependencies:
  - @agentick/elicitation@1.0.0-next.13
  - @agentick/prompts@1.0.0-next.13
  - @agentick/pubsub@1.0.0-next.13
  - @agentick/runtime@1.0.0-next.13
  - @agentick/spec@1.0.0-next.13
  - @agentick/tasks@1.0.0-next.13
  - @agentick/tool@1.0.0-next.13
  - @agentick/tool-executor@1.0.0-next.13
  - @agentick/utils@1.0.0-next.13

## 1.0.0-next.12

### Patch Changes

- Updated dependencies:
  - @agentick/elicitation@1.0.0-next.12
  - @agentick/prompts@1.0.0-next.12
  - @agentick/pubsub@1.0.0-next.12
  - @agentick/runtime@1.0.0-next.12
  - @agentick/spec@1.0.0-next.12
  - @agentick/tasks@1.0.0-next.12
  - @agentick/tool@1.0.0-next.12
  - @agentick/tool-executor@1.0.0-next.12
  - @agentick/utils@1.0.0-next.12

## 1.0.0-next.11

### Minor Changes

- MCP server capability-extensions seam: `McpServerOptions.extensions`
  (typed off the SDK's `ServerCapabilities["extensions"]`) advertises
  spec extensions in the `initialize` result — e.g. the MCP Apps
  negotiation `{"io.modelcontextprotocol/ui": { mimeTypes:
  ["text/html;profile=mcp-app"] }}`. A separate slot from `capabilities`
  deliberately: wired capabilities are harness-verified ("no lying on
  the wire"), extension claims are adopter-owned. Absent/empty →
  advertised capabilities byte-identical to before; the bag is copied at
  construction; client-side passthrough pinned by test.

### Patch Changes

- Updated dependencies:
  - @agentick/elicitation@1.0.0-next.11
  - @agentick/prompts@1.0.0-next.11
  - @agentick/pubsub@1.0.0-next.11
  - @agentick/runtime@1.0.0-next.11
  - @agentick/spec@1.0.0-next.11
  - @agentick/tasks@1.0.0-next.11
  - @agentick/tool@1.0.0-next.11
  - @agentick/tool-executor@1.0.0-next.11
  - @agentick/utils@1.0.0-next.11

## 1.0.0-next.10

### Patch Changes

- Updated dependencies:
  - @agentick/elicitation@1.0.0-next.10
  - @agentick/prompts@1.0.0-next.10
  - @agentick/pubsub@1.0.0-next.10
  - @agentick/runtime@1.0.0-next.10
  - @agentick/spec@1.0.0-next.10
  - @agentick/tasks@1.0.0-next.10
  - @agentick/tool@1.0.0-next.10
  - @agentick/tool-executor@1.0.0-next.10
  - @agentick/utils@1.0.0-next.10

## 1.0.0-next.9

### Minor Changes

- ADR 92 Slice A — the ingress family joins the operation grammar. Every
  MCP server request crossing runs as a named, journaled, guardable op
  (`mcp:command:<verb>`) with the connection dimension + authenticated
  identity on its scope; work inside a crossing journals as a child
  (parentOpId + connection dim, two levels deep); the security pipeline
  rides the op guard seam (stages unchanged on the wire — byte-identical
  frames); per-op-class journal policy (call-tool/initialize persisted,
  reads bus-only). Subscription dispatch runs as
  `subscriptions:command:dispatch` (guard-vetoable scheduled fires).
  Admission failures emit a discrete event (connection shape + failure
  class, never credentials). Runtime spine rule: child op scopes inherit
  the ambient crossing's work-path + identity dimensions.

### Patch Changes

- Updated dependencies:
  - @agentick/elicitation@1.0.0-next.9
  - @agentick/prompts@1.0.0-next.9
  - @agentick/pubsub@1.0.0-next.9
  - @agentick/runtime@1.0.0-next.9
  - @agentick/spec@1.0.0-next.9
  - @agentick/tasks@1.0.0-next.9
  - @agentick/tool@1.0.0-next.9
  - @agentick/tool-executor@1.0.0-next.9
  - @agentick/utils@1.0.0-next.9

## 1.0.0-next.8

### Patch Changes

- Updated dependencies:
  - @agentick/elicitation@1.0.0-next.8
  - @agentick/prompts@1.0.0-next.8
  - @agentick/pubsub@1.0.0-next.8
  - @agentick/runtime@1.0.0-next.8
  - @agentick/spec@1.0.0-next.8
  - @agentick/tasks@1.0.0-next.8
  - @agentick/tool@1.0.0-next.8
  - @agentick/tool-executor@1.0.0-next.8
  - @agentick/utils@1.0.0-next.8

## 1.0.0-next.7

### Patch Changes

- Updated dependencies:
  - @agentick/elicitation@1.0.0-next.7
  - @agentick/prompts@1.0.0-next.7
  - @agentick/pubsub@1.0.0-next.7
  - @agentick/runtime@1.0.0-next.7
  - @agentick/spec@1.0.0-next.7
  - @agentick/tasks@1.0.0-next.7
  - @agentick/tool@1.0.0-next.7
  - @agentick/tool-executor@1.0.0-next.7
  - @agentick/utils@1.0.0-next.7

## 1.0.0-next.6

### Minor Changes

- MCP tool wire extensions via a namespaced `metadata.mcp` block, projected
  at the wire (no spec changes): result-side `_meta` (envelope
  `metadata.mcp.meta` → wire `CallToolResult._meta` — makes
  `wwwAuthenticateMeta` step-up challenges actually reach clients),
  declaration-side `_meta` (→ wire `Tool._meta`, the MCP Apps `ui://`
  template-linkage carrier), and advisory annotation hints
  (readOnly/destructive/idempotent/openWorld → wire `Tool.annotations`).
  Typed helpers `mcpToolExtensions` / `mcpResultExtensions` exported from
  `@agentick/mcp/server`. Wire output is byte-identical when no extensions
  are carried.

### Patch Changes

- Updated dependencies:
  - @agentick/elicitation@1.0.0-next.6
  - @agentick/prompts@1.0.0-next.6
  - @agentick/pubsub@1.0.0-next.6
  - @agentick/runtime@1.0.0-next.6
  - @agentick/spec@1.0.0-next.6
  - @agentick/tasks@1.0.0-next.6
  - @agentick/tool@1.0.0-next.6
  - @agentick/tool-executor@1.0.0-next.6
  - @agentick/utils@1.0.0-next.6

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
