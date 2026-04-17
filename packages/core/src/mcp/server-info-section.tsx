/**
 * MCP Server Info Section
 *
 * Renders a compact <Section> with connected MCP server metadata for the
 * model's context. The goal is orientation, not exhaustive listing — tool
 * descriptions are already in function declarations, and resource URIs are
 * discoverable via list_resources / platform_knowledge.
 *
 * Rendered per-server:
 * - Server name + version
 * - Instructions (the server's own guidance for the LLM)
 * - Brief summary of connected resources/tools (counts + names)
 *
 * Uses useData to fetch metadata after connection — blocks the agent loop
 * until server info is available.
 */

import React from "react";
import { useData } from "../hooks/index.js";
import { MCPClient } from "./client.js";
import { Section } from "../jsx/components/primitives.js";
import type { MCPConfig, MCPServerConfig } from "./types.js";
import type { JSX } from "../jsx/jsx-runtime.js";

function normalizeName(name: string, config: MCPServerConfig | MCPConfig): string {
  if ("serverName" in config && config.serverName) return config.serverName;
  return name;
}

export interface MCPServerInfoSectionProps {
  servers: Record<string, MCPServerConfig | MCPConfig>;
  mcpClient: MCPClient;
  sectionId?: string;
}

interface ServerMetadata {
  name: string;
  serverName: string;
  version: string;
  description?: string;
  instructions?: string;
  supportsApps: boolean;
  toolNames: string[];
  resourceCount: number;
  templateCount: number;
  guideUris: string[];
  appUris: string[];
}

export function MCPServerInfoSection(props: MCPServerInfoSectionProps): JSX.Element | null {
  const { servers, mcpClient, sectionId } = props;
  const serverKeys = Object.keys(servers);

  const metadata = useData<ServerMetadata[]>(
    "mcp-server-metadata",
    async () => {
      const results: ServerMetadata[] = [];

      for (const key of serverKeys) {
        const config = servers[key];
        const serverName = normalizeName(key, config);

        try {
          const info = mcpClient.getServerInfo(serverName);
          if (!info) continue;

          const [tools, resources, templates] = await Promise.all([
            mcpClient.listTools(serverName).catch(() => []),
            mcpClient.listResources(serverName).catch(() => []),
            mcpClient.listResourceTemplates(serverName).catch(() => []),
          ]);

          results.push({
            name: info.name,
            serverName,
            version: info.version,
            description: info.description,
            instructions: mcpClient.getInstructions(serverName),
            supportsApps: mcpClient.supportsMcpApps(serverName),
            toolNames: tools.map((t) => t.name),
            resourceCount: resources.length,
            templateCount: templates.length,
            guideUris: resources
              .filter((r) => !r.uri.startsWith("ui://") && !r.uri.includes("/schema/"))
              .map((r) => r.uri),
            appUris: resources.filter((r) => r.uri.startsWith("ui://")).map((r) => r.uri),
          });
        } catch {
          // Server not connected — skip
        }
      }

      return results;
    },
    serverKeys,
  );

  if (!metadata || metadata.length === 0) return null;

  return (
    <Section key="mcp-server-info" id={sectionId ?? "mcp-servers"} audience="model">
      {metadata.map((server) => (
        <ServerInfo key={server.serverName} server={server} />
      ))}
    </Section>
  ) as unknown as JSX.Element;
}

function ServerInfo({ server }: { server: ServerMetadata }) {
  const schemaCount = server.resourceCount - server.guideUris.length - server.appUris.length;

  return (
    <>
      <h2>
        {server.name} <small>(v{server.version})</small>
      </h2>
      {server.description && <p>{server.description}</p>}

      {server.instructions && <>{server.instructions}</>}

      <h3>Connected</h3>
      <ul>
        <li>
          <strong>Tools:</strong> {server.toolNames.join(", ")}
        </li>
        <li>
          <strong>Resources:</strong>{" "}
          {server.guideUris.length > 0 && `${server.guideUris.length} guides`}
          {schemaCount > 0 && `${server.guideUris.length > 0 ? ", " : ""}${schemaCount} schemas`}
          {server.appUris.length > 0 && `, ${server.appUris.length} apps`}
          {server.templateCount > 0 && ` (${server.templateCount} templates)`}
          {" — use list_resources or platform_knowledge for details"}
        </li>
      </ul>
    </>
  ) as any;
}
