# agentick-website

## 1.1.0

### @agentick/mcp

- **Custom InMemoryTransport** — replaces SDK re-export with own implementation using `queueMicrotask` for deferred delivery. Fixes "unknown message ID" race condition when server connects before client registers response handlers. (`packages/mcp/src/transport/in-memory.ts`)
- **Server capability negotiation** — `MCPServer` advertises `extensions["io.modelcontextprotocol/ui"]` when apps are registered. New `description` field on `MCPServerOptions` passed to SDK Server's `serverInfo`. Constants: `MCP_APP_MIME_TYPE`, `MCP_APPS_EXTENSION_ID`.
- **MCPClient metadata methods** — `getServerInfo(serverName)` returns `{ name, version, description }` from the initialize handshake. `getInstructions(serverName)` returns the server's instructions string. Client advertises `io.modelcontextprotocol/ui` capability by default (opt out via `mcpApps: false`).
- **MCPTransport type** — added `"in-process"` to the union type and `MCPToolConfig.transport`.

### @agentick/gateway

- **MCP plugin config** — `name`, `version`, and `description` fields added (deprecates `serverName`/`serverVersion`). `MCPStandaloneTool` interface now includes `ui` and `_meta` fields for MCP Apps linkage passthrough to `MCPServer`.

### @agentick/core

- **Tool schema normalization** — `normalizeModelInput` and `resolveTools` are now async. `enrichMetadata` converts Zod schemas to JSON Schema via kernel's `toJSONSchema`; plain JSON Schema objects detected via `detectSchemaType` and passed through. All adapters receive `metadata.inputSchema` (JSON Schema) alongside `metadata.input` (Zod).
- **Compiler collector fix** — `collectTool` reads `node.props.input ?? node.props.schema` (was only `schema`). Fixes `<Tool input={z.object(...)}>` where the schema was silently dropped.
- **MCPServerInfoSection** — new `<MCPServerInfoSection>` component renders connected MCP server metadata (name/version/description, instructions, tools/resources summary) into the model's context. Automatically included by the `<MCP>` component. Uses `useData` for async metadata fetch.

### @agentick/google

- **mapToolDefinition** — reads `metadata.inputSchema ?? metadata.input` for JSON Schema fallback. `ensureObjectSchema` wraps empty `{}` parameters with `{ type: "object" }` for Gemini compliance. `prepareInput` is now async.

### @agentick/openai, @agentick/apple

- `prepareInput` is now async (signature change to support async `normalizeModelInput`).

## 1.0.1

### Patch Changes

- 152ac52: add logging middleware
