/**
 * # Agentick MCP (Model Context Protocol)
 *
 * Integration with MCP servers for external tool execution.
 * MCP allows agents to use tools provided by external servers.
 *
 * ## Features
 *
 * - **MCPClient** - Connect to MCP servers
 * - **MCPService** - Manage multiple MCP connections
 * - **Tool Discovery** - Auto-discover tools from MCP servers
 * - **Tool Components** - Use MCP tools as JSX components
 *
 * ## Quick Start
 *
 * ```typescript
 * import { discoverMCPTools } from 'agentick/mcp';
 *
 * // Discover tools from an MCP server
 * const tools = await discoverMCPTools({
 *   server: {
 *     command: 'npx',
 *     args: ['-y', '@modelcontextprotocol/server-filesystem'],
 *   },
 * });
 *
 * // Use in an agent
 * const MyAgent = () => (
 *   <>
 *     <System>You can read and write files.</System>
 *     {tools.map(tool => <Tool key={tool.name} tool={tool} />)}
 *   </>
 * );
 * ```
 *
 * @see {@link MCPClient} - MCP server client
 * @see {@link MCPService} - MCP connection manager
 * @see {@link discoverMCPTools} - Tool discovery
 *
 * @module agentick/mcp
 */

export * from "./types.js";
export * from "./client.js";
export * from "./service.js";
export * from "./tool.js";
export { MCPToolComponent, MCPTool } from "./component.js";
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
