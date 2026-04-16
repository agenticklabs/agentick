/**
 * # Agentick MCP (Model Context Protocol)
 *
 * Connect to MCP servers for external tools and resources.
 *
 * ## Usage
 *
 * ```tsx
 * import { MCP } from "agentick";
 *
 * function MyAgent() {
 *   return (
 *     <>
 *       <MCP servers={{
 *         postgres: { command: "npx", args: ["-y", "@modelcontextprotocol/server-postgres", connStr] },
 *         filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/data"] },
 *       }} />
 *       <System>You can query databases and read files.</System>
 *       <Timeline />
 *     </>
 *   );
 * }
 * ```
 *
 * Tools from each server are registered individually.
 * Resources are unified under `list_resources` and `read_resource` tools
 * for progressive discovery across all servers.
 *
 * @module agentick/mcp
 */

// ── Public API ────────────────────────────────────────────────────────
export { MCP, MCPComponent } from "./mcp-component.js";
export type { MCPComponentProps } from "./mcp-component.js";

// ── Types ─────────────────────────────────────────────────────────────
export type {
  MCPConfig,
  MCPServerConfig,
  MCPTransport,
  MCPToolDefinition,
  MCPResource,
  MCPResourceTemplate,
  MCPResourceContent,
} from "./types.js";

// ── Client (for advanced usage / sharing) ─────────────────────────────
export { MCPClient, uriMatchesTemplate } from "./client.js";
export { MCPService } from "./service.js";

// ── Low-level components (implementation details, rarely needed) ──────
export { MCPToolComponent, MCPTool } from "./component.js";
export { MCPResourceComponent, MCPResources } from "./resource-component.js";
export type { MCPResourceComponentProps, MCPServerEntry } from "./resource-component.js";
export { MCPAppHost } from "./app-host.js";
export type { MCPAppHostProps } from "./app-host.js";

// ── Tool utilities ────────────────────────────────────────────────────
export { MCPTool as MCPToolClass, mcpSchemaToZod, normalizeResult } from "./tool.js";
export type { MCPToolConfig } from "./tool.js";
export {
  createMCPTool,
  createMCPToolFromDefinition,
  discoverMCPTools,
  normalizeMCPConfig,
  mergeMCPConfig,
} from "./create-mcp-tool.js";
export type {
  CreateMCPToolOptions,
  CreateMCPToolFromDefinitionOptions,
  DiscoverMCPToolsOptions,
} from "./create-mcp-tool.js";
