---
"@agentick/mcp": minor
"@agentick/gateway": minor
---

Propagate tool `outputSchema` end-to-end when serving MCP. Tools defined with `createTool({ output })` now expose their output schema on `tools/list`, and `MCPServer` emits `outputSchema` for any `MCPToolDefinition` that declares one. The gateway's `tool-catalog` method gained an optional `output` field on each entry, and the `mcpServerPlugin` forwards it (along with a new `outputSchema` field on `MCPStandaloneTool`) into the registered `MCPToolDefinition`. JSON Schema conversion is shared via a new internal `toToolJSONSchema` helper, so input and output schemas go through the same Zod→draft-07 path.
