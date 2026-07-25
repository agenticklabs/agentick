/**
 * MCP contributor — `<mcp>` intrinsic.
 *
 * Produces an `MCPDeclaration`. MCP server config flows into the
 * declaration; resolution + materialization happens runtime-side.
 *
 * Props derive from {@link MCPDeclaration}; fields forward by spread,
 * guarded by the {@link _conformance} assertion.
 */

import type { MCPDeclaration } from "@agentick/spec";
import type { ElementInstance } from "../../host/host-instance.js";
import type { CollectContext, Contributor } from "../contributor.js";
import type { IRFragment } from "../fragments.js";
import { omitUndefined } from "@agentick/utils";
import type { Exhausted, UnhandledSpecKeys } from "./spec-conformance.js";

/**
 * `<mcp>` props, derived from {@link MCPDeclaration}. Deltas: `id`
 * re-typed OPTIONAL (defaulted from {@link CollectContext.stableId}) and
 * `config` re-typed OPTIONAL (defaulted to `{}`).
 */
export type MCPProps = Omit<MCPDeclaration, "id" | "config"> & {
  readonly id?: string;
  readonly config?: Record<string, unknown>;
};

type MCPForwarded = "serverName" | "transport" | "exposes" | "metadata";
type MCPSupplied = "id" | "config";
type _conformance = Exhausted<UnhandledSpecKeys<MCPDeclaration, MCPForwarded, MCPSupplied>>;

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
      ...(omitUndefined({ ...props }) as Partial<MCPDeclaration>),
      id: props.id ?? ctx.stableId("mcp", instance),
      serverName: props.serverName,
      transport: props.transport,
      config: props.config ?? {},
    };
    return [{ kind: "mcp-declaration", mcp }];
  },
};
