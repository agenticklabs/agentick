/**
 * MCP Tool
 *
 * Wraps an MCP server tool as an ExecutableTool.
 * The tool forwards execution to the MCP server via MCPClient.
 */

import {
  type ToolMetadata,
  type ExecutableTool,
  type ToolHandler,
  ToolExecutionType,
} from "../tool/tool";
import type { ContentBlock } from "@tentickle/shared";
import type { MCPClient } from "./client";
import type { MCPToolDefinition } from "./types";
import { z } from "zod";
import type { Procedure } from "@tentickle/kernel";
import { createEngineProcedure } from "../procedure";

// ============================================================================
// Schema Conversion
// ============================================================================

/**
 * Converts MCP JSON Schema to Zod schema.
 * Basic conversion - supports common types.
 */
export function mcpSchemaToZod(schema: MCPToolDefinition["inputSchema"]): z.ZodSchema {
  const properties = schema.properties || {};
  const required = schema.required || [];
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [key, prop] of Object.entries(properties)) {
    let zType: z.ZodTypeAny;

    switch (prop.type) {
      case "string":
        zType = z.string();
        break;
      case "number":
      case "integer":
        zType = z.number();
        break;
      case "boolean":
        zType = z.boolean();
        break;
      case "array":
        zType = z.array(z.any());
        break;
      case "object":
        zType = z.record(z.string(), z.any());
        break;
      default:
        zType = z.any();
    }

    if (prop.description) {
      zType = zType.describe(prop.description);
    }

    if (!required.includes(key)) {
      zType = zType.optional();
    }

    shape[key] = zType;
  }

  return z.object(shape);
}

/**
 * Normalize MCP tool result to ContentBlock[].
 */
export function normalizeResult(result: any): ContentBlock[] {
  if (typeof result === "string") {
    return [{ type: "text", text: result }];
  }

  if (result && typeof result === "object") {
    if (Array.isArray(result.content)) {
      return result.content as ContentBlock[];
    }
    return [{ type: "text", text: JSON.stringify(result, null, 2) }];
  }

  return [{ type: "text", text: String(result) }];
}

// ============================================================================
// MCPTool
// ============================================================================

/**
 * MCP tool configuration stored in metadata.mcpConfig.
 */
export interface MCPToolConfig {
  serverUrl?: string;
  serverName?: string;
  transport?: "stdio" | "sse" | "websocket";
  [key: string]: any;
}

/**
 * MCPTool wraps an MCP server tool as an ExecutableTool.
 *
 * This class is used internally by MCP creation functions.
 * For most use cases, prefer `createMCPTool()` or `discoverMCPTools()`.
 *
 * @example Direct usage (advanced)
 * ```typescript
 * const tool = new MCPTool(mcpClient, 'server-name', toolDefinition, mcpConfig);
 *
 * // Register with COM
 * ctx.addTool(tool);
 *
 * // Or execute directly
 * const result = await tool.run({ path: '/file.txt' });
 * ```
 */
export class MCPTool<
  THandler extends ToolHandler = ToolHandler,
> implements ExecutableTool<THandler> {
  public readonly metadata: ToolMetadata<Parameters<THandler>[0]>;
  public readonly run: Procedure<THandler>;

  constructor(
    private mcpClient: MCPClient,
    private serverName: string,
    mcpToolDefinition: MCPToolDefinition,
    mcpConfig?: MCPToolConfig,
  ) {
    // Convert MCP schema to Zod
    const zodSchema = mcpSchemaToZod(mcpToolDefinition.inputSchema);

    // Build metadata
    this.metadata = {
      name: mcpToolDefinition.name,
      description: mcpToolDefinition.description,
      input: zodSchema,
      type: ToolExecutionType.MCP,
      mcpConfig: mcpConfig,
    };

    // Create procedure that forwards to MCP server
    this.run = createEngineProcedure<THandler>(
      {
        name: "tool:run", // Low cardinality span name (same as regular tools)
        metadata: {
          type: "mcp",
          toolName: mcpToolDefinition.name,
          id: mcpToolDefinition.name,
          operation: "run",
          server: this.serverName,
        },
      },
      (async (input: any) => {
        const result = await this.mcpClient.callTool(
          this.serverName,
          mcpToolDefinition.name,
          input,
        );
        return normalizeResult(result);
      }) as THandler,
    );
  }
}
