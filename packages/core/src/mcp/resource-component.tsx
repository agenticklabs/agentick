/**
 * MCP Resource Component
 *
 * Connects to MCP servers, discovers their resources, and makes them
 * available to the model through progressive disclosure:
 *
 * 1. **Orientation Section** — by default, a path-grouped tree with
 *    counts (e.g. `schema/ — 55 resources`). Bounded in size regardless
 *    of how many resources a server exposes. Override via
 *    `renderResources` (the renderer IS the config — no string presets).
 * 2. **`list_resources` tool** — full details with URIs, mime types,
 *    optional server/pattern filters.
 * 3. **`read_resource` tool** — fetch resource content by URI.
 *
 * Supports multiple servers simultaneously. Resources from all servers
 * are unified under a single pair of tools — the model doesn't need
 * to know which server owns which resource.
 */

import React, { type ReactNode } from "react";
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

/**
 * Renderer for the orientation Section. Receives discovered resources
 * and templates; returns the Section content as ReactNode/string, or
 * `null` to suppress the Section entirely.
 *
 * Built-in renderers exported below: {@link renderResourceTree} (default),
 * {@link renderResourceList} (verbose flat listing — historical behavior).
 */
export type MCPResourceRenderer = (
  resources: MCPResource[],
  templates: MCPResourceTemplate[],
) => ReactNode | string | null;

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

  /**
   * Renderer for the orientation Section. Defaults to
   * {@link renderResourceTree} — a path-based directory listing with
   * counts that stays bounded regardless of resource count.
   *
   * Pass {@link renderResourceList} for the historical verbose flat
   * listing, your own function for something custom, or
   * `() => null` to suppress the Section entirely (tools still register).
   *
   * No string preset — the renderer IS the config.
   */
  renderResources?: MCPResourceRenderer;
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
  const renderResources = props.renderResources ?? renderResourceTree;

  // useData blocks compilation until discovery completes.
  // This ensures the orientation Section and tools are available on the first model call.
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

  const sectionContent = renderResources(discovery.resources, discovery.templates);

  // Return JSX: section for orientation (if renderer returned non-null),
  // plus tools for progressive discovery. Section and Tool components
  // register through the fiber tree, guaranteeing they're available
  // before the model is called.
  return (
    <>
      {sectionContent !== null && sectionContent !== undefined && (
        <Section
          key="mcp-resources-section"
          id={props.sectionId ?? "mcp-resources"}
          audience="model"
        >
          {sectionContent}
        </Section>
      )}
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
// Renderers
// ============================================================================

/**
 * Default renderer. Treats URIs as paths and renders a directory-style
 * tree with counts — bounded in size no matter how many resources a
 * server exposes.
 *
 * Example for 5 guides + 55 schemas + 2 root-level resources under one
 * server with scheme `knowify://`:
 *
 *   knowify://
 *     me                           [text/markdown]
 *     company                      [text/markdown]
 *     guide/   — 5 resources
 *     schema/  — 55 resources  (template: knowify://schema/{model})
 *
 *   Use list_resources to discover URIs; read_resource to fetch content.
 *
 * Grouping rule: split URIs by scheme://host then by first path segment.
 * Resources whose URI has no path segment (host-only, e.g. `knowify://me`)
 * are rendered as leaves at the root of their group. Resources with one
 * or more path segments contribute to a directory entry counted under
 * the first segment.
 *
 * Templates contribute a directory description (their `description` and
 * full `uriTemplate`) at the segment they live under. They do not
 * double-count against resources.
 */
export const renderResourceTree: MCPResourceRenderer = (resources, templates) => {
  if (resources.length === 0 && templates.length === 0) {
    return "No resources available.";
  }

  type Leaf = {
    /** displayed name within the group (URI minus scheme://host/) */
    label: string;
    mimeType?: string;
    description?: string;
  };
  type Dir = {
    /** number of concrete resources under this directory */
    count: number;
    mimeTypes: Set<string>;
    /** descriptions from templates that live at this directory */
    templateInfo: Array<{ uriTemplate: string; description?: string; mimeType?: string }>;
  };
  type Group = { leaves: Leaf[]; dirs: Map<string, Dir> };

  const groups = new Map<string, Group>();
  const ensureGroup = (key: string): Group => {
    let g = groups.get(key);
    if (!g) {
      g = { leaves: [], dirs: new Map() };
      groups.set(key, g);
    }
    return g;
  };
  const ensureDir = (group: Group, name: string): Dir => {
    let d = group.dirs.get(name);
    if (!d) {
      d = { count: 0, mimeTypes: new Set(), templateInfo: [] };
      group.dirs.set(name, d);
    }
    return d;
  };

  for (const r of resources) {
    const parsed = parseURI(r.uri);
    if (!parsed) continue; // skip malformed
    const groupKey = `${parsed.scheme}://`;
    const group = ensureGroup(groupKey);
    if (parsed.segments.length === 0) {
      // Pure-scheme URI (e.g. `knowify://`) — exceptionally rare. Skip.
      continue;
    }
    if (parsed.segments.length === 1) {
      // Single segment: leaf at the root of the group
      // (e.g. `knowify://me` → `me` rendered inline under `knowify://`).
      group.leaves.push({
        label: parsed.segments[0],
        mimeType: r.mimeType,
        description: r.description,
      });
    } else {
      // Multi-segment: count toward the first-segment directory
      // (e.g. `knowify://schema/projects` → +1 to `schema/`).
      const dir = ensureDir(group, parsed.segments[0]);
      dir.count++;
      if (r.mimeType) dir.mimeTypes.add(r.mimeType);
    }
  }

  for (const t of templates) {
    // Templates look like `knowify://schema/{model}`. Normalize variables
    // to a placeholder for parsing — we only care about structure.
    const normalized = t.uriTemplate.replace(/\{[^}]+\}/g, "_");
    const parsed = parseURI(normalized);
    if (!parsed) continue;
    const groupKey = `${parsed.scheme}://`;
    const group = ensureGroup(groupKey);
    if (parsed.segments.length < 2) continue; // template at root has no directory to annotate
    const dirName = parsed.segments[0];
    const dir = ensureDir(group, dirName);
    dir.templateInfo.push({
      uriTemplate: t.uriTemplate,
      description: t.description,
      mimeType: t.mimeType,
    });
  }

  const lines: string[] = [];
  for (const [groupKey, { leaves, dirs }] of groups) {
    // groupKey already ends with "://"
    lines.push(groupKey);
    // Stable ordering: leaves first (alphabetized), then dirs (alphabetized).
    for (const leaf of leaves.sort((a, b) => a.label.localeCompare(b.label))) {
      const mime = leaf.mimeType ? `  [${leaf.mimeType}]` : "";
      lines.push(`  ${leaf.label}${mime}`);
    }
    const sortedDirs = [...dirs.entries()].sort(([a], [b]) => a.localeCompare(b));
    for (const [name, dir] of sortedDirs) {
      const count = `${dir.count} resource${dir.count === 1 ? "" : "s"}`;
      const tmpl = dir.templateInfo[0];
      const tmplPart = tmpl
        ? `  (template: ${tmpl.uriTemplate}${tmpl.description ? ` — ${tmpl.description}` : ""})`
        : "";
      lines.push(`  ${name}/   — ${count}${tmplPart}`);
    }
    lines.push("");
  }

  lines.push(
    "Use list_resources to discover URIs (optionally filter by `server` or `pattern`); read_resource to fetch content.",
  );

  return lines.join("\n");
};

