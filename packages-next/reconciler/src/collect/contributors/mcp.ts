/**
 * MCP contributor — `<mcp>` intrinsic.
 *
 * Produces an `MCPDeclaration`. MCP server config flows into the
 * declaration; resolution + materialization happens runtime-side.
 */

import type { MCPDeclaration, MCPTransport } from "@agentick/spec-next";
import type { ElementInstance } from "../../host/host-instance.js";
import type { CollectContext, Contributor } from "../contributor.js";
import type { IRFragment } from "../fragments.js";

interface MCPProps {
  readonly id?: string;
  readonly serverName: string;
  readonly transport: MCPTransport;
  readonly config: Record<string, unknown>;
  readonly exposes?: readonly ("tools" | "resources" | "prompts")[];
  readonly metadata?: Record<string, unknown>;
}

export const mcpContributor: Contributor = {
  type: "mcp",
  contribute(instance: ElementInstance, ctx: CollectContext): readonly IRFragment[] {
    const props = instance.props as unknown as MCPProps;
    if (!props.serverName || !props.transport) {
      return [
        {
          kind: "diagnostic",
          diagnostic: {
            severity: "warning",
            message: `<mcp> missing serverName or transport`,
            code: "MISSING_MCP_FIELDS",
          },
        },
      ];
    }
    const mcp: MCPDeclaration = {
      id: props.id ?? ctx.stableId("mcp", instance),
      serverName: props.serverName,
      transport: props.transport,
      config: props.config ?? {},
      ...(props.exposes !== undefined ? { exposes: props.exposes } : {}),
      ...(props.metadata !== undefined ? { metadata: props.metadata } : {}),
    };
    return [{ kind: "mcp-declaration", mcp }];
  },
};
