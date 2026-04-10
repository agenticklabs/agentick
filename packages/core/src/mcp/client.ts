/**
 * MCP Client — Thin adapter over @agentick/mcp
 *
 * Re-exports MCPClient from @agentick/mcp/client with backward-compatible
 * type mappings. Core components use this adapter without changes.
 *
 * Migration: the full implementation moved to @agentick/mcp/client.
 * This file maintains the existing API surface for core consumers.
 */

import {
  MCPClient as BaseMCPClient,
  uriMatchesTemplate as baseUriMatchesTemplate,
  type MCPConnectionConfig,
  type DiscoveredTool,
  type DiscoveredResource,
  type DiscoveredResourceTemplate,
  type ResourceContent,
} from "@agentick/mcp/client";
import type {
  MCPConfig,
  MCPToolDefinition,
  MCPResource,
  MCPResourceTemplate,
  MCPResourceContent,
} from "./types.js";

/**
 * MCPClient adapter — wraps @agentick/mcp/client's MCPClient
 * with core's existing type signatures for backward compatibility.
 */
export class MCPClient {
  private inner = new BaseMCPClient();

  async connect(config: MCPConfig): Promise<void> {
    await this.inner.connect(toConnectionConfig(config));
  }

  async disconnect(serverName: string): Promise<void> {
    await this.inner.disconnect(serverName);
  }

  async disconnectAll(): Promise<void> {
    await this.inner.disconnectAll();
  }

  async listTools(serverName: string): Promise<MCPToolDefinition[]> {
    const tools = await this.inner.listTools(serverName);
    return tools.map(toCoreTool);
  }

  async callTool(serverName: string, toolName: string, input: any): Promise<any> {
    return this.inner.callTool(serverName, toolName, input);
  }

  async listResources(serverName: string): Promise<MCPResource[]> {
    const resources = await this.inner.listResources(serverName);
    return resources.map(toCoreResource);
  }

  async listResourceTemplates(serverName: string): Promise<MCPResourceTemplate[]> {
    const templates = await this.inner.listResourceTemplates(serverName);
    return templates.map(toCoreTemplate);
  }

  async readResource(serverName: string, uri: string): Promise<MCPResourceContent[]> {
    const contents = await this.inner.readResource(serverName, uri);
    return contents.map(toCoreContent);
  }

  async readResourceByURI(uri: string): Promise<MCPResourceContent[]> {
    const contents = await this.inner.readResourceByURI(uri);
    return contents.map(toCoreContent);
  }

  async listAllResources(): Promise<MCPResource[]> {
    const resources = await this.inner.listAllResources();
    return resources.map(toCoreResource);
  }

  async listAllResourceTemplates(): Promise<MCPResourceTemplate[]> {
    const templates = await this.inner.listAllResourceTemplates();
    return templates.map(toCoreTemplate);
  }

  invalidateResources(serverName?: string): void {
    this.inner.invalidateResources(serverName);
  }
}

// ============================================================================
// Type Mappers
// ============================================================================

function toConnectionConfig(config: MCPConfig): MCPConnectionConfig {
  return {
    serverName: config.serverName,
    transport: config.transport === "websocket" ? "streamable-http" : config.transport,
    connection: config.connection,
    auth: config.auth,
  };
}

function toCoreTool(tool: DiscoveredTool): MCPToolDefinition {
  return {
    name: tool.name,
    description: tool.description ?? "",
    inputSchema: tool.inputSchema as MCPToolDefinition["inputSchema"],
  };
}

function toCoreResource(resource: DiscoveredResource): MCPResource {
  return {
    uri: resource.uri,
    name: resource.name,
    description: resource.description,
    mimeType: resource.mimeType,
    serverName: resource.serverName,
  };
}

function toCoreTemplate(template: DiscoveredResourceTemplate): MCPResourceTemplate {
  return {
    uriTemplate: template.uriTemplate,
    name: template.name,
    description: template.description,
    mimeType: template.mimeType,
    serverName: template.serverName,
  };
}

function toCoreContent(content: ResourceContent): MCPResourceContent {
  return {
    uri: content.uri,
    text: content.text,
    blob: content.blob,
    mimeType: content.mimeType,
  };
}

// ============================================================================
// Re-exports
// ============================================================================

export { baseUriMatchesTemplate as uriMatchesTemplate };