/**
 * Historical flat-list renderer. Use as `renderResources={renderResourceList}`
 * if you want every resource enumerated upfront — appropriate for small
 * resource sets (a handful per server) where the agent benefits from
 * seeing everything inline without an extra tool call.
 *
 * Not the default because resource sets in practice tend to grow
 * (one entry per schema, per guide, per app...) and the flat listing
 * dominates prompt overhead.
 */
export const renderResourceList: MCPResourceRenderer = (resources, templates) => {
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
};

// ============================================================================
// URI Parsing
// ============================================================================

/**
 * Parse a resource URI into scheme + path segments. Returns null if the
 * URI doesn't have the expected `<scheme>://<rest>` shape.
 *
 * MCP URIs aren't URLs in the traditional sense — there's no "host" in
 * the network sense. `knowify://schema/projects` should parse as
 * scheme=knowify, segments=['schema', 'projects'] (not host=schema,
 * path=projects). The tree renderer groups by scheme and uses the first
 * segment as the directory name.
 */
function parseURI(uri: string): { scheme: string; segments: string[] } | null {
  const match = uri.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.*)$/);
  if (!match) return null;
  const [, scheme, rest] = match;
  const segments = rest ? rest.split("/").filter(Boolean) : [];
  return { scheme, segments };
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
