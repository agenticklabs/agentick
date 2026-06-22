/**
 * `@agentick/mcp-next/react` — React-side helpers for surfacing
 * MCP-provided tools to the rendered tree.
 *
 * `withMCP({ servers })` (app-level) does the discovery + handler
 * registration; this subpath provides the JSX glue to make the
 * discovered tools visible to the model.
 */

export { MCPTools, type MCPToolsProps } from "./mcp-tools.js";
