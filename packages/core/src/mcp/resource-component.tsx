/**
 * MCP Resource Component
 *
 * Connects to MCP servers, discovers their resources, and makes them
 * available to the model through progressive disclosure:
 *
 * 1. **Context (always visible)** — terrain map of resource names and descriptions
 * 2. **`list_resources` tool** — full details with URIs, mime types, optional filtering
 * 3. **`read_resource` tool** — fetch resource content by URI
 *
 * Supports multiple servers simultaneously. Resources from all servers
 * are unified under a single pair of tools — the model doesn't need
 * to know which server owns which resource.
 */

import React from "react";
import { z } from "zod";
import type { ContentBlock } from "@agentick/shared";
import { MCPClient } from "./client.js";
import type { MCPConfig, MCPServerConfig, MCPResource, MCPResourceTemplate } from "./types.js";
import { normalizeMCPConfig, mergeMCPConfig } from "./create-mcp-tool.js";
import { useData, useOnUnmount } from "../hooks/index.js";
import { Section, Tool } from "../jsx/components/primitives.js";
import type { JSX } from "../jsx/jsx-runtime.js";
import type { ComponentBaseProps } from "../jsx/jsx-types.js";
import type { EngineComponent } from "../component/component.js";

// ============================================================================
// Types
// ============================================================================

export interface MCPServerEntry {
  config: MCPServerConfig | MCPConfig;
  runtimeConfig?: Partial<MCPConfig>;
}

export interface MCPResourceComponentProps extends ComponentBaseProps, Partial<EngineComponent> {
  /**
   * MCP servers to discover resources from.
   *
   * Map of server name → config. Supports Cursor-style or full MCPConfig.
   *
   * ```tsx
   * <MCPResources servers={{
   *   postgres: { command: "npx", args: ["-y", "@modelcontextprotocol/server-postgres", connStr] },
   *   filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/data"] },
   * }} />
   * ```
   */
  servers: Record<string, MCPServerConfig | MCPConfig | MCPServerEntry>;

  /**
   * Shared MCPClient instance (for sharing connections with MCPToolComponent).
   * If not provided, creates a new one.
   */
  mcpClient?: MCPClient;

  /**
   * ID for the context section. Defaults to "mcp-resources".
   */
  sectionId?: string;

  /**
   * Custom tool names. Defaults to "list_resources" and "read_resource".
   */
  listToolName?: string;
  readToolName?: string;
}

// ============================================================================
// Discovery Result
// ============================================================================

interface DiscoveryResult {
  mcpClient: MCPClient;
  resources: MCPResource[];
  templates: MCPResourceTemplate[];
}

// ============================================================================
// Component
// ============================================================================

export function MCPResourceComponent(props: MCPResourceComponentProps): JSX.Element | null {
  const listToolName = props.listToolName ?? "list_resources";
  const readToolName = props.readToolName ?? "read_resource";

  // useData blocks compilation until discovery completes.
  // This ensures the terrain map and tools are available on the first model call.
  const discovery = useData<DiscoveryResult>(
    `mcp-resources:${Object.keys(props.servers).sort().join(",")}`,
    async () => {
      const mcpClient = props.mcpClient ?? new MCPClient();

      // Connect to all servers
      const entries = Object.entries(props.servers);
      await Promise.all(
        entries.map(async ([name, rawConfig]) => {
          const { config, runtimeConfig } = normalizeServerEntry(name, rawConfig);
          const effective = mergeMCPConfig(config, runtimeConfig);
          await mcpClient.connect({
            ...effective,
            transport:
              effective.transport === "websocket" ? "streamable-http" : effective.transport,
          });
        }),
      );

      // Discover resources and templates from all servers in parallel
      const [resources, templates] = await Promise.all([
        mcpClient.listAllResources(),
        mcpClient.listAllResourceTemplates(),
      ]);

      return { mcpClient, resources, templates };
    },
    [JSON.stringify(Object.keys(props.servers).sort())],
  );

  // Cleanup on unmount — disconnect if we created the client
  useOnUnmount(() => {
    if (!props.mcpClient) {
      discovery.mcpClient.disconnectAll();
    }
  });

  const terrainMap = formatTerrainMap(discovery.resources, discovery.templates);

  // Return JSX: section for terrain map, tools for progressive discovery.
  // Section and Tool components register through the fiber tree,
  // guaranteeing they're available before the model is called.
  return (
    <>
      <Section key="mcp-resources-section" id={props.sectionId ?? "mcp-resources"} audience="model">
        {terrainMap}
      </Section>
      <Tool
        key="mcp-list-resources"
        name={listToolName}
        description={
          "List available MCP resources with full URIs, mime types, and descriptions. " +
          "Optionally filter by server name or name pattern."
        }
        input={z.object({
          server: z.string().optional().describe("Filter by server name"),
          pattern: z.string().optional().describe("Filter resource names by substring match"),
        })}
        handler={createListHandler(discovery.mcpClient)}
      />
      <Tool
        key="mcp-read-resource"
        name={readToolName}
        description={
          "Read the content of an MCP resource by URI. " +
          "Use list_resources first to discover available URIs."
        }
        input={z.object({
          uri: z.string().describe("Resource URI to read"),
        })}
        handler={createReadHandler(discovery.mcpClient)}
      />
    </>
  ) as unknown as JSX.Element;
}

