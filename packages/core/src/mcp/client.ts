/**
 * MCP Client — Re-export from @agentick/mcp
 *
 * Core uses the MCP package's MCPClient directly. Type conversions
 * (MCPConfig → MCPConnectionConfig, DiscoveredTool → MCPToolDefinition)
 * are handled at the call sites that need them (MCPService, MCPResourceComponent).
 *
 * This file re-exports for backward compatibility so existing core imports
 * (`import { MCPClient } from "./client.js"`) continue to work.
 */

export { MCPClient, uriMatchesTemplate } from "@agentick/mcp/client";
export type { MCPConnectionConfig } from "@agentick/mcp/client";