/**
 * JSX-friendly factory.
 */
export function MCPResources(props: MCPResourceComponentProps): JSX.Element {
  return React.createElement(MCPResourceComponent, props) as unknown as JSX.Element;
}

// ============================================================================
// Terrain Map
// ============================================================================

function formatTerrainMap(resources: MCPResource[], templates: MCPResourceTemplate[]): string {
  const lines: string[] = [];

  if (resources.length > 0) {
    lines.push("Resources:");
    for (const r of resources) {
      const desc = r.description ? ` — ${r.description}` : "";
      const mime = r.mimeType ? ` [${r.mimeType}]` : "";
      lines.push(`  ${r.name}${mime}${desc}`);
    }
  }

  if (templates.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Resource Templates:");
    for (const t of templates) {
      const desc = t.description ? ` — ${t.description}` : "";
      const mime = t.mimeType ? ` [${t.mimeType}]` : "";
      lines.push(`  ${t.name} (${t.uriTemplate})${mime}${desc}`);
    }
  }

  if (lines.length === 0) {
    return "No resources available.";
  }

  lines.push("");
  lines.push("Use list_resources for URIs and details. Use read_resource to fetch content.");

  return lines.join("\n");
}

// ============================================================================
// Tool Handlers
// ============================================================================

function createListHandler(client: MCPClient) {
  return async (input: { server?: string; pattern?: string }): Promise<ContentBlock[]> => {
    const [allResources, allTemplates] = await Promise.all([
      client.listAllResources(),
      client.listAllResourceTemplates(),
    ]);

    let resources = allResources;
    let templates = allTemplates;

    if (input.server) {
      resources = resources.filter((r) => r.serverName === input.server);
      templates = templates.filter((t) => t.serverName === input.server);
    }

    if (input.pattern) {
      const p = input.pattern.toLowerCase();
      resources = resources.filter(
        (r) =>
          r.name.toLowerCase().includes(p) ||
          r.uri.toLowerCase().includes(p) ||
          r.description?.toLowerCase().includes(p),
      );
      templates = templates.filter(
        (t) =>
          t.name.toLowerCase().includes(p) ||
          t.uriTemplate.toLowerCase().includes(p) ||
          t.description?.toLowerCase().includes(p),
      );
    }

    const result: any[] = [];

    for (const r of resources) {
      result.push({
        type: "resource",
        uri: r.uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType,
        server: r.serverName,
      });
    }

    for (const t of templates) {
      result.push({
        type: "template",
        uriTemplate: t.uriTemplate,
        name: t.name,
        description: t.description,
        mimeType: t.mimeType,
        server: t.serverName,
      });
    }

    if (result.length === 0) {
      return [{ type: "text", text: "No resources found." }];
    }

    return [{ type: "text", text: JSON.stringify(result, null, 2) }];
  };
}

function createReadHandler(client: MCPClient) {
  return async (input: { uri: string }): Promise<ContentBlock[]> => {
    const contents = await client.readResourceByURI(input.uri);

    const blocks: ContentBlock[] = [];
    for (const content of contents) {
      if (content.text != null) {
        blocks.push({ type: "text", text: content.text });
      } else if (content.blob != null) {
        blocks.push({
          type: "text",
          text: `[Binary content: ${content.mimeType || "application/octet-stream"}, ${content.blob.length} bytes base64]`,
        });
      }
    }

    if (blocks.length === 0) {
      blocks.push({ type: "text", text: "(empty resource)" });
    }

    return blocks;
  };
}

// ============================================================================
// Config Normalization
// ============================================================================

function normalizeServerEntry(
  name: string,
  raw: MCPServerConfig | MCPConfig | MCPServerEntry,
): { config: MCPConfig; runtimeConfig?: Partial<MCPConfig> } {
  if (
    "config" in raw &&
    typeof (raw as MCPServerEntry).config === "object" &&
    !("transport" in raw)
  ) {
    const entry = raw as MCPServerEntry;
    return {
      config: normalizeMCPConfig(name, entry.config),
      runtimeConfig: entry.runtimeConfig,
    };
  }

  return { config: normalizeMCPConfig(name, raw as MCPServerConfig | MCPConfig) };
}
